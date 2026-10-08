import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { scrubText, containsGuiltLanguage } from '../src/pipeline/scrubber.js';
import { scoreSeverity } from '../src/pipeline/severity.js';
import { rankSimilar } from '../src/pipeline/similarity.js';
import { submitPost, authorTokenFromSecret, buildSummary, parseAttachment } from '../src/pipeline/ingest.js';
import { adviserReply, buildReportDraft } from '../src/adviser.js';
import { normalizeLocation } from '../src/pipeline/location.js';

const token = (n) => authorTokenFromSecret(`test-secret-${n}-xxxxxxxxxxxxxxxx`);
const post = (db, overrides) => submitPost(db, { authorToken: token(1), useLlm: false, ...overrides });

test('scrubber reproduces the spec example redactions', () => {
  const r = scrubText('Mark Santos and his clique from 3-B are sharing non-consensual photos of John Doe in our group chat and calling him names every afternoon during chemistry lab.');
  assert.match(r.text, /^\[Student Group A\] from \[Section\]/); // sections narrow it to a few students
  assert.match(r.text, /photos of \[Student B\]/);
  assert.doesNotMatch(r.text, /Mark|Santos|John|Doe/);
});

test('scrubber removes contact details, IDs, handles, faculty names and surname-only mentions', () => {
  const r = scrubText('Ms. Reyes saw it. Bea Lopez texted 0917 123 4567 and bea@mail.com, IG @bea.lopez, ID 2021-10432. Later Lopez laughed.');
  for (const leaked of ['Reyes', 'Bea', 'Lopez', '0917', 'bea@mail.com', '@bea', '2021-10432']) assert.ok(!r.text.includes(leaked), `leaked ${leaked}: ${r.text}`);
  assert.match(r.text, /\[Faculty Member\]/);
  assert.match(r.text, /\[Phone Removed\]/);
  assert.match(r.text, /\[Social Handle\]/);
  assert.match(r.text, /\[Student ID Removed\]/);
});

test('scrubber keeps possessives and does not redact campus places', () => {
  const r = scrubText("I get anxious in Mr. Cruz's class near the Science Lab on Monday.");
  assert.match(r.text, /\[Faculty Member\]'s class near the Science Lab on Monday/);
});

test('guilt and punitive language is neutralized', () => {
  const r = scrubText('Paolo Reyes is a total predator and should be expelled.');
  assert.ok(r.defamationNeutralized);
  assert.doesNotMatch(r.text, /predator|expelled/);
});

test('retaliation language is detected', () => {
  assert.ok(scrubText("Let's expose him and everyone go spam his account.").retaliation);
  assert.ok(!scrubText('They posted my photo in the group chat without asking.').retaliation);
});

test('severity: crisis, high, and low cases', () => {
  assert.equal(scoreSeverity('I want to end my life').score, 5);
  assert.ok(scoreSeverity('I want to end my life').crisis);
  assert.equal(scoreSeverity('They are sharing non-consensual photos of a classmate').score, 4);
  assert.equal(scoreSeverity('some light teasing at lunch').score, 2);
  assert.equal(scoreSeverity('they shoved me in the hallway every day').score, 4); // repeated physical -> systemic
  assert.equal(scoreSeverity('general question about the library', { clusterSize: 5 }).score, 4);
  assert.equal(scoreSeverity('she says she will hurt me after class').score, 4); // plain-language threat
  assert.equal(scoreSeverity("they're gonna jump him at dismissal").score, 4);
  assert.equal(scoreSeverity('someone posted edited pics of me').score, 3);
});

test('similarity ranks near-duplicates above unrelated text', () => {
  const ranked = rankSimilar('Students are sharing edited photos in the section group chat to mock a classmate', [
    { id: 1, text: 'Someone is sharing edited photos in our section group chat to mock a classmate' },
    { id: 2, text: 'The library aircon is broken again' },
  ]);
  assert.equal(ranked[0].id, 1);
  assert.ok(ranked[0].score > 0.8, `score ${ranked[0].score}`);
  assert.ok(ranked[1].score < 0.2);
});

test('end-to-end: high-severity post bypasses the feed, clusters, and escalates', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  await post(db, { category: 'Cyberbullying', location_tag: 'Online Section Chat', narrative: 'Teasing and photo sharing reported in Chem lab group chat, people laughing at a classmate.', now: now - 2 * 864e5 });
  const r = await post(db, {
    authorToken: token(2),
    category: 'Cyberbullying',
    location_tag: 'Online Section Chat',
    narrative: 'Mark Santos and his clique from 3-B are sharing non-consensual photos of John Doe in our group chat and calling him names every afternoon during chemistry lab.',
    now,
  });
  assert.equal(r.status, 'flagged_admin');
  assert.equal(r.severity_score, 4);
  assert.ok(r.cluster, 'linked to a cluster');
  assert.equal(r.cluster.report_count, 2);

  const stored = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.post_id);
  assert.equal(stored.raw_content, null, 'raw narrative purged');
  assert.doesNotMatch(stored.sanitized_content, /Mark|Santos|John|Doe/);

  const esc = db.prepare('SELECT * FROM escalations WHERE post_id = ?').get(r.post_id);
  assert.ok(esc);
  assert.ok(!containsGuiltLanguage(esc.summary_brief));
  assert.match(esc.summary_brief, /Pending counselor review/);
});

test('end-to-end: same type + zone within 7 days clusters; outside the window does not', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  await post(db, { category: 'Campus Safety', location_tag: 'Gym', narrative: 'The gym floor near the bleachers is wet and slippery after rain.', now: now - 10 * 864e5 });
  const a = await post(db, { category: 'Campus Safety', location_tag: 'Gym', narrative: 'Basketball hoop backboard in the gym looks cracked and unstable.', now: now - 864e5 });
  assert.equal(a.cluster, null, 'previous report is outside the 7-day window');
  const b = await post(db, { category: 'Campus Safety', location_tag: 'Gym', narrative: 'One of the gym ceiling fans is wobbling a lot during PE.', now });
  assert.ok(b.cluster);
  assert.equal(b.cluster.match_reason, 'type_location_window');
});

test('end-to-end: retaliation posts are held for moderation, not published', async () => {
  const db = openDb(':memory:');
  const r = await post(db, { category: 'Bullying', location_tag: 'Cafeteria', narrative: "Let's expose the kids who bully people in the cafeteria, everyone go spam their accounts." });
  assert.equal(r.status, 'pending_moderation');
});

test('end-to-end: personal crisis reports are escalated but never clustered', async () => {
  const db = openDb(':memory:');
  await post(db, { category: 'Mental Health', location_tag: 'Library', narrative: 'Exams are stressful, studying in the library helps me a bit.' });
  const r = await post(db, { authorToken: token(3), category: 'Mental Health', location_tag: 'Library', narrative: 'I feel hopeless and sometimes I want to end my life.' });
  assert.equal(r.status, 'flagged_admin');
  assert.equal(r.severity_score, 5);
  assert.ok(r.crisis);
  assert.equal(r.cluster, null);
});

test('cluster titles drop "Pattern", old titles are migrated, and students are counted once', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  await post(db, { category: 'Bullying', location_tag: 'Cafeteria', narrative: 'Some students keep taking seats from others at lunch time.', now: now - 864e5 });
  await post(db, { category: 'Bullying', location_tag: 'Cafeteria', narrative: 'People throw food at the younger students during lunch.', now: now - 3600e3 });
  const r = await post(db, { authorToken: token(9), category: 'Bullying', location_tag: 'Cafeteria', narrative: 'A group blocks the cafeteria line and pushes the younger kids.', now });
  assert.equal(r.cluster.title, 'Cafeteria Bullying');
  assert.equal(r.cluster.report_count, 3);
  assert.equal(r.cluster.student_count, 2); // token(1) posted twice


  // A database from an older version gets its titles cleaned up when it is opened.
  const file = path.join(os.tmpdir(), `care-migrate-${process.pid}-${Date.now()}.db`);
  const legacy = openDb(file);
  legacy.exec(`INSERT INTO incident_clusters (cluster_title, incident_type, location_tag, report_count, first_reported_at, last_reported_at)
               VALUES ('Gym Peer Pressure Pattern', 'Peer Pressure', 'Gym', 2, '2026-01-01', '2026-01-02')`);
  legacy.close();
  const reopened = openDb(file);
  assert.equal(reopened.prepare('SELECT cluster_title FROM incident_clusters').get().cluster_title, 'Gym Peer Pressure');
  reopened.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
});

test('validation rejects unknown categories and short narratives', async () => {
  const db = openDb(':memory:');
  await assert.rejects(post(db, { category: 'Gossip', location_tag: 'Gym', narrative: 'x'.repeat(40) }), /category/);
  await assert.rejects(post(db, { category: 'Bullying', location_tag: 'Gym', narrative: 'too short' }), /20 characters/);
});

test('free-text locations normalize to zones and never carry names', async () => {
  assert.equal(normalizeLocation('chem lab'), 'Science Lab');
  assert.equal(normalizeLocation('  the Canteen '), 'Cafeteria');
  assert.equal(normalizeLocation('GC'), 'Online Section Chat');
  assert.equal(normalizeLocation('Computer Room 204'), 'Computer Room 204');
  assert.doesNotMatch(normalizeLocation("Mr. Cruz's room"), /Cruz/);
  assert.equal(normalizeLocation(' '), null);

  const db = openDb(':memory:');
  const r = await post(db, { category: 'Campus Safety', location_tag: 'canteen', narrative: 'The canteen floor is slippery near the sink area every lunch.' });
  assert.equal(db.prepare('SELECT location_tag FROM posts WHERE id = ?').get(r.post_id).location_tag, 'Cafeteria');
  await assert.rejects(post(db, { category: 'Bullying', location_tag: 'Gym', narrative: 'x'.repeat(3001) }), /3,000/);
});

test('summaries never contain guilt language', () => {
  const s = buildSummary({ category: 'Bullying', location: 'Gym', score: 4, indicators: ['physical contact'], cluster: null, crisis: false });
  assert.ok(!containsGuiltLanguage(s));
});

test('attachments: only JPEG/PNG, EXIF stripped', () => {
  // Minimal JPEG: SOI, APP1 (EXIF) segment, SOS, EOI.
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9])]);
  const parsed = parseAttachment(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.ok(!parsed.data.includes(Buffer.from('Exif')));
  assert.throws(() => parseAttachment('data:application/pdf;base64,AAAA'), /JPEG or PNG/);
});

test('adviser (offline) surfaces crisis resources and drafts reports without names', async () => {
  const crisis = await adviserReply([{ role: 'user', content: 'i want to kill myself' }], { useLlm: false });
  assert.ok(crisis.crisis);
  assert.match(crisis.reply, /1553/);
  const draft = await buildReportDraft([{ role: 'user', content: 'Paolo Mendoza keeps pressuring me to vape in the gym after PE' }], { useLlm: false });
  assert.equal(draft.category, 'Peer Pressure');
  assert.equal(draft.location_tag, 'Gym');
  assert.doesNotMatch(draft.narrative, /Paolo|Mendoza/);
});
