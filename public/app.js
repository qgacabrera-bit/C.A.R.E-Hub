import { $, el, taggedText, timeAgo, sevBadge, hashtag, api, storage } from './common.js';

const state = { meta: null, topics: new Set(), secret: null, handle: '', chat: [], view: 'feed',privateDraft: null, chatBusy: false };

// Identity colors for topic dots (decorative; topic names are always shown as text).

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

// Anonymous animal avatars. The animal and background come from the student's anonymous number, so
// they look random but stay the same for that student (and change with "New Identity").
const AVATAR_ANIMALS = ['cat', 'dog', 'owl', 'fox', 'bear', 'rabbit', 'panda', 'penguin', 'frog', 'koala', 'chick', 'sheep'];
const AVATAR_BACKGROUNDS = [1, 2, 3, 4, 5, 6].map((i) => `var(--avatar-${i})`); // warm tints, defined in styles.css

function paintAvatar(node, handle) {
  const n = Number(String(handle).replace(/\D/g, '')) || 0;
  const animal = AVATAR_ANIMALS[n % AVATAR_ANIMALS.length];
  node.replaceChildren(svgIcon(`av-${animal}`, 'avatar-art'));
  node.style.setProperty('--avatar-bg', AVATAR_BACKGROUNDS[Math.floor(n / AVATAR_ANIMALS.length) % AVATAR_BACKGROUNDS.length]);
  node.title = `Anonymous ${animal.charAt(0).toUpperCase()}${animal.slice(1)}`;
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
    closeReactionDocks();
  }
});

// ---------------------------------------------------------------------------------------------
// Sidebar cards: helplines, concerns raised, standards
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
  // Placeholders (09XX-XXX-XXXX, Local XXXX) are never dialable, so a tap can't call a random number.
  const dialable = !c.placeholder && /^[\d-]+$/.test(c.number);
  return el('div', { class: 'helpline' },
    el('div', {}, el('strong', { text: c.label }), el('small', { text: c.note })),
    dialable
      ? el('a', { class: 'call-btn', href: `tel:${c.number.replace(/-/g, '')}`, 'aria-label': `Call ${c.label} ${c.number}` }, phoneIcon(), c.number)
      : el('span', { class: 'pill', title: c.placeholder ? 'Placeholder - the real number will be added by your school' : null, text: c.number }),
  );
}

const CONTACT_GROUPS = [
  ['crisis', 'Talk to someone now · 24/7'],
  ['campus', 'On campus'],
  ['community', 'In your community'],
];

function renderHelplines() {
  const all = state.meta.emergencyContacts;
  // Sidebar: the two always-available lines plus the counselors; the full list is one tap away.
  const compact = [
    all.find((c) => c.number === '1553'),
    all.find((c) => /guidance/i.test(c.label)),
    all.find((c) => c.number === '911'),
  ].filter(Boolean);
  document.querySelectorAll('[data-helplines]').forEach((node) => {
    if (node.dataset.helplines === 'all') {
      node.replaceChildren(...CONTACT_GROUPS.map(([key, title]) => {
        const rows = all.filter((c) => (c.group ?? 'crisis') === key);
        return rows.length ? el('section', { class: 'helpline-group' }, el('h2', { class: 'helpline-group-title', text: title }), ...rows.map(helplineRow)) : null;
      }).filter(Boolean));
      return;
    }
    node.replaceChildren(...compact.map(helplineRow),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-view-link': 'hotlines' }, 'See all contacts'));
  });
}

// "N students shared this" (falls back to the report count from an older server).
function sharedBy(info) {
  const n = info.student_count ?? info.report_count;
  return `${n} student${n === 1 ? '' : 's'} shared this`;
}

async function loadConcerns() {
  let concerns = [];
  try {
    concerns = await api('/api/patterns');
  } catch {
    /* sidebar is best-effort */
  }
  document.querySelectorAll('[data-concerns]').forEach((node) => {
    if (!concerns.length) return node.replaceChildren(el('p', { class: 'small muted', text: 'No concerns raised right now.' }));
    node.replaceChildren(...concerns.map((c) => el('div', { class: 'concern' },
      el('div', { class: 'concern-title', text: c.title }),
      el('div', { class: 'concern-meta' },
        el('span', { class: 'pill pill-status', text: c.status }),
        el('span', { text: `${sharedBy(c)} · ${timeAgo(c.last_reported_at)}` }),
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
  // Topics are identified by their labels only.
  const option = (label, checked, onChange) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'topic' }, input, el('span', { text: label }));
  };
  list.replaceChildren(
    option('All Topics', state.topics.size === 0, () => setTopics([])),
    ...state.meta.categories.map((c) => option(c, state.topics.has(c), (on) => {
      const next = new Set(state.topics);
      if (on) next.add(c);
      else next.delete(c);
      setTopics([...next]);
    })),
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
  const dockId = `rx-dock-${post.id}`;
  const wrap = el('div', { class: 'react-wrap' });
  const primary = el('button', { class: 'react-primary', type: 'button', 'aria-expanded': 'false', 'aria-controls': dockId });
  const dockInner = el('div', { class: 'dock-inner', role: 'group', 'aria-label': 'Reactions' });
  const dock = el('div', { class: 'reactions-dock', id: dockId }, dockInner);

  const setOpen = (open) => {
    wrap.classList.toggle('open', open);
    primary.setAttribute('aria-expanded', String(open));
  };

  const paint = () => {
    const mine = Object.hasOwn(R, post.my_reaction ?? '') ? post.my_reaction : null;
    const total = kinds.reduce((sum, k) => sum + (post.reactions[k] || 0), 0);
    const label = mine ? R[mine].short : 'Support';
    primary.classList.toggle('is-mine', Boolean(mine));
    primary.replaceChildren(reactionIcon(mine ?? 'support'), el('span', { text: label }), el('span', { class: 'react-total', text: `· ${total}` }));
    primary.setAttribute('aria-label', `${mine ? `You reacted ${R[mine].label}` : 'Support'}, ${total} reaction${total === 1 ? '' : 's'}. Show reaction options`);
    dockInner.querySelectorAll('.dock-btn').forEach((b) => {
      const k = b.dataset.kind;
      const n = post.reactions[k] || 0;
      b.setAttribute('aria-pressed', String(k === mine));
      b.setAttribute('aria-label', `${R[k].label}, ${n}${k === mine ? ' (your reaction, select to remove)' : ''}`);
      b.querySelector('.dock-count').textContent = n;
    });
  };

  async function react(kind) {
    setOpen(false);
    try {
      const res = await api(`/api/posts/${post.id}/react`, { method: 'POST', body: { secret: state.secret, kind } });
      post.my_reaction = res.my_reaction;
      post.reactions = res.reactions;
      paint();
    } catch (e) {
      primary.title = e.message;
    }
    primary.focus();
  }

  for (const k of kinds) {
    const b = el('button', { class: 'dock-btn', type: 'button', 'data-kind': k, title: R[k].label },
      reactionIcon(k, 'rx-lg'), el('span', { class: 'dock-label', text: R[k].short }), el('span', { class: 'dock-count' }));
    b.addEventListener('click', () => react(k));
    dockInner.append(b);
  }

  // Tap/click reveals the reaction types; choosing one reacts (same one again removes it).
  primary.addEventListener('click', () => {
    const open = !wrap.classList.contains('open');
    closeReactionDocks();
    setOpen(open);
  });

  wrap.append(primary, dock);
  paint();
  return wrap;
}
function closeReactionDocks(except) {
  document.querySelectorAll('.react-wrap.open').forEach((w) => {
    if (w === except) return;
    w.classList.remove('open');
    w.querySelector('.react-primary')?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('pointerdown', (e) => closeReactionDocks(e.target.closest('.react-wrap')));

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

function concernPill(pattern) {
  if (!pattern) return null;
  const status = { active: 'Heard', reviewing: 'Under counselor review', resolved: 'Addressed by student welfare' }[pattern.status] ?? 'Heard';
  return el('span', { class: 'pill pill-status', title: 'Similar posts are grouped so counselors can see concerns students raise' }, `${status} · ${sharedBy(pattern)}`);
}

function renderPost(p) {
  return el('article', { class: 'card post' },
    postHeader(p),
    el('p', { class: 'post-body' }, taggedText(p.content)),
    p.pattern ? el('div', { class: 'meta-row' }, concernPill(p.pattern)) : null,
    el('div', { class: 'post-foot' }, buildReactions(p)),
  );
}

function feedSection(label, key, cards) {
  return el('section', { class: 'feed-section', 'aria-labelledby': `section-${key}` },
    el('h2', { class: 'section-label', id: `section-${key}`, text: label }),
    el('div', { class: 'feed' }, ...cards));
}

// ---------------------------------------------------------------------------------------------
// Campus updates: newspaper-style slides (headline, summary, picture) that rotate on their own.
// Tapping one opens the full article in a dialog.
// ---------------------------------------------------------------------------------------------
const UPDATE_ROTATE_MS = 7000;
const UPDATE_ICONS = { Bullying: 'i-users', Cyberbullying: 'i-chat', 'Peer Pressure': 'i-ear', 'Campus Safety': 'i-shield' };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let stopUpdatesCarousel = () => {};
let updateDialog = null;

// The "photo" is an illustration of the topic and place; updates never carry real photos of students.
function updatePicture(n, cls) {
  return el('div', { class: `update-picture ${cls}`, 'aria-hidden': 'true' },
    svgIcon(UPDATE_ICONS[n.category] ?? 'i-shield', 'icon update-picture-icon'),
    el('span', { class: 'update-picture-caption', text: n.location }));
}

// Counselor-written articles about resolved incidents are labelled apart from automatic notices.
const updateKicker = (n) => el('div', { class: 'update-kicker' },
  el('span', { text: n.kind === 'article' ? 'Resolved · Campus update' : 'Campus update' }), el('span', { class: 'hashtag', text: hashtag(n.category) }));
const updateMeta = (n) => el('div', { class: 'meta-row' },
  el('span', { class: 'pill pill-status', text: n.status }), el('span', { class: 'post-sub', text: `Updated ${timeAgo(n.updated_at)}` }));

function openUpdateArticle(n, onClose) {
  if (!updateDialog) {
    updateDialog = el('dialog', { class: 'update-dialog', 'aria-labelledby': 'update-dialog-title' });
    updateDialog.addEventListener('click', (e) => e.target === updateDialog && updateDialog.close()); // backdrop click
    document.body.append(updateDialog);
  }
  updateDialog.replaceChildren(
    el('button', { type: 'button', class: 'icon-btn update-dialog-close', 'aria-label': 'Close article', text: '×', onclick: () => updateDialog.close() }),
    updatePicture(n, 'update-picture-banner'),
    el('div', { class: 'update-article' },
      updateKicker(n),
      el('h2', { class: 'update-article-headline', id: 'update-dialog-title', text: n.headline }),
      updateMeta(n),
      n.byline ? el('p', { class: 'update-byline', text: n.byline }) : null,
      el('div', { class: 'update-article-body' }, ...n.article.map((p) => el('p', { text: p }))),
      el('p', { class: 'update-article-note', text: 'Campus updates summarize anonymous, sanitized reports. They are not a finding of fault and do not replace the school\'s formal procedures.' }),
    ),
  );
  updateDialog.addEventListener('close', onClose, { once: true });
  updateDialog.showModal();
  updateDialog.scrollTop = 0;
}

function updatesCarousel(notices) {
  stopUpdatesCarousel();
  const total = notices.length;
  const holds = new Set(); // reasons the rotation is paused (hover, keyboard focus, open article)
  let index = 0;
  let timer = null;

  const slides = notices.map((n, i) => el('article', { class: 'update-slide', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${total}` },
    el('div', { class: 'update-copy' },
      updateKicker(n),
      el('h3', { class: 'update-headline' },
        el('button', { type: 'button', class: 'update-open', 'aria-haspopup': 'dialog', text: n.headline, onclick: () => {
          hold('article');
          openUpdateArticle(n, () => release('article'));
        } })),
      el('p', { class: 'update-summary', text: n.summary }),
      updateMeta(n),
    ),
    updatePicture(n, 'update-picture-slide'),
  ));
  const track = el('div', { class: 'updates-track' }, ...slides);
  const dots = notices.map((_, i) => el('button', { type: 'button', class: 'update-dot', 'aria-label': `Show update ${i + 1} of ${total}`, onclick: () => go(i) }));
  const root = el('div', { class: 'card updates-carousel', role: 'region', 'aria-roledescription': 'carousel', 'aria-label': 'Campus updates' },
    el('div', { class: 'updates-viewport' }, track),
    total > 1 ? el('div', { class: 'update-dots' }, ...dots) : null);

  function go(i) {
    const hadFocus = slides[index].contains(document.activeElement);
    index = (i + total) % total;
    track.style.transform = `translateX(-${index * 100}%)`;
    slides.forEach((s, j) => (s.inert = j !== index));
    dots.forEach((d, j) => (j === index ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current')));
    if (hadFocus) slides[index].querySelector('.update-open').focus({ preventScroll: true });
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (total < 2 || holds.size || reducedMotion.matches || document.hidden) return;
    timer = setTimeout(() => root.isConnected && go(index + 1), UPDATE_ROTATE_MS);
  }
  function hold(why) {
    holds.add(why);
    clearTimeout(timer);
  }
  function release(why) {
    holds.delete(why);
    schedule();
  }

  root.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && hold('hover'));
  root.addEventListener('pointerleave', () => release('hover'));
  root.addEventListener('focusin', (e) => e.target.matches(':focus-visible') && hold('focus'));
  root.addEventListener('focusout', (e) => !root.contains(e.relatedTarget) && release('focus'));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
  });

  // Swipe between slides on touch screens; a swipe must not also open the article.
  let startX = null;
  let swiped = false;
  root.addEventListener('pointerdown', (e) => (startX = e.clientX));
  root.addEventListener('pointerup', (e) => {
    const dx = startX == null ? 0 : e.clientX - startX;
    startX = null;
    if (total > 1 && Math.abs(dx) > 40) {
      swiped = true;
      go(index + (dx < 0 ? 1 : -1));
    }
  });
  root.addEventListener('click', (e) => {
    if (!swiped) return;
    swiped = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', schedule);
  stopUpdatesCarousel = () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', schedule);
    reducedMotion.removeEventListener('change', schedule);
  };

  go(0);
  return root;
}

let feedSeq = 0;
async function loadFeed() {
  const feed = $('#feed');
  const seq = ++feedSeq;
  try {
    const q = state.topics.size ? `?categories=${encodeURIComponent([...state.topics].join(','))}` : '';
    const data = await api(`/api/feed${q}`, { headers: sessionHeaders() });
    if (seq !== feedSeq) return; // a newer filter change won
    const sections = [];
    if (data.notices.length) sections.push(feedSection('Campus updates', 'updates', [updatesCarousel(data.notices)]));
    else stopUpdatesCarousel();
    sections.push(feedSection('From students', 'students',
      data.posts.length ? data.posts.map(renderPost) : [el('div', { class: 'card empty', text: 'No posts in these topics yet.' })]));
    feed.replaceChildren(...sections);
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
        res.redaction_count ? el('span', { class: 'pill', text: `${res.redaction_count} identifier${res.redaction_count === 1 ? '' : 's'} removed` }) : el('span', { class: 'pill', text: 'No identifiers found' }),
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
    loadConcerns();
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
  published: ['Posted anonymously', 'Your post is live on the feed with identifying details removed. A summary was also shared with the Guidance team.'],
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
        r.cluster ? el('span', { class: 'pill', text: `Part of a concern raised · ${sharedBy(r.cluster)}` }) : null,
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
      el('div', { class: 'meta-row' }, sevBadge(p.severity_score, p.severity_label), concernPill(p.pattern)),
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
  $('#adviser-launcher').hidden = true;
  $('#adviser-fab').setAttribute('aria-expanded', 'true');
  if (!state.chat.length) pushMessage('assistant', WELCOME.content, false, { suggestions: WELCOME.suggestions });
  $('#adviser-input').focus();
}
function closeAdviser() {
  $('#adviser').hidden = true;
  $('#adviser-launcher').hidden = false;
  $('#adviser-fab').setAttribute('aria-expanded', 'false');
  $('#adviser-fab').focus();
}
$('#adviser-fab').addEventListener('click', openAdviser);
$('#adviser-close').addEventListener('click', closeAdviser);
document.querySelectorAll('[data-open-adviser]').forEach((n) => n.addEventListener('click', openAdviser));

// "I'm here if you need someone to talk to" - shown until the student hides it once.
function initAdviserHello() {
  $('#adviser-hello').hidden = storage.get('care.helloHidden') === '1';
  $('#adviser-hello-close').addEventListener('click', () => {
    $('#adviser-hello').hidden = true;
    storage.set('care.helloHidden', '1');
  });
}

// Adviser replies carry her chibi avatar so students can see who is answering.
function adviserMessage(text, extraClass = '') {
  return el('div', { class: 'msg-row msg-row-assistant' },
    el('img', { class: 'msg-avatar', src: '/img/care-adviser-chibi.png', alt: '', width: '32', height: '32' }),
    el('div', { class: `msg msg-assistant ${extraClass}`.trim() }, chatFormatting(text)),
  );
}

// AI replies sometimes arrive with Markdown (**bold**, *italic*, "- " lists). Turn just those into
// formatting using DOM nodes and textContent - never innerHTML - so a reply can't inject markup.
const INLINE_MD = /\*\*(\S(?:[^*\n]*?\S)?)\*\*|__(\S(?:[^_\n]*?\S)?)__|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])|(?<![\w_])_(\S(?:[^_\n]*?\S)?)_(?![\w_])/g;

function chatFormatting(text) {
  const frag = document.createDocumentFragment();
  String(text ?? '').split('\n').forEach((rawLine, i) => {
    if (i > 0) frag.append('\n');
    const line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/, '')     // "## Heading" -> "Heading"
      .replace(/^(\s*)[-*+]\s+/, '$1• ');    // "- item" / "* item" -> "• item"
    let last = 0;
    for (const m of line.matchAll(INLINE_MD)) {
      if (m.index > last) frag.append(line.slice(last, m.index));
      const bold = m[1] ?? m[2];
      frag.append(el(bold !== undefined ? 'strong' : 'em', { text: bold ?? m[3] ?? m[4] }));
      last = m.index + m[0].length;
    }
    if (last < line.length) frag.append(line.slice(last));
  });
  return frag;
}

const WELCOME = {
  content: "Hi, I'm the C.A.R.E. Adviser. I'm here to listen and help you think things through. You don't need to share any names. Our chat isn't saved, but if you choose to post or report something, a summary with names removed is always shared with the Guidance team so someone can help. What's on your mind?",
  suggestions: [
    { label: 'Something happened at school', action: 'reply', text: 'Something happened at school' },
    { label: "I'm feeling stressed", action: 'reply', text: "I'm feeling stressed" },
    { label: 'Is this anonymous?', action: 'reply', text: 'Will anyone know it was me?' },
  ],
};

function saveChat() {
  try {
    sessionStorage.setItem('care.chat', JSON.stringify(state.chat));
  } catch {
    /* ignore */
  }
}

// Quick replies under her latest message. Calls are real links so they work as one tap.
function suggestionChips(list) {
  return el('div', { class: 'chips-row', role: 'group', 'aria-label': 'Suggested replies' }, ...list.map((s) => {
    if (s.action === 'call') return el('a', { class: 'chip-btn chip-urgent', href: `tel:${s.number}` }, s.label);
    const chip = el('button', { class: `chip-btn${s.action === 'private_report' ? ' chip-primary' : ''}`, type: 'button' }, s.label);
    chip.addEventListener('click', () => runSuggestion(s));
    return chip;
  }));
}

function runSuggestion(s) {
  if (s.action === 'reply') return sendChat(s.text ?? s.label);
  if (s.action === 'private_report') return startPrivateReport();
  if (s.action === 'draft_post') return draftPost();
  if (s.action === 'hotlines') return showView('hotlines');
  if (s.action === 'view_mine') return showView('mine');
}

function renderChat() {
  const nodes = state.chat.map((m) => {
    if (m.crisis) return crisisCard();
    return m.role === 'assistant' ? adviserMessage(m.content) : el('div', { class: 'msg msg-user', text: m.content });
  });
  const last = state.chat.at(-1);
  if (last?.role === 'assistant' && last.suggestions?.length && !state.privateDraft && !state.chatBusy) nodes.push(suggestionChips(last.suggestions));
  if (state.privateDraft) nodes.push(privateReportCard(state.privateDraft));
  $('#adviser-log').replaceChildren(...nodes);
  $('#adviser-log').scrollTop = $('#adviser-log').scrollHeight;
}

function pushMessage(role, content, persist = true, extra = {}) {
  state.chat.push({ role, content, ...extra });
  if (persist) saveChat();
  renderChat();
}

// What the server sees: plain turns plus the adviser's last `offer`, so "yes"/"oo" is understood.
const chatPayload = () => state.chat.filter((m) => !m.crisis).map(({ role, content, offer }) => ({ role, content, ...(offer ? { offer } : {}) }));
const hasStory = () => state.chat.some((m) => m.role === 'user' && m.content.trim().length >= 12);

async function sendChat(text) {
  if (state.chatBusy) return;
  state.chatBusy = true;
  pushMessage('user', text);
  $('#adviser-log').append(adviserMessage('Adviser is typing…', 'muted'));
  $('#adviser-log').scrollTop = $('#adviser-log').scrollHeight;
  try {
    const res = await api('/api/adviser/chat', { method: 'POST', body: { messages: chatPayload() } });
    if (res.crisis) state.chat.push({ role: 'assistant', content: '', crisis: true });
    state.chatBusy = false;
    pushMessage('assistant', res.reply, true, { ...(res.offer ? { offer: res.offer } : {}), suggestions: res.suggestions ?? [] });
  } catch (err) {
    state.chatBusy = false;
    pushMessage('assistant', `Sorry, I couldn't respond just now (${err.message}). If this is urgent, call NCMH 1553 or 911.`, false);
  }
}

$('#adviser-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#adviser-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendChat(text);
});
$('#adviser-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#adviser-form').requestSubmit();
  }
});
$('#adviser-clear').addEventListener('click', () => {
  state.chat = [];
  state.privateDraft = null;
  saveChat();
  openAdviser();
});

async function draftPost() {
  if (!hasStory()) return pushMessage('assistant', "Tell me a little about what happened first, and I'll turn it into a draft for you.", false);
  const btn = $('#adviser-draft');
  btn.disabled = true;
  btn.textContent = 'Drafting…';
  try {
    const draft = await api('/api/adviser/draft', { method: 'POST', body: { messages: chatPayload() } });
    openComposer();
    $('#category-select').value = draft.category;
    $('#location-input').value = draft.location_tag;
    $('#narrative').value = draft.narrative;
    schedulePreview();
    pushMessage('assistant', "I put a draft in the post composer. Please read it over and change anything that isn't right. Nothing is shared until you press Post Anonymously.");
  } catch (err) {
    pushMessage('assistant', err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft a post';
  }
}
$('#adviser-draft').addEventListener('click', draftPost);

// ---------------------------------------------------------------------------------------------
// Private report: the Adviser sends it to counselors only. Never on the feed or public counts.
// ---------------------------------------------------------------------------------------------
async function startPrivateReport() {
  if (!hasStory()) {
    return pushMessage('assistant', "I can send it privately to the counselors. First, tell me what happened: what, where, and how often. You don't need to use any names.", false);
  }
  const btn = $('#adviser-private');
  btn.disabled = true;
  try {
    const draft = await api('/api/adviser/draft', { method: 'POST', body: { messages: chatPayload() } });
    state.privateDraft = { ...draft, unlinked: false, error: '' };
    renderChat();
  } catch (err) {
    pushMessage('assistant', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

function privateReportCard(draft) {
  const category = el('select', { 'aria-label': 'Category' }, ...state.meta.categories.map((c) => el('option', { value: c, text: c })));
  category.value = draft.category;
  const location = el('input', { type: 'text', list: 'location-list', maxlength: '60', 'aria-label': 'Campus location', value: draft.location_tag });
  const narrative = el('textarea', { maxlength: '3000', 'aria-label': 'What happened', rows: '5' });
  narrative.value = draft.narrative;
  const unlinked = el('input', { type: 'checkbox' });
  unlinked.checked = draft.unlinked;
  const error = el('div', { class: 'alert alert-error', role: 'alert', hidden: !draft.error, text: draft.error });
  const send = el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Send to counselors');
  const cancel = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Cancel');

  // Keep edits if the card re-renders.
  const sync = () => Object.assign(state.privateDraft, { category: category.value, location_tag: location.value, narrative: narrative.value, unlinked: unlinked.checked });
  [category, location, narrative, unlinked].forEach((n) => n.addEventListener('input', sync));
  cancel.addEventListener('click', () => {
    state.privateDraft = null;
    pushMessage('assistant', "No problem, nothing was sent. I'm still here if you want to keep talking.", false);
  });

  const form = el('form', { class: 'private-card' },
    el('div', { class: 'private-card-title' }, svgIcon('i-lock'), 'Send privately to counselors'),
    el('p', { class: 'private-card-note', text: 'Only the Guidance team will see this. It never appears on the feed, and names and contact details are removed automatically. Please check the details below.' }),
    el('div', { class: 'private-card-row' }, category, location),
    narrative,
    el('label', { class: 'ack' }, unlinked, el('span', { text: "Extra private: don't link this to my anonymous ID. I won't be able to check its status in My Reports." })),
    error,
    el('div', { class: 'adviser-actions' }, cancel, send),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    sync();
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const res = await api('/api/adviser/private-report', {
        method: 'POST',
        body: { secret: state.secret, category: category.value, location_tag: location.value, narrative: narrative.value, unlinked: unlinked.checked },
      });
      state.privateDraft = null;
      if (res.crisis) state.chat.push({ role: 'assistant', content: '', crisis: true });
      pushMessage('assistant', res.unlinked
        ? "Sent. Only the Guidance team can see it, and it isn't linked to you in any way. Thank you for speaking up. That took courage. I'm still here if you want to talk."
        : 'Sent. Only the Guidance team can see it, and it will never appear on the feed. You can check its status anytime in My Reports. Thank you for speaking up. That took courage.',
      true, { suggestions: res.unlinked ? [] : [{ label: 'View My Reports', action: 'view_mine' }] });
    } catch (err) {
      state.privateDraft.error = err.message;
      renderChat();
    }
  });
  return form;
}
$('#adviser-private').addEventListener('click', startPrivateReport);

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
// The fixed disclaimer footer wraps differently per width; keep the Adviser button and the end of
// the feed clear of it by publishing its real height as --footer-h.
function trackFooterHeight() {
  const footer = $('#disclaimer');
  if (!footer) return;
  const update = () => document.documentElement.style.setProperty('--footer-h', `${Math.ceil(footer.getBoundingClientRect().height)}px`);
  update();
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(footer);
}

// Counselors who open the student view get a way back to the portal. Visibility is decided only by the
// server's answer for the stored token - never by client-side state alone.
async function showExitForAdmins() {
  let token = null;
  try {
    token = sessionStorage.getItem('care.admin');
  } catch {
    return;
  }
  if (!token) return;
  try {
    const { role } = await api('/api/admin/whoami', { token });
    if (role === 'admin') {
      $('#exit-student-view').hidden = false;
    } else if (role === 'student') {
      try {
        sessionStorage.removeItem('care.admin');
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* leave the button hidden */
  }
}

async function boot() {
  trackFooterHeight();
  showExitForAdmins();
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
  initAdviserHello();
  loadIdentity().catch(() => {});
  loadConcerns();
  showView(location.hash.slice(1) || 'feed', { push: false });
}

boot().catch((e) => {
  $('#feed').replaceChildren(el('div', { class: 'alert alert-error', text: `C.A.R.E. Hub couldn't start: ${e.message}` }));
});
