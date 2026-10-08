import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scrub, detectRetaliation, scrubText } from '../src/pipeline/scrubber.js';

test('scrub() returns { text, counts, totalRedactions, flags }', () => {
  const r = scrub('Ms. Reyes saw Bea Lopez text 0917 123 4567 and email bea@mail.com, IG @bea.lopez, ID 2021-10432, link https://fb.com/x, from Section 3-B.');
  assert.deepEqual(Object.keys(r).sort(), ['counts', 'flags', 'text', 'totalRedactions']);
  assert.deepEqual(Object.keys(r.counts).sort(), ['accusation', 'email', 'faculty_name', 'handle', 'judgment', 'link', 'person_name', 'phone', 'section', 'student_id'].sort());
  assert.equal(r.counts.faculty_name, 1);
  assert.equal(r.counts.person_name, 1);
  for (const type of ['phone', 'email', 'handle', 'student_id', 'link', 'section']) assert.equal(r.counts[type], 1, type);
  assert.equal(r.totalRedactions, Object.values(r.counts).reduce((a, b) => a + b, 0));
  assert.deepEqual(r.flags, { defamation: false, retaliation: false });
});

test('words inside tags are never re-scanned as names', () => {
  const r = scrub('Text me at 0917 123 4567. They removed my bag. Email me at a@b.co, link www.x.com was removed too.');
  assert.match(r.text, /They removed my bag/);
  assert.match(r.text, /was removed too/);
  assert.equal(r.counts.person_name, 0);
});

test('group phrase becomes [Student Group A] without rewriting solo mentions', () => {
  const r = scrub('Mark Santos and his clique from 3-B keep teasing me. Yesterday Santos pushed me.');
  assert.equal(r.text, '[Student Group A] from [Section] keep teasing me. Yesterday [Student A] pushed me.');
});

test('casual lowercase first names are caught; everyday words are not', () => {
  assert.equal(scrub('me and bea were in the lab with will and grace').text, 'me and [Student A] were in the lab with will and grace');
  assert.match(scrub('Mark Santos laughed at me. You can mark my words.').text, /mark my words/);
});

test('sections are redacted; place names that contain "section" are not', () => {
  const r = scrub('It happens in Section 3-B, sec 11-Rizal, section Sampaguita and 7-A, and in the Online Section Chat.');
  assert.equal(r.counts.section, 4);
  assert.match(r.text, /Online Section Chat/);
  assert.equal(scrub('section 3 because nobody helps').text, '[Section] because nobody helps');
});

test('Filipino honorific and classroom cues mark names', () => {
  assert.equal(scrub('kuya Migs and my seatmate Jerome laughed. si ate Liza saw it but we ate Jollibee after.').text,
    'kuya [Student A] and my seatmate [Student B] laughed. si ate [Student C] saw it but we ate Jollibee after.');
  assert.equal(scrub('teacher Ana and coach Ramos ignored it.').text, '[Faculty Member A] and [Faculty Member B] ignored it.');
  assert.equal(scrub('my classmate keeps teasing me').counts.person_name, 0);
});

test('accusations and judgments are rewritten and flagged', () => {
  const r = scrub('Paolo Reyes is a total predator and should be expelled.');
  assert.equal(r.text, '[Student A] is [characterization removed] and [judgment removed].');
  assert.equal(r.counts.accusation, 1);
  assert.equal(r.counts.judgment, 1);
  assert.equal(r.flags.defamation, true);
});

test('re-scrubbing tagged text keeps tags and continues the lettering', () => {
  const once = scrub('Mark Santos teased me. Ms. Reyes saw it.').text;
  const twice = scrub(`${once} Then Bea Cruz and Mr. Lim joined in.`).text;
  assert.equal(twice, '[Student A] teased me. [Faculty Member] saw it. Then [Student B] and [Faculty Member B] joined in.');
});

test('detectRetaliation is a fast boolean pre-check', () => {
  assert.equal(detectRetaliation("Let's expose him, everyone go spam his account."), true);
  assert.equal(detectRetaliation('They posted my photo in the group chat without asking.'), false);
  assert.equal(scrub("Let's expose him").flags.retaliation, true);
});

test('scrubText keeps the fields the ingest pipeline relies on', () => {
  const r = scrubText('Ms. Reyes saw Bea Lopez post my number 0917 123 4567. Bea is a creep.');
  for (const key of ['text', 'counts', 'totalRedactions', 'flags', 'redactionCount', 'residualIdentifiers', 'notes', 'knownSurfaces', 'retaliation', 'defamationNeutralized']) {
    assert.ok(key in r, key);
  }
  assert.equal(r.redactionCount, r.totalRedactions - r.counts.accusation - r.counts.judgment); // identifiers only
  assert.ok(r.knownSurfaces.includes('Bea Lopez'));
});

test('CommonJS callers can require() the module (Node 22.12+ require(esm))', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../src/pipeline/scrubber.js');
  assert.equal(typeof cjs.scrub, 'function');
  assert.equal(typeof cjs.detectRetaliation, 'function');
  assert.equal(cjs.scrub('call 0917 123 4567').text, 'call [Phone Removed]');
});
