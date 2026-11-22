// Small, dependency-free helpers.

export const NOTE_FIELDS = ['title', 'content', 'tags', 'pinned'];

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback using getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const nowIso = () => new Date().toISOString();

/** Milliseconds since epoch for an ISO-ish timestamp; 0 if invalid. */
export function ts(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function normalizeTag(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/.]/gu, '')
    .slice(0, 32);
}

export function normalizeTags(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}

/** Coerce anything into a well-formed note object (used by stores and import). */
export function sanitizeNote(n) {
  const now = nowIso();
  return {
    id: typeof n?.id === 'string' && UUID_RE.test(n.id) ? n.id : uid(),
    title: String(n?.title ?? '').slice(0, 500),
    content: String(n?.content ?? '').slice(0, 200000),
    tags: normalizeTags(n?.tags),
    pinned: Boolean(n?.pinned),
    created_at: ts(n?.created_at) ? new Date(ts(n.created_at)).toISOString() : now,
    updated_at: ts(n?.updated_at) ? new Date(ts(n.updated_at)).toISOString() : now,
  };
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

export function wordCount(text) {
  const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}

const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

export function relativeTime(iso) {
  const t = ts(iso);
  if (!t) return '';
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: abs > 31536000 ? 'numeric' : undefined });
}

export function fullDate(iso) {
  const t = ts(iso);
  return t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** Plain-text preview of markdown for list snippets (never rendered as HTML). */
export function snippet(md, max = 140) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const safeStorage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export function $(sel, root = document) { return root.querySelector(sel); }

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
