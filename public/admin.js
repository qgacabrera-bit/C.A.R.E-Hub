import { $, el, taggedText, timeAgo, sevBadge, hashtag, api } from './common.js';

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
    alert(e.message);
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
          alert(e.message);
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
// Resolution article editor: write it yourself, or give the AI context and edit its draft. Either
// way the counselor reviews the final text before it is published to the student feed.
// ---------------------------------------------------------------------------------------------
const CONTEXT_MIN = 40;
let fieldSeq = 0;

function labeled(text, control) {
  control.id ||= `article-field-${++fieldSeq}`;
  return el('div', {}, el('label', { class: 'field', for: control.id, text }), control);
}
let aiDrafting = false;
let articleModal = null;
let articleOpener = null;
let articleDirty = false;

function openArticleEditor(c, opener) {
  if (!articleModal) {
    articleModal = el('dialog', { class: 'report-modal article-modal', 'aria-labelledby': 'article-modal-title' });
    // Esc or the close button must not silently throw away an unsaved article.
    articleModal.addEventListener('cancel', (e) => {
      if (articleDirty && !confirm('Close without saving? Your changes to this article will be lost.')) e.preventDefault();
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
  const modeAi = choice('ai', 'Draft with AI', aiDrafting
    ? 'Give the AI context about what was done, then review and edit its draft.'
    : 'The AI is offline right now, so your context is filled into a template you can edit.');

  const context = el('textarea', { rows: '4', maxlength: '2000', 'aria-describedby': 'article-context-hint' });
  context.value = a.context ?? '';
  const contextCount = el('span', { class: 'small muted' });
  const generate = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Generate draft');
  const aiMsg = el('p', { class: 'small', role: 'status' });
  const aiPanel = el('div', { class: 'stack article-ai', hidden: true },
    labeled('Context for the draft (required)', context),
    el('p', { class: 'hint', id: 'article-context-hint', text: 'What was done, what changed, and what students should know. The AI only uses what you write here plus the incident facts. Names and contact details are removed before anything is sent to the AI.' }),
    el('div', { class: 'article-ai-row' }, contextCount, generate),
    aiMsg);

  const headline = el('input', { type: 'text', maxlength: '120' });
  const summary = el('textarea', { rows: '2', maxlength: '400' });
  const body = el('textarea', { rows: '10', maxlength: '6000', 'aria-describedby': 'article-body-hint' });
  headline.value = a.headline ?? '';
  summary.value = a.summary ?? '';
  body.value = a.body ?? '';
  const aiNote = el('p', { class: 'alert article-ai-note', text: 'AI draft: check every fact against what actually happened, and edit anything that is wrong or missing before publishing.' });
  const preview = el('div', { class: 'article-preview' });
  const previewBox = el('details', { class: 'article-preview-box' }, el('summary', {}, 'Preview as students will see it'), preview);
  previewBox.addEventListener('toggle', () => previewBox.open && renderPreview());
  const fields = el('div', { class: 'stack', hidden: true },
    aiNote,
    labeled('Headline', headline),
    labeled('Summary (shown on the carousel slide)', summary),
    labeled('Full article', body),
    el('p', { class: 'hint', id: 'article-body-hint', text: 'Leave a blank line between paragraphs.' }),
    previewBox);

  const reviewed = el('input', { type: 'checkbox' });
  const review = el('label', { class: 'ack article-review', hidden: true }, reviewed,
    el('span', { text: 'I reviewed this article: the facts are accurate, it names or hints at no one, and it does not blame anyone.' }));
  const errors = el('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const statusLine = el('p', { class: 'small muted article-status' });
  const save = el('button', { class: 'btn btn-sm', type: 'button' }, published ? 'Unpublish and save as draft' : 'Save draft');
  const publish = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, published ? 'Update published article' : 'Publish');
  const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
    if (!articleDirty || confirm('Close without saving? Your changes to this article will be lost.')) articleModal.close();
  } }, 'Close');

  function renderPreview() {
    const paragraphs = body.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    preview.replaceChildren(
      el('div', { class: 'small muted', text: `Resolved · Campus update · ${hashtag(c.incident_type)}` }),
      el('h4', { class: 'article-preview-headline', text: headline.value || 'Headline' }),
      el('p', { class: 'article-preview-summary', text: summary.value || 'Summary' }),
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
      : 'AI draft: check every fact against what actually happened, and edit anything that is wrong or missing before publishing.';
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
    if ((headline.value || summary.value || body.value) && !confirm('Replace the current headline, summary and article with a new draft?')) return;
    generate.disabled = true;
    errors.hidden = true;
    aiMsg.textContent = 'Drafting...';
    try {
      const d = await call(`/api/admin/clusters/${c.id}/article/draft`, { method: 'POST', body: { context: context.value } });
      headline.value = d.headline;
      summary.value = d.summary;
      body.value = d.body;
      source = d.source;
      aiMsg.textContent = d.source === 'ai' ? 'Draft ready. Review it below.' : 'The AI was unavailable, so a template was filled in from your context. Review it below.';
      if (d.issues.length) showErrors('The draft needs changes before it can be published:', d.issues);
      changed();
      showMode('ai');
      headline.focus();
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
        body: { headline: headline.value, summary: summary.value, body: body.value, context: context.value, source, publish: doPublish, reviewed: reviewed.checked },
      });
      c.article = res.article;
      articleDirty = false;
      if (doPublish) {
        articleModal.close();
        alert('Published. Students will see this article in the campus updates.');
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
        alert(e.message);
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
    renderStats(data.stats);
    renderPriority(data.priority);
    renderClusters(data.clusters);
    renderHotspots(data.hotspots);
    renderModeration(data.moderation);
    renderEscalations(data.escalations);
    renderAllReports(data.allReports ?? []);
  } catch (e) {
    if (e.status !== 401) alert(`Could not load dashboard: ${e.message}`);
  }
}

api('/api/admin/config').then((c) => { $('#demo-hint').hidden = !c.demo_passcode; }).catch(() => {});
load();
