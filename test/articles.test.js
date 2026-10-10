import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { articleIssues, draftArticle } from '../src/articles.js';
import { adminRouter } from '../src/routes/admin.js';
import { publicRouter } from '../src/routes/public.js';
import { submitPost, authorTokenFromSecret } from '../src/pipeline/ingest.js';

const CONTEXT = 'Maintenance replaced the loose ceiling fan mounts on October 8 and checked the bleachers. PE classes resumed in the gym the next day.';
const GOOD = {
  headline: 'Gym ceiling fans repaired after student reports',
  summary: 'Student welfare services and maintenance fixed the loose ceiling fans that students reported in the gym.',
  body: 'Students reported that ceiling fans in the gym were wobbling during PE.\n\nMaintenance replaced the fan mounts and checked the bleachers. PE classes are back in the gym.\n\nIf you notice anything unsafe, tell a staff member or report it on C.A.R.E. Hub.',
};

test('publish checks block names, contact details and blame words', () => {
  assert.deepEqual(articleIssues(GOOD), []);
  assert.ok(articleIssues({ ...GOOD, body: `${GOOD.body}\n\nWe thank Mark Santos from 3-B for reporting it.` }).some((i) => /identifies someone/.test(i)));
  assert.ok(articleIssues({ ...GOOD, body: `${GOOD.body}\n\nThe culprit has been punished.` }).some((i) => /blame/.test(i)));
  assert.ok(articleIssues({ ...GOOD, headline: 'Fans' }).some((i) => /headline is too short/.test(i)));
});

test('offline drafting fills a template from the counselor context', async () => {
  const incident = { category: 'Campus Safety', location: 'Gym', report_count: 3, indicators: ['safety hazard'], first_reported_at: '2026-10-01T02:00:00Z', last_reported_at: '2026-10-05T02:00:00Z' };
  const d = await draftArticle(incident, CONTEXT, { useLlm: false });
  assert.equal(d.source, 'template');
  assert.match(d.body, /replaced the loose ceiling fan mounts/);
  assert.match(d.body, /1553/);
  assert.deepEqual(d.issues, []);
});

async function withApp(fn) {
  const db = await openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter(db));
  app.use('/api', publicRouter(db));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token = '';
  const req = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  token = (await req('POST', '/admin/login', { passcode: config.adminPasscode })).body.token;
  try {
    await fn({ db, req });
  } finally {
    server.close();
    await db.close();
  }
}

const reporter = (n) => authorTokenFromSecret(`article-test-secret-${n}-xxxxxxxxxxxx`);

test('a resolved recurring incident gets a reviewed article on the student feed', async () => {
  await withApp(async ({ db, req }) => {
    const now = Date.now();
    await submitPost(db, { authorToken: reporter(1), useLlm: false, category: 'Campus Safety', location_tag: 'Gym', narrative: 'The gym ceiling fan is wobbling a lot during PE.', now: now - 864e5 });
    const r = await submitPost(db, { authorToken: reporter(2), useLlm: false, category: 'Campus Safety', location_tag: 'Gym', narrative: 'Another ceiling fan in the gym shakes and looks loose.', now });
    const id = r.cluster.id;

    // Drafting needs real context.
    assert.equal((await req('POST', `/admin/clusters/${id}/article/draft`, { context: 'fixed' })).status, 400);
    const draft = await req('POST', `/admin/clusters/${id}/article/draft`, { context: CONTEXT });
    assert.equal(draft.status, 200);
    assert.ok(['ai', 'template'].includes(draft.body.source));

    // A draft can be saved any time, but publishing needs a resolved incident and a confirmed review.
    assert.equal((await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, context: CONTEXT })).status, 200);
    assert.equal((await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, publish: true, reviewed: true })).status, 409);
    await req('PATCH', `/admin/clusters/${id}`, { status: 'resolved' });
    assert.equal((await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, publish: true })).status, 400);
    const blocked = await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, body: `${GOOD.body}\n\nThanks to Mark Santos for the tip.`, publish: true, reviewed: true });
    assert.equal(blocked.status, 422);
    assert.ok(blocked.body.issues.length);
    assert.equal((await req('GET', '/feed')).body.notices.filter((n) => n.kind === 'article').length, 0, 'drafts stay private');

    const pub = await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, context: CONTEXT, publish: true, reviewed: true });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.article.status, 'published');

    const notices = (await req('GET', '/feed')).body.notices;
    const article = notices.find((n) => n.kind === 'article');
    assert.equal(article.headline, GOOD.headline);
    assert.equal(article.article.length, 3);
    assert.ok(!JSON.stringify(notices).includes('October 8'), 'counselor context never reaches students');
    assert.ok(!notices.some((n) => n.kind === 'notice' && n.category === 'Campus Safety' && n.location === 'Gym'), 'the article replaces the automatic notice');

    const overview = await req('GET', '/admin/overview');
    assert.equal(overview.body.clusters.find((c) => c.id === id).article.context, CONTEXT);

    // A new report reopens the incident and hides the "addressed" article until it is resolved again.
    await submitPost(db, { authorToken: reporter(3), useLlm: false, category: 'Campus Safety', location_tag: 'Gym', narrative: 'The gym fan is wobbling again today during PE class.', now: now + 1000 });
    assert.ok(!(await req('GET', '/feed')).body.notices.some((n) => n.kind === 'article'));
  });
});

test('wellbeing incidents never get a public article', async () => {
  await withApp(async ({ db, req }) => {
    const c = await db.insert(`INSERT INTO incident_clusters (cluster_title, incident_type, location_tag, report_count, first_reported_at, last_reported_at, status)
                               VALUES ('Library Wellbeing', 'Mental Health', 'Library', 2, ?, ?, 'resolved')`, [new Date().toISOString(), new Date().toISOString()]);
    assert.equal((await req('POST', `/admin/clusters/${c}/article/draft`, { context: CONTEXT })).status, 403);
    assert.equal((await req('PUT', `/admin/clusters/${c}/article`, { ...GOOD, publish: true, reviewed: true })).status, 403);
  });
});
