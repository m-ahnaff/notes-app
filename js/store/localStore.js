// Demo-mode store: notes live in this browser's localStorage.
// Falls back to memory (with persistent=false) when storage is blocked.
import { NOTE_FIELDS, nowIso, pick, sanitizeNote } from '../util.js';
import { StoreError } from './errors.js';

export const LOCAL_KEY = 'notes-app:demo:notes:v1';

function storageAvailable() {
  try {
    const k = '__notes_app_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const MAX_CONTENT = 200000;
const MAX_TITLE = 500;

function assertSize(n) {
  if (String(n.content ?? '').length > MAX_CONTENT || String(n.title ?? '').length > MAX_TITLE) {
    throw new StoreError('Note is too large to save (200,000 characters max).', { retryable: false, code: 'too-large' });
  }
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Read demo notes without creating a store (used to offer "copy to account"). */
export function peekLocalNotes() {
  try {
    const arr = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(arr) ? arr.map(sanitizeNote) : [];
  } catch {
    return [];
  }
}

export function createLocalStore() {
  const persistent = storageAvailable();
  let memory = [];

  function readAll() {
    if (!persistent) return memory;
    let raw = null;
    try {
      raw = localStorage.getItem(LOCAL_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) throw new Error('not an array');
      return arr.map(sanitizeNote);
    } catch {
      // Keep a copy of unreadable data instead of overwriting it on the next write.
      if (raw) {
        try { localStorage.setItem(`${LOCAL_KEY}:corrupt-${Date.now()}`, raw); localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ }
      }
      return memory;
    }
  }

  function writeAll(arr) {
    memory = arr;
    if (!persistent) return;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(arr));
    } catch (err) {
      throw new StoreError('Browser storage is full — export your notes and remove some.', { retryable: false, cause: err });
    }
  }

  const listeners = new Set();
  const onStorage = (e) => {
    if (e.key === LOCAL_KEY || e.key === null) listeners.forEach((cb) => cb({ type: 'external' }));
  };

  return {
    kind: 'local',
    persistent,

    async list() {
      return clone(readAll());
    },

    async get(id) {
      return clone(readAll().find((n) => n.id === id) ?? null);
    },

    async create(note) {
      assertSize(note);
      const all = readAll();
      const n = sanitizeNote({ ...note, updated_at: nowIso() });
      const i = all.findIndex((x) => x.id === n.id);
      if (i >= 0) all[i] = { ...n, created_at: all[i].created_at };
      else all.push(n);
      writeAll(all);
      return clone(i >= 0 ? all[i] : n);
    },

    async update(id, patch) {
      const all = readAll();
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) return null;
      assertSize({ ...all[i], ...patch });
      const next = sanitizeNote({ ...all[i], ...pick(patch, NOTE_FIELDS), updated_at: nowIso() });
      next.created_at = all[i].created_at;
      all[i] = next;
      writeAll(all);
      return clone(next);
    },

    /** Bulk insert for import: one storage write, keeps the notes' own timestamps. */
    async createMany(notes) {
      notes.forEach(assertSize);
      const all = readAll();
      const ids = new Set(all.map((n) => n.id));
      const add = notes.map(sanitizeNote).filter((n) => !ids.has(n.id));
      writeAll(all.concat(add));
      return clone(add);
    },

    async delete(id) {
      writeAll(readAll().filter((x) => x.id !== id));
    },

    subscribe(cb) {
      if (listeners.size === 0) window.addEventListener('storage', onStorage);
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) window.removeEventListener('storage', onStorage);
      };
    },

    async refresh() {
      return this.list();
    },

    dispose() {
      listeners.clear();
      window.removeEventListener('storage', onStorage);
    },
  };
}
