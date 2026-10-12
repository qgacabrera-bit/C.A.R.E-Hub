import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { articleIssues, draftArticle, bylineText, bylineStyleFor, cleanAuthorName } from '../src/articles.js';
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
    await fn({ db, req, base });
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

    const unsigned = await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, context: CONTEXT, publish: true, reviewed: true });
    assert.equal(unsigned.status, 422, 'publishing needs a byline name');
    assert.ok(unsigned.body.issues.some((i) => /name for the byline/.test(i)));

    const pub = await req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, context: CONTEXT, author_name: 'Ms. Reyes', publish: true, reviewed: true });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.article.status, 'published');

    const notices = (await req('GET', '/feed')).body.notices;
    const article = notices.find((n) => n.kind === 'article');
    assert.equal(article.headline, GOOD.headline);
    assert.equal(article.article.length, 3);
    assert.equal(article.byline, 'Written by Ms. Reyes');
    assert.equal(article.picture_preset, 'shield', "a new article starts with its topic's illustration");
    assert.equal(article.picture_url, null);
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

test('bylines credit the counselor, and Kali when she helped', () => {
  assert.equal(bylineStyleFor('counselor', 'kali_led'), 'counselor');
  assert.equal(bylineStyleFor('ai'), 'kali_led');
  assert.equal(bylineStyleFor('ai', 'counselor_led'), 'counselor_led');
  assert.equal(bylineStyleFor('template', 'kali_led'), 'counselor_led', 'the offline template is only a starting point');
  assert.equal(bylineText({ author_name: 'Ms. Reyes', byline_style: 'kali_led' }), 'Written by Kali, with the guidance of Ms. Reyes');
  assert.equal(bylineText({ author_name: 'Ms. Reyes', byline_style: 'counselor_led' }), 'Written by Ms. Reyes, with the help of Kali');
  assert.equal(bylineText({ author_name: '', byline_style: 'counselor' }), 'Reviewed and published by student welfare services');
  assert.equal(cleanAuthorName('  Mr.   Dela  Cruz '), 'Mr. Dela Cruz');
  assert.equal(cleanAuthorName('<script>'), '');
  assert.equal(cleanAuthorName('09171234567'), '');
});

// 1x1 PNG with a tEXt chunk, which must be stripped before the picture is stored.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const textChunk = (() => {
  const data = Buffer.from('Author\0Mark Santos');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'ascii');
  data.copy(chunk, 8);
  return chunk; // CRC left as zeros: the stripper drops the chunk without reading it
})();
const PNG_WITH_TEXT = Buffer.concat([PNG.subarray(0, 33), textChunk, PNG.subarray(33)]);

test('article pictures: uploads are cleaned and only public while the article is', async () => {
  await withApp(async ({ db, req, base: api }) => {
    const now = Date.now();
    await submitPost(db, { authorToken: reporter(4), useLlm: false, category: 'Bullying', location_tag: 'Cafeteria', narrative: 'Some students keep mocking younger kids at lunch in the cafeteria.', now: now - 864e5 });
    const r = await submitPost(db, { authorToken: reporter(5), useLlm: false, category: 'Bullying', location_tag: 'Cafeteria', narrative: 'Younger students get teased at lunch every day in the cafeteria.', now });
    const id = r.cluster.id;
    await req('PATCH', `/admin/clusters/${id}`, { status: 'resolved' });
    const save = (extra) => req('PUT', `/admin/clusters/${id}/article`, { ...GOOD, context: CONTEXT, author_name: 'Ms. Reyes', source: 'ai', byline_style: 'counselor_led', ...extra });

    // Kali's pictures can only be saved by the token the server handed out.
    assert.equal((await save({ picture: { kind: 'ai', token: 'made-up' } })).status, 410);
    assert.equal((await save({ picture: { kind: 'upload', data: 'data:image/gif;base64,R0lGOD' } })).status, 400);

    const saved = await save({ picture: { kind: 'upload', data: `data:image/png;base64,${PNG_WITH_TEXT.toString('base64')}` } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.article.picture.kind, 'upload');
    assert.equal(saved.body.article.byline, 'Written by Ms. Reyes, with the help of Kali');
    const stored = await db.get('SELECT picture_data FROM incident_articles WHERE cluster_id = ?', [id]);
    assert.ok(!Buffer.from(stored.picture_data).includes('Mark Santos'), 'picture metadata is stripped');

    // A save without a picture keeps the saved one.
    assert.equal((await save({})).body.article.picture.kind, 'upload');

    const { id: articleId } = await db.get('SELECT id FROM incident_articles WHERE cluster_id = ?', [id]);
    const base = `/updates/pictures/${articleId}`;
    const pictureStatus = async () => (await fetch(api + base)).status;
    assert.equal(await pictureStatus(), 404, 'a draft picture is not public');
    const feedArticle = async () => (await req('GET', '/feed')).body.notices.find((n) => n.kind === 'article');
    assert.equal(await feedArticle(), undefined, 'drafts are not public');

    await save({ publish: true, reviewed: true });
    const article = await feedArticle();
    assert.ok(article.picture_url.startsWith(`/api${base}?v=`), article.picture_url);
    assert.equal(article.picture_by_kali, false);
    assert.equal(article.byline, 'Written by Ms. Reyes, with the help of Kali');
    assert.equal(await pictureStatus(), 200);

    // Switching to a preset removes the stored picture.
    await save({ picture: { kind: 'preset', preset: 'heart' }, publish: true, reviewed: true });
    const after = await feedArticle();
    assert.equal(after.picture_preset, 'heart');
    assert.equal(after.picture_url, null);
    assert.equal((await db.get('SELECT picture_data FROM incident_articles WHERE cluster_id = ?', [id])).picture_data, null);
  });
});
