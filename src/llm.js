// Thin wrapper around the Claude API. Every caller must treat a `null` result as "use the offline
// engine" - the platform is fully functional without an API key.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let client = null;
let disabledReason = null;

function credentialsPresent() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

export function llmStatus() {
  if (config.llmMode === 'off') return { enabled: false, reason: 'CARE_LLM=off' };
  if (disabledReason) return { enabled: false, reason: disabledReason };
  if (config.llmMode === 'auto' && !credentialsPresent()) return { enabled: false, reason: 'no Anthropic credentials found' };
  return { enabled: true, model: config.model };
}

function getClient() {
  if (!llmStatus().enabled) return null;
  client ??= new Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client;
}

/**
 * Call Claude once. Returns the text (or parsed JSON when `schema` is given), or null on any failure.
 */
export async function callClaude({ system, messages, maxTokens = 8000, effort = 'low', schema = null }) {
  const anthropic = getClient();
  if (!anthropic) return null;
  try {
    const response = await anthropic.beta.messages.create({
      model: config.model,
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
    if (!text) return null;
    if (!schema) return text;
    try {
      return JSON.parse(text);
    } catch {
      console.warn('[llm] structured output did not parse - using offline engine');
      return null;
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      disabledReason = 'Anthropic credentials rejected';
      console.warn('[llm] %s - switching to offline engine for this session', disabledReason);
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
