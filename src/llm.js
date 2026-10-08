// Thin, provider-neutral wrapper around the AI model (Gemini or Claude). Every caller must treat a
// `null` result as "use the offline engine" - the platform is fully functional without an API key.
//
// Provider choice (CARE_LLM_PROVIDER): "gemini", "anthropic", or "auto" (default) - auto uses Gemini
// when GEMINI_API_KEY / GOOGLE_API_KEY is set, otherwise Claude when Anthropic credentials are set.
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';
import { config } from './config.js';

const REQUEST_TIMEOUT_MS = 60_000;
const disabled = {}; // provider -> reason, once its key has been rejected this session
let anthropicClient = null;
let geminiClient = null;

const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const anthropicCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);

function chooseProvider() {
  const wanted = config.llmProvider;
  if (wanted === 'gemini' || wanted === 'anthropic') return wanted;
  if (geminiKey()) return 'gemini';
  if (anthropicCredentials()) return 'anthropic';
  return null;
}

export function llmStatus() {
  if (config.llmMode === 'off') return { enabled: false, reason: 'CARE_LLM=off' };
  const provider = chooseProvider();
  if (!provider) return { enabled: false, reason: 'no AI API key found (set GEMINI_API_KEY or ANTHROPIC_API_KEY)' };
  if (disabled[provider]) return { enabled: false, reason: disabled[provider] };
  if (provider === 'gemini' && !geminiKey()) return { enabled: false, reason: 'CARE_LLM_PROVIDER=gemini but GEMINI_API_KEY is not set' };
  if (provider === 'anthropic' && config.llmMode === 'auto' && !anthropicCredentials()) return { enabled: false, reason: 'CARE_LLM_PROVIDER=anthropic but no Anthropic credentials found' };
  return { enabled: true, provider, model: provider === 'gemini' ? config.geminiModel : config.anthropicModel };
}

function parseStructured(text, schema) {
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    console.warn('[llm] structured output did not parse - using offline engine');
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------
// Google's 500/503 "high demand" errors are usually brief: retry once, then try the lighter
// Flash-Lite model before falling back to the offline engine.
const GEMINI_BUSY = new Set([500, 503]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(args) {
  const attempts = [config.geminiModel, config.geminiModel, config.geminiFallbackModel].filter(Boolean);
  for (let i = 0; i < attempts.length; i += 1) {
    const result = await geminiOnce(args, attempts[i], i === attempts.length - 1);
    if (result !== BUSY) return result;
    if (i === 0) await sleep(1500);
    else if (i < attempts.length - 1) console.warn('[llm] Gemini still busy - trying %s', attempts[i + 1]);
  }
  console.warn('[llm] Gemini is overloaded right now - using offline engine for this request');
  return null;
}

const BUSY = Symbol('busy');

async function geminiOnce({ system, messages, maxTokens, schema }, model, lastAttempt) {
  geminiClient ??= new GoogleGenAI({ apiKey: geminiKey() });
  try {
    const response = await geminiClient.models.generateContent({
      model,
      // Gemini calls the assistant role "model".
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(schema && { responseMimeType: 'application/json', responseJsonSchema: schema }),
      },
    });

    if (response.promptFeedback?.blockReason) {
      console.warn('[llm] Gemini blocked the prompt (%s) - using offline engine', response.promptFeedback.blockReason);
      return null;
    }
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') {
      console.warn('[llm] Gemini stopped early (%s) - using offline engine', finish);
      return null;
    }
    const text = response.text?.trim();
    return text ? parseStructured(text, schema) : null;
  } catch (error) {
    if (error instanceof GeminiApiError && GEMINI_BUSY.has(error.status) && !lastAttempt) return BUSY;
    if (error instanceof GeminiApiError && (error.status === 400 || error.status === 401 || error.status === 403) && /api key|API_KEY|permission|unauthori[sz]ed/i.test(error.message)) {
      disabled.gemini = 'Gemini API key rejected';
      console.warn('[llm] %s - switching to offline engine for this session', disabled.gemini);
    } else if (error instanceof GeminiApiError && error.status === 404) {
      console.warn('[llm] Gemini model "%s" not found - set GEMINI_MODEL to an available model', model);
    } else if (error instanceof GeminiApiError && error.status === 429) {
      console.warn('[llm] Gemini rate limit or quota reached - using offline engine for this request');
    } else if (error instanceof GeminiApiError) {
      console.warn('[llm] Gemini API error %s: %s', error.status, error.message);
    } else {
      console.warn('[llm] Gemini request failed: %s', error?.message ?? error);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------
async function callAnthropic({ system, messages, maxTokens, effort, schema }) {
  anthropicClient ??= new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  try {
    const response = await anthropicClient.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      // Re-run safety-classifier declines on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, ...(schema && { format: { type: 'json_schema', schema } }) },
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      console.warn('[llm] request declined (category: %s) - using offline engine', response.stop_details?.category ?? 'n/a');
      return null;
    }
    if (response.stop_reason === 'max_tokens') {
      console.warn('[llm] response truncated at max_tokens - using offline engine');
      return null;
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text ? parseStructured(text, schema) : null;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      disabled.anthropic = 'Anthropic credentials rejected';
      console.warn('[llm] %s - switching to offline engine for this session', disabled.anthropic);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.warn('[llm] rate limited - using offline engine for this request');
    } else if (error instanceof Anthropic.APIError) {
      console.warn('[llm] API error %s: %s', error.status ?? 'n/a', error.message);
    } else {
      console.warn('[llm] unexpected error: %s', error?.message ?? error);
    }
    return null;
  }
}

/**
 * Call the configured model once. Returns the text (or parsed JSON when `schema` is given), or null
 * on any failure. `effort` only applies to Claude; Gemini uses its defaults.
 */
export async function callLlm({ system, messages, maxTokens = 8000, effort = 'low', schema = null }) {
  const status = llmStatus();
  if (!status.enabled) return null;
  const args = { system, messages, maxTokens, effort, schema };
  return status.provider === 'gemini' ? callGemini(args) : callAnthropic(args);
}
