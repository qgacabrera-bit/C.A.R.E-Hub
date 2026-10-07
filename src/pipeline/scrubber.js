// Deterministic PII & defamation scrubber.
//
// This layer always runs - with or without Claude - and it re-checks Claude's output, so a model
// mistake can never re-introduce an identifier that the rules already know about.

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

const LOWERCASE_AMBIGUOUS = new Set(`
mark joy grace faith rose lily amber angel jade jack max may will bobby hannah sam kim jean robin pia mae gab ana
ella mia lea luke sean art bill dawn eve hope ivy june sky star rob ian carl paul`.trim().split(/\s+/));

const NAME_PARTICLES =new Set(['de', 'del', 'dela', 'delos', 'los', 'la', 'van', 'von', 'da', 'di']);

const NAME_TOKEN = String.raw`[A-Z][a-zA-Z-]*(?:'(?!s\b)[a-zA-Z]+)?`; // allows O'Brien, never a possessive 's
const TITLE_RE = new RegExp(String.raw`\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Ma'?am|Madam|Teacher|Coach|Principal|Dean|Engr|Atty)\.?\s+(${NAME_TOKEN}(?:\s+(?:(?:de|del|dela|delos|la)\s+)?${NAME_TOKEN})?)`, 'g');
const CAP_SPAN_RE = new RegExp(String.raw`\b${NAME_TOKEN}(?:\s+(?:(?:de|del|dela|delos|los|la|van|von|da|di)\s+)?${NAME_TOKEN}){0,3}`, 'g');

const CONTACT_RULES = [
  { type: 'link', tag: '[Link Removed]', re: /\b(?:https?:\/\/|www\.)\S+|\b(?:facebook|fb|instagram|tiktok|twitter|x|youtube|discord)\.(?:com|gg)\/\S+/gi },
  { type: 'email', tag: '[Email Removed]', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { type: 'phone', tag: '[Phone Removed]', re: /(?:\+?63[\s-]?|\b0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\b\d{3}[\s-]\d{3,4}[\s-]\d{4}\b/g },
  { type: 'student_id', tag: '[Student ID Removed]', re: /\b(?:\d{2,4}-\d{4,6}|[A-Z]{1,3}-?\d{5,9}|\d{7,})\b/g },
  { type: 'handle', tag: '[Social Handle]', re: /(?<![\w.])@[A-Za-z0-9_.]{2,30}\b/g },
];

const GROUP_RE = /(\[Student ([A-Z])\])\s+and\s+(?:his|her|their)\s+(?:clique|friends|group|barkada|gang|crew|squad|circle|tropa)/gi;

// Guilt / defamation language: rewritten into objective wording rather than deleted, so the report
// still reads naturally but never pronounces guilt.
const LABELS = 'predator|rapist|criminal|thief|pervert|psycho(?:path)?|monster|abuser|molester|creep|scammer|druggie|addict|whore|slut|bitch|bastard|sociopath|harasser|stalker';
const DEFAMATION_RULES = [
  {
    re: new RegExp(`\\b(is|are|was|were)\\s+(?:a|an|the)?\\s*(?:total\\s+|complete\\s+|real\\s+|known\\s+|literal\\s+)?(?:${LABELS})s?\\b`, 'gi'),
    to: (_m, verb) => `${verb} the subject of a reported concern`,
  },
  { re: /\b(is|are|was|were)\s+(?:definitely\s+|clearly\s+|100%\s+)?guilty\b/gi, to: (_m, verb) => `${verb} the subject of a reported concern` },
  {
    re: /\b(?:should|must|deserves? to|needs? to)\s+(?:be\s+|get\s+)?(?:expelled|fired|arrested|jailed|suspended|punished|kicked out|banned|beaten|hurt|exposed)\b/gi,
    to: () => '[punitive demand removed]',
  },
  { re: new RegExp(`\\b(?:that|this|the|a)\\s+(?:${LABELS})\\b`, 'gi'), to: () => 'the person involved' },
];

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

/** Find person mentions. Returns entities ordered by first appearance. */
export function detectNames(text) {
  const entities = new Map(); // surface -> { kind, index }
  const add = (surface, kind, index) => {
    const key = surface.trim();
    if (!key || entities.has(key)) return;
    entities.set(key, { kind, index });
  };

  for (const m of text.matchAll(TITLE_RE)) add(m[0], 'faculty', m.index);

  for (const m of text.matchAll(CAP_SPAN_RE)) {
    // Skip spans already covered by a faculty title match.
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
    if (FIRST_NAMES.has(m[0]) && !LOWERCASE_AMBIGUOUS.has(m[0]) && m[0].length > 2) add(m[0], 'student', m.index);
  }

  return [...entities.entries()]
    .map(([surface, e]) => ({ surface, ...e }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Scrub a narrative. Returns the sanitized text plus a report of what was changed.
 * `existingTags` lets a second pass (e.g. after Claude) continue the same lettering.
 */
export function scrubText(input) {
  let text = String(input ?? '').replace(/\r\n/g, '\n').trim();
  const redactions = [];
  const notes = [];

  for (const rule of CONTACT_RULES) {
    text = text.replace(rule.re, () => {
      redactions.push({ type: rule.type, tag: rule.tag });
      return rule.tag;
    });
  }

  const entities = detectNames(text);
  const students = entities.filter((e) => e.kind === 'student');
  const faculty = entities.filter((e) => e.kind === 'faculty');

  // Assign tags. Tokens of a full name map to the same tag ("Mark Santos" ... "Santos").
  const surfaceToTag = new Map();
  const studentTagByToken = new Map();
  let studentIdx = 0;
  for (const e of students) {
    const tokens = e.surface.split(/\s+/).filter((t) => !NAME_PARTICLES.has(t));
    const existing = tokens.map((t) => studentTagByToken.get(t.toLowerCase())).find(Boolean);
    const tag = existing ?? `[Student ${letterFor(studentIdx++)}]`;
    surfaceToTag.set(e.surface, tag);
    for (const t of tokens) if (t.length >= 3 && !studentTagByToken.has(t.toLowerCase())) studentTagByToken.set(t.toLowerCase(), tag);
  }
  faculty.forEach((e, i) => surfaceToTag.set(e.surface, faculty.length === 1 ? '[Faculty Member]' : `[Faculty Member ${letterFor(i)}]`));

  // Replace longest surfaces first so "Mark Santos" wins over "Mark".
  const surfaces = [...surfaceToTag.keys()].sort((a, b) => b.length - a.length);
  for (const surface of surfaces) {
    const tag = surfaceToTag.get(surface);
    const re = new RegExp(`(?<![\\w\\[])${escapeRe(surface)}(?![\\w])`, 'g');
    text = text.replace(re, () => {
      redactions.push({ type: tag.startsWith('[Faculty') ? 'faculty_name' : 'student_name', tag });
      return tag;
    });
  }
  // Leftover partial tokens of known full names (surname mentioned alone, any case).
  for (const [token, tag] of studentTagByToken) {
    const re = new RegExp(`(?<![\\w\\[])${escapeRe(token)}(?![\\w\\]])`, 'gi');
    text = text.replace(re, () => {
      redactions.push({ type: 'student_name', tag });
      return tag;
    });
  }

  // "[Student A] and his clique" -> "[Student Group A]"
  text = text.replace(GROUP_RE, (_m, _tag, letter) => `[Student Group ${letter}]`);
  text = text.replace(/\[Student ([A-Z]\d*)\]/g, (m, letter) => (text.includes(`[Student Group ${letter}]`) ? `[Student Group ${letter}]` : m));

  let defamationNeutralized = false;
  for (const rule of DEFAMATION_RULES) {
    text = text.replace(rule.re, (...args) => {
      defamationNeutralized = true;
      return rule.to(...args);
    });
  }
  if (defamationNeutralized) notes.push('Accusatory or punitive language was rewritten into objective wording.');

  const retaliation = RETALIATION_RULES.some((re) => re.test(text));
  if (retaliation) notes.push('Possible call-out or retaliation language - held for counselor moderation.');

  const residual = findResidualIdentifiers(text);
  if (residual.length) notes.push(`Possible unredacted identifier(s): ${residual.join(', ')}`);

  text = text.replace(/[ \t]{2,}/g, ' ').trim();

  return {
    text,
    redactions,
    redactionCount: redactions.length,
    defamationNeutralized,
    retaliation,
    residualIdentifiers: residual,
    notes,
    knownSurfaces: surfaces,
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

export function hasRetaliationLanguage(text) {
  return RETALIATION_RULES.some((re) => re.test(text));
}

// Words that must never appear in system-generated summaries (guardrail: no determining guilt).
const GUILT_TERMS = /\b(guilty|perpetrator|culprit|offender|criminal|convicted|liable|punish(?:ed|ment)?|expel(?:led)?|wrongdoer|villain|abuser|predator|bully)\b/i;
export function containsGuiltLanguage(text) {
  return GUILT_TERMS.test(text);
}
