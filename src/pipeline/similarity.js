// TF-IDF cosine similarity over sanitized narratives. Runs fully offline, so clustering works in
// demos without any embedding service. Redaction tags are ignored so "[Student A]" never drives a match.

const STOP = new Set(`
a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other
our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
these they this those through to too under until up very was we were what when where which while who whom why will
with would you your yours yourself yourselves also still really even got get gets getting like one ones im ive dont
cant wont didnt doesnt isnt arent wasnt
`.trim().split(/\s+/));

// Light stemming plus a few synonym folds so "photos"/"pics"/"pictures" land on the same term.
const SYNONYMS = {
  pic: 'photo', picture: 'photo', image: 'photo', img: 'photo', video: 'photo',
  chem: 'chemistry', laboratory: 'lab',
  gc: 'groupchat', chat: 'groupchat',
  tease: 'taunt', mock: 'taunt', insult: 'taunt', name: 'taunt',
  shove: 'push', vape: 'vape', vaping: 'vape',
};

function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return SYNONYMS[w] ?? w;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, '').replace(/'/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * Compare `text` against `docs` ([{ id, text }]). Returns [{ id, score }] sorted by score desc.
 * IDF is computed over the candidate corpus plus the new text.
 */
export function rankSimilar(text, docs) {
  const queryTokens = tokenize(text);
  if (!queryTokens.length || !docs.length) return [];
  const docTokens = docs.map((d) => tokenize(d.text));
  const N = docs.length + 1;
  const df = new Map();
  for (const tokens of [queryTokens, ...docTokens]) for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const vectorize = (tokens) => {
    const v = new Map();
    for (const [t, f] of termFreq(tokens)) v.set(t, (1 + Math.log(f)) * idf(t));
    return v;
  };
  const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));

  const q = vectorize(queryTokens);
  const qn = norm(q);
  return docs
    .map((d, i) => {
      const v = vectorize(docTokens[i]);
      let dot = 0;
      for (const [t, w] of q) if (v.has(t)) dot += w * v.get(t);
      const denom = qn * norm(v);
      return { id: d.id, score: denom ? Number((dot / denom).toFixed(3)) : 0 };
    })
    .sort((a, b) => b.score - a.score);
}
