// Deterministic PII & defamation scrubber.
//
// This layer always runs - with or without Claude - and it re-checks Claude's output, so a model
// mistake can never re-introduce an identifier that the rules already know about.
//
// Public API
//   scrub(input)            -> { text, counts, totalRedactions, flags: { defamation, retaliation } }
//   detectRetaliation(text) -> boolean (fast pre-check for chat and preview routes)
//   scrubText(input)        -> scrub()'s result plus the fields the ingest pipeline relies on
//                              (redactionCount, residualIdentifiers, notes, knownSurfaces, ...)
//
// This file is an ES module (package.json "type": "module"). CommonJS code can still load it with
// `const { scrub, detectRetaliation } = require('./scrubber.js')` on Node 22.12+ (require(esm)).
//
// How it avoids corrupting its own output: every redaction is first stored as an opaque placeholder
// (private-use characters <n>) and only turned into its visible [Tag] at the very end.
// Later passes therefore never see words inside tags - e.g. "Removed" in "[Phone Removed]" can
// never be mistaken for a name.

// Synthetic-friendly list of common first names (English + Filipino). Used to catch single-name
// mentions ("Bea keeps posting...") that the multi-word heuristic cannot see.
const FIRST_NAMES = new Set(`
aaron abby adrian aiden aira alex alexa alexis alice allan althea alyssa amanda amber ana andrea andrew angel angela
angelica angelo anna anne annie anthony antonio aria ariel arnold arvin ashley audrey bea bella ben benjamin bianca
bobby brandon brian bryan camille carl carla carlo carlos carmela caroline cathy charles charlie chloe chris christian
christine claire clarisse daniel danica danielle darren david dennis diana diego dominic dylan edward eliza elijah ella
emily emma eric erica ethan faith francis gabriel gab gela gino grace hannah harold henry ian isaac isabel isabella
ivan jack jacob jade jake james jamie jane janelle janine jasmine jason javier jay jayden jean jenny jericho jerome
jess jessica jillian joan joanna joel john johnny jomar jonathan jose joseph josh joshua joy juan julia julian justin
karen karl kate katherine katrina kayla kevin kim kristine kyle lance lara laura lea leo liam lily lorenzo louise lucas
luis luke mae maria mark marco mariel marie mario martin mary matt matthew max maxine mia michael michelle miguel mika
mikee miles nathan nathaniel nicole nico noah olivia oliver patrick paolo patricia paul paula pia rachel rafael ralph
raymond rebecca renz rica richard rico rob robert robin rose ryan sam samantha sarah sean sofia sophia stephanie steven
tina thomas trisha troy vanessa vince vincent wendy william yna ysabel zach zoe
`.trim().split(/\s+/));

// Capitalized words that are not people: campus places, subjects, apps, calendar words, sentence
// starters. Anything here is never treated as a name.
const STOPWORDS = new Set(`
a an the i i'm im i've ive i'd id i'll ill we they he she it my our your their his her its this that these those there
then when while after before during yesterday today tonight tomorrow last next every some someone somebody everyone
everybody nobody people students student classmates classmate teachers teacher faculty admin staff guard guards security
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
october november december
science chemistry chem physics biology bio math mathematics english filipino history araling panlipunan values pe mapeh
ict tle research lab laboratory hallway floor gym gymnasium cafeteria canteen library restroom restrooms cr comfort room
room classroom building hall gate parking field grounds campus school bus commute jeep jeepney main north south east west
grade section block batch year level senior junior high college department office clinic guidance counseling council
online chat group gc discord messenger facebook fb instagram ig tiktok twitter x youtube snapchat telegram viber
whatsapp google classroom zoom meet reddit roblox valorant mobile legends ml
also and but or so because if please help hello hi hey sorry thanks thank okay ok yes no not just still even again
what why how who where which really very maybe anyway anyone everything nothing something
first second third fourth 1st 2nd 3rd 4th upper lower old new
`.trim().split(/\s+/));

// First names that are also everyday English words: never redacted when typed in lowercase.
const LOWERCASE_AMBIGUOUS = new Set(`
mark joy grace faith rose lily amber angel jade jack max may will bobby hannah sam kim jean robin pia mae gab ana
ella mia lea luke sean art bill dawn eve hope ivy june sky star rob ian carl paul`.trim().split(/\s+/));

const NAME_PARTICLES = new Set(['de', 'del', 'dela', 'delos', 'los', 'la', 'van', 'von', 'da', 'di']);

const NAME_TOKEN = String.raw`[A-Z][a-zA-Z-]*(?:'(?!s\b)[a-zA-Z]+)?`; // allows O'Brien, never a possessive 's
const ANY_CASE_TOKEN = String.raw`[A-Za-z][a-zA-Z-]*(?:'(?!s\b)[a-zA-Z]+)?`;
const TITLE_RE = new RegExp(String.raw`\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Ma'?am|Madam|Teacher|Coach|Principal|Dean|Engr|Atty)\.?\s+(${NAME_TOKEN}(?:\s+(?:(?:de|del|dela|delos|la)\s+)?${NAME_TOKEN})?)`, 'g');
const CAP_SPAN_RE = new RegExp(String.raw`\b${NAME_TOKEN}(?:\s+(?:(?:de|del|dela|delos|los|la|van|von|da|di)\s+)?${NAME_TOKEN}){0,3}`, 'g');

// Relational cues that are usually followed by a person: Filipino honorifics and classroom roles.
// "kuya Migs", "ate Bea", "my seatmate Jerome" -> the name is a student; "teacher Ana", "coach Reyes"
// (lowercase - capitalized titles are covered by TITLE_RE) -> faculty.
const STUDENT_CUES = 'kuya|ate|seatmate|classmate|groupmate|blockmate|batchmate|crush|bestfriend|best friend|bff';
const FACULTY_CUES = 'teacher|coach|sir|ma\'?am';
const CUE_RE = new RegExp(String.raw`\b(${STUDENT_CUES}|${FACULTY_CUES})\s+(${ANY_CASE_TOKEN})(?:\s+(${NAME_TOKEN}))?`, 'gi');
const FACULTY_CUE_RE = new RegExp(`^(?:${FACULTY_CUES})$`, 'i');

// ---------------------------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------------------------
const OPEN = '';
const CLOSE = '';
const TOKEN_RE = /(\d+)/g;

class Vault {
  constructor() {
    this.tags = [];
  }
  put(tag) {
    this.tags.push(tag);
    return `${OPEN}${this.tags.length - 1}${CLOSE}`;
  }
  tagAt(index) {
    return this.tags[Number(index)];
  }
  restore(text) {
    return text.replace(TOKEN_RE, (_m, i) => this.tags[Number(i)]);
  }
}

// Tags already present (a second pass over Claude's rewrite, or re-scrubbing a draft) are frozen
// first, and their letters reserved, so new names never collide with existing [Student B] etc.
const KNOWN_TAG_RE = /\[(?:Student(?: Group)? ([A-Z])\d*|Faculty Member(?: ([A-Z])\d*)?|Phone Removed|Email Removed|Student ID Removed|Social Handle|Link Removed|Section|characterization removed|judgment removed|punitive demand removed)\]/g;

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------
const CONTACT_RULES = [
  { type: 'link', tag: '[Link Removed]', re: /\b(?:https?:\/\/|www\.)\S+|\b(?:facebook|fb|instagram|tiktok|twitter|x|youtube|discord)\.(?:com|gg)\/\S+/gi },
  { type: 'email', tag: '[Email Removed]', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: 'phone', tag: '[Phone Removed]', re: /(?:\+?63[\s-]?|\b0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\b\d{3}[\s-]\d{3,4}[\s-]\d{4}\b/g },
  { type: 'student_id', tag: '[Student ID Removed]', re: /\b(?:\d{2,4}-\d{4,6}|[A-Z]{1,3}-?\d{5,9}|\d{7,})\b/g },
  { type: 'handle', tag: '[Social Handle]', re: /(?<![\w.])@[A-Za-z0-9_.]{2,30}\b/g },
];

// Campus sections narrow a report down to a handful of students: "Section 3-B", "sec 11-Rizal",
// "section Sampaguita", or a bare "3-B" / "11-Rizal".
const SECTION_RULES = [
  /\b(?:section|sec\.?)\s*[-:]?\s*\d{1,2}(?:-?[A-Za-z]+)?\b/gi,
  /\b[Ss]ection\s+[A-Z][a-z]+\b(?<!\b[Ss]ection\s+(?:Chat|Group|Gc|Head|Adviser|Representative|Rep))/g,
  /\b\d{1,2}-[A-Z][A-Za-z]*\b/g,
];

const GROUP_WORDS = 'clique|friends|group|barkada|gang|crew|squad|circle|tropa';
const GROUP_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}\\s+and\\s+(?:his|her|their)\\s+(?:${GROUP_WORDS})`, 'gi');

// Guilt / defamation language. Labels become [characterization removed]; calls for punishment
// become [judgment removed]. Nothing here ever pronounces guilt.
const LABELS = 'predator|rapist|criminal|thief|pervert|psycho(?:path)?|monster|abuser|molester|creep|scammer|druggie|addict|whore|slut|bitch|bastard|sociopath|harasser|stalker';
const DEFAMATION_RULES = [
  { type: 'judgment', re: /\b(?:should|must|deserves? to|needs? to)\s+(?:be\s+|get\s+)?(?:expelled|fired|arrested|jailed|suspended|punished|kicked out|banned|beaten|hurt|exposed)\b/gi, keepVerb: false },
  { type: 'accusation', re: new RegExp(`\\b(is|are|was|were)\\s+(?:a|an|the)?\\s*(?:total\\s+|complete\\s+|real\\s+|known\\s+|literal\\s+)?(?:${LABELS})s?\\b`, 'gi'), keepVerb: true },
  { type: 'accusation', re: /\b(is|are|was|were)\s+(?:definitely\s+|clearly\s+|100%\s+)?guilty\b/gi, keepVerb: true },
  { type: 'accusation', re: new RegExp(`\\b(?:that|this|the|a)\\s+(?:${LABELS})\\b`, 'gi'), keepVerb: false },
];
const DEFAMATION_TAGS = { accusation: '[characterization removed]', judgment: '[judgment removed]' };

// Call-out / retaliation / pile-on intent. These posts are held for counselor moderation rather
// than rejected, so a genuine report that happens to match is never lost.
const RETALIATION_RULES = [
  /\b(?:let'?s|lets|we should|we need to|everyone|everybody|y'?all|guys,? (?:let'?s|go))\s+(?:all\s+|go\s+)?(?:expose|shame|cancel|doxx?|ruin|jump|beat(?:\s+up)?|get back at|hunt(?:\s+down)?|spam|mass[- ]report|call (?:him|her|them) out|post (?:his|her|their)|share (?:his|her|their)|leak|bash|attack)\b/i,
  /\b(?:expose|doxx?)\s+(?:him|her|them|this|these|those)\b/i,
  /#\s?(?:expose|cancel)\w*/i,
  /\bmake (?:him|her|them) pay\b/i,
  /\bteach (?:him|her|them) a lesson\b/i,
  /\bspread (?:this|the word) (?:so|until|everywhere)\b/i,
  /\b(?:what is|whats|what's|anyone (?:know|have))\s+(?:his|her|their)\s+(?:address|number|account|real name)\b/i,
];

const COUNT_TYPES = ['person_name', 'faculty_name', 'phone', 'email', 'student_id', 'handle', 'link', 'section', 'accusation', 'judgment'];
const IDENTIFIER_TYPES = COUNT_TYPES.filter((t) => t !== 'accusation' && t !== 'judgment');

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
function isSentenceStart(text, index) {
  const before = text.slice(0, index).trimEnd();
  return before.length === 0 || /[.!?:;"“(\n]$/.test(before);
}

function letterFor(i) {
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isNameWord = (word) => Boolean(word) && !STOPWORDS.has(word.toLowerCase()) && !NAME_PARTICLES.has(word);
const isCasualFirstName = (word) => FIRST_NAMES.has(word) && !LOWERCASE_AMBIGUOUS.has(word) && word.length > 2;

/** Find person mentions. Returns entities ordered by first appearance. */
export function detectNames(text) {
  const entities = new Map(); // surface -> { kind, index }
  const add = (surface, kind, index) => {
    const key = surface.trim();
    if (!key || entities.has(key)) return;
    entities.set(key, { kind, index });
  };

  for (const m of text.matchAll(TITLE_RE)) add(m[0], 'faculty', m.index);

  // Honorific / relational cues: "kuya Migs", "my seatmate Jerome", "teacher Ana".
  for (const m of text.matchAll(CUE_RE)) {
    const [, cue, first, second] = m;
    const capitalized = /^[A-Z]/.test(first);
    const plausible = capitalized ? isNameWord(first) : isCasualFirstName(first);
    if (!plausible) continue;
    // "ate" is also the English past tense of "eat" ("we ate Jollibee"): only trust it before a known
    // first name or after a Filipino/possessive marker ("si ate Bea", "my ate Liza").
    if (/^ate$/i.test(cue) && !FIRST_NAMES.has(first.toLowerCase()) && !/\b(?:my|our|si|ni|kay|ang|sa)\s+$/i.test(text.slice(0, m.index))) continue;
    // The regex is case-insensitive for the cue word, so check the surname's capital letter here.
    const name = second && capitalized && /^[A-Z]/.test(second) && isNameWord(second) ? `${first} ${second}` : first;
    if (FACULTY_CUE_RE.test(cue)) add(`${cue} ${name}`, 'faculty', m.index);
    else add(name, 'student', m.index + m[0].indexOf(first));
  }

  for (const m of text.matchAll(CAP_SPAN_RE)) {
    // Skip spans already covered by a faculty match.
    if ([...entities.entries()].some(([s, e]) => e.kind === 'faculty' && m.index >= e.index && m.index < e.index + s.length)) continue;
    let tokens = m[0].split(/\s+/);
    // Trim stopwords from both ends ("Then Mark Santos" -> "Mark Santos").
    while (tokens.length && STOPWORDS.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
    while (tokens.length && (STOPWORDS.has(tokens.at(-1).toLowerCase()) || NAME_PARTICLES.has(tokens.at(-1)))) tokens = tokens.slice(0, -1);
    if (!tokens.length) continue;
    const offset = m.index + m[0].indexOf(tokens[0]);
    if (tokens.some((t) => STOPWORDS.has(t.toLowerCase()))) {
      // Mixed spans like "Mark Science Lab": keep only a leading known first name.
      if (FIRST_NAMES.has(tokens[0].toLowerCase())) add(tokens[0], 'student', offset);
      continue;
    }
    const capitalized = tokens.filter((t) => !NAME_PARTICLES.has(t));
    if (capitalized.length >= 2) add(tokens.join(' '), 'student', offset);
    else if (FIRST_NAMES.has(tokens[0].toLowerCase())) add(tokens[0], 'student', offset);
  }

  // Lowercase first names typed casually ("me and bea"), skipping names that are also everyday words.
  for (const m of text.matchAll(/\b[a-z][a-z'-]+\b/g)) {
    if (isCasualFirstName(m[0])) add(m[0], 'student', m.index);
  }

  return [...entities.entries()]
    .map(([surface, e]) => ({ surface, ...e }))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------------------------
function scrubCore(input) {
  const vault = new Vault();
  const counts = Object.fromEntries(COUNT_TYPES.map((t) => [t, 0]));
  let text = String(input ?? '').replace(/\r\n/g, '\n').trim();

  // 1. Freeze tags that are already present and reserve their letters.
  const usedStudentLetters = new Set();
  const usedFacultyLetters = new Set();
  let plainFacultyPresent = false;
  text = text.replace(KNOWN_TAG_RE, (tag, studentLetter, facultyLetter) => {
    if (studentLetter) usedStudentLetters.add(studentLetter);
    if (facultyLetter) usedFacultyLetters.add(facultyLetter);
    if (tag === '[Faculty Member]') plainFacultyPresent = true;
    return vault.put(tag);
  });

  // 2. Contact details, IDs, handles, links, then campus sections.
  for (const rule of CONTACT_RULES) {
    text = text.replace(rule.re, () => {
      counts[rule.type] += 1;
      return vault.put(rule.tag);
    });
  }
  for (const re of SECTION_RULES) {
    text = text.replace(re, () => {
      counts.section += 1;
      return vault.put('[Section]');
    });
  }

  // 3. People. Tokens of a full name map to the same tag ("Mark Santos" ... "Santos").
  const entities = detectNames(text);
  const students = entities.filter((e) => e.kind === 'student');
  const faculty = entities.filter((e) => e.kind === 'faculty');

  const nextLetter = (used) => {
    for (let i = 0; ; i += 1) {
      const letter = letterFor(i);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
  };

  const surfaceToTag = new Map();
  const tagByToken = new Map(); // lowercase name token -> { tag, written }
  for (const e of students) {
    const tokens = e.surface.split(/\s+/).filter((t) => !NAME_PARTICLES.has(t));
    const existing = tokens.map((t) => tagByToken.get(t.toLowerCase())?.tag).find(Boolean);
    const tag = existing ?? `[Student ${nextLetter(usedStudentLetters)}]`;
    surfaceToTag.set(e.surface, tag);
    for (const t of tokens) if (t.length >= 3 && !tagByToken.has(t.toLowerCase())) tagByToken.set(t.toLowerCase(), { tag, written: t });
  }
  const letterFaculty = faculty.length > 1 || plainFacultyPresent || usedFacultyLetters.size > 0;
  if (plainFacultyPresent) usedFacultyLetters.add('A');
  for (const e of faculty) {
    surfaceToTag.set(e.surface, letterFaculty ? `[Faculty Member ${nextLetter(usedFacultyLetters)}]` : '[Faculty Member]');
  }

  // Replace longest surfaces first so "Mark Santos" wins over "Mark".
  const surfaces = [...surfaceToTag.keys()].sort((a, b) => b.length - a.length);
  for (const surface of surfaces) {
    const tag = surfaceToTag.get(surface);
    const re = new RegExp(`(?<![\\w'])${escapeRe(surface)}(?![\\w])`, 'g');
    text = text.replace(re, () => {
      counts[tag.startsWith('[Faculty') ? 'faculty_name' : 'person_name'] += 1;
      return vault.put(tag);
    });
  }
  // Leftover parts of known full names ("Santos" after "Mark Santos"). Capitalized form always;
  // lowercase only when it isn't also an everyday word ("mark my words" stays as it is).
  for (const [token, { tag, written }] of tagByToken) {
    const forms = new Set([written, token.charAt(0).toUpperCase() + token.slice(1)]);
    if (!LOWERCASE_AMBIGUOUS.has(token) && !STOPWORDS.has(token)) forms.add(token);
    const re = new RegExp(`(?<![\\w'])(?:${[...forms].map(escapeRe).join('|')})(?![\\w])`, 'g');
    text = text.replace(re, () => {
      counts.person_name += 1;
      return vault.put(tag);
    });
  }

  // 4. "[Student A] and his clique" -> "[Student Group A]" for that phrase only; a later solo
  //    mention of the same person stays [Student A].
  text = text.replace(GROUP_RE, (match, index) => {
    const tag = vault.tagAt(index);
    const letter = /^\[Student ([A-Z]\d*)\]$/.exec(tag)?.[1];
    return letter ? vault.put(`[Student Group ${letter}]`) : match;
  });

  // 5. Accusations and calls for punishment.
  let defamation = false;
  for (const rule of DEFAMATION_RULES) {
    text = text.replace(rule.re, (_m, verb) => {
      defamation = true;
      counts[rule.type] += 1;
      const token = vault.put(DEFAMATION_TAGS[rule.type]);
      return rule.keepVerb ? `${verb} ${token}` : token;
    });
  }

  // 6. Back to visible tags.
  text = vault.restore(text).replace(/[ \t]{2,}/g, ' ').trim();
  const retaliation = detectRetaliation(text);
  const totalRedactions = COUNT_TYPES.reduce((sum, t) => sum + counts[t], 0);
  const identifierCount = IDENTIFIER_TYPES.reduce((sum, t) => sum + counts[t], 0);

  return { text, counts, totalRedactions, identifierCount, flags: { defamation, retaliation }, surfaces };
}

/** Sanitize a narrative. */
export function scrub(input) {
  const { text, counts, totalRedactions, flags } = scrubCore(input);
  return { text, counts, totalRedactions, flags };
}

/** Fast pre-check for call-out / retaliation intent. */
export function detectRetaliation(text) {
  return RETALIATION_RULES.some((re) => re.test(String(text ?? '')));
}

/**
 * scrub() plus the extra fields the ingest pipeline uses: moderation notes, residual-name
 * warnings, and the raw surfaces it removed (to reject an LLM rewrite that brings one back).
 */
export function scrubText(input) {
  const core = scrubCore(input);
  const notes = [];
  if (core.flags.defamation) notes.push('Accusatory or punitive language was rewritten into objective wording.');
  if (core.flags.retaliation) notes.push('Possible call-out or retaliation language - held for counselor moderation.');
  const residual = findResidualIdentifiers(core.text);
  if (residual.length) notes.push(`Possible unredacted identifier(s): ${residual.join(', ')}`);
  return {
    text: core.text,
    counts: core.counts,
    totalRedactions: core.totalRedactions,
    flags: core.flags,
    // Identifiers only (names, contacts, IDs, handles, links, sections) - what the UI calls "removed".
    redactionCount: core.identifierCount,
    defamationNeutralized: core.flags.defamation,
    retaliation: core.flags.retaliation,
    residualIdentifiers: residual,
    notes,
    knownSurfaces: core.surfaces,
  };
}

/** Mid-sentence capitalized words that are not known places/apps/tags. Used as a moderation signal. */
export function findResidualIdentifiers(text) {
  const stripped = text.replace(/\[[^\]]*\]/g, ' ');
  const found = new Set();
  for (const m of stripped.matchAll(/\b[A-Z][a-z][a-zA-Z'-]+\b/g)) {
    const word = m[0];
    if (STOPWORDS.has(word.toLowerCase())) continue;
    if (isSentenceStart(stripped, m.index)) continue;
    found.add(word);
  }
  return [...found];
}

/** True when any previously detected raw identifier survives in `text` (used to validate LLM output). */
export function leaksKnownSurface(text, surfaces) {
  return surfaces.some((s) => new RegExp(`(?<![\\w\\[])${escapeRe(s)}(?![\\w])`, 'i').test(text));
}

/** @deprecated use detectRetaliation */
export const hasRetaliationLanguage = detectRetaliation;

// Words that must never appear in system-generated summaries (guardrail: no determining guilt).
const GUILT_TERMS = /\b(guilty|perpetrator|culprit|offender|criminal|convicted|liable|punish(?:ed|ment)?|expel(?:led)?|wrongdoer|villain|abuser|predator|bully)\b/i;
export function containsGuiltLanguage(text) {
  return GUILT_TERMS.test(text);
}
