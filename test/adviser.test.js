import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/db.js';
import { offlineReply } from '../src/adviserEngine.js';
import { adviserReply, buildReportDraft } from '../src/adviser.js';
import { publicRouter } from '../src/routes/public.js';
import { submitPost, authorTokenFromSecret } from '../src/pipeline/ingest.js';

const user = (content) => ({ role: 'user', content });
const intentOf = (text) => offlineReply([user(text)]).intent;

test('offline adviser recognizes topics in English and Taglish', () => {
  const cases = {
    'they keep posting edited pics of me in the gc': 'cyberbullying',
    'binubully ako ng mga classmates ko': 'verbal_social',
    'tinulak ako sa hallway kanina': 'physical',
    'my barkada keeps pressuring me to vape': 'peer_pressure',
    'sir keeps humiliating me in front of the class': 'teacher',
    'the railing on the stairs is broken': 'campus_safety',
    'i feel so alone lately': 'sad_lonely',
    'finals are next week and i am so stressed': 'stress',
    'kinakabahan ako, my heart is racing': 'anxiety',
    'will anyone know it was me if i report?': 'privacy',
    'i want to get back at them and expose them': 'retaliation',
    'are you a bot?': 'about_bot',
    'hello po': 'greeting',
    'salamat': 'thanks',
    'Something happened at school': 'opener',
    'may nangyari sa school': 'opener',
  };
  for (const [text, expected] of Object.entries(cases)) assert.equal(intentOf(text), expected, text);
});

test('safety topics win and are flagged as crisis', () => {
  for (const text of ['gusto ko nang mamatay', 'i want to end my life', 'my dad hits me when he is drunk', 'he has a knife and said he is going to hurt me']) {
    const r = offlineReply([user(text)]);
    assert.ok(r.crisis, text);
    assert.ok(r.suggestions.some((s) => s.action === 'call' || s.action === 'private_report'), text);
  }
});

test('priority resolves overlapping keywords', () => {
  assert.equal(intentOf('they pressure me to copy my homework every day'), 'peer_pressure');
  assert.equal(intentOf('the smoke alarm in the gym is broken'), 'campus_safety');
  assert.equal(intentOf('i have an online class and too much homework'), 'stress');
});

test('short answers follow up on what she just offered', () => {
  const offered = (offer) => [user('they keep daring me to vape'), { role: 'assistant', content: 'x', offer }];
  assert.equal(offlineReply([...offered('scripts'), user('oo')]).intent, 'follow_up:scripts');
  assert.equal(offlineReply([...offered('grounding'), user('yes please')]).intent, 'follow_up:grounding');
  assert.equal(offlineReply([...offered('report_options'), user('sige')]).intent, 'follow_up:report_options');
  assert.equal(offlineReply([...offered('scripts'), user('not now')]).intent, 'decline');
  // A crisis message is never swallowed by a pending "yes".
  assert.ok(offlineReply([...offered('scripts'), user('ayoko nang mabuhay')]).crisis);
});

test('incidents offer private and anonymous report options; replies vary', async () => {
  const r = await adviserReply([user('people keep laughing at me and calling me names')], { useLlm: false });
  assert.equal(r.offer, 'report_options');
  assert.deepEqual(r.suggestions.slice(0, 2).map((s) => s.action), ['private_report', 'draft_post']);
  const first = offlineReply([user('i feel so alone')]).reply;
  const second = offlineReply([user('i feel so alone'), { role: 'assistant', content: first }, user('i am still so lonely')]).reply;
  assert.notEqual(first, second);
});

test('offline draft skips small talk and uses the discussed topic', async () => {
  const draft = await buildReportDraft([
    user('hi'), { role: 'assistant', content: 'Hi!' },
    user('Something happened at school'), { role: 'assistant', content: 'Tell me' },
    user('someone made a fake account with edited photos of me'), { role: 'assistant', content: 'Sorry' },
    user('will anyone know it was me?'),
  ], { useLlm: false });
  assert.equal(draft.category, 'Cyberbullying');
  assert.match(draft.narrative, /fake account/);
  assert.doesNotMatch(draft.narrative, /^hi\b|will anyone know|something happened/i);
});

// ---------------------------------------------------------------------------------------------
// Private reports over HTTP
// ---------------------------------------------------------------------------------------------
async function withServer(fn) {
  const db = openDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api', publicRouter(db));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (path, headers = {}) => fetch(base + path, { headers }).then((r) => r.json());
  try {
    await fn({ db, post, get });
  } finally {
    server.close();
  }
}

const SECRET = 'private-report-test-secret-0123456789';

test('private reports go to counselors only and never appear publicly', async () => {
  await withServer(async ({ db, post, get }) => {
    const narrative = 'Some students in the cafeteria keep taking my food and laughing at me every lunch.';
    const r = await post('/adviser/private-report', { secret: SECRET, category: 'Bullying', location_tag: 'canteen', narrative });
    assert.equal(r.status, 201);

    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.body.post_id);
    assert.equal(row.visibility, 'private');
    assert.equal(row.status, 'flagged_admin');
    assert.equal(row.location_tag, 'Cafeteria');
    const esc = db.prepare('SELECT * FROM escalations WHERE post_id = ?').get(row.id);
    assert.match(esc.summary_brief, /Sent privately through the C\.A\.R\.E\. Adviser/);

    const feed = await get('/feed');
    assert.ok(!feed.posts.some((p) => p.id === row.id));
    assert.ok(!feed.notices.some((n) => n.location === 'Cafeteria'), 'private reports never feed public notices');

    const mine = await post('/my-posts', { secret: SECRET });
    assert.equal(mine.body.posts.length, 1);
    assert.match(mine.body.posts[0].follow_up, /Sent privately to counselors/);
    assert.equal(mine.body.posts[0].pattern, null);
  });
});

test('unlinked private reports cannot be traced back to the student', async () => {
  await withServer(async ({ db, post }) => {
    const r = await post('/adviser/private-report', { secret: SECRET, unlinked: true, category: 'Peer Pressure', location_tag: 'Gym', narrative: 'A group in the gym keeps pressuring younger students to vape after PE.' });
    assert.equal(r.status, 201);
    assert.equal(r.body.post_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE visibility = 'private'").get().n, 1);
    const token = authorTokenFromSecret(SECRET);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE anonymous_author_token = ?').get(token).n, 0);
    const mine = await post('/my-posts', { secret: SECRET });
    assert.equal(mine.body.posts.length, 0);
  });
});

test('public "students shared this" counts ignore private reports', async () => {
  await withServer(async ({ db, post, get }) => {
    const now = Date.now();
    await submitPost(db, { authorToken: authorTokenFromSecret('public-a-0123456789abcdef'), category: 'Bullying', location_tag: 'Library', narrative: 'Some students keep mocking others in the library every day.', now: now - 3600e3, useLlm: false });
    await post('/adviser/private-report', { secret: SECRET, category: 'Bullying', location_tag: 'Library', narrative: 'People keep mocking me in the library and hiding my bag.' });
    await submitPost(db, { authorToken: authorTokenFromSecret('public-b-0123456789abcdef'), category: 'Bullying', location_tag: 'Library', narrative: 'Students in the library keep laughing at the younger kids.', now, useLlm: false });
    const feed = await get('/feed');
    const clustered = feed.posts.find((p) => p.pattern);
    assert.equal(clustered.pattern.student_count, 2); // the private reporter is not counted publicly
  });
});

// ---------------------------------------------------------------------------------------------
// Support pathways policy
// ---------------------------------------------------------------------------------------------
import { ensureFormalChannels } from '../src/adviserEngine.js';
import { adminRouter } from '../src/routes/admin.js';
import { config } from '../src/config.js';

const namesAllFormalChannels = (reply) =>
  /guidance/i.test(reply) && /\b911\b|campus security|vawc/i.test(reply) && /\b1553\b/.test(reply);

test('serious concerns always point to Guidance, an authority and the crisis hotline', () => {
  const serious = [
    'gusto ko nang mamatay', 'he has a knife and said he is going to hurt me', 'my dad hits me when he is drunk',
    'someone groped me in the hallway', 'they posted my nudes in the gc', 'someone punched me after class',
    'sir keeps humiliating me in front of everyone', 'they said they will beat me up after class',
  ];
  for (const text of serious) {
    const r = offlineReply([user(text)]);
    assert.ok(r.serious, text);
    assert.ok(namesAllFormalChannels(r.reply), `missing a formal channel: ${text}`);
    assert.ok(!r.suggestions.some((s) => /who else/i.test(s.label)), `no local-only suggestion for: ${text}`);
  }
});

test('AI replies to serious concerns get the formal channels added if missing', () => {
  const fixed = ensureFormalChannels('That sounds really scary. I am here for you.');
  assert.ok(namesAllFormalChannels(fixed));
  const complete = 'Please tell your Guidance Office, call 911 if you are in danger, or the NCMH line 1553.';
  assert.equal(ensureFormalChannels(complete), complete);
});

test('low-severity concerns may add local support, never instead of Guidance', () => {
  const r = offlineReply([user('people keep laughing at me and calling me names')]);
  assert.equal(r.serious, false);
  assert.ok(r.suggestions.some((s) => s.label === 'Who else can I talk to?'));
  const local = offlineReply([user('who else can I talk to?')]);
  assert.match(local.reply, /class adviser/i);
  assert.match(local.reply, /student council/i);
  assert.match(local.reply, /Guidance Office/);
  assert.match(local.reply, /not instead of/i);
  // After a serious topic, the same question leads with the formal channels.
  const afterSerious = offlineReply([user('someone groped me in the hallway'), { role: 'assistant', content: 'x' }, user('who else can I talk to?')]);
  assert.ok(afterSerious.serious);
  assert.ok(namesAllFormalChannels(afterSerious.reply));
});

test('every concern, including ordinary published posts, reaches the counselor portal', async () => {
  const db = openDb(':memory:');
  const published = await submitPost(db, { authorToken: authorTokenFromSecret('portal-test-0123456789abcdef'), category: 'Campus Safety', location_tag: 'Library', narrative: 'The library stairs are slippery when it rains.', useLlm: false });
  assert.equal(published.status, 'published');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter(db));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    const { token } = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: config.adminPasscode }) }).then((r) => r.json());
    const overview = await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const row = overview.allReports.find((p) => p.id === published.post_id);
    assert.ok(row, 'published post is listed for counselors');
    assert.equal(row.status, 'published');
    assert.match(row.content, /slippery/);
  } finally {
    server.close();
  }
});
