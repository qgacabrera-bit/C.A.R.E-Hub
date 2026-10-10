# C.A.R.E. Hub

[![CI](https://github.com/qgacabrera-bit/C.A.R.E-Hub/actions/workflows/ci.yml/badge.svg)](https://github.com/qgacabrera-bit/C.A.R.E-Hub/actions/workflows/ci.yml)

**Campus Anonymous Reporting & Escalation Hub**: a privacy-first platform where students anonymously share experiences, report incidents, and get support. Recurring patterns are surfaced to counselors without exposing anyone's identity.

> Demo build. All data is **synthetic**. Never load real student data, real IDs, or genuine complaints.

## Quick start

```bash
npm install
cp .env.example .env # optional - npm start loads .env automatically
npm start            # http://localhost:3000  (seeds synthetic demo data on first run)
npm test             # pipeline + guardrail tests
npm run seed         # wipe and reload the synthetic dataset
```

* Student app: `http://localhost:3000/`
* Counselor portal: `http://localhost:3000/admin` (demo passcode `counselor-demo`)

Requires Node.js 22.13+. Production data lives in Supabase Postgres (`DATABASE_URL`); without it, local development uses an embedded Postgres (PGlite) under `data/pglite`.

### Optional: AI-assisted review (Gemini or Claude)
Set `GEMINI_API_KEY` (Google Gemini, default model `gemini-flash-latest`) or `ANTHROPIC_API_KEY` (Claude, `claude-opus-5-5`) to have an AI model double-check sanitization, add context to urgency scores, power the Adviser chat, and draft reports. With both set, Gemini is used unless `CARE_LLM_PROVIDER=anthropic`. Without a key, the app runs entirely on its deterministic offline engine; if a key is rejected or a request fails, it falls back to that engine automatically. Student messages are scrubbed of names, numbers and handles before anything is sent to the AI provider.

> **Gemini free tier and student data:** on Gemini's free (unpaid) tier, Google's terms allow prompts and responses to be used to improve its products and to be read by human reviewers. For anything beyond synthetic demo data, use an API key from a Google Cloud project with billing enabled (paid tier), where that does not apply. Check the current [Gemini API terms](https://ai.google.dev/gemini-api/terms) before a pilot.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSCODE` | `counselor-demo` | Counselor portal passcode. **Required (12+ chars) when `NODE_ENV=production`**; the server refuses to start otherwise |
| `NODE_ENV` | – | `production` enables the passcode guard and hides the demo-passcode hint |
| `TRUST_PROXY` | `0` | Set to `1` behind a hosting proxy so rate limits apply per visitor |
| `CARE_LLM` | `auto` | `auto` uses an AI model when a key exists; `off` forces offline |
| `CARE_LLM_PROVIDER` | `auto` | `gemini`, `anthropic`, or `auto` (Gemini first) |
| `GEMINI_API_KEY` | – | Enables Gemini (`GOOGLE_API_KEY` also works) |
| `GEMINI_MODEL` | `gemini-flash-latest` | Pin a specific Gemini model |
| `GEMINI_FALLBACK_MODEL` | `gemini-flash-lite-latest` | Tried when the main model is overloaded (503); empty disables |
| `ANTHROPIC_API_KEY` | – | Enables Claude |
| `RETAIN_RAW_CONTENT` | `false` | Raw narratives are purged after sanitization unless `true` |
| `DATABASE_URL` | – | Supabase Transaction pooler string. **Required when `NODE_ENV=production`**. Empty = embedded PGlite for local dev |
| `DB_POOL_MAX` | `5` | Max pooled Postgres connections per instance |
| `CARE_SEED` | `true` | `false` skips auto-seeding an empty DB |

## Deploying

GitHub hosts the code. **GitHub Pages can't run this app**: it serves static files only, and C.A.R.E. Hub needs its Node server and a Postgres database (Supabase). Pushing to `main` runs the tests and a server smoke test on Node 22 and 24 in GitHub Actions (`.github/workflows/ci.yml`).

**Render:** the repo includes a `render.yaml` Blueprint. In Render, choose **New → Blueprint**, pick this repository, and apply. The counselor passcode is generated for you; find it under the service's **Environment** tab. The free plan resets the database on every restart; see the comments in `render.yaml` to add a persistent disk.

To put it online elsewhere, deploy the repository to any Node or Docker host (Railway, Fly.io, a VPS):

| Setting | Value |
|---|---|
| Build / install | `npm ci` (or use the included `Dockerfile`) |
| Start | `npm start` |
| Health check | `GET /healthz` |
| Env (required) | `NODE_ENV=production`, `DATABASE_URL=<Supabase Transaction pooler string>`, `ADMIN_PASSCODE=<12+ chars>`, `TRUST_PROXY=1` |
| Env (optional) | `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, `CARE_LLM`, `CARE_LLM_PROVIDER` |
| Storage | Supabase Postgres. The tables come from `supabase/migrations/` and must already exist; the app never creates or alters them |

```bash
docker build -t care-hub .
docker run -p 3000:3000 -e DATABASE_URL='postgresql://...' \
  -e ADMIN_PASSCODE='a-long-private-passcode' -e TRUST_PROXY=1 care-hub
```

Before any pilot with real students, also work through the review list below. Change the placeholder campus contacts, replace the shared passcode with real sign-in, and get your school's sign-off on data handling.

## Architecture

```
Student browser ──► POST /api/posts
                     │
                     ▼
   1. Deterministic scrubber (src/pipeline/scrubber.js)
      links, emails, phones, student IDs, @handles → tags
      names → [Student A] / [Student Group A] / [Faculty Member]
      guilt & punitive language → objective wording
      call-out / retaliation intent → flagged
   2. Optional Claude review (src/pipeline/ingest.js)
      sees only pre-scrubbed text; its rewrite is re-checked by the rules
      and rejected if it re-introduces a redacted identifier
   3. Similarity & clustering (src/pipeline/similarity.js)
      TF-IDF cosine > 0.80  OR  same category + zone within 7 days
      → link to an Incident Cluster
   4. Severity 1–5 (src/pipeline/severity.js)
      rules floor; Claude may raise, never lower; repeated harassment
      and clusters ≥ 4 reports count as systemic
   5. Routing
      ≥ 4 or crisis    → flagged_admin + escalation (never on public feed)
      retaliation/ID risk → pending_moderation
      otherwise          → published
```

| Module | Files |
|---|---|
| Student app: 3-column shell, inline composer, reaction dock, My Reports, Adviser widget | `public/index.html`, `public/app.js`, `public/styles.css` |
| Ingestion, scrubbing, clustering, triage | `src/pipeline/*` |
| C.A.R.E. Adviser (chat + report drafts) | `src/adviser.js`, `src/llm.js` |
| Counselor triage dashboard | `public/admin.html`, `public/admin.js`, `src/routes/admin.js` |
| Schema (`posts`, `incident_clusters`, `escalations`, + `reactions`, `attachments`) | `src/db.js` |

## How the guardrails are enforced

| Guardrail | Implementation |
|---|---|
| No accusations / defamation | Names, faculty, handles, phones, IDs are redacted before storage. Guilt labels ("is a predator") and punitive demands ("should be expelled") are rewritten. A live privacy preview shows students what will be published. |
| No determining guilt | Escalation summaries come from a fixed objective template and are checked against a guilt-term list. They always end with "Pending counselor review; this summary does not determine fault." |
| No retaliation facilitation | No comments, only four supportive reactions (one per student per post). Call-out language is held for counselor moderation. The Adviser refuses to help plan exposure or retaliation. |
| No real PII in demo | The seed data is synthetic. A demo banner is shown. Raw narratives are purged after processing. No IPs are stored (rate limiting uses salted in-memory hashes). Author identity is a SHA-256 hash of a random browser-held secret. Attachments are JPEG/PNG only, with EXIF/text metadata stripped, and visible to counselors only. |
| No policy/legal substitution | A persistent footer disclaimer appears on every page, student and counselor. |
| Emergency safeguards | A one-tap "Helpline 1553" pill in the sticky top bar (every screen size), plus a "Need someone to talk to?" card in the sidebar and a full contacts page (crisis lines, campus offices, student council, SK and the barangay VAWC desk; local numbers are placeholders to replace before a pilot). Self-harm signals in posts or chat show crisis resources immediately, are scored 5/5, are routed privately, and are never clustered. |

## Design decisions to review before a pilot
* **Free-text locations.** The composer's location field accepts typed text with suggestions. Known zones and aliases ("chem lab", "canteen", "gc") collapse to canonical names so clustering still works. Anything else is run through the PII scrubber, so a location like "Mr. Cruz's room" can't carry a name.
* **Self-hosted fonts.** Inter and Plus Jakarta Sans are served from `node_modules/@fontsource-variable/*`. A font CDN would see every student's IP address. The page makes zero third-party requests.
* **Counselor portal actions.** Report content is read-only. Counselors can only move a cluster through `active → reviewing → resolved` (shown to authors as follow-ups) and approve or withhold held posts. This adds a `withheld` post status beyond the spec's three.
* **Author removal.** Students can remove their own posts, except high-priority ones, which stay with counselors for safety.
* **Campus contacts** in `src/config.js` marked "demo placeholder" must be replaced with real numbers.
* **Admin auth** is a single shared passcode with in-memory sessions (sessions reset on restart), which is fine for a demo. Use real SSO for production.
* **Offline name detection** is heuristic (capitalized spans plus a first-name list). Uncertain cases are held for moderation rather than published. Claude review catches more, especially nicknames.
