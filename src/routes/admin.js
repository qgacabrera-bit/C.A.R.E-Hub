import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { severityLabel } from '../pipeline/severity.js';
import { UserError } from '../pipeline/ingest.js';
import { rateLimit } from './rateLimit.js';

// Counselor portal. Report content is read-only here: counselors can move a cluster through its
// review workflow and make publish/withhold moderation decisions, but cannot edit narratives, see
// author tokens, or contact students.

const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return next(new UserError('Counselor session expired. Please sign in again.', 401));
  }
  next();
}

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
};

export function adminRouter(db) {
  const r = express.Router();

  r.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many sign-in attempts. Try again later.' }), (req, res, next) => {
    if (!safeEqual(req.body?.passcode ?? '', config.adminPasscode)) return next(new UserError('Incorrect passcode.', 401));
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + SESSION_TTL });
    res.json({ token, expires_in: SESSION_TTL / 1000 });
  });

  r.use(requireAdmin);

  r.get('/overview', (_req, res) => {
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const stats = db.prepare(`SELECT
        (SELECT COUNT(*) FROM posts WHERE created_at >= ?) AS reports_30d,
        (SELECT COUNT(*) FROM posts WHERE status = 'flagged_admin') AS priority,
        (SELECT COUNT(*) FROM posts WHERE status = 'pending_moderation') AS moderation,
        (SELECT COUNT(*) FROM incident_clusters WHERE status != 'resolved') AS open_clusters`).get(since30);

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
      created_at: p.created_at,
    });

    const priority = db.prepare(`SELECT p.*, e.summary_brief, e.sent_to, e.dispatched_at FROM posts p
                                 LEFT JOIN escalations e ON e.post_id = p.id
                                 WHERE p.status = 'flagged_admin'
                                 ORDER BY p.severity_score DESC, p.created_at DESC LIMIT 100`).all()
      .map((p) => ({ ...shapePost(p), summary: p.summary_brief, sent_to: p.sent_to, dispatched_at: p.dispatched_at }));

    const moderation = db.prepare(`SELECT * FROM posts WHERE status = 'pending_moderation' ORDER BY created_at ASC LIMIT 100`).all().map(shapePost);

    const clusters = db.prepare(`SELECT c.*, MAX(p.severity_score) AS max_severity, ROUND(AVG(p.severity_score), 1) AS avg_severity,
                                        GROUP_CONCAT(p.risk_indicators, '|') AS indicator_blobs
                                 FROM incident_clusters c LEFT JOIN posts p ON p.cluster_id = c.id
                                 GROUP BY c.id ORDER BY (c.status = 'resolved'), max_severity DESC, c.last_reported_at DESC`).all()
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
        reports: db.prepare(`SELECT id, sanitized_content, severity_score, status, created_at FROM posts WHERE cluster_id = ? ORDER BY created_at DESC`).all(c.id),
      }));

    const hotspots = db.prepare(`SELECT location_tag AS location, COUNT(*) AS reports, MAX(severity_score) AS max_severity,
                                        ROUND(AVG(severity_score), 1) AS avg_severity, GROUP_CONCAT(DISTINCT category) AS categories
                                 FROM posts WHERE created_at >= ? GROUP BY location_tag ORDER BY reports DESC, max_severity DESC`).all(since30)
      .map((h) => ({ ...h, categories: h.categories ? h.categories.split(',') : [] }));

    const escalations = db.prepare(`SELECT * FROM escalations ORDER BY dispatched_at DESC LIMIT 50`).all();

    res.json({ stats, priority, moderation, clusters, hotspots, escalations });
  });

  r.patch('/clusters/:id', (req, res, next) => {
    const status = req.body?.status;
    if (!['active', 'reviewing', 'resolved'].includes(status)) return next(new UserError('Invalid cluster status.'));
    const info = db.prepare('UPDATE incident_clusters SET status = ? WHERE id = ?').run(status, Number(req.params.id));
    if (!info.changes) return next(new UserError('Cluster not found.', 404));
    res.json({ ok: true, status });
  });

  r.post('/posts/:id/moderate', (req, res, next) => {
    const decision = req.body?.decision;
    if (!['publish', 'withhold'].includes(decision)) return next(new UserError('Decision must be "publish" or "withhold".'));
    const info = db.prepare(`UPDATE posts SET status = ? WHERE id = ? AND status = 'pending_moderation'`)
      .run(decision === 'publish' ? 'published' : 'withheld', Number(req.params.id));
    if (!info.changes) return next(new UserError('Post is not awaiting moderation.', 404));
    res.json({ ok: true });
  });

  r.get('/attachments/:postId', (req, res, next) => {
    const file = db.prepare('SELECT mime_type, data FROM attachments WHERE post_id = ?').get(Number(req.params.postId));
    if (!file) return next(new UserError('No attachment.', 404));
    res.set({ 'Content-Type': file.mime_type, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
    res.send(Buffer.from(file.data));
  });

  return r;
}
