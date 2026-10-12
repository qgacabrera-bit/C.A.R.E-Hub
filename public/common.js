export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Render sanitized text with redaction tags highlighted. Built with DOM nodes - never innerHTML. */
export function taggedText(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(\[[^\]]{1,40}\])/g)) {
    if (!part) continue;
    frag.append(/^\[[^\]]+\]$/.test(part) ? el('span', { class: 'tag', text: part }) : document.createTextNode(part));
  }
  return frag;
}

export function timeAgo(iso) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function sevBadge(score, label) {
  return el('span', { class: `sev sev-${score}`, title: `Urgency ${score} of 5` }, `${score}/5 · ${label}`);
}

export const hashtag = (category) => `#${category.replace(/[^A-Za-z]/g, '')}`;

export async function api(path, { method = 'GET', body, token, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: fall back to in-memory only */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Site-styled confirm / notice dialogs, used instead of the browser's confirm() and alert().
// ---------------------------------------------------------------------------------------------
// Icon shapes are constant markup, never user text.
const DIALOG_ICONS = {
  warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
  danger: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};
let dialogSeq = 0;

/**
 * Ask the visitor to confirm something. Resolves true for the confirm button, false for Cancel,
 * Esc or a click outside. `tone` sets the icon and button color: info | warning | danger | error | success.
 * With `cancelLabel: null` it is a one-button notice (see notify()).
 */
export function confirmDialog({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', tone = 'info' }) {
  return new Promise((resolve) => {
    const id = `care-dialog-${++dialogSeq}`;
    const opener = document.activeElement;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = DIALOG_ICONS[tone] ?? DIALOG_ICONS.info;

    let answer = false;
    const finish = (value) => {
      answer = value;
      dialog.close();
    };
    const ok = el('button', { class: `btn ${tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}`, type: 'button', onclick: () => finish(true) }, confirmLabel);
    const cancel = cancelLabel ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => finish(false) }, cancelLabel) : null;
    const dialog = el('dialog', { class: `care-dialog care-dialog-${tone}`, role: cancel ? 'alertdialog' : 'dialog', 'aria-labelledby': `${id}-title`, 'aria-describedby': message ? `${id}-text` : null },
      el('div', { class: 'care-dialog-icon' }, icon),
      el('h2', { class: 'care-dialog-title', id: `${id}-title`, text: title }),
      message ? el('p', { class: 'care-dialog-text', id: `${id}-text`, text: message }) : null,
      el('div', { class: 'care-dialog-actions' }, cancel, ok));

    dialog.addEventListener('click', (e) => e.target === dialog && finish(false)); // backdrop
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    // Destructive choices start on Cancel, so a stray Enter never deletes anything.
    (tone === 'danger' && cancel ? cancel : ok).focus();
  });
}

/** One-button notice: an error, a success message, or anything that needs acknowledging. */
export const notify = ({ title, message, tone = 'info', okLabel = 'OK' }) =>
  confirmDialog({ title, message, tone, confirmLabel: okLabel, cancelLabel: null });
