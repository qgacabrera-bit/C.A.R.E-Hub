import express from 'express';
import { config } from '../config.js';
import { llmStatus } from '../llm.js';
import { adviserReply, buildReportDraft } from '../adviser.js';
import crypto from 'node:crypto';
import { authorTokenFromSecret, displayHandle, submitPost, UserError } from '../pipeline/ingest.js';
import { scoreSeverity, severityLabel } from '../pipeline/severity.js';
import { scrubText } from '../pipeline/scrubber.js';
import { rateLimit } from './rateLimit.js';

// Supportive reactions only (stored keys are stable; icons and wording live in the client). One per student per post.
export const REACTIONS = {
  support: 'Support',
  strength: 'Solidarity',
  same: "You're Not Alone",
  heard: 'Heard',
};

const DESCRIPTOR_ORDER = [
  'unauthorized or intimate image sharing', 'sexual harassment', 'threats or intimidation', 'physical assault', 'stalking',
  'hazing', 'hazardous condition with injury risk', 'threat of violence or weapon', 'physical contact', 'online harassment',
  'coercion to use substances', 'safety hazard', 'near-miss injury', 'verbal taunting', 'peer pressure',
];

function requireToken(secret) {
  const token = authorTokenFromSecret(secret);
  if (!token) throw new UserError('Missing or invalid anonymous session. Refresh the page and try again.', 401);
  return token;
}

function reactionCounts(db, postIds) {
  if (!postIds.length) return new Map();
  const rows = db.prepare(`SELECT post_id, kind, COUNT(*) AS n FROM reactions WHERE post_id IN (${postIds.map(() => '?').join(',')}) GROUP BY post_id, kind`).all(...postIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.post_id)) map.set(r.post_id, Object.fromEntries(Object.keys(REACTIONS).map((k) => [k, 0])));
    map.get(r.post_id)[r.kind] = r.n;
  }
  return map;
}

/** Pattern-level public notices for high-priority reports. Never includes narrative text. */
function campusNotices(db) {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`SELECT p.category, p.location_tag, p.risk_indicators, p.created_at, c.status AS cluster_status
                           FROM posts p LEFT JOIN incident_clusters c ON c.id = p.cluster_id
                           WHERE p.status = 'flagged_admin' AND p.visibility = 'public' AND p.category != 'Mental Health' AND p.created_at >= ?`).all(since);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.category}|${r.location_tag}`;
    const g = groups.get(key) ?? { category: r.category, location: r.location_tag, indicators: new Set(), count: 0, last: r.created_at, resolved: true };
    JSON.parse(r.risk_indicators).forEach((i) => g.indicators.add(i));
    g.count += 1;
    if (r.created_at > g.last) g.last = r.created_at;
    if (r.cluster_status !== 'resolved') g.resolved = false;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((g) => {
      const descriptors = DESCRIPTOR_ORDER.filter((d) => g.indicators.has(d)).slice(0, 2);
      const what = (g.indicators.has('repeated pattern reported') ? 'repeated ' : '') + (descriptors.length ? descriptors.join(' and ') : `${g.category.toLowerCase()} concerns`);
      return {
        category: g.category,
        location: g.location,
        updated_at: g.last,
        status: g.resolved ? 'Addressed by student welfare services' : 'Pending counselor review',
        text: `Reports have been noted regarding ${what} around the ${g.location}. This concern has been logged and forwarded to student welfare services for monitoring.`,
      };
    });
}

// Distinct anonymous students behind a cluster ("N students shared this").
const STUDENT_COUNT_SQL = (clusterCol) => `(SELECT COUNT(DISTINCT sp.anonymous_author_token) FROM posts sp WHERE sp.cluster_id = ${clusterCol} AND sp.visibility = 'public')`;

function followUpFor(post) {
  if (post.visibility === 'private') {
    return post.cluster_status === 'reviewing' ? 'Sent privately to counselors through the C.A.R.E. Adviser - a counselor is reviewing this concern.'
      : post.cluster_status === 'resolved' ? 'Sent privately to counselors - marked addressed by student welfare services.'
      : 'Sent privately to counselors through the C.A.R.E. Adviser. It will never appear on the feed. Pending counselor review.';
  }
  switch (post.status) {
    case 'published':
      return post.cluster_status === 'reviewing' ? 'Published. Counselors are reviewing the related concern.'
        : post.cluster_status === 'resolved' ? 'Published. The related concern was marked addressed by student welfare services.'
        : 'Published to the feed (identifying details removed). The Guidance team can see a summary.';
    case 'flagged_admin':
      return post.cluster_status === 'reviewing' ? 'Routed privately to counselors - a counselor is reviewing this concern.'
        : post.cluster_status === 'resolved' ? 'Routed privately to counselors - marked addressed by student welfare services.'
        : 'Routed privately to counselors. Pending counselor review.';
    case 'pending_moderation':
      return 'Held for moderation before publishing.';
    case 'withheld':
      return 'Not published after moderation review. You can still talk to the C.A.R.E. Adviser or your Guidance Office.';
    default:
      return '';
  }
}

export function publicRouter(db) {
  const r = express.Router();
  const postLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, message: 'You have submitted several reports recently. Please wait a while before posting again.' });
  const previewLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Preview paused for a moment - keep typing.' });
  const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many messages at once - take a breath and try again in a minute.' });

  r.get('/meta', (_req, res) => {
    res.json({
      categories: config.categories,
      locations: config.locations,
      emergencyContacts: config.emergencyContacts,
      reactions: REACTIONS,
      llm: llmStatus(),
    });
  });

  // `categories` is a comma-separated topic filter. The anonymous session (sent as a header so it
  // never lands in a URL) is only used to mark which reaction this student has given.
  r.get('/feed', (req, res) => {
    const topics = String(req.query.categories ?? '').split(',').filter((c) => config.categories.includes(c));
    const viewer = authorTokenFromSecret(req.get('X-Anon-Session'));
    const posts = db.prepare(`SELECT p.id, p.anonymous_author_token, p.category, p.sanitized_content, p.location_tag, p.severity_score,
                                     p.cluster_id, p.created_at, c.report_count, c.status AS cluster_status,
                                     ${STUDENT_COUNT_SQL('c.id')} AS student_count
                              FROM posts p LEFT JOIN incident_clusters c ON c.id = p.cluster_id
                              WHERE p.status = 'published' AND p.visibility = 'public' ${topics.length ? `AND p.category IN (${topics.map(() => '?').join(',')})` : ''}
                              ORDER BY p.created_at DESC LIMIT 100`).all(...topics);
    const counts = reactionCounts(db, posts.map((p) => p.id));
    const mine = new Map(viewer && posts.length
      ? db.prepare(`SELECT post_id, kind FROM reactions WHERE author_token = ? AND post_id IN (${posts.map(() => '?').join(',')})`)
        .all(viewer, ...posts.map((p) => p.id)).map((r) => [r.post_id, r.kind])
      : []);
    res.json({
      notices: campusNotices(db).filter((n) => !topics.length || topics.includes(n.category)),
      posts: posts.map((p) => ({
        my_reaction: mine.get(p.id) ?? null,
        id: p.id,
        handle: displayHandle(p.anonymous_author_token),
        category: p.category,
        content: p.sanitized_content,
        location: p.location_tag,
        severity_score: p.severity_score,
        severity_label: severityLabel(p.severity_score),
        pattern: p.cluster_id ? { report_count: p.report_count, student_count: p.student_count, status: p.cluster_status } : null,
        created_at: p.created_at,
        reactions: counts.get(p.id) ?? Object.fromEntries(Object.keys(REACTIONS).map((k) => [k, 0])),
      })),
    });
  });

  // Public "Concerns Raised" list: titles and counts only, never narratives. Wellbeing
  // clusters are personal and stay counselor-only.
  r.get('/patterns', (_req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const rows = db.prepare(`SELECT id, cluster_title, incident_type, location_tag, report_count, last_reported_at, status,
                                    ${STUDENT_COUNT_SQL('incident_clusters.id')} AS student_count
                             FROM incident_clusters
                             WHERE status != 'resolved' AND incident_type != 'Mental Health' AND last_reported_at >= ?
                               AND (SELECT COUNT(*) FROM posts pp WHERE pp.cluster_id = incident_clusters.id AND pp.visibility = 'public') >= 2
                             ORDER BY report_count DESC, last_reported_at DESC LIMIT 6`).all(since);
    res.json(rows.map((c) => ({
      title: c.cluster_title,
      category: c.incident_type,
      location: c.location_tag,
      report_count: c.report_count,
      student_count: c.student_count,
      last_reported_at: c.last_reported_at,
      status: c.status === 'reviewing' ? 'Under counselor review' : 'Heard',
    })));
  });

  // Live privacy preview (rules only, nothing stored) so students see what will be published and
  // whether the post would be routed privately.
  r.post('/preview', previewLimiter, (req, res) => {
    const text = String(req.body?.narrative ?? '').slice(0, config.maxNarrativeLength);
    const result = scrubText(text);
    const severity = scoreSeverity(`${result.text}\n${text}`, { category: req.body?.category });
    res.json({
      text: result.text,
      redaction_count: result.redactionCount,
      notes: result.notes,
      crisis: severity.crisis,
      private_routing: severity.crisis || severity.score >= config.escalationThreshold,
      held_for_moderation: result.retaliation || result.residualIdentifiers.length > 0,
    });
  });

  r.post('/posts', postLimiter, async (req, res, next) => {
    try {
      const token = requireToken(req.body?.secret);
      if (req.body?.acknowledged !== true) throw new UserError('Please confirm you have read the community standards.');
      const result = await submitPost(db, {
        authorToken: token,
        category: req.body.category,
        location_tag: req.body.location_tag,
        narrative: req.body.narrative,
        attachment: req.body.attachment,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  r.post('/my-posts', (req, res, next) => {
    try {
      const token = requireToken(req.body?.secret);
      const posts = db.prepare(`SELECT p.id, p.category, p.location_tag, p.sanitized_content, p.severity_score, p.status, p.visibility, p.created_at,
                                       p.moderation_notes, c.id AS cluster_id, c.report_count, c.status AS cluster_status,
                                       ${STUDENT_COUNT_SQL('c.id')} AS student_count
                                FROM posts p LEFT JOIN incident_clusters c ON c.id = p.cluster_id
                                WHERE p.anonymous_author_token = ? ORDER BY p.created_at DESC`).all(token);
      res.json({
        handle: displayHandle(token),
        posts: posts.map((p) => ({
          id: p.id,
          category: p.category,
          location: p.location_tag,
          content: p.sanitized_content,
          severity_score: p.severity_score,
          severity_label: severityLabel(p.severity_score),
          status: p.status,
          visibility: p.visibility,
          created_at: p.created_at,
          // Private reports never show public "students shared this" counts.
          pattern: p.cluster_id && p.visibility === 'public' ? { report_count: p.report_count, student_count: p.student_count, status: p.cluster_status } : null,
          follow_up: followUpFor(p),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/my-posts/:id/withdraw', (req, res, next) => {
    try {
      const token = requireToken(req.body?.secret);
      const post = db.prepare('SELECT id, cluster_id, status FROM posts WHERE id = ? AND anonymous_author_token = ?').get(Number(req.params.id), token);
      if (!post) throw new UserError('Report not found.', 404);
      if (post.status === 'flagged_admin') {
        // Safety reports stay with counselors; only public visibility can be changed by the author.
        throw new UserError('High-priority reports stay with counselors so they can make sure everyone is safe. Contact your Guidance Office if you have concerns.', 409);
      }
      db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
      if (post.cluster_id) db.prepare('UPDATE incident_clusters SET report_count = MAX(report_count - 1, 0) WHERE id = ?').run(post.cluster_id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  r.post('/posts/:id/react', (req, res, next) => {
    try {
      const token = requireToken(req.body?.secret);
      const kind = req.body?.kind;
      if (!Object.hasOwn(REACTIONS, kind)) throw new UserError('Unknown reaction.');
      const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'").get(Number(req.params.id));
      if (!post) throw new UserError('Post not found.', 404);
      // One reaction per student: same kind toggles off, a different kind replaces it.
      const existing = db.prepare('SELECT kind FROM reactions WHERE post_id = ? AND author_token = ?').get(post.id, token);
      db.prepare('DELETE FROM reactions WHERE post_id = ? AND author_token = ?').run(post.id, token);
      const myReaction = existing?.kind === kind ? null : kind;
      if (myReaction) db.prepare('INSERT INTO reactions (post_id, kind, author_token) VALUES (?, ?, ?)').run(post.id, myReaction, token);
      res.json({ my_reaction: myReaction, reactions: reactionCounts(db, [post.id]).get(post.id) ?? Object.fromEntries(Object.keys(REACTIONS).map((k) => [k, 0])) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/adviser/chat', chatLimiter, async (req, res, next) => {
    try {
      res.json(await adviserReply(req.body?.messages));
    } catch (err) {
      next(err);
    }
  });

  r.post('/adviser/draft', chatLimiter, async (req, res, next) => {
    try {
      const draft = await buildReportDraft(req.body?.messages);
      if (!draft) throw new UserError('Tell the Adviser a bit more about what happened first.');
      res.json(draft);
    } catch (err) {
      next(err);
    }
  });

  // Private report through the Adviser: counselors only, never on the feed or in public counts.
  // `unlinked: true` stores it under a throwaway random token, so it cannot be tied to the
  // student's anonymous ID at all (the trade-off: it won't appear in My Reports).
  r.post('/adviser/private-report', postLimiter, async (req, res, next) => {
    try {
      const unlinked = req.body?.unlinked === true;
      const authorToken = unlinked
        ? crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex')
        : requireToken(req.body?.secret);
      const result = await submitPost(db, {
        authorToken,
        category: req.body?.category,
        location_tag: req.body?.location_tag,
        narrative: req.body?.narrative,
        visibility: 'private',
      });
      res.status(201).json({
        post_id: unlinked ? null : result.post_id,
        unlinked,
        severity_score: result.severity_score,
        severity_label: result.severity_label,
        crisis: result.crisis,
        sanitized_content: result.sanitized_content,
        redaction_count: result.redaction_count,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
