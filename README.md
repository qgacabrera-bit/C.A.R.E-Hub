# C.A.R.E. Hub
**Campus Anonymous Reporting & Escalation Hub**: a privacy-first platform where students anonymously share experiences, report incidents, and get support. Recurring patterns are surfaced to counselors without exposing anyone's identity.

> Demo build. All data is **synthetic**. Never load real student data, real IDs, or genuine complaints.

## Quick start

```bash
npm install
npm start            # http://localhost:3000  (seeds synthetic demo data on first run)
npm test             # pipeline + guardrail tests
npm run seed         # wipe and reload the synthetic dataset
```

* Student app: `http://localhost:3000/`
* Counselor portal: `http://localhost:3000/admin` (demo passcode `counselor-demo`)

Requires Node.js 22.13+ (uses the built-in `node:sqlite`; no native builds).

### Optional: Claude-assisted review
Set `ANTHROPIC_API_KEY` to have Claude (`claude-opus-5-5`) review sanitization, add context to urgency scores, power the Adviser chat, and draft reports. Without a key, the app runs entirely on its deterministic offline engine. If the key is rejected, the app falls back to that engine automatically.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSCODE` | `counselor-demo` | Counselor portal passcode. **Change it for any shared deployment** |
| `CARE_LLM` | `auto` | `auto` uses Claude if credentials exist; `off` forces offline |
| `ANTHROPIC_API_KEY` | – | Enables Claude features |
| `RETAIN_RAW_CONTENT` | `false` | Raw narratives are purged after sanitization unless `true` |
| `CARE_DB_PATH` | `data/care-hub.db` | SQLite file |
| `CARE_SEED` | `true` | `false` skips auto-seeding an empty DB |

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
| Emergency safeguards | A one-tap "Helpline 1553" pill in the sticky top bar (every screen size), plus a 24/7 Support card in the sidebar and a Crisis Hotlines page. Self-harm signals in posts or chat show crisis resources immediately, are scored 5/5, are routed privately, and are never clustered. |

## Design decisions to review before a pilot
* **Free-text locations.** The composer's location field accepts typed text with suggestions. Known zones and aliases ("chem lab", "canteen", "gc") collapse to canonical names so clustering still works. Anything else is run through the PII scrubber, so a location like "Mr. Cruz's room" can't carry a name.
* **Self-hosted fonts.** Inter and Plus Jakarta Sans are served from `node_modules/@fontsource-variable/*`. A font CDN would see every student's IP address. The page makes zero third-party requests.
* **Counselor portal actions.** Report content is read-only. Counselors can only move a cluster through `active → reviewing → resolved` (shown to authors as follow-ups) and approve or withhold held posts. This adds a `withheld` post status beyond the spec's three.
* **Author removal.** Students can remove their own posts, except high-priority ones, which stay with counselors for safety.
* **Campus contacts** in `src/config.js` marked "demo placeholder" must be replaced with real numbers.
* **Admin auth** is a single shared passcode with in-memory sessions, which is fine for a demo. Use real SSO for production.
* **Offline name detection** is heuristic (capitalized spans plus a first-name list). Uncertain cases are held for moderation rather than published. Claude review catches more, especially nicknames.
