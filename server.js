import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './src/config.js';
import { openDb } from './src/db.js';
import { llmStatus } from './src/llm.js';
import { publicRouter } from './src/routes/public.js';
import { adminRouter } from './src/routes/admin.js';
import { seedIfEmpty } from './src/seed.js';

// Never expose the counselor portal behind the publicly documented demo passcode.
if (config.isProduction && config.usingDemoPasscode) {
  console.error('Refusing to start: set ADMIN_PASSCODE (12+ characters) when NODE_ENV=production.');
  process.exit(1);
}

const db = openDb();
await seedIfEmpty(db);

const app = express();
app.disable('x-powered-by');
// Behind a hosting proxy (Render, Railway, Fly...) set TRUST_PROXY=1 so rate limits apply per visitor,
// not to the proxy's single address. Addresses are still only hashed in memory, never stored.
app.set('trust proxy', config.trustProxy);

// Privacy-first: no request logging, no IP storage, no third-party assets.
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  });
  next();
});
app.use(express.json({ limit: '3mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api/admin', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, adminRouter(db));
app.use('/api', publicRouter(db));
// Fonts are self-hosted: a third-party font CDN would see every student's IP address.
const fontDir = (pkg) => fileURLToPath(new URL(`./node_modules/@fontsource-variable/${pkg}/files/`, import.meta.url));
app.use('/fonts/inter', express.static(fontDir('inter'), { maxAge: '30d', immutable: true }));
app.use('/fonts/jakarta', express.static(fontDir('plus-jakarta-sans'), { maxAge: '30d', immutable: true }));
app.use(express.static(config.publicDir, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large (2 MB max).' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong. Your report was not saved - please try again.' });
});

app.listen(config.port, () => {
  const llm = llmStatus();
  console.log(`C.A.R.E. Hub running at http://localhost:${config.port}`);
  console.log(`  Counselor portal: http://localhost:${config.port}/admin  (passcode: ${config.usingDemoPasscode ? 'counselor-demo [demo default]' : 'set via ADMIN_PASSCODE'})`);
  console.log(`  AI engine: ${llm.enabled ? `Claude (${llm.model}) with offline safety rules` : `offline rules only (${llm.reason})`}`);
});
