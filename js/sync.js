// Sync engine: debounced, per-note serialized writes with retry.
//
// Guarantees:
//  * At most one request in flight per note, so saves can never land out of order.
//  * Edits made while a request is in flight are kept in `pending` and sent next;
//    the save response never overwrites fields that still have unsaved edits.
//  * A create is an idempotent upsert of the *current* local note, so a retry after a
//    lost response is safe, and an update that finds no row recreates the note
//    instead of losing the user's typing.
//  * Network/transient failures back off and retry; permanent failures surface once.
import { NOTE_FIELDS } from './util.js';

const MAX_BACKOFF = 30000;
const MAX_WAIT = 5000; // save at least every 5s during continuous typing

export class Syncer {
  /**
   * @param {import('./store/index.js').NoteStore} store
   * @param {{ getLocal:(id:string)=>any, onSaved:(id:string, note:any)=>void,
   *           onStatus:(s:{state:string, error?:Error})=>void, onError:(id:string, err:Error)=>void,
   *           onDone?:(id:string)=>void, onIdle?:(id:string)=>void, delay?:number }} opts
   */
  constructor(store, { getLocal, onSaved, onDone, onIdle, onStatus, onError, delay = 800 }) {
    this.store = store;
    this.getLocal = getLocal;
    this.onSaved = onSaved;
    this.onDone = onDone || (() => {});
    this.onIdle = onIdle || (() => {});
    this.onStatus = onStatus;
    this.onError = onError;
    this.delay = delay;
    this.entries = new Map();
    this.disposed = false;
    this.lastState = 'saved';
    this._onOnline = () => this.retryAll();
    window.addEventListener('online', this._onOnline);
  }

  _entry(id) {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        pending: null, needsCreate: false, needsDelete: false,
        timer: null, retryTimer: null, running: null, again: false,
        attempt: 0, failed: null, firstPendingAt: 0,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Queue an upsert of the full local note (new note, restore, import). */
  create(id) {
    const e = this._entry(id);
    e.needsDelete = false;
    e.needsCreate = true;
    e.pending = null;
    e.failed = null;
    this._schedule(id, 0);
  }

  /** Queue a debounced partial update. */
  patch(id, patch) {
    const e = this._entry(id);
    if (e.needsDelete) return;
    if (!e.needsCreate) e.pending = { ...(e.pending || {}), ...patch };
    // After a permanent failure we keep trying on each typing pause (the user may
    // have fixed the cause), but the same error is only reported once.
    if (!e.firstPendingAt) e.firstPendingAt = Date.now();
    const overdue = Date.now() - e.firstPendingAt >= MAX_WAIT;
    if (overdue && e.timer) return; // a save is already due; don't push it back
    this._schedule(id, overdue ? 0 : this.delay);
  }

  /** Queue a delete; drops any unsent edits for that note. */
  remove(id) {
    const e = this._entry(id);
    e.pending = null;
    e.needsCreate = false;
    e.needsDelete = true;
    e.failed = null;
    this._schedule(id, 0);
  }

  /** Fields whose local value is newer than anything the server has confirmed. */
  pendingFields(id) {
    const e = this.entries.get(id);
    if (!e) return [];
    if (e.needsCreate) return NOTE_FIELDS;
    return Object.keys(e.pending || {});
  }

  isDirty(id) {
    const e = this.entries.get(id);
    return Boolean(e && (e.pending || e.needsCreate || e.needsDelete || e.running || e.timer || e.retryTimer || e.failed));
  }

  hasUnsaved() {
    for (const id of this.entries.keys()) if (this.isDirty(id)) return true;
    return false;
  }

  flush(id) {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    clearTimeout(e.timer); e.timer = null;
    clearTimeout(e.retryTimer); e.retryTimer = null;
    return this._run(id);
  }

  flushAll() {
    return Promise.allSettled([...this.entries.keys()].map((id) => this.flush(id)));
  }

  retryAll() {
    for (const [id, e] of this.entries) {
      if (e.retryTimer || e.failed || e.pending) { e.failed = null; e.attempt = 0; this.flush(id); }
    }
  }

  _schedule(id, ms) {
    const e = this._entry(id);
    // While backing off, new edits just accumulate; the retry (or an `online`
    // event / explicit flush) sends them. Typing must not defeat the backoff.
    if (e.retryTimer) { this._emit(); return; }
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { e.timer = null; this._run(id); }, ms);
    this._emit();
  }

  _run(id) {
    const e = this.entries.get(id);
    if (!e || this.disposed) return Promise.resolve();
    if (e.running) { e.again = true; return e.running; }

    e.running = (async () => {
      do {
        e.again = false;
        if (this.disposed) return;
        let saved = null;
        if (e.needsDelete) {
          e.needsDelete = false;
          try { await this.store.delete(id); } catch (err) { if (!e.needsCreate) e.needsDelete = true; throw err; }
          e.attempt = 0;
          e.failed = null;
          e.failedMsg = null;
          if (!this.disposed) this.onDone(id);
          continue;
        } else if (e.needsCreate) {
          const note = this.getLocal(id);
          e.needsCreate = false;
          e.pending = null;
          e.firstPendingAt = 0;
          if (!note) continue;
          try { saved = await this.store.create(note); } catch (err) { if (!e.needsDelete) e.needsCreate = true; throw err; }
        } else if (e.pending) {
          const patch = e.pending;
          e.pending = null;
          e.firstPendingAt = 0;
          try {
            saved = await this.store.update(id, patch);
          } catch (err) {
            if (!e.needsCreate && !e.needsDelete) e.pending = { ...patch, ...(e.pending || {}) };
            throw err;
          }
          if (saved === null) {
            // Row vanished (deleted on another device). Last write wins: recreate it
            // from the local copy so nothing the user typed is lost.
            if (!e.needsDelete) { e.needsCreate = true; e.pending = null; }
            continue;
          }
        } else {
          break;
        }
        e.attempt = 0;
        e.failed = null;
        e.failedMsg = null;
        if (this.disposed) return;
        this.onDone(id);
        if (saved && !e.needsDelete) this.onSaved(id, saved);
      } while (!this.disposed && (e.again || e.needsDelete || e.needsCreate || (e.pending && !e.timer)));
    })()
      .catch((err) => {
        if (this.disposed) return;
        if (err && err.retryable === true) {
          e.attempt += 1;
          const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(e.attempt, 5));
          clearTimeout(e.retryTimer);
          e.retryTimer = setTimeout(() => { e.retryTimer = null; this._run(id); }, wait);
          this.lastError = err;
        } else {
          const repeat = e.failedMsg === String(err?.message);
          e.failed = err;
          e.failedMsg = String(err?.message);
          if (!repeat) this.onError(id, err);
        }
      })
      .finally(() => {
        e.running = null;
        if (this.disposed) return;
        const busy = e.pending || e.needsCreate || e.needsDelete || e.timer || e.retryTimer;
        if (!busy && !e.failed) { this.entries.delete(id); this.onIdle(id); }
        else if (e.again && !e.timer && !e.retryTimer) this._run(id);
        this._emit();
      });

    this._emit();
    return e.running;
  }

  _emit() {
    let state = 'saved';
    let error;
    for (const e of this.entries.values()) {
      if (e.failed) { state = 'error'; error = e.failed; break; }
      if (e.retryTimer) state = 'offline';
      else if (state !== 'offline' && (e.running || e.timer || e.pending || e.needsCreate || e.needsDelete)) state = 'saving';
    }
    if (state === 'offline') error = this.lastError;
    this.lastState = state;
    this.onStatus({ state, error });
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('online', this._onOnline);
    for (const e of this.entries.values()) {
      clearTimeout(e.timer);
      clearTimeout(e.retryTimer);
    }
    this.entries.clear();
  }
}
