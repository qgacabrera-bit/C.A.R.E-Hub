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
$('#logout').addEventListener('click', () => {
  setToken(null);
  showDashboard(false);
});
$('#refresh').addEventListener('click', () => load());

// ---------------------------------------------------------------------------------------------

function renderStats(s) {
  const tile = (value, label) => el('div', { class: 'stat' }, el('div', { class: 'stat-value', text: value }), el('div', { class: 'stat-label', text: label }));
  $('#stats').replaceChildren(
    tile(s.priority, 'Reports in the counselor queue'),
    tile(s.open_clusters, 'Open incident clusters'),
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
        ? el('span', {}, `Cluster #${p.cluster.id} · ${p.cluster.title}`, el('span', { class: 'muted', text: ` · ${p.cluster.report_count} reports since ${shortDate(p.cluster.first_reported_at)} · ${CLUSTER_STATUS[p.cluster.status] ?? p.cluster.status}` }))
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

function renderClusters(clusters) {
  const table = $('#clusters');
  if (!clusters.length) return table.replaceChildren(el('tr', {}, el('td', { text: 'No clusters yet. Clusters form when similar reports recur.' })));
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...['Cluster', 'Zone', 'Reports', 'Peak urgency', 'Window', 'Workflow status'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, ...clusters.map((c) => {
      const select = el('select', { 'aria-label': `Status for cluster ${c.id}` },
        ...['active', 'reviewing', 'resolved'].map((s) => {
          const opt = el('option', { value: s, text: { active: 'Active', reviewing: 'Under review', resolved: 'Resolved' }[s] });
          opt.selected = c.status === s;
          return opt;
        }));
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await call(`/api/admin/clusters/${c.id}`, { method: 'PATCH', body: { status: select.value } });
        } catch (e) {
          alert(e.message);
          select.value = c.status;
        } finally {
          select.disabled = false;
        }
      });
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
      );
    })),
  );
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
      el('td', {}, el('strong', { text: r.category }), el('div', { class: 'small muted', text: `${r.location} · #${r.id}${r.cluster_id ? ` · Cluster #${r.cluster_id}` : ''}` })),
      el('td', {}, sevBadge(r.severity_score, r.severity_label)),
      el('td', { class: 'small', text: r.private_report ? 'Private report (via the Adviser)' : (WHERE_IT_IS[r.status] ?? r.status) }),
      el('td', { class: 'small' }, el('details', {}, el('summary', {}, 'Read'), el('p', { class: 'log-summary' }, taggedText(r.content)))),
    ))),
  );
}

function renderEscalations(rows) {
  const table = $('#escalations');
  if (!rows.length) return table.replaceChildren(el('tr', {}, el('td', { text: 'No escalations yet.' })));
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...['When', 'Scope', 'Urgency', 'Routed to', 'Summary'].map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', { class: 'small', text: new Date(r.dispatched_at).toLocaleString() }),
      el('td', { text: r.post_id ? `Report #${r.post_id}` : `Cluster #${r.cluster_id}` }),
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
