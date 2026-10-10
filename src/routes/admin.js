import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { severityLabel } from '../pipeline/severity.js';
import { UserError } from '../pipeline/ingest.js';
import { rateLimit } from './rateLimit.js';
import { LIMITS, articleIssues, draftArticle } from '../articles.js';
import { llmStatus } from '../llm.js';

// Counselor portal. Report content is read-only here: counselors can move a cluster through its
// review workflow and make publish/withhold moderation decisions, but cannot edit narratives, see
// author tokens, or contact students.

export const ROLES = { STUDENT: 'student', ADMIN: 'admin' };

const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { role, expires }

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token);
}, 10 * 60 * 1000).unref();

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Everyone without a live session is a student - the public page needs no login.
function roleOf(req) {
  const session = sessions.get(bearer(req));
  return session && session.expires >= Date.now() ? session.role : ROLES.STUDENT;
}

function requireRole(...allowed) {
  return (req, _res, next) => {
    const role = roleOf(req);
    if (role === ROLES.STUDENT) {
      sessions.delete(bearer(req));
      return next(new UserError('Counselor session expired. Please sign in again.', 401));
    }
    if (!allowed.includes(role)) return next(new UserError('You do not have permission to do that.', 403));
    next();
  };
}

// Route ids outside the Postgres integer range would be a database error; treat them as "not found".
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : -1;
}

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
};

// Wellbeing concerns are personal: they stay counselor-only and never get a public article.
const PRIVATE_CATEGORIES = new Set(['Mental Health']);

const shapeArticle = (a) => ({
  headline: a.headline,
  summary: a.summary,
  body: a.body,
  context: a.counselor_context,
  source: a.source,
  status: a.status,
  updated_at: a.updated_at,
  published_at: a.published_at,
});

export function adminRouter(db) {
  const r = express.Router();

  // Lets the login page show the demo hint only when the demo passcode is actually in use.
  r.get('/config', (_req, res) => res.json({ demo_passcode: config.usingDemoPasscode }));

  r.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many sign-in attempts. Try again later.' }), (req, res, next) => {
    if (!safeEqual(req.body?.passcode ?? '', config.adminPasscode)) return next(new UserError('Incorrect passcode.', 401));
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { role: ROLES.ADMIN, expires: Date.now() + SESSION_TTL });
    res.json({ token, role: ROLES.ADMIN, expires_in: SESSION_TTL / 1000 });
  });

  // Public: a missing, fake or expired token simply reports the default student role.
  r.get('/whoami', (req, res) => res.json({ role: roleOf(req) }));

  r.use(requireRole(ROLES.ADMIN));

  r.post('/logout', (req, res) => {
    sessions.delete(bearer(req));
    res.json({ ok: true });
  });

  r.get('/overview', async (_req, res) => {
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const stats = await db.get(`SELECT
        (SELECT COUNT(*)::int FROM posts WHERE created_at >= ?) AS reports_30d,
        (SELECT COUNT(*)::int FROM posts WHERE status = 'flagged_admin') AS priority,
        (SELECT COUNT(*)::int FROM posts WHERE status = 'pending_moderation') AS moderation,
        (SELECT COUNT(*)::int FROM incident_clusters WHERE status != 'resolved') AS open_clusters`, [since30]);

    const shapePost = (p) => ({
      id: p.id,
      category: p.category,
      location: p.location_tag,
      content: p.sanitized_content,
      severity_score: p.severity_score,
      severity_label: severityLabel(p.severity_score),
      indicators: parse(p.risk_indicators),
      notes: parse(p.moderation_notes),
      cluster_id: p.cluster_id,
      has_attachment: Boolean(p.has_attachment),
      private_report: p.visibility === 'private',
      created_at: p.created_at,
    });

    // Structured fields for the counselor queue (the stored summary_brief stays as the audit text).
    const priority = (await db.all(`SELECT p.*, e.summary_brief, e.sent_to, e.dispatched_at,
                                           c.cluster_title, c.report_count AS cluster_reports, c.first_reported_at AS cluster_first, c.status AS cluster_status
                                    FROM posts p
                                    LEFT JOIN escalations e ON e.post_id = p.id
                                    LEFT JOIN incident_clusters c ON c.id = p.cluster_id
                                    WHERE p.status = 'flagged_admin'
                                    ORDER BY p.severity_score DESC, p.created_at DESC LIMIT 100`))
      .map((p) => {
        const post = shapePost(p);
        return {
          ...post,
          summary: p.summary_brief,
          sent_to: p.sent_to,
          dispatched_at: p.dispatched_at,
          wellbeing_risk: post.indicators.includes('self-harm or suicide risk'),
          cluster: p.cluster_id ? { id: p.cluster_id, title: p.cluster_title, report_count: p.cluster_reports, first_reported_at: p.cluster_first, status: p.cluster_status } : null,
        };
      });

    const moderation = (await db.all(`SELECT * FROM posts WHERE status = 'pending_moderation' ORDER BY created_at ASC LIMIT 100`)).map(shapePost);

    // Linked reports for every cluster in one query, instead of one query per cluster.
    const linked = Map.groupBy(
      await db.all(`SELECT id, cluster_id, sanitized_content, severity_score, status, created_at
                    FROM posts WHERE cluster_id IS NOT NULL ORDER BY created_at DESC`),
      (p) => p.cluster_id,
    );

    const articles = new Map((await db.all('SELECT * FROM incident_articles')).map((a) => [a.cluster_id, shapeArticle(a)]));

    const clusters = (await db.all(`SELECT c.*, MAX(p.severity_score) AS max_severity, ROUND(AVG(p.severity_score), 1)::float8 AS avg_severity,
                                           string_agg(p.risk_indicators, '|') AS indicator_blobs
                                    FROM incident_clusters c LEFT JOIN posts p ON p.cluster_id = c.id
                                    GROUP BY c.id ORDER BY (c.status = 'resolved'), max_severity DESC NULLS LAST, c.last_reported_at DESC`))
      .map((c) => ({
        id: c.id,
        title: c.cluster_title,
        incident_type: c.incident_type,
        location: c.location_tag,
        report_count: c.report_count,
        first_reported_at: c.first_reported_at,
        last_reported_at: c.last_reported_at,
        status: c.status,
        max_severity: c.max_severity ?? 1,
        avg_severity: c.avg_severity ?? 1,
        indicators: [...new Set((c.indicator_blobs ?? '').split('|').filter(Boolean).flatMap(parse))].slice(0, 6),
        reports: (linked.get(c.id) ?? []).map(({ cluster_id, ...p }) => p),
        article: articles.get(c.id) ?? null,
        public_article_allowed: !PRIVATE_CATEGORIES.has(c.incident_type),
      }));

    const hotspots = (await db.all(`SELECT location_tag AS location, COUNT(*)::int AS reports, MAX(severity_score) AS max_severity,
                                           ROUND(AVG(severity_score), 1)::float8 AS avg_severity, string_agg(DISTINCT category, ',') AS categories
                                    FROM posts WHERE created_at >= ? GROUP BY location_tag ORDER BY reports DESC, max_severity DESC`, [since30]))
      .map((h) => ({ ...h, categories: h.categories ? h.categories.split(',') : [] }));

    const escalations = await db.all(`SELECT * FROM escalations ORDER BY dispatched_at DESC LIMIT 50`);

    // Every concern students share reaches this page as a sanitized summary - not only the urgent ones.
    const allReports = (await db.all(`SELECT id, category, location_tag, sanitized_content, severity_score, status, visibility, cluster_id, created_at
                                      FROM posts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200`, [since30]))
      .map((p) => ({
        id: p.id, category: p.category, location: p.location_tag, content: p.sanitized_content,
        severity_score: p.severity_score, severity_label: severityLabel(p.severity_score),
        status: p.status, private_report: p.visibility === 'private', cluster_id: p.cluster_id, created_at: p.created_at,
      }));

    res.json({ stats, priority, moderation, clusters, hotspots, escalations, allReports, ai_drafting: llmStatus().enabled });
  });

  r.patch('/clusters/:id', async (req, res, next) => {
    const status = req.body?.status;
    if (!['active', 'reviewing', 'resolved'].includes(status)) return next(new UserError('Invalid status.'));
    const { changes } = await db.run('UPDATE incident_clusters SET status = ? WHERE id = ?', [status, toId(req.params.id)]);
    if (!changes) return next(new UserError('Recurring incident not found.', 404));
    res.json({ ok: true, status });
  });

  // ---- Resolution articles: written after a recurring incident is resolved, reviewed, then published ----

  async function loadIncident(id) {
    const c = await db.get('SELECT * FROM incident_clusters WHERE id = ?', [toId(id)]);
    if (!c) throw new UserError('Recurring incident not found.', 404);
    if (PRIVATE_CATEGORIES.has(c.incident_type)) throw new UserError('Wellbeing concerns stay counselor-only, so they never get a public article.', 403);
    const blobs = await db.all('SELECT risk_indicators FROM posts WHERE cluster_id = ?', [c.id]);
    return {
      id: c.id,
      status: c.status,
      category: c.incident_type,
      location: c.location_tag,
      report_count: c.report_count,
      first_reported_at: c.first_reported_at,
      last_reported_at: c.last_reported_at,
      indicators: [...new Set(blobs.flatMap((b) => parse(b.risk_indicators)))].filter((i) => i !== 'repeated pattern reported'),
    };
  }

  const text = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

  r.post('/clusters/:id/article/draft', rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: 'Too many drafts in a short time. Try again in a few minutes.' }), async (req, res, next) => {
    try {
      const incident = await loadIncident(req.params.id);
      const context = text(req.body?.context, LIMITS.context[1]);
      if (context.length < LIMITS.context[0]) {
        return next(new UserError(`Add more context first (at least ${LIMITS.context[0]} characters): what was done, what changed, and what students should know.`));
      }
      res.json(await draftArticle(incident, context));
    } catch (e) {
      next(e);
    }
  });

  // Save a draft, or publish after review. Publishing needs a resolved incident, the counselor's review
  // confirmation, and a draft that passes the identity / blame checks.
  r.put('/clusters/:id/article', async (req, res, next) => {
    try {
      const incident = await loadIncident(req.params.id);
      const b = req.body ?? {};
      const article = {
        headline: text(b.headline, LIMITS.headline[1] + 1).replace(/\s+/g, ' '),
        summary: text(b.summary, LIMITS.summary[1] + 1).replace(/\s+/g, ' '),
        body: text(b.body, LIMITS.body[1] + 1),
        context: text(b.context, LIMITS.context[1]),
        source: ['counselor', 'ai', 'template'].includes(b.source) ? b.source : 'counselor',
      };
      const publish = b.publish === true;
      if (publish) {
        if (incident.status !== 'resolved') throw new UserError('Mark the recurring incident as resolved before publishing its article.', 409);
        if (b.reviewed !== true) throw new UserError('Confirm that you reviewed the article before publishing.');
        const issues = articleIssues(article);
        if (issues.length) return res.status(422).json({ error: 'Fix these before publishing:', issues });
      } else if (!article.headline && !article.summary && !article.body) {
        throw new UserError('There is nothing to save yet.');
      }

      const now = new Date().toISOString();
      await db.run(`INSERT INTO incident_articles (cluster_id, headline, summary, body, counselor_context, source, status, created_at, updated_at, published_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (cluster_id) DO UPDATE SET headline = EXCLUDED.headline, summary = EXCLUDED.summary, body = EXCLUDED.body,
                      counselor_context = EXCLUDED.counselor_context, source = EXCLUDED.source, status = EXCLUDED.status,
                      updated_at = EXCLUDED.updated_at, published_at = EXCLUDED.published_at`,
      [incident.id, article.headline, article.summary, article.body, article.context, article.source,
        publish ? 'published' : 'draft', now, now, publish ? now : null]);
      res.json({ article: shapeArticle(await db.get('SELECT * FROM incident_articles WHERE cluster_id = ?', [incident.id])) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/posts/:id/moderate', async (req, res, next) => {
    const decision = req.body?.decision;
    if (!['publish', 'withhold'].includes(decision)) return next(new UserError('Decision must be "publish" or "withhold".'));
    const { changes } = await db.run(`UPDATE posts SET status = ? WHERE id = ? AND status = 'pending_moderation'`,
      [decision === 'publish' ? 'published' : 'withheld', toId(req.params.id)]);
    if (!changes) return next(new UserError('Post is not awaiting moderation.', 404));
    res.json({ ok: true });
  });

  r.get('/attachments/:postId', async (req, res, next) => {
    const file = await db.get('SELECT mime_type, data FROM attachments WHERE post_id = ?', [toId(req.params.postId)]);
    if (!file) return next(new UserError('No attachment.', 404));
    res.set({ 'Content-Type': file.mime_type, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
    res.send(Buffer.from(file.data));
  });

  return r;
}
