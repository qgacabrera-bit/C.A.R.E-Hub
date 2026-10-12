import { $, el, taggedText, timeAgo, sevBadge, hashtag, api, confirmDialog, notify } from './common.js';

const SEV_LABELS = ['', 'Low', 'Guarded', 'Moderate', 'High Priority', 'Critical'];
let token = null;
try {
  token = sessionStorage.getItem('care.admin');
} catch {
  /* ignore */
}

function setToken(t) {
  token = t;
  try {
    if (t) sessionStorage.setItem('care.admin', t);
    else sessionStorage.removeItem('care.admin');
  } catch {
    /* ignore */
  }
}

function showDashboard(on) {
  $('#login').hidden = on;
  $('#dashboard').hidden = !on;
  $('#logout').hidden = !on;
  $('#refresh').hidden = !on;
}

async function call(path, opts = {}) {
  try {
    return await api(path, { ...opts, token });
  } catch (e) {
    if (e.status === 401) {
      setToken(null);
      showDashboard(false);
    }
    throw e;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: { passcode: $('#passcode').value } });
    setToken(res.token);
    $('#passcode').value = '';
    await load();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});
$('#logout').addEventListener('click', async () => {
  await call('/api/admin/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  showDashboard(false);
});
$('#refresh').addEventListener('click', () => load());

// ---------------------------------------------------------------------------------------------

function renderStats(s) {
  const tile = (value, label) => el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: value }), el('div', { class: 'stat-label', text: label }));
  $('#stats').replaceChildren(
    tile(s.priority, 'Reports in the counselor queue'),
    tile(s.open_clusters, 'Open recurring incidents'),
    tile(s.moderation, 'Posts held for moderation'),
    tile(s.reports_30d, 'Reports in the last 30 days'),
  );
}

function indicatorPills(list) {
  return list.length ? el('div', { class: 'indicator-list' }, ...list.map((i) => el('span', { class: 'pill', text: i }))) : null;
}

const CLUSTER_STATUS = { active: 'Active', reviewing: 'Under review', resolved: 'Resolved' };
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// One labeled row of a queue card.
function fact(label, ...value) {
  return el('div', { class: 'fact' }, el('dt', { text: label }), el('dd', {}, ...value));
}

function queueCard(p) {
  return el('article', { class: 'card queue-card' },
    el('div', { class: 'queue-head' },
      sevBadge(p.severity_score, p.severity_label),
      el('span', { class: 'queue-title', text: p.category }),
      el('span', { class: 'queue-meta', text: `Report #${p.id} · ${timeAgo(p.created_at)}` }),
    ),
    (p.wellbeing_risk || p.private_report) ? el('div', { class: 'queue-tags' },
      p.wellbeing_risk ? el('span', { class: 'pill pill-alert', text: "Possible risk to the student's own safety - prioritize wellbeing outreach" }) : null,
      p.private_report ? el('span', { class: 'pill', text: 'Sent privately via the Adviser' }) : null,
    ) : null,
    el('dl', { class: 'facts' },
      fact('Reported', indicatorPills(p.indicators) ?? el('span', { class: 'muted', text: 'No specific indicators matched' })),
      fact('Where', p.location),
      fact('Pattern', p.cluster
        ? el('span', {}, `Recurring incident #${p.cluster.id} · ${p.cluster.title}`, el('span', { class: 'muted', text: ` · ${p.cluster.report_count} reports since ${shortDate(p.cluster.first_reported_at)} · ${CLUSTER_STATUS[p.cluster.status] ?? p.cluster.status}` }))
        : el('span', { class: 'muted', text: 'Single report (no similar reports yet)' })),
      fact('Source', p.private_report ? 'Sent privately through the C.A.R.E. Adviser (never on the feed)' : 'Anonymous post, kept off the public feed'),
      fact('Routed to', p.sent_to ? `${p.sent_to} · ${new Date(p.dispatched_at).toLocaleString()}` : '-'),
      fact('Status', 'Pending counselor review'),
    ),
    el('details', { class: 'queue-account' },
      el('summary', {}, "Student's account (identifying details removed)"),
      el('p', { class: 'post-body' }, taggedText(p.content)),
      p.has_attachment ? el('p', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openAttachment(p.id); } }, 'View attached image (metadata stripped)')) : null,
    ),
    el('p', { class: 'queue-foot', text: 'Identifying details were redacted before routing. This does not determine fault.' }),
  );
}

// Grouped by urgency so the most serious reports are read first.
function renderPriority(items) {
  const wrap = $('#priority');
  if (!items.length) return wrap.replaceChildren(el('p', { class: 'muted', text: 'Nothing in the counselor queue right now.' }));
  const groups = [
    ['Critical · urgency 5', items.filter((p) => p.severity_score >= 5)],
    ['High priority · urgency 4', items.filter((p) => p.severity_score === 4)],
    ['Private reports · urgency 1-3', items.filter((p) => p.severity_score < 4)],
  ].filter(([, list]) => list.length);
  wrap.replaceChildren(...groups.map(([label, list]) => el('section', { class: 'queue-group' },
    el('h3', { class: 'queue-group-title' }, label, el('span', { class: 'queue-count', text: list.length })),
    el('div', { class: 'stack' }, ...list.map(queueCard)),
  )));
}

async function openAttachment(postId) {
  try {
    const res = await fetch(`/api/admin/attachments/${postId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Attachment unavailable');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    notify({ title: "Couldn't open the attachment", message: e.message, tone: 'error' });
  }
}

// What the Article column says for a recurring incident: [label, tone, button text or null].
function articleState(c) {
  const a = c.article;
  if (!c.public_article_allowed) return ['Kept private (wellbeing)', '', null];
  if (a?.status === 'published') {
    return c.status === 'resolved' ? ['Published', 'pill-ok', 'Edit article'] : ['Published · hidden while reopened', 'pill-alert', 'Edit article'];
  }
  if (c.status !== 'resolved') return a ? ['Draft saved', '', 'Continue draft'] : ['After resolving', 'muted', null];
  return a ? ['Draft · not published', 'pill-alert', 'Continue draft'] : ['Article needed', 'pill-alert', 'Write article'];
}

function renderClusters(clusters) {
  const table = $('#clusters');
  if (!clusters.length) return table.replaceChildren(el('tr', {}, el('td', { text: 'No recurring incidents yet. They form when similar reports recur in the same place.' })));
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...['Incident', 'Zone', 'Reports', 'Peak urgency', 'Window', 'Workflow status', 'Article'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, ...clusters.map((c) => {
      const select = el('select', { 'aria-label': `Status for recurring incident ${c.id}` },
        ...['active', 'reviewing', 'resolved'].map((s) => {
          const opt = el('option', { value: s, text: CLUSTER_STATUS[s] });
          opt.selected = c.status === s;
          return opt;
        }));
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await call(`/api/admin/clusters/${c.id}`, { method: 'PATCH', body: { status: select.value } });
          c.status = select.value;
          // Resolving asks for the article that tells students what was done.
          if (c.status === 'resolved' && c.public_article_allowed && c.article?.status !== 'published') openArticleEditor(c, select);
          load();
        } catch (e) {
          notify({ title: "Couldn't change the status", message: e.message, tone: 'error' });
          select.value = c.status;
        } finally {
          select.disabled = false;
        }
      });
      const [label, tone, action] = articleState(c);
      const articleCell = el('td', {}, el('div', { class: 'article-cell' },
        el('span', { class: tone === 'muted' ? 'small muted' : `pill ${tone}`, text: label }),
        action ? el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => openArticleEditor(c, e.currentTarget) }, action) : null));
      return el('tr', {},
        el('td', {},
          el('strong', { text: `#${c.id} ${c.title}` }),
          indicatorPills(c.indicators),
          el('details', {}, el('summary', {}, `Linked reports (${c.reports.length})`),
            el('ul', { class: 'cluster-reports' }, ...c.reports.map((r) => el('li', {}, el('span', { class: 'muted', text: `#${r.id} · ${r.severity_score}/5 · ` }), taggedText(r.sanitized_content))))),
        ),
        el('td', { text: c.location }),
        el('td', { text: c.report_count }),
        el('td', {}, sevBadge(c.max_severity, SEV_LABELS[c.max_severity])),
        el('td', { class: 'small', text: `${new Date(c.first_reported_at).toLocaleDateString()} – ${new Date(c.last_reported_at).toLocaleDateString()}` }),
        el('td', {}, select),
        articleCell,
      );
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Resolution article editor: write it yourself, or give Kali context and edit her draft. Either
// way the counselor reviews the final text before it is published to the student feed.
// ---------------------------------------------------------------------------------------------
const CONTEXT_MIN = 40;
let fieldSeq = 0;

// Preset article pictures: the same line icons the student page draws (its sprite's i-<name>).
const PRESET_PICTURES = {
  shield: ['Safety', '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'],
  users: ['Together', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'],
  chat: ['Talking it out', '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'],
  ear: ['Listening', '<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>'],
  heart: ['Support', '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>'],
  smile: ['Wellbeing', '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>'],
};
const DEFAULT_PRESET = { Bullying: 'users', Cyberbullying: 'chat', 'Peer Pressure': 'ear', 'Campus Safety': 'shield' };

// The markup is the constant icon data above, never user input.
function presetIcon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PRESET_PICTURES[name]?.[1] ?? PRESET_PICTURES.shield[1];
  return svg;
}

// Counselors share one passcode, so the byline name is typed in and remembered on this computer.
const NAME_KEY = 'care.counselorName';
function rememberedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

// The saved picture needs the counselor's token, so it is fetched rather than linked.
async function savedPictureUrl(clusterId) {
  try {
    const res = await fetch(`/api/admin/clusters/${clusterId}/article/picture`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? URL.createObjectURL(await res.blob()) : null;
  } catch {
    return null;
  }
}

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('That file could not be read.'));
  reader.readAsDataURL(file);
});

function labeled(text, control) {
  control.id ||= `article-field-${++fieldSeq}`;
  return el('div', {}, el('label', { class: 'field', for: control.id, text }), control);
}
let aiDrafting = false;
let aiPictures = false;
let articleModal = null;
let articleOpener = null;
let articleDirty = false;

const confirmDiscardArticle = () => confirmDialog({
  title: 'Close without saving?', message: 'Your changes to this article will be lost.',
  confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', tone: 'danger',
});

function openArticleEditor(c, opener) {
  if (!articleModal) {
    articleModal = el('dialog', { class: 'report-modal article-modal', 'aria-labelledby': 'article-modal-title' });
    // Esc or the close button must not silently throw away an unsaved article.
    articleModal.addEventListener('cancel', async (e) => {
      if (!articleDirty) return;
      e.preventDefault();
      if (await confirmDiscardArticle()) articleModal.close();
    });
    articleModal.addEventListener('close', () => {
      articleOpener?.isConnected && articleOpener.focus();
      articleOpener = null;
    });
    document.body.append(articleModal);
  }
  articleOpener = opener;
  articleDirty = false;

  const a = c.article ?? {};
  let source = a.source ?? 'counselor';
  const published = a.status === 'published';

  const choice = (value, title, desc) => el('label', { class: 'choice' },
    el('input', { type: 'radio', name: 'article-mode', value }),
    el('span', {}, el('strong', { text: title }), el('span', { class: 'small muted', text: desc })));
  const modeSelf = choice('self', 'Write it myself', 'Start from a blank article.');
  const modeAi = choice('ai', 'Draft with Kali', aiDrafting
    ? 'Give Kali context about what was done, then review and edit her draft.'
    : 'Kali is offline right now, so your context is filled into a template you can edit.');

  const context = el('textarea', { rows: '4', maxlength: '2000', 'aria-describedby': 'article-context-hint' });
  context.value = a.context ?? '';
  const contextCount = el('span', { class: 'small muted' });
  const generate = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Generate draft');
  const aiMsg = el('p', { class: 'small', role: 'status' });
  const aiPanel = el('div', { class: 'stack article-ai', hidden: true },
    labeled('Context for the draft (required)', context),
    el('p', { class: 'hint', id: 'article-context-hint', text: 'What was done, what changed, and what students should know. Kali only uses what you write here plus the incident facts. Names and contact details are removed before anything is sent to her.' }),
    el('div', { class: 'article-ai-row' }, contextCount, generate),
    aiMsg);

  const headline = el('input', { type: 'text', maxlength: '120' });
  const summary = el('textarea', { rows: '2', maxlength: '400' });
  const body = el('textarea', { rows: '10', maxlength: '6000', 'aria-describedby': 'article-body-hint' });
  headline.value = a.headline ?? '';
  summary.value = a.summary ?? '';
  body.value = a.body ?? '';
  const aiNote = el('p', { class: 'alert article-ai-note', text: "Kali's draft: check every fact against what actually happened, and edit anything that is wrong or missing before publishing." });

  // ---- Byline: who wrote it, and whether Kali helped ----
  const authorName = el('input', { type: 'text', maxlength: '60', autocomplete: 'name', placeholder: 'e.g. Ms. Reyes', 'aria-describedby': 'article-byline-preview' });
  authorName.value = a.author_name || rememberedName();
  let bylineStyle = a.byline_style === 'counselor_led' ? 'counselor_led' : 'kali_led';
  const bylineKali = el('option', { value: 'kali_led' });
  const bylineCounselor = el('option', { value: 'counselor_led' });
  const bylineSelect = el('select', { 'aria-label': 'Byline' }, bylineKali, bylineCounselor);
  const bylineChoice = labeled('Kali helped write this. How should the byline read?', bylineSelect);
  const bylinePreview = el('p', { class: 'hint', id: 'article-byline-preview' });
  const who = () => authorName.value.trim() || 'your name';
  const bylineFor = (style) => (source === 'counselor' ? `Written by ${who()}`
    : style === 'counselor_led' || source === 'template' ? `Written by ${who()}, with the help of Kali`
      : `Written by Kali, with the guidance of ${who()}`);
  function renderByline() {
    bylineChoice.hidden = source !== 'ai';
    bylineSelect.value = bylineStyle;
    bylineKali.textContent = bylineFor('kali_led');
    bylineCounselor.textContent = bylineFor('counselor_led');
    bylinePreview.textContent = `Students will see: "${bylineFor(bylineStyle)}"`;
  }
  authorName.addEventListener('input', () => {
    renderByline();
    changed();
  });
  bylineSelect.addEventListener('change', () => {
    bylineStyle = bylineSelect.value;
    renderByline();
    changed();
  });
  const bylineSection = el('div', { class: 'stack article-byline' },
    labeled('Your name (shown to students)', authorName), bylineChoice, bylinePreview);

  // ---- Picture: Kali illustrates it (online), the counselor uploads one, or a preset illustration ----
  let pictureKind = a.picture?.kind ?? 'preset';
  let picturePreset = a.picture?.preset || DEFAULT_PRESET[c.incident_type] || 'shield';
  let pictureSrc = null;       // preview URL for an uploaded or generated picture
  let pendingPicture = null;   // what the next save sends; null keeps the saved picture
  let pictureTouched = Boolean(c.article); // an existing article keeps its picture; a new one may be auto-illustrated
  const pictureBox = el('div', { class: 'article-picture-preview', 'aria-live': 'polite' });
  const pictureMsg = el('p', { class: 'small', role: 'status' });
  const kaliPicture = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Generate with Kali');
  const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png', hidden: true });
  const uploadPicture = el('button', { class: 'btn btn-sm', type: 'button', onclick: () => fileInput.click() }, 'Upload a picture');
  const presetButtons = Object.entries(PRESET_PICTURES).map(([name, [label]]) => {
    const b = el('button', { class: 'preset-btn', type: 'button', title: label, 'aria-label': `Use the ${label} illustration` }, presetIcon(name));
    b.addEventListener('click', () => {
      setPicture('preset', { preset: name });
      pendingPicture = { kind: 'preset', preset: name };
    });
    b.dataset.preset = name;
    return b;
  });
  kaliPicture.hidden = !aiPictures;

  function renderPicture() {
    pictureBox.replaceChildren(pictureKind === 'preset' || !pictureSrc
      ? el('div', { class: 'update-picture article-picture-art' }, presetIcon(picturePreset, 'icon update-picture-icon'), el('span', { class: 'update-picture-caption', text: c.location }))
      : el('img', { src: pictureSrc, alt: pictureKind === 'ai' ? "Kali's illustration for this article" : 'Your uploaded picture' }));
    presetButtons.forEach((b) => b.setAttribute('aria-pressed', String(pictureKind === 'preset' && b.dataset.preset === picturePreset)));
    if (previewBox.open) renderPreview();
  }
  function setPicture(kind, { preset, src } = {}) {
    pictureKind = kind;
    if (preset) picturePreset = preset;
    if (src !== undefined) pictureSrc = src;
    pictureTouched = true;
    pictureMsg.textContent = '';
    renderPicture();
    changed();
  }

  async function generatePicture() {
    kaliPicture.disabled = true;
    pictureMsg.textContent = 'Kali is illustrating the article…';
    try {
      const p = await call(`/api/admin/clusters/${c.id}/article/picture`, { method: 'POST', body: { headline: headline.value, summary: summary.value } });
      setPicture('ai', { src: p.preview });
      pendingPicture = { kind: 'ai', token: p.token };
      pictureMsg.textContent = 'Kali made this picture. Check that it fits before publishing, or generate another.';
    } catch (e) {
      pictureMsg.textContent = e.message;
      if (e.status === 409) { // pictures are off for now: fall back to upload / illustrations
        aiPictures = false;
        kaliPicture.hidden = true;
      }
    } finally {
      kaliPicture.disabled = false;
    }
  }
  kaliPicture.addEventListener('click', generatePicture);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) return void (pictureMsg.textContent = 'Choose a JPEG or PNG picture.');
    if (file.size > 2 * 1024 * 1024) return void (pictureMsg.textContent = 'That picture is larger than 2 MB. Choose a smaller one.');
    try {
      const data = await readAsDataUrl(file);
      setPicture('upload', { src: data });
      pendingPicture = { kind: 'upload', data };
    } catch (e) {
      pictureMsg.textContent = e.message;
    }
  });

  const pictureSection = el('fieldset', { class: 'article-picture stack' },
    el('legend', { class: 'field', text: 'Picture' }),
    el('p', { class: 'hint', text: aiPictures
      ? 'Kali can illustrate the article, or you can upload a picture or pick an illustration. Never use a photo that shows students or anyone who could be recognized.'
      : 'Kali can\'t make pictures right now, so upload a picture or pick an illustration. Never use a photo that shows students or anyone who could be recognized.' }),
    el('div', { class: 'article-picture-row' }, pictureBox,
      el('div', { class: 'stack' },
        el('div', { class: 'article-picture-actions' }, kaliPicture, uploadPicture, fileInput),
        el('div', { class: 'preset-row', role: 'group', 'aria-label': 'Illustrations' }, ...presetButtons))),
    pictureMsg);
  const preview = el('div', { class: 'article-preview' });
  const previewBox = el('details', { class: 'article-preview-box' }, el('summary', {}, 'Preview as students will see it'), preview);
  previewBox.addEventListener('toggle', () => previewBox.open && renderPreview());
  const fields = el('div', { class: 'stack', hidden: true },
    aiNote,
    labeled('Headline', headline),
    labeled('Summary (shown on the carousel slide)', summary),
    labeled('Full article', body),
    el('p', { class: 'hint', id: 'article-body-hint', text: 'Leave a blank line between paragraphs.' }),
    bylineSection,
    pictureSection,
    previewBox);

  const reviewed = el('input', { type: 'checkbox' });
  const review = el('label', { class: 'ack article-review', hidden: true }, reviewed,
    el('span', { text: 'I reviewed this article: the facts are accurate, it names or hints at no one, and it does not blame anyone.' }));
  const errors = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const statusLine = el('p', { class: 'small muted article-status' });
  const save = el('button', { class: 'btn btn-sm', type: 'button' }, published ? 'Unpublish and save as draft' : 'Save draft');
  const publish = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, published ? 'Update published article' : 'Publish');
  const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
    if (!articleDirty || await confirmDiscardArticle()) articleModal.close();
  } }, 'Close');

  function renderPreview() {
    const paragraphs = body.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    preview.replaceChildren(
      pictureBox.firstChild?.cloneNode(true) ?? null,
      el('div', { class: 'small muted', text: `Resolved · Campus update · ${hashtag(c.incident_type)}` }),
      el('h4', { class: 'article-preview-headline', text: headline.value || 'Headline' }),
      el('p', { class: 'article-preview-summary', text: summary.value || 'Summary' }),
      el('p', { class: 'small muted', text: bylineFor(bylineStyle) }),
      ...paragraphs.map((p) => el('p', { text: p })),
    );
  }
  function setStatus() {
    const resolved = c.status === 'resolved';
    statusLine.textContent = !c.article ? 'Not saved yet.'
      : c.article.status === 'published' ? `Published ${new Date(c.article.published_at).toLocaleString()}${resolved ? '' : ' · hidden from students while the incident is reopened'}.`
      : `Draft saved ${timeAgo(c.article.updated_at)}. Students can't see it yet.`;
    publish.disabled = !reviewed.checked || !resolved;
    publish.title = resolved ? (reviewed.checked ? '' : 'Confirm your review first') : 'Resolve the incident before publishing';
  }
  function showMode(mode) {
    aiPanel.hidden = mode !== 'ai';
    const hasText = headline.value || summary.value || body.value;
    fields.hidden = !mode || (mode === 'ai' && !hasText);
    review.hidden = fields.hidden;
    save.hidden = fields.hidden;
    publish.hidden = fields.hidden;
    aiNote.hidden = !(source === 'ai' || source === 'template');
    aiNote.textContent = source === 'template'
      ? 'Template draft: it was filled in from your context. Rewrite it in your own words and check every fact before publishing.'
      : "Kali's draft: check every fact against what actually happened, and edit anything that is wrong or missing before publishing.";
    renderByline();
  }
  function updateCount() {
    const n = context.value.trim().length;
    contextCount.textContent = n < CONTEXT_MIN ? `${n} / ${CONTEXT_MIN} characters minimum` : `${n} characters`;
    generate.disabled = n < CONTEXT_MIN;
  }
  // Any edit after the review checkbox was ticked needs a fresh review.
  const changed = () => {
    articleDirty = true;
    reviewed.checked = false;
    if (previewBox.open) renderPreview();
    setStatus();
  };
  const showErrors = (message, issues = []) => {
    errors.replaceChildren(el('strong', { text: message }), issues.length ? el('ul', {}, ...issues.map((i) => el('li', { text: i }))) : null);
    errors.hidden = false;
  };

  [headline, summary, body].forEach((f) => f.addEventListener('input', changed));
  context.addEventListener('input', () => {
    articleDirty = true;
    updateCount();
  });
  reviewed.addEventListener('change', setStatus);
  [modeSelf, modeAi].forEach((m) => m.querySelector('input').addEventListener('change', (e) => {
    if (e.target.value === 'self' && !(headline.value || summary.value || body.value)) source = 'counselor';
    showMode(e.target.value);
  }));

  generate.addEventListener('click', async () => {
    if ((headline.value || summary.value || body.value) && !(await confirmDialog({
      title: 'Replace your draft?', message: "Kali will write a new headline, summary and article, replacing what's there now.",
      confirmLabel: 'Replace', cancelLabel: 'Keep mine', tone: 'warning',
    }))) return;
    generate.disabled = true;
    errors.hidden = true;
    aiMsg.textContent = 'Kali is drafting the article...';
    try {
      const d = await call(`/api/admin/clusters/${c.id}/article/draft`, { method: 'POST', body: { context: context.value } });
      headline.value = d.headline;
      summary.value = d.summary;
      body.value = d.body;
      source = d.source;
      aiMsg.textContent = d.source === 'ai' ? 'Draft ready. Review it below.' : 'Kali was unavailable, so a template was filled in from your context. Review it below.';
      if (d.issues.length) showErrors('The draft needs changes before it can be published:', d.issues);
      changed();
      showMode('ai');
      headline.focus();
      // Kali illustrates her own draft unless the counselor already picked a picture.
      if (d.source === 'ai' && aiPictures && !pictureTouched) generatePicture();
    } catch (e) {
      aiMsg.textContent = '';
      showErrors(e.message);
    } finally {
      updateCount();
    }
  });

  async function submit(doPublish, btn) {
    btn.disabled = true;
    errors.hidden = true;
    try {
      const res = await call(`/api/admin/clusters/${c.id}/article`, {
        method: 'PUT',
        body: {
          headline: headline.value, summary: summary.value, body: body.value, context: context.value, source,
          author_name: authorName.value, byline_style: bylineStyle, ...(pendingPicture && { picture: pendingPicture }),
          publish: doPublish, reviewed: reviewed.checked,
        },
      });
      c.article = res.article;
      articleDirty = false;
      pendingPicture = null;
      if (authorName.value.trim()) rememberName(authorName.value.trim());
      if (doPublish) {
        articleModal.close();
        notify({ title: 'Article published', message: 'Students will see it in the campus updates.', tone: 'success', okLabel: 'Done' });
      } else {
        save.textContent = 'Save draft';
        publish.textContent = 'Publish';
      }
      load();
    } catch (e) {
      showErrors(e.message, e.data?.issues);
    } finally {
      btn.disabled = false;
      setStatus();
    }
  }
  save.addEventListener('click', () => submit(false, save));
  publish.addEventListener('click', () => submit(true, publish));

  articleModal.replaceChildren(
    el('div', { class: 'report-modal-head' },
      el('h3', { id: 'article-modal-title', text: 'Resolution article' }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => cancel.click() }, '×')),
    el('div', { class: 'article-body stack' },
      el('p', { class: 'small muted', text: `Recurring incident #${c.id} · ${c.title} · ${c.report_count} reports · ${CLUSTER_STATUS[c.status]}` }),
      el('p', { class: 'small', text: 'Tell students what was done about this concern. Students only see the article after you review and publish it.' }),
      el('fieldset', { class: 'choices' }, el('legend', { class: 'field', text: 'How do you want to write it?' }), modeSelf, modeAi),
      aiPanel,
      fields,
      review,
      errors,
      statusLine,
      el('div', { class: 'adviser-actions article-actions' }, cancel, save, publish)),
  );

  // Reopening an existing article continues in the mode it was written in; a new one starts with the choice.
  const startMode = c.article ? (source === 'counselor' ? 'self' : 'ai') : null;
  if (startMode) (startMode === 'ai' ? modeAi : modeSelf).querySelector('input').checked = true;
  showMode(startMode);
  renderPicture();
  if (c.article && pictureKind !== 'preset') {
    savedPictureUrl(c.id).then((url) => {
      if (url && !pendingPicture) {
        pictureSrc = url;
        renderPicture();
      }
    });
  }
  updateCount();
  setStatus();
  articleModal.showModal();
}

// Single-series ranked bars: one hue, value at the tip, details on hover/focus.
function renderHotspots(spots) {
  const wrap = $('#hotspots');
  if (!spots.length) return wrap.replaceChildren(el('p', { class: 'muted', text: 'No reports in the last 30 days.' }));
  const max = Math.max(...spots.map((s) => s.reports));
  wrap.replaceChildren(...spots.map((s) => {
    const detail = `${s.location}: ${s.reports} report(s), average urgency ${s.avg_severity}/5, peak ${s.max_severity}/5 · ${s.categories.join(', ')}`;
    const bar = el('div', { class: 'hotspot-bar', title: detail, tabindex: '0', role: 'img', 'aria-label': detail });
    bar.style.width = `${Math.max(2, (s.reports / max) * 100)}%`;
    return el('div', { class: 'hotspot' },
      el('div', { class: 'hotspot-label' }, s.location, el('small', { text: s.categories.join(' · ') })),
      el('div', { class: 'hotspot-track' }, bar, el('span', { class: 'hotspot-value', text: s.reports }), sevBadge(s.max_severity, `peak`)),
    );
  }));
}

function renderModeration(items) {
  const wrap = $('#moderation');
  if (!items.length) return wrap.replaceChildren(el('p', { class: 'muted', text: 'Nothing waiting for moderation.' }));
  wrap.replaceChildren(...items.map((p) => {
    const decide = async (decision, btn) => {
      btn.disabled = true;
      try {
        await call(`/api/admin/posts/${p.id}/moderate`, { method: 'POST', body: { decision } });
        load();
      } catch (e) {
        notify({ title: "Couldn't save that decision", message: e.message, tone: 'error' });
        btn.disabled = false;
      }
    };
    return el('article', { class: 'card stack' },
      el('div', { class: 'post-head' }, el('span', { class: 'hashtag', text: hashtag(p.category) }), el('span', { text: `${p.location} · ${timeAgo(p.created_at)}` })),
      el('p', { class: 'post-body' }, taggedText(p.content)),
      p.notes.length ? el('div', { class: 'summary', text: p.notes.join(' ') }) : null,
      el('div', { class: 'adviser-actions' },
        el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => decide('publish', e.target) }, 'Publish as-is'),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: (e) => decide('withhold', e.target) }, 'Withhold'),
      ),
    );
  }));
}

const WHERE_IT_IS = {
  published: 'On the public feed',
  flagged_admin: 'In the counselor queue',
  pending_moderation: 'Held for moderation',
  withheld: 'Withheld after review',
};

function renderAllReports(rows) {
  const table = $('#all-reports');
  if (!rows.length) return table.replaceChildren(el('tr', {}, el('td', { text: 'No reports in the last 30 days.' })));
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...['When', 'Report', 'Urgency', 'Where it is', 'Summary'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', { class: 'small', text: timeAgo(r.created_at) }),
      el('td', {}, el('strong', { text: r.category }), el('div', { class: 'small muted', text: `${r.location} · #${r.id}${r.cluster_id ? ` · Recurring incident #${r.cluster_id}` : ''}` })),
      el('td', {}, sevBadge(r.severity_score, r.severity_label)),
      el('td', { class: 'small', text: r.private_report ? 'Private report (via the Adviser)' : (WHERE_IT_IS[r.status] ?? r.status) }),
      el('td', { class: 'small' }, el('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => openReportModal(r, e.currentTarget) }, 'Read')),
    ))),
  );
}

// One reusable pop-up for reading a full report, so opening a summary never stretches the table.
let reportModal = null;
let reportModalOpener = null;

function openReportModal(report, opener) {
  if (!reportModal) {
    reportModal = el('dialog', { class: 'report-modal', 'aria-labelledby': 'report-modal-title' });
    reportModal.addEventListener('click', (e) => {
      if (e.target === reportModal) reportModal.close();
    });
    reportModal.addEventListener('close', () => {
      reportModalOpener?.focus();
      reportModalOpener = null;
    });
    document.body.append(reportModal);
  }
  reportModalOpener = opener;
  reportModal.replaceChildren(
    el('div', { class: 'report-modal-head' },
      el('h3', { id: 'report-modal-title', text: `Report #${report.id} · ${report.category}` }),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => reportModal.close() }, '×'),
    ),
    el('div', { class: 'report-modal-meta small muted' },
      sevBadge(report.severity_score, report.severity_label),
      el('span', { text: report.location }),
      el('span', { text: new Date(report.created_at).toLocaleString() }),
      report.cluster_id ? el('span', { text: `Recurring incident #${report.cluster_id}` }) : null,
    ),
    el('p', { class: 'report-modal-body' }, taggedText(report.content)),
    el('p', { class: 'report-modal-note small muted', text: 'Identifying details were removed. This does not determine fault.' }),
  );
  reportModal.showModal();
}

function renderEscalations(rows) {
  const table = $('#escalations');
  if (!rows.length) return table.replaceChildren(el('tr', {}, el('td', { text: 'No escalations yet.' })));
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...['When', 'Scope', 'Urgency', 'Routed to', 'Summary'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', { class: 'small', text: new Date(r.dispatched_at).toLocaleString() }),
      el('td', { text: r.post_id ? `Report #${r.post_id}` : `Recurring incident #${r.cluster_id}` }),
      el('td', {}, sevBadge(r.severity_level, SEV_LABELS[r.severity_level])),
      el('td', { class: 'small', text: r.sent_to }),
      el('td', { class: 'small' }, el('details', {}, el('summary', {}, 'View summary'), el('p', { class: 'log-summary', text: r.summary_brief }))),
    ))),
  );
}

async function load() {
  if (!token) return showDashboard(false);
  try {
    const data = await call('/api/admin/overview');
    showDashboard(true);
    aiDrafting = Boolean(data.ai_drafting);
    aiPictures = Boolean(data.ai_pictures);
    renderStats(data.stats);
    renderPriority(data.priority);
    renderClusters(data.clusters);
    renderHotspots(data.hotspots);
    renderModeration(data.moderation);
    renderEscalations(data.escalations);
    renderAllReports(data.allReports ?? []);
  } catch (e) {
    if (e.status !== 401) notify({ title: "Couldn't load the dashboard", message: e.message, tone: 'error' });
  }
}

api('/api/admin/config').then((c) => { $('#demo-hint').hidden = !c.demo_passcode; }).catch(() => {});
load();
