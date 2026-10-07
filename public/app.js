import { $, el, taggedText, timeAgo, sevBadge, hashtag, api, storage } from './common.js';

const state = { meta: null, topics: new Set(), secret: null, handle: '', chat: [], view: 'feed' };

// Identity colors for topic dots (decorative; topic names are always shown as text).
const TOPIC_COLORS = {
  Bullying: '#2a78d6',
  Cyberbullying: '#eb6834',
  'Peer Pressure': '#1baf7a',
  'Campus Safety': '#eda100',
  'Mental Health': '#e87ba4',
};

const STANDARDS = [
  'Share experiences, not accusations: describe what happened, never name or tag people.',
  'Support only. React with care; no call-outs, exposing, or pile-ons.',
  'Keep photos of others off the feed. Counselors can receive them privately.',
  'Urgent safety concerns go privately to counselors, not the public feed.',
  'In danger right now? Call 1553 or 911 first.',
];

// ---------------------------------------------------------------------------------------------
// Anonymous identity: a random secret kept on this device. The server only stores its hash.
// ---------------------------------------------------------------------------------------------
function newSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function getSecret() {
  let s = storage.get('care.secret');
  if (!s) {
    s = newSecret();
    storage.set('care.secret', s);
  }
  return s;
}
const sessionHeaders = () => ({ 'X-Anon-Session': state.secret });

function paintAvatar(node, handle) {
  const digits = handle.replace(/\D/g, '');
  node.textContent = digits.slice(-2) || '#';
  node.style.setProperty('--hue', String((Number(digits) * 47) % 360));
}
function renderIdentity() {
  document.querySelectorAll('[data-handle]').forEach((n) => (n.textContent = state.handle || 'Student #…'));
  document.querySelectorAll('[data-avatar]').forEach((n) => paintAvatar(n, state.handle));
}
async function loadIdentity() {
  const data = await api('/api/my-posts', { method: 'POST', body: { secret: state.secret } });
  state.handle = data.handle;
  renderIdentity();
  return data;
}

$('#reset-identity').addEventListener('click', async () => {
  if (!confirm('Start a new anonymous identity? This browser will no longer see the status of your earlier reports. Counselors still keep them.')) return;
  state.secret = newSecret();
  storage.set('care.secret', state.secret);
  await loadIdentity();
  if (state.view === 'mine') loadMine();
  loadFeed();
});

// ---------------------------------------------------------------------------------------------
// Views (hash-based so the back button works; the hash never reaches the server)
// ---------------------------------------------------------------------------------------------
const VIEWS = ['feed', 'mine', 'guidelines', 'hotlines'];
function showView(name, { push = true } = {}) {
  if (!VIEWS.includes(name)) name = 'feed';
  state.view = name;
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  document.querySelectorAll('.nav-link').forEach((b) => (b.dataset.view === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (push && location.hash !== `#${name}`) history.pushState(null, '', name === 'feed' ? location.pathname : `#${name}`);
  if (name === 'feed') loadFeed();
  if (name === 'mine') loadMine();
  closeDrawer();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-view-link]');
  if (link) {
    e.preventDefault();
    showView(link.dataset.viewLink);
  }
});
window.addEventListener('popstate', () => showView(location.hash.slice(1) || 'feed', { push: false }));

// Mobile drawer
function openDrawer() {
  $('#rail-left').classList.add('open');
  $('#drawer-backdrop').hidden = false;
  $('#menu-btn').setAttribute('aria-expanded', 'true');
}
function closeDrawer() {
  $('#rail-left').classList.remove('open');
  $('#drawer-backdrop').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}
$('#menu-btn').addEventListener('click', openDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    document.querySelectorAll('.react-wrap.open').forEach((w) => w.classList.remove('open'));
  }
});

// ---------------------------------------------------------------------------------------------
// Sidebar cards: helplines, patterns, standards
// ---------------------------------------------------------------------------------------------
function svgIcon(id, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}
const phoneIcon = () => svgIcon('i-phone');
function helplineRow(c) {
  const dialable = /^[\d-]+$/.test(c.number);
  return el('div', { class: 'helpline' },
    el('div', {}, el('strong', { text: c.label.replace(/\s*\(demo placeholder\)/i, '') }), el('small', { text: c.note })),
    dialable
      ? el('a', { class: 'call-btn', href: `tel:${c.number.replace(/-/g, '')}`, 'aria-label': `Call ${c.label} ${c.number}` }, phoneIcon(), c.number)
      : el('span', { class: 'pill', text: c.number }),
  );
}
function renderHelplines() {
  const all = state.meta.emergencyContacts;
  const compact = [
    all.find((c) => c.number === '1553'),
    all.find((c) => /campus security/i.test(c.label)),
    all.find((c) => c.number === '911'),
  ].filter(Boolean);
  document.querySelectorAll('[data-helplines]').forEach((node) => {
    const list = node.dataset.helplines === 'all' ? all : compact;
    node.replaceChildren(...list.map(helplineRow),
      ...(node.dataset.helplines === 'all' ? [] : [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-view-link': 'hotlines' }, 'All hotlines')]));
  });
}

async function loadPatterns() {
  let patterns = [];
  try {
    patterns = await api('/api/patterns');
  } catch {
    /* sidebar is best-effort */
  }
  document.querySelectorAll('[data-patterns]').forEach((node) => {
    if (!patterns.length) return node.replaceChildren(el('p', { class: 'small muted', text: 'No recurring patterns right now.' }));
    node.replaceChildren(...patterns.map((p) => el('div', { class: 'pattern' },
      el('div', { class: 'pattern-title', text: p.title }),
      el('div', { class: 'pattern-meta' },
        el('span', { class: p.status === 'Under counselor review' ? 'pill pill-brand' : 'pill', text: p.status }),
        el('span', { text: `${p.report_count} reports · ${timeAgo(p.last_reported_at)}` }),
      ),
    )));
  });
}

function renderStandards() {
  document.querySelectorAll('[data-standards]').forEach((ul) => ul.replaceChildren(...STANDARDS.map((s) => el('li', { text: s }))));
}

// ---------------------------------------------------------------------------------------------
// Topic filter (multi-select)
// ---------------------------------------------------------------------------------------------
function saveTopics() {
  storage.set('care.topics', JSON.stringify([...state.topics]));
}
function renderTopics() {
  const list = $('#topic-list');
  const option = (label, checked, onChange, color) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const dot = color ? el('span', { class: 'topic-dot', 'aria-hidden': 'true' }) : null;
    if (dot) dot.style.setProperty('--dot', color);
    return el('label', { class: 'topic' }, input, el('span', { text: label }), dot);
  };
  list.replaceChildren(
    option('All Topics', state.topics.size === 0, () => setTopics([])),
    ...state.meta.categories.map((c) => option(c, state.topics.has(c), (on) => {
      const next = new Set(state.topics);
      if (on) next.add(c);
      else next.delete(c);
      setTopics([...next]);
    }, TOPIC_COLORS[c])),
  );
}
function setTopics(list) {
  state.topics = new Set(list.length === state.meta.categories.length ? [] : list);
  saveTopics();
  renderTopics();
  loadFeed();
}
$('#topics-reset').addEventListener('click', () => setTopics([]));

// ---------------------------------------------------------------------------------------------
// Reactions: primary button + hover dock + count chips
// ---------------------------------------------------------------------------------------------
// Presentation lives client-side; the server only knows the stable kind keys.
const REACTION_UI = {
  support: { icon: 'i-heart', label: 'Support', short: 'Support' },
  strength: { icon: 'i-users', label: 'Solidarity', short: 'Solidarity' },
  same: { icon: 'i-smile', label: "You're Not Alone", short: 'Not Alone' },
  heard: { icon: 'i-ear', label: 'Heard', short: 'Heard' },
};
const reactionIcon = (kind, size = '') => svgIcon(REACTION_UI[kind].icon, `icon rx-icon rx-${kind} ${size}`.trim());

function buildReactions(post) {
  const R = REACTION_UI;
  const kinds = Object.keys(R);
  post.reactions ??= {};
  const wrap = el('div', { class: 'react-wrap' });
  const primary = el('button', { class: 'react-primary', type: 'button' });
  const dockInner = el('div', { class: 'dock-inner', role: 'toolbar', 'aria-label': 'Choose a reaction' });
  const dock = el('div', { class: 'reactions-dock' }, dockInner);
  const chips = el('div', { class: 'react-chips' });

  const paint = () => {
    const mine = Object.hasOwn(R, post.my_reaction ?? '') ? post.my_reaction : null;
    primary.replaceChildren(reactionIcon(mine ?? 'support'), R[mine ?? 'support'].short);
    primary.setAttribute('aria-pressed', String(Boolean(mine)));
    primary.setAttribute('aria-label', mine ? `Remove your ${R[mine].label} reaction` : 'React with Support');
    dockInner.querySelectorAll('.dock-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === mine)));
    chips.replaceChildren(...kinds
      .filter((k) => post.reactions[k] > 0)
      .sort((a, b) => post.reactions[b] - post.reactions[a])
      .map((k) => {
        const chip = el('button', {
          class: 'react-chip', type: 'button', 'aria-pressed': String(k === mine),
          'aria-label': `${R[k].label}: ${post.reactions[k]}${k === mine ? ' (yours, click to remove)' : ' (click to react)'}`,
          title: R[k].label,
        }, reactionIcon(k, 'rx-sm'), el('b', { text: post.reactions[k] }));
        chip.addEventListener('click', () => react(k));
        return chip;
      }));
  };

  async function react(kind) {
    wrap.classList.remove('open');
    try {
      const res = await api(`/api/posts/${post.id}/react`, { method: 'POST', body: { secret: state.secret, kind } });
      post.my_reaction = res.my_reaction;
      post.reactions = res.reactions;
      paint();
    } catch (e) {
      primary.title = e.message;
    }
  }

  for (const k of kinds) {
    const b = el('button', { class: 'dock-btn', type: 'button', 'data-kind': k, 'data-tip': R[k].label, 'aria-label': `React with ${R[k].label}` }, reactionIcon(k, 'rx-lg'));
    b.addEventListener('click', () => react(k));
    dockInner.append(b);
  }

  // Click: toggle your current reaction, or add Support. Touch long-press opens the dock.
  let longPressed = false;
  let pressTimer;
  primary.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      wrap.classList.add('open');
    }, 420);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => primary.addEventListener(t, () => clearTimeout(pressTimer)));
  primary.addEventListener('contextmenu', (e) => {
    if (longPressed) e.preventDefault();
  });
  primary.addEventListener('click', () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    react(post.my_reaction ?? 'support');
  });

  wrap.append(dock, primary);
  paint();
  return [wrap, chips];
}
document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll('.react-wrap.open').forEach((w) => {
    if (!w.contains(e.target)) w.classList.remove('open');
  });
});

// ---------------------------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------------------------
function postHeader({ handle, category, location, created_at }) {
  const avatar = el('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true' });
  paintAvatar(avatar, handle);
  return el('div', { class: 'post-head' },
    avatar,
    el('div', { class: 'post-who' },
      el('div', { class: 'post-handle', text: handle }),
      el('div', { class: 'post-sub' }, el('span', { class: 'hashtag', text: hashtag(category) }), el('span', { text: `· ${location} · ${timeAgo(created_at)}` })),
    ),
  );
}

function patternPill(pattern) {
  if (!pattern) return null;
  const status = { active: 'Pattern observed', reviewing: 'Under counselor review', resolved: 'Addressed by student welfare' }[pattern.status] ?? 'Pattern observed';
  return el('span', { class: 'pill pill-brand', title: 'Similar reports are grouped so counselors can spot patterns' }, `${status} · ${pattern.report_count} similar reports`);
}

function renderPost(p) {
  return el('article', { class: 'card post' },
    postHeader(p),
    el('p', { class: 'post-body' }, taggedText(p.content)),
    p.pattern ? el('div', { class: 'meta-row' }, patternPill(p.pattern)) : null,
    el('div', { class: 'post-foot' }, ...buildReactions(p)),
  );
}

function renderNotice(n) {
  return el('article', { class: 'card post notice' },
    el('div', { class: 'notice-title' }, 'Campus Incident Update (Sanitized)', el('span', { class: 'hashtag', text: '#CampusSafety' })),
    el('p', { class: 'post-body' }, n.text),
    el('div', { class: 'meta-row' }, el('span', { class: 'pill pill-brand', text: n.status }), el('span', { class: 'small muted', text: `Updated ${timeAgo(n.updated_at)}` })),
  );
}

let feedSeq = 0;
async function loadFeed() {
  const feed = $('#feed');
  const seq = ++feedSeq;
  try {
    const q = state.topics.size ? `?categories=${encodeURIComponent([...state.topics].join(','))}` : '';
    const data = await api(`/api/feed${q}`, { headers: sessionHeaders() });
    if (seq !== feedSeq) return; // a newer filter change won
    const items = [...data.notices.map(renderNotice), ...data.posts.map(renderPost)];
    feed.replaceChildren(...(items.length ? items : [el('div', { class: 'card empty', text: 'No posts in these topics yet.' })]));
  } catch (e) {
    feed.replaceChildren(el('div', { class: 'alert alert-error', text: `Couldn't load the feed: ${e.message}` }));
  }
}

// ---------------------------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------------------------
const PREVIEW_MIN = 15;

function openComposer() {
  $('#composer-collapsed').hidden = true;
  $('#composer-form').hidden = false;
  if (state.view !== 'feed') showView('feed');
  $('#category-select').focus();
}
function collapseComposer() {
  $('#composer-form').hidden = true;
  $('#composer-collapsed').hidden = false;
}
function resetComposer() {
  $('#composer-form').reset();
  $('#category-select').value = '';
  $('#char-count').textContent = '0';
  $('#privacy-preview').hidden = true;
  $('#file-chip').hidden = true;
  showFormError('');
}
$('#composer-open').addEventListener('click', openComposer);
$('#composer-close').addEventListener('click', collapseComposer); // keeps the draft
$('#composer-discard').addEventListener('click', () => {
  if ($('#narrative').value.trim() && !confirm('Discard this post?')) return;
  resetComposer();
  collapseComposer();
});

function fillSelectors() {
  $('#category-select').append(...state.meta.categories.map((c) => el('option', { value: c, text: c })));
  $('#location-list').replaceChildren(...state.meta.locations.map((l) => el('option', { value: l })));
}

let previewTimer;
let previewSeq = 0;
function schedulePreview() {
  const text = $('#narrative').value;
  $('#char-count').textContent = text.length.toLocaleString('en-US');
  clearTimeout(previewTimer);
  if (text.trim().length < PREVIEW_MIN) {
    $('#privacy-preview').hidden = true;
    return;
  }
  previewTimer = setTimeout(async () => {
    const seq = ++previewSeq;
    try {
      const res = await api('/api/preview', { method: 'POST', body: { narrative: text, category: $('#category-select').value } });
      if (seq !== previewSeq) return;
      $('#preview-text').replaceChildren(taggedText(res.text));
      $('#preview-flags').replaceChildren(...[
        res.redaction_count ? el('span', { class: 'pill pill-brand', text: `${res.redaction_count} identifier${res.redaction_count === 1 ? '' : 's'} removed` }) : el('span', { class: 'pill', text: 'No identifiers found' }),
        res.private_routing ? el('span', { class: 'pill flag-private', text: 'Will go privately to counselors - not shown on the feed' }) : null,
        res.held_for_moderation && !res.private_routing ? el('span', { class: 'pill', text: 'A counselor will review this before it posts' }) : null,
      ].filter(Boolean));
      const crisis = $('#privacy-preview').querySelector('.alert-crisis');
      if (res.crisis && !crisis) $('#privacy-preview').append(crisisCard());
      if (!res.crisis && crisis) crisis.remove();
      $('#privacy-preview').hidden = false;
    } catch {
      /* preview is best-effort */
    }
  }, 350);
}
$('#narrative').addEventListener('input', schedulePreview);
$('#category-select').addEventListener('change', schedulePreview);

$('#attachment').addEventListener('change', () => {
  const file = $('#attachment').files[0];
  $('#file-chip').hidden = !file;
  if (file) $('#file-chip').textContent = `${file.name.slice(0, 24)} · counselors only`;
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(file);
  });
}
function showFormError(msg) {
  $('#form-error').textContent = msg;
  $('#form-error').hidden = !msg;
}

$('#composer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError('');
  const category = $('#category-select').value;
  const location = $('#location-input').value.trim();
  const narrative = $('#narrative').value.trim();
  if (!category) return showFormError('Choose a category for your post.');
  if (location.length < 2) return showFormError('Add a campus location (pick a suggestion or type your own).');
  if (narrative.length < 20) return showFormError('Describe what happened in at least 20 characters.');
  if (!$('#ack').checked) return showFormError('Please confirm the community standards before posting.');
  const file = $('#attachment').files[0];
  if (file && file.size > 2 * 1024 * 1024) return showFormError('The photo is larger than 2 MB.');

  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Anonymizing…';
  try {
    const result = await api('/api/posts', {
      method: 'POST',
      body: { secret: state.secret, category, location_tag: location, narrative, acknowledged: true, attachment: file ? await readFile(file) : undefined },
    });
    resetComposer();
    collapseComposer();
    renderResult(result);
    loadFeed();
    loadPatterns();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post Anonymously';
  }
});

function crisisCard() {
  return el('div', { class: 'alert alert-crisis', role: 'alert' },
    el('strong', { text: 'You matter, and you don\'t have to face this alone.' }),
    el('p', {}, 'Please reach out right now: ', el('a', { href: 'tel:1553' }, 'NCMH Crisis Hotline 1553'), ' · ',
      el('a', { href: 'tel:09178998727' }, '0917-899-8727'), ' · ', el('a', { href: 'tel:911' }, 'Emergency 911'),
      '. If you can, go to a trusted adult or your Guidance Office now.'),
  );
}

const STATUS_COPY = {
  published: ['Posted anonymously', 'Your post is live on the feed with identifying details removed.'],
  flagged_admin: ['Sent privately to counselors', 'This looked urgent, so it went straight to the counselor priority queue instead of the public feed. Pending counselor review.'],
  pending_moderation: ['Waiting for review', 'A counselor will check this before it can be published. This happens when a post may still identify someone or reads like a call-out.'],
};

function renderResult(r) {
  const [title, body] = STATUS_COPY[r.status] ?? ['Received', ''];
  const box = $('#report-result');
  box.hidden = false;
  box.replaceChildren(...[
    r.crisis ? crisisCard() : null,
    el('div', { class: 'card stack' },
      el('div', { class: 'card-title' }, el('span', { text: title }), el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => (box.hidden = true) }, '×')),
      el('p', { class: 'muted small', text: body }),
      el('div', { class: 'meta-row' },
        sevBadge(r.severity_score, r.severity_label),
        el('span', { class: 'pill', text: `${r.redaction_count} identifier(s) removed` }),
        r.cluster ? el('span', { class: 'pill pill-brand', text: `Linked to a pattern · ${r.cluster.report_count} similar reports` }) : null,
      ),
      el('div', { class: 'privacy-preview' }, el('div', { class: 'privacy-preview-text' }, taggedText(r.sanitized_content))),
      el('div', {}, el('button', { class: 'btn btn-sm', type: 'button', 'data-view-link': 'mine' }, 'Track in My Reports')),
    ),
  ].filter(Boolean));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------------------------
// My reports
// ---------------------------------------------------------------------------------------------
async function loadMine() {
  const list = $('#my-posts');
  try {
    const data = await loadIdentity();
    if (!data.posts.length) {
      list.replaceChildren(el('div', { class: 'card empty', text: 'You haven\'t shared anything from this browser yet.' }));
      return;
    }
    list.replaceChildren(...data.posts.map((p) => el('article', { class: 'card post' },
      postHeader({ handle: data.handle, category: p.category, location: p.location, created_at: p.created_at }),
      el('p', { class: 'post-body' }, taggedText(p.content)),
      el('div', { class: 'meta-row' }, sevBadge(p.severity_score, p.severity_label), patternPill(p.pattern)),
      el('div', { class: 'alert' }, el('strong', { text: 'Status: ' }), p.follow_up),
      p.status !== 'flagged_admin' ? el('div', { class: 'post-foot' },
        el('button', {
          class: 'btn btn-sm btn-ghost btn-danger', type: 'button',
          onclick: async (ev) => {
            if (!confirm('Remove this post? This cannot be undone.')) return;
            ev.currentTarget.disabled = true;
            try {
              await api(`/api/my-posts/${p.id}/withdraw`, { method: 'POST', body: { secret: state.secret } });
              loadMine();
            } catch (e) {
              alert(e.message);
            }
          },
        }, 'Remove post'),
      ) : null,
    )));
  } catch (e) {
    list.replaceChildren(el('div', { class: 'alert alert-error', text: e.message }));
  }
}

// ---------------------------------------------------------------------------------------------
// Adviser
// ---------------------------------------------------------------------------------------------
function openAdviser() {
  $('#adviser').hidden = false;
  $('#adviser-fab').hidden = true;
  $('#adviser-fab').setAttribute('aria-expanded', 'true');
  if (!state.chat.length) pushMessage('assistant', 'Hi, I\'m the C.A.R.E. Adviser. I\'m here to listen and help you think things through. You don\'t need to share any names. What\'s on your mind?', false);
  $('#adviser-input').focus();
}
function closeAdviser() {
  $('#adviser').hidden = true;
  $('#adviser-fab').hidden = false;
  $('#adviser-fab').setAttribute('aria-expanded', 'false');
  $('#adviser-fab').focus();
}
$('#adviser-fab').addEventListener('click', openAdviser);
$('#adviser-close').addEventListener('click', closeAdviser);

function saveChat() {
  try {
    sessionStorage.setItem('care.chat', JSON.stringify(state.chat));
  } catch {
    /* ignore */
  }
}
function renderChat() {
  $('#adviser-log').replaceChildren(...state.chat.map((m) => (m.crisis ? crisisCard() : el('div', { class: `msg msg-${m.role}`, text: m.content }))));
  $('#adviser-log').scrollTop = $('#adviser-log').scrollHeight;
}
function pushMessage(role, content, persist = true) {
  state.chat.push({ role, content });
  if (persist) saveChat();
  renderChat();
}

$('#adviser-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#adviser-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  pushMessage('user', text);
  $('#adviser-log').append(el('div', { class: 'msg msg-assistant muted', text: 'Adviser is typing…' }));
  $('#adviser-log').scrollTop = $('#adviser-log').scrollHeight;
  try {
    const res = await api('/api/adviser/chat', { method: 'POST', body: { messages: state.chat.filter((m) => !m.crisis) } });
    if (res.crisis) state.chat.push({ role: 'assistant', content: '', crisis: true });
    pushMessage('assistant', res.reply);
  } catch (err) {
    pushMessage('assistant', `Sorry, I couldn't respond just now (${err.message}). If this is urgent, call NCMH 1553 or 911.`, false);
  }
});
$('#adviser-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#adviser-form').requestSubmit();
  }
});
$('#adviser-clear').addEventListener('click', () => {
  state.chat = [];
  saveChat();
  openAdviser();
});
$('#adviser-draft').addEventListener('click', async () => {
  const btn = $('#adviser-draft');
  btn.disabled = true;
  btn.textContent = 'Drafting…';
  try {
    const draft = await api('/api/adviser/draft', { method: 'POST', body: { messages: state.chat.filter((m) => !m.crisis) } });
    openComposer();
    $('#category-select').value = draft.category;
    $('#location-input').value = draft.location_tag;
    $('#narrative').value = draft.narrative;
    schedulePreview();
    pushMessage('assistant', 'I put a draft in the post composer. Please read it over and change anything that isn\'t right. Nothing is shared until you press Post Anonymously.');
  } catch (err) {
    pushMessage('assistant', err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft a post';
  }
});

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
async function boot() {
  state.secret = getSecret();
  try {
    state.topics = new Set(JSON.parse(storage.get('care.topics') || '[]'));
  } catch {
    state.topics = new Set();
  }
  try {
    state.chat = JSON.parse(sessionStorage.getItem('care.chat') || '[]');
  } catch {
    state.chat = [];
  }
  state.meta = await api('/api/meta');
  state.topics = new Set([...state.topics].filter((t) => state.meta.categories.includes(t)));
  if (!state.meta.llm.enabled) $('#adviser-mode').textContent = 'Guided support assistant (offline mode) · not a counselor · chats are not stored';
  renderStandards();
  renderHelplines();
  renderTopics();
  fillSelectors();
  renderChat();
  loadIdentity().catch(() => {});
  loadPatterns();
  showView(location.hash.slice(1) || 'feed', { push: false });
}

boot().catch((e) => {
  $('#feed').replaceChildren(el('div', { class: 'alert alert-error', text: `C.A.R.E. Hub couldn't start: ${e.message}` }));
});
