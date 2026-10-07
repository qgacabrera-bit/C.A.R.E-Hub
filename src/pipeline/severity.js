// Rule-based urgency scoring (1-5). Each indicator carries a neutral, objective label that is reused
// in counselor summaries and public pattern notices - never a judgment about a person.

const INDICATORS = [
  // 5 - imminent danger to life
  { score: 5, label: 'self-harm or suicide risk', crisis: true, re: /\b(kill(?:ing)? myself|end(?:ing)? my life|suicid\w*|self[- ]?harm|cut(?:ting)? myself|hurt(?:ing)? myself|want(?:ed)? to die|don'?t want to (?:live|be here)|overdos\w*|no reason to live)\b/i },
  { score: 5, label: 'threat of violence or weapon', re: /\b(gun|knife|knives|weapon|bomb|shoot(?:ing)?|stab(?:bing)?|kill (?:him|her|them|you|us|me|everyone)|going to kill|murder)\b/i },

  // 4 - high priority
  { score: 4, label: 'unauthorized or intimate image sharing', re: /\b(non[- ]?consensual|without (?:my|her|his|their) (?:consent|permission)|nudes?|intimate (?:photos?|pics?|images?|videos?)|unauthori[sz]ed (?:photos?|pics?|images?|videos?)|private (?:photos?|pics?|videos?)|sextortion|upskirt)\b/i },
  { score: 4, label: 'sexual harassment', re: /\b(groped|groping|touched me|touching me|sexual(?:ly)? harass\w*|catcall\w*|lewd|molest\w*)\b/i },
  { score: 4, label: 'threats or intimidation', re: /\b(threat(?:en)?(?:ed|s|ing)?|blackmail\w*|extort\w*|or else|wait (?:for me )?after class)\b/i },
  // Plain-language threats ("she will hurt me", "they're gonna jump him").
  { score: 4, label: 'threats or intimidation', re: /\b(?:will|gonna|going to|'ll|wants? to|said (?:she|he|they)(?:'d| would)|threatened to)\s+(?:hurt|beat(?:\s+up)?|jump|get|stab|slap|punch|attack|break)\s+(?:me|you|him|her|them|us)\b/i },
  { score: 4, label: 'physical assault', re: /\b(assault\w*|beat(?:en|ing)? (?:me|him|her|them|up)|punch(?:ed|ing)?|choked|jumped (?:me|him|her))\b/i },
  { score: 4, label: 'stalking', re: /\b(stalk\w*|following me home|follows me home|tracking my location)\b/i },
  { score: 4, label: 'hazardous condition with injury risk', re: /\b(exposed (?:wires?|wiring)|gas leak|fire hazard|sparking|electrocut\w*|collaps\w*|ceiling (?:fell|is falling)|smell(?:s|ed)? (?:gas|smoke))\b/i },
  { score: 4, label: 'hazing', re: /\b(haz(?:ing|ed)|initiation rites?|paddl\w*)\b/i },

  // 3 - moderate
  { score: 3, label: 'physical contact', re: /\b(push(?:ed|ing)|shov(?:ed|ing)|kick(?:ed|ing)|slapp?(?:ed|ing)|hit me|tripp?(?:ed|ing) me|spat on)\b/i },
  { score: 3, label: 'online harassment', re: /\b(fake account|dummy account|posted (?:about|a photo|pics?|my)|edited (?:photos?|pics?)|meme(?:s|d)? (?:of|about) me|group ?chat|gc)\b.*\b(mock|laugh|insult|humiliat|harass|shame|edit)/i },
  { score: 3, label: 'online harassment', re: /\b(?:edited|photoshopped|morphed|doctored)\s+(?:pics?|photos?|pictures?|images?|videos?)\b/i },
  { score: 3, label: 'coercion to use substances', re: /\b(forc(?:ed|ing)|pressur(?:ed|ing)|made) (?:me|us|him|her|them) (?:to )?(?:drink|vape|smoke|take|try)\b|\b(vape|alcohol|weed|drugs?|pills?)\b.*\b(forced|pressured|dared)\b/i },
  { score: 3, label: 'exclusion or isolation', re: /\b(excluded|exclud(?:e|ing) me|isolat\w*|no one talks to me|everyone ignores me|kicked (?:me )?out of the (?:group|gc))\b/i },
  { score: 3, label: 'emotional distress', re: /\b(panic attacks?|can'?t (?:sleep|eat|breathe)|hopeless|breaking down|anxiety attacks?|depress\w*|scared to go to school|afraid to go to school)\b/i },
  { score: 3, label: 'safety hazard', re: /\b(broken (?:railing|stairs?|steps?|glass|door|lock)|slippery|no lights?|lights? (?:are|is|have been) out|dark (?:hallway|corridor|area)|loose (?:tiles?|railing)|flood\w*|unsafe|no guard)\b|\b(?:railing|stairs?|steps?|tiles?|ceiling|door)\b[^.]{0,40}\b(?:loose|broken|wobbl\w*|cracked)\b/i },
  { score: 3, label: 'near-miss injury', re: /\b(?:almost|nearly) (?:slipped|fell|fall|got hit|hit|drowned|electrocuted|injured)\b/i },

  // 2 - low
  { score: 2, label: 'verbal taunting', re: /\b(teas(?:e|ed|ing)|name[- ]calling|calling (?:me|him|her|them) names|mock(?:ed|ing)?|insult\w*|laugh(?:ed|ing)? at|slur\w*|taunt\w*|body[- ]sham\w*)\b/i },
  { score: 2, label: 'rumors or gossip', re: /\b(rumou?rs?|gossip\w*|spreading lies|talking behind)\b/i },
  { score: 2, label: 'peer pressure', re: /\b(pressur\w*|dared|forced to|made me)\b/i },
  { score: 2, label: 'theft or property interference', re: /\b(stole|stolen|took my|taking my|vandali[sz]\w*|destroyed my|broke my|throw(?:s|ing)? (?:away )?my|threw (?:away )?my)\b/i },
];

const REPETITION_RE = /\b(every ?(?:day|afternoon|morning|week|class|time)|daily|always|again and again|repeatedly|for (?:weeks|months|days)|keeps? (?:on )?\w+ing|(?:still|kept) happening|multiple times|many times|several times)\b/i;

/**
 * Score a sanitized narrative. Returns { score, indicators: string[], crisis: boolean, repeated }.
 * Category and cluster size are taken into account so systemic patterns rise in priority.
 */
export function scoreSeverity(text, { category, clusterSize = 0, systemicClusterSize = 4 } = {}) {
  const hits = INDICATORS.filter((ind) => ind.re.test(text));
  let score = hits.reduce((max, h) => Math.max(max, h.score), 1);
  const indicators = [...new Set(hits.map((h) => h.label))];
  const crisis = hits.some((h) => h.crisis);
  const repeated = REPETITION_RE.test(text);

  // Repeated moderate harassment is treated as systemic.
  if (repeated && score === 3) {
    score = 4;
    indicators.push('repeated pattern reported');
  } else if (repeated && score === 2) {
    score = 3;
    indicators.push('repeated pattern reported');
  }

  if (category === 'Mental Health' && score < 2) score = 2; // always routed with care

  if (clusterSize >= systemicClusterSize && score < 4) {
    score = 4;
    indicators.push('recurring cluster of similar reports');
  }

  return { score: Math.min(5, Math.max(1, score)), indicators: [...new Set(indicators)], crisis, repeated };
}

export const severityLabel = (s) => ['', 'Low', 'Guarded', 'Moderate', 'High Priority', 'Critical'][s] || 'Unknown';
