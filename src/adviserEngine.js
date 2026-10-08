// Offline C.A.R.E. Adviser: keyword/intent engine used when Claude is unavailable, and for the
// quick-reply suggestions shown under every reply. Deterministic, English + Taglish, safety first.
//
// A reply is { reply, crisis, intent, offer, suggestions }:
//   offer        - what she just asked ("scripts", "grounding", ...) so a later "yes"/"oo" is understood
//   suggestions  - tappable chips: { label, action, text? }  (action: reply | private_report |
//                  draft_post | hotlines | call | view_mine)
import { scoreSeverity } from './pipeline/severity.js';

const CALL_1553 = { label: 'Call 1553 now', action: 'call', number: '1553' };
const CALL_911 = { label: 'Call 911', action: 'call', number: '911' };
const HOTLINES = { label: 'See all contacts', action: 'hotlines' };
const PRIVATE = { label: 'Send privately to counselors', action: 'private_report' };
const DRAFT = { label: 'Draft an anonymous post', action: 'draft_post' };
const say = (label, text = label) => ({ label, action: 'reply', text });

// Ordered by priority: the first matching intent wins. `incident: true` marks topics that are
// worth reporting, so she can offer the private/anonymous report options.
const INTENTS = [
  // ---- Safety tier --------------------------------------------------------------------------
  {
    id: 'self_harm',
    test: (t) => scoreSeverity(t).crisis,
    crisis: true,
    replies: [
      "I'm really glad you told me, and I'm worried about your safety. You don't have to carry this alone. Please reach out right now: NCMH Crisis Hotline 1553 (free, 24/7) or 0917-899-8727, or 911 if you're in immediate danger. If you can, go to a trusted adult or your Guidance Office now. I'm still here with you.",
    ],
    suggestions: [CALL_1553, HOTLINES, PRIVATE],
  },
  {
    id: 'immediate_danger',
    re: /\b(gun|baril|knife|kutsilyo|weapon|bomb|going to (?:kill|shoot|stab|hurt) (?:me|us|everyone)|threaten(?:ed|ing)? to (?:kill|hurt)|papatayin|(?:someone|they|he|she) (?:is|are) (?:following|hurting) me|i'?m not safe|not safe right now|in danger)\b/i,
    crisis: true,
    replies: [
      "Your safety comes first. If you're in danger right now, call 911 or go straight to campus security, a teacher, or any office where other people are. Stay where adults can see you. As soon as you can, tell your Guidance Office. I can send this to them privately right now. If you need to talk to someone while you wait, the NCMH Crisis Hotline 1553 is free and open 24/7.",
    ],
    suggestions: [CALL_911, PRIVATE, HOTLINES],
    incident: true,
  },
  {
    id: 'abuse_home',
    re: /\b((?:my|our) (?:dad|mom|father|mother|stepdad|stepmom|step-?parent|parents?|guardian|tito|tita|lolo|lola|kuya|ate) (?:hits?|beats?|hurts?|hurt|slaps?|kicks?|punche[sd])(?: me)?|abuse[sd]? at home|hurt(?:s|ing)? me at home|sinasaktan ako|binubugbog|bugbog sa bahay|scared to go home|afraid to go home|takot (?:ako )?umuwi)\b/i,
    crisis: true,
    replies: [
      "I'm so sorry. No one is allowed to hurt you, at home or anywhere, and it is not your fault. If you're in danger right now, call 911. Please tell your Guidance Office. They can help keep you safe and contact the right people. Your barangay VAWC desk also helps young people facing violence at home. You can call the NCMH Crisis Hotline 1553 anytime, 24/7. I can send this privately to the counselors for you now.",
    ],
    suggestions: [PRIVATE, CALL_911, HOTLINES],
    incident: true,
  },
  {
    id: 'sexual_harassment',
    re: /\b(touched me|touching me|groped|grop(?:e|ing)|sexual(?:ly)?|send (?:me )?nudes|nudes?|private (?:photos?|pics?|videos?)|intimate (?:photos?|pics?)|upskirt|hinipuan|hinihipuan|binastos|bastos|manyak|catcall(?:ed|ing)?)\b/i,
    replies: [
      "Thank you for trusting me with this. What happened is not your fault. If photos or videos are involved, don't forward or repost them, even as proof. Counselors can handle evidence safely. Please let your Guidance Office know; I can send it to them privately so it never appears on the feed. If you're in danger, call 911 or go to campus security, and your barangay VAWC desk can also help. If this is weighing on you, the NCMH Crisis Hotline 1553 is free and open 24/7.",
    ],
    suggestions: [PRIVATE, say('Can I stay anonymous?', 'Will anyone know it was me?'), HOTLINES],
    incident: true,
  },

  // ---- Feelings & intentions -------------------------------------------------------------------
  {
    id: 'retaliation',
    re: /\b(get back at|revenge|ganti(?:han)?|resbak|expose (?:him|her|them)|make (?:him|her|them) pay|call (?:him|her|them) out|post (?:about )?(?:him|her|them)|teach (?:him|her|them) a lesson)\b/i,
    replies: [
      "It makes sense to feel angry when someone hurts you. Exposing or getting back at them usually makes things worse for you, though: it can turn into a bigger fight, or get you in trouble instead. A safer move is letting the counselors handle it. I can send what happened to them privately.",
    ],
    suggestions: [PRIVATE, say('Help me calm down', 'I am so angry right now'), say('What else can I do?', 'What should I do?')],
  },
  {
    id: 'anxiety',
    re: /\b(panic(?:king)?|anxi(?:ety|ous)|can'?t breathe|heart (?:is )?racing|shaking|nervous|kinakabahan|kabado|overwhelm(?:ed|ing)?|so angry|galit na galit)\b/i,
    offer: 'grounding',
    replies: [
      "I'm here with you. Let's slow things down together. Breathe in for 4 counts, hold for 4, and breathe out slowly for 6. Try it three times. Want me to walk you through a quick grounding exercise too?",
      "That sounds really overwhelming. You're safe to take a pause here. Try unclenching your jaw and dropping your shoulders, then take one slow breath out. Would a short grounding exercise help right now?",
    ],
    suggestions: [say('Yes, walk me through it', 'Yes'), say('I just want to talk', 'No, I just want to talk')],
  },
  {
    id: 'sad_lonely',
    re: /\b(sad|lonely|alone|no friends|walang kaibigan|nobody (?:cares|likes me)|depress(?:ed|ing)?|crying|cry myself|empty|hopeless|malungkot|nalulungkot|nag-?iisa|iyak)\b/i,
    replies: [
      "I'm really sorry you're feeling this way. Feeling alone is heavy, and reaching out like this takes courage. You matter here. Is something specific making it harder lately, or has it been building up for a while?",
      "Thank you for telling me. Sadness can make everything feel bigger and harder. You don't have to sort it all out at once. Would it help to talk about what's been happening, or about small things that might make today a little easier?",
    ],
    suggestions: [say('Something happened', 'Something happened at school'), say("It's been building up", "It's been building up for a while"), HOTLINES],
  },
  {
    id: 'stress',
    re: /\b(exams?|finals|quiz(?:zes)?|grades?|deadlines?|failing|bagsak|thesis|projects?|school ?work|homework|too much work|pagod|exhausted|burn(?:ed|t)? out|stressed?)\b/i,
    replies: [
      "School pressure can pile up fast. Try picking just one small task you can finish in the next 25 minutes, then take a 5-minute break. Progress counts even when it's small. Your teachers and Guidance Office can also help if the load feels unfair or too much.",
      "That's a lot to carry. Write down everything that's due, then circle only the one thing due soonest. Just start there. Sleep and short breaks aren't wasted time; they help you think. Do you want to talk about what's stressing you most?",
    ],
    suggestions: [say('Talk it through', 'I want to talk about what is stressing me'), say("I can't keep up", "I feel like I can't keep up")],
  },

  // ---- Incidents ---------------------------------------------------------------------------------
  {
    id: 'cyberbullying',
    re: /\b(group ?chat|gc|posted|post(?:ing|s)? (?:about|of) me|pinost|fake (?:account|acc)|dummy (?:account|acc)|edited (?:photos?|pics?|pictures?)|memes? (?:of|about) me|screenshots?|comments?|chismis online|messenger|discord|tiktok|facebook|fb|instagram|ig|cyber ?bull\w*)\b/i,
    category: 'Cyberbullying',
    replies: [
      "I'm sorry this is happening online. It can feel like there's no escape from it. A few things that help: don't reply to them, take screenshots for yourself (but don't share them around), and use the app's report and block tools. The counselors can also step in. Would you like to report it?",
      "Online harassment is real harassment, and it's not your fault. Keep screenshots private as evidence, mute or block where you can, and step away from the chat for a bit if it's hurting. If you'd like, I can help you report it, either as an anonymous post or privately to counselors.",
    ],
    offer: 'report_options',
    incident: true,
  },
  {
    id: 'physical',
    re: /\b(push(?:ed|es|ing)?|shov(?:ed|ing)|hit(?:s|ting)? me|punch(?:ed|es)?|kick(?:ed|s)?|slap(?:ped|s)?|trip(?:ped)? me|beat (?:me )?up|sinuntok|tinulak|sinampal|sinipa|hinampas)\b/i,
    category: 'Bullying',
    replies: [
      "I'm really sorry. Nobody has the right to hurt you physically. For now, try to stay close to friends or near teachers and staff, especially in the places it happens. Physical harm is something counselors need to know about. Would you like me to help report it?",
      "That's not okay, and it's not your fault. If you're hurt, please visit the school clinic. Stick near other people when you can. This should go to the counselors. I can send it privately, or help you post anonymously.",
    ],
    offer: 'report_options',
    incident: true,
  },
  {
    id: 'verbal_social',
    re: /\b(bull(?:y|ied|ying|ies)|binubully|teas(?:e|ed|ing)|mock(?:ed|ing)?|laugh(?:ed|ing)? at me|call(?:ed|ing)? me names|names? (?:at|for) me|insult(?:ed|ing)?|rumou?rs?|gossip|chismis|exclud(?:e|ed|ing)|ignor(?:e|ed|ing) me|left out|inaasar|inaaway|pinagtatawanan|pinag-?uusapan)\b/i,
    category: 'Bullying',
    replies: [
      "I'm sorry you're going through this. Being teased or left out hurts, and it's not your fault. It can help to note what happened, where, and how often, without names. Would you like me to help you report it so a counselor can step in?",
      "That sounds really hurtful, especially if it keeps happening. You deserve to feel safe at school. You don't have to handle it by yourself. Do you want to tell me more, or should I help you report it?",
    ],
    offer: 'report_options',
    incident: true,
  },
  {
    id: 'peer_pressure',
    re: /\b(pressur\w*|pinipilit|pilit|dare[ds]?|vape|vaping|yosi|smok(?:e|ing)|drink(?:ing)?|alcohol|inom|weed|drugs?|cheat(?:ing)?|copy (?:my )?homework|kopya|cut(?:ting)? class|skip(?:ping)? class|cutting|barkada wants)\b/i,
    category: 'Peer Pressure',
    offer: 'scripts',
    replies: [
      "That's a tough spot. You want to keep your friends, but not on their terms. You never owe anyone a yes. Do you want a few simple lines you can use to say no without making it a big deal?",
      "Peer pressure is hard because it comes from people you care about. Saying no doesn't make you uncool; it means you know your limits. Want some easy ways to turn it down?",
    ],
    suggestions: [say('Yes, give me lines to say no', 'Yes'), say('It keeps happening', 'It keeps happening every day'), DRAFT],
  },
  {
    id: 'teacher',
    re: /\b(teacher|sir|ma'?am|coach|prof(?:essor)?|adviser|faculty|guro)\b.*\b(yell|shout|sigaw|unfair|humiliat|embarrass|threat|touch|hipo|grade me|insult|favoritism|pinapahiya)\w*/i,
    category: 'Bullying',
    replies: [
      "That sounds really uncomfortable, and you're right to take it seriously. Staff should treat students with respect. You don't have to confront them yourself. The Guidance team can look into it without naming you. Would you like to send this to them privately?",
    ],
    suggestions: [PRIVATE, say('Will they know it was me?', 'Will anyone know it was me?')],
    incident: true,
  },
  {
    id: 'campus_safety',
    re: /\b(broken|slippery|exposed wires?|wiring|leak(?:ing)?|baha|flood(?:ed|ing)?|no lights?|dark (?:hallway|area|corridor)|railing|unsafe|hazard|fire|smoke alarm|cracked|sira)\b/i,
    category: 'Campus Safety',
    replies: [
      "Thanks for looking out for everyone. Safety hazards are worth reporting quickly. Note where it is and what's wrong (and whether anyone got hurt). An anonymous post helps other students stay careful too. Want me to draft it?",
    ],
    suggestions: [DRAFT, PRIVATE],
    incident: true,
  },

  // ---- Questions about the platform -----------------------------------------------------------
  {
    id: 'privacy',
    re: /\b(anonymous|anonymity|will (?:they|anyone|someone) know|find out (?:it was|it's) me|who (?:can|will) see|track(?:ed|ing)? me|my (?:ip|name)|identif\w*|secret|private|malalaman ba|safe to report)\b/i,
    replies: [
      "Your privacy is protected. There's no account and no IP address stored; you're just a random \"Student #\" from a key kept in this browser. Names, numbers, and handles are removed automatically before anything is saved. If you want it even more private, I can send your report only to the counselors, and you can choose not to link it to your ID at all.",
    ],
    suggestions: [PRIVATE, DRAFT],
  },
  {
    id: 'want_report',
    re: /\b(report|i want to tell|tell (?:a |the )?(?:counsel?lor|guidance|teacher|someone)|what should i do|what do i do|what can i do|anong gagawin|paano (?:mag-?)?report|help me)\b/i,
    offer: 'report_options',
    replies: [
      "You have two ways to report, and both keep you anonymous. You can post it on the feed with names removed, so others know they're not alone. Or I can send it privately to the counselors only, and it never appears on the feed. Which feels right for you?",
    ],
  },
  {
    id: 'talk_human',
    re: /\b(real person|human|talk to (?:a |the )?(?:counsel?lor|guidance|someone)|counsel?lor|guidance office|psychologist|therapist)\b/i,
    replies: [
      "Talking to a real person can help a lot. Your school's Guidance Office is there for exactly this, and you can visit them directly. If you'd rather not walk in yet, I can send your concern privately so they know to reach out through official channels, without your name.",
    ],
    suggestions: [PRIVATE, HOTLINES],
  },
  {
    id: 'about_bot',
    re: /\b(are you (?:a )?(?:bot|robot|ai|real|human)|who are you|what are you|ano ka|sino ka)\b/i,
    replies: [
      "I'm the C.A.R.E. Adviser, a support assistant here to listen, help you calm down, think through what to do, and report things safely. I'm not a counselor or a therapist, but I can connect you to the people who are.",
    ],
  },

  // ---- Small talk ------------------------------------------------------------------------------
  {
    // "Who else can I talk to?" - local support, always alongside the Guidance Office.
    id: 'local_support',
    re: /\b(who else can i (?:talk|go) to|who (?:can|could) i (?:talk|go) to|someone else i can talk to|student council|ssg|sslg|class adviser|adviser ko|sangguniang kabataan|sk)\b/i,
    replies: [''],
  },
  {
    // Conversation openers ("something happened", the welcome chip) - invite the story.
    id: 'opener',
    re: /^(?:something (?:bad )?happened(?: at school| today)?|may nangyari(?: sa school)?|i (?:just )?(?:want|need) to talk|can i talk to you|i need help)[\s!.?]*$/i,
    replies: [
      "I'm here, and I'm listening. Tell me what happened in your own words: where it was, what was said or done, and how often it's been happening. You don't need to use anyone's name.",
      "Okay, take your time. What happened? Even a rough version is fine, and we can sort out the details together.",
    ],
  },
  {
    id: 'greeting',
    re: /^(?:hi+|hello+|hey+|yo|good (?:morning|afternoon|evening)|kumusta|musta|hello po|hi po)\b[\s!.?]*$/i,
    replies: [
      "Hi! I'm glad you're here. How are you feeling today?",
      "Hey! What's on your mind? You can tell me as much or as little as you want.",
    ],
    suggestions: [say('Something happened at school'), say("I'm feeling stressed", "I'm feeling stressed"), say('I just want to talk')],
  },
  {
    id: 'thanks',
    re: /\b(thank(?:s| you)|ty|salamat|tysm)\b/i,
    replies: [
      "You're welcome. I'm glad you reached out. I'm here whenever you need to talk.",
      "Anytime. Taking care of yourself like this matters. Come back whenever you need.",
    ],
  },
  {
    id: 'bye',
    re: /^(?:bye|goodbye|good ?night|gtg|got to go|sige na|ingat)\b/i,
    replies: [
      "Take care of yourself. If anything feels urgent later, the Helpline 1553 button is always at the top of the page.",
    ],
  },
];

// Explicit priority: safety first, then incidents (most actionable), then feelings, then questions
// about the platform, then small talk. E.g. "they pressure me to copy homework" is peer pressure,
// not school stress; "the smoke alarm is broken" is a campus hazard, not peer pressure.
const PRIORITY = [
  'self_harm', 'immediate_danger', 'abuse_home', 'sexual_harassment', 'retaliation',
  'cyberbullying', 'physical', 'teacher', 'verbal_social', 'campus_safety', 'peer_pressure',
  'anxiety', 'sad_lonely', 'stress',
  'privacy', 'local_support', 'want_report', 'talk_human', 'about_bot',
  'opener', 'greeting', 'thanks', 'bye',
];
INTENTS.sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));

const AFFIRM =/^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|okie|sige|oo|opo|please|go|game|g|tara)\b/i;
const NEGATE = /^(?:no|nope|nah|not (?:now|yet|really)|hindi|ayoko|wag na|huwag)\b/i;

const FOLLOW_UPS = {
  scripts: {
    reply: "Here are a few you can use:\n• \"Nah, I'm good.\" Say it once, calmly, then change the topic.\n• \"Not today, I've got stuff to do.\"\n• \"My parents would kill me, pass.\" Blaming someone else makes it easy.\n• Just walk toward other friends or a teacher. You don't owe an explanation.\nIf they keep pushing even after you say no, that's pressure worth reporting.",
    suggestions: [say('It keeps happening', 'It keeps happening every day'), PRIVATE],
  },
  grounding: {
    reply: "Let's do 5-4-3-2-1. Look around and name:\n• 5 things you can see\n• 4 things you can feel (your feet on the floor, your sleeves)\n• 3 things you can hear\n• 2 things you can smell\n• 1 slow breath out\nTake your time. How do you feel now, even a little bit?",
    suggestions: [say('A bit better', 'I feel a bit better'), say('Still not okay', "I'm still not okay")],
  },
  report_options: {
    reply: "Okay. You can choose how it goes:\n• Send privately to counselors: only the Guidance team sees it, and it never appears on the feed.\n• Anonymous post: it appears on the feed with names removed, so others know they're not alone.\nEither way, I'll help you write it.",
    suggestions: [PRIVATE, DRAFT],
  },
};

const FALLBACKS = [
  "Thank you for sharing that with me. Take your time. What happened, and how are you feeling about it right now?",
  "I'm listening. Can you tell me a bit more about what's going on: what happened, where, or how often?",
  "That sounds like a lot to hold. Do you want to talk it through, or would it help to figure out a next step together?",
];

const INCIDENT_CATEGORIES = Object.fromEntries(INTENTS.filter((i) => i.category).map((i) => [i.id, i.category]));
const OFFERS = new Set(Object.keys(FOLLOW_UPS).concat(['grounding']));

function matchIntent(text) {
  return INTENTS.find((intent) => (intent.test ? intent.test(text) : intent.re.test(text))) ?? null;
}

function pickVariant(list, history) {
  const assistantTurns = history.filter((m) => m.role === 'assistant');
  const last = assistantTurns.at(-1)?.content;
  let i = assistantTurns.length % list.length;
  if (list[i] === last && list.length > 1) i = (i + 1) % list.length;
  return list[i];
}

/** Topics the student has raised so far (used to tailor offers and the offline draft). */
export function detectTopics(history) {
  const topics = [];
  for (const m of history) {
    if (m.role !== 'user') continue;
    const intent = matchIntent(m.content);
    if (intent && !topics.includes(intent.id)) topics.push(intent.id);
  }
  return topics;
}

export function isIncidentTopic(id) {
  return Boolean(INTENTS.find((i) => i.id === id)?.incident || INCIDENT_CATEGORIES[id]);
}

export function categoryForTopics(topics) {
  for (const id of topics) if (INCIDENT_CATEGORIES[id]) return INCIDENT_CATEGORIES[id];
  if (topics.some((t) => t === 'self_harm' || t === 'sad_lonely' || t === 'anxiety' || t === 'stress')) return 'Mental Health';
  return null;
}

/** Small talk and platform questions are left out of report drafts. */
export function isSmallTalk(text) {
  const intent = matchIntent(text);
  return Boolean(intent && ['opener', 'greeting', 'thanks', 'bye', 'privacy', 'about_bot', 'want_report', 'talk_human', 'local_support'].includes(intent.id))
    || AFFIRM.test(text.trim()) || NEGATE.test(text.trim());
}

// ---------------------------------------------------------------------------------------------
// Support pathways
//   Serious concerns -> always the Guidance Office + the relevant authority + the crisis hotline.
//   Low-severity concerns -> may also suggest local support (class adviser, student council, SK),
//   always in addition to the Guidance Office, never instead of it.
// ---------------------------------------------------------------------------------------------
const SERIOUS_INTENTS = new Set(['self_harm', 'immediate_danger', 'abuse_home', 'sexual_harassment', 'physical', 'teacher']);
const LOW_SEVERITY_INTENTS = new Set(['verbal_social', 'peer_pressure', 'stress', 'sad_lonely', 'anxiety', 'cyberbullying', 'campus_safety']);
const LOCAL = say('Who else can I talk to?');

const FORMAL_CHANNELS_NOTE = "Please make sure your Guidance Office knows about this - I can send it to them privately. If you're in danger, call 911 or go to campus security. And if you need to talk to someone right now, the NCMH Crisis Hotline 1553 is free and open 24/7.";

/** True when a message or intent needs the formal channels (not just local support). */
export function isSeriousConcern(text, intentId) {
  return SERIOUS_INTENTS.has(intentId) || scoreSeverity(text).score >= 4;
}

/** Make sure a reply to a serious concern names the Guidance Office, an authority and the hotline. */
export function ensureFormalChannels(reply) {
  const hasGuidance = /guidance/i.test(reply);
  const hasAuthority = /\b911\b|campus security|vawc|police|principal/i.test(reply);
  const hasHotline = /\b1553\b/.test(reply);
  return hasGuidance && hasAuthority && hasHotline ? reply : `${reply}\n\n${FORMAL_CHANNELS_NOTE}`;
}

function seriousSuggestions(base) {
  const list = [...base];
  for (const chip of [PRIVATE, CALL_1553, HOTLINES]) if (!list.some((s) => s.label === chip.label)) list.push(chip);
  return list.slice(0, 4);
}

const LOCAL_SUPPORT_REPLY = "Besides the Guidance Office, there are other people who can help with everyday things:\n• Your class adviser\n• A student council (SSG / SSLG) officer you trust\n• A teacher you feel comfortable with\n• Your barangay's Sangguniang Kabataan (SK) for youth programs and community support\nThey're great for support alongside the counselors, not instead of them. If things ever feel serious or unsafe, the Guidance Office is always the place to go.";
const LOCAL_SUPPORT_SERIOUS_REPLY = "For what you've told me, please start with your Guidance Office. They're trained for this and can bring in the right people. I can send it to them privately. If you're in danger, call 911 or go to campus security, and the NCMH Crisis Hotline 1553 is free and open 24/7. A class adviser or student council officer you trust can be extra support too, but in addition to the counselors, not instead of them.";

/**
 * Offline reply for the latest student message. `history` is the normalized conversation; the
 * previous assistant turn may carry `offer` so short answers like "yes" are understood.
 */
export function offlineReply(history) {
  const latest = [...history].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '';
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const lastOffer = OFFERS.has(lastAssistant?.offer) ? lastAssistant.offer : null;

  const intent = matchIntent(latest);
  const isShort = latest.length <= 25;
  const serious = isSeriousConcern(latest, intent?.id);

  // Safety intents always win, even over a pending "yes/no".
  if (intent?.crisis) {
    return {
      reply: ensureFormalChannels(pickVariant(intent.replies, history)),
      crisis: true, serious: true, intent: intent.id, offer: null, suggestions: seriousSuggestions(intent.suggestions ?? []),
    };
  }

  if (intent?.id === 'local_support') {
    const earlierSerious = history.some((m) => m.role === 'user' && isSeriousConcern(m.content, matchIntent(m.content)?.id));
    return earlierSerious
      ? { reply: LOCAL_SUPPORT_SERIOUS_REPLY, crisis: false, serious: true, intent: 'local_support', offer: null, suggestions: [PRIVATE, CALL_1553, HOTLINES] }
      : { reply: LOCAL_SUPPORT_REPLY, crisis: false, serious: false, intent: 'local_support', offer: null, suggestions: [HOTLINES, PRIVATE] };
  }

  if (isShort && lastOffer && AFFIRM.test(latest)) {
    const f = FOLLOW_UPS[lastOffer];
    return { reply: f.reply, crisis: false, serious: false, intent: `follow_up:${lastOffer}`, offer: null, suggestions: f.suggestions };
  }
  if (isShort && NEGATE.test(latest)) {
    return {
      reply: "That's okay. We can just talk. What's been on your mind the most?",
      crisis: false, serious: false, intent: 'decline', offer: null, suggestions: [],
    };
  }

  if (intent) {
    let suggestions = intent.suggestions ?? [];
    // Incidents get report options.
    if (intent.offer === 'report_options') {
      suggestions = [PRIVATE, DRAFT, say('Tell you more first', 'I want to tell you more first')];
    }
    let reply = pickVariant(intent.replies, history);
    if (serious) {
      reply = ensureFormalChannels(reply);
      suggestions = seriousSuggestions(suggestions);
    } else if (LOW_SEVERITY_INTENTS.has(intent.id)) {
      suggestions = [...suggestions, LOCAL].slice(0, 4);
    }
    return { reply, crisis: false, serious, intent: intent.id, offer: intent.offer ?? null, suggestions };
  }

  // Nothing matched: reflect, and if they described an incident earlier, keep the report door open.
  const topics = detectTopics(history);
  const hadIncident = topics.some(isIncidentTopic);
  return {
    reply: serious ? ensureFormalChannels(pickVariant(FALLBACKS, history)) : pickVariant(FALLBACKS, history),
    crisis: false,
    serious,
    intent: 'fallback',
    offer: hadIncident ? 'report_options' : null,
    suggestions: serious ? seriousSuggestions([]) : hadIncident ? [PRIVATE, DRAFT] : [],
  };
}

/** Suggestions only (used alongside AI replies, which write their own text). */
export function suggestionsFor(history) {
  const r = offlineReply(history);
  // "reply" chips answer a question the AI may not have asked; keep action chips and the
  // "Who else can I talk to?" chip, which always makes sense.
  return r.suggestions.filter((s) => s.action !== 'reply' || s === LOCAL);
}
