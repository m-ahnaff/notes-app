// Cloud store backed by the `public.notes` table. Row Level Security on the
// server is the real access control; the user_id filter here is only for the
// index and defence in depth.
import { NOTE_FIELDS, normalizeTags, pick } from '../util.js';
import { StoreError } from './errors.js';

const COLS = 'id,title,content,tags,pinned,created_at,updated_at';
const PAGE = 1000;          // PostgREST default max-rows
const TIMEOUT_MS = 15000;   // a hung request must not block a note's save queue forever
const CHUNK = 200;          // rows per bulk upsert

const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined);
const withTimeout = (q) => { const sig = signal(); return sig ? q.abortSignal(sig) : q; };

function normalize(row) {
  return {
    id: row.id,
    title: row.title ?? '',
    content: row.content ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function clean(patch) {
  const out = pick(patch, NOTE_FIELDS);
  if ('tags' in out) out.tags = normalizeTags(out.tags);
  if ('title' in out) out.title = String(out.title ?? '').slice(0, 500);
  if ('content' in out) out.content = String(out.content ?? '');
  if ('pinned' in out) out.pinned = Boolean(out.pinned);
  return out;
}

/** Turn a PostgREST { error, status } into a StoreError with a retry hint. */
function fail(error, status) {
  // status 0 = fetch failed (offline / DNS / CORS); 5xx, 408, 429 = transient;
  // 401 = expired JWT, which supabase-js refreshes in the background.
  const retryable = !status || status >= 500 || status === 408 || status === 429 || status === 401;
  let message = error?.message || 'Request failed';
  if (error?.code === '42501') message = 'Permission denied by the database (row level security).';
  if (error?.code === '23514') message = 'Note is too large to save.';
  if (error?.code === '42P01') message = 'The notes table is missing — run supabase/schema.sql in the SQL editor.';
  return new StoreError(message, { retryable, cause: error, code: error?.code });
}

export function createSupabaseStore(client, user) {
  const userId = user.id;
  const table = () => client.from('notes');

  // Another tab may sign in as a different user; supabase-js shares the session
  // through localStorage, so this store would silently start writing with the
  // new user's token. Refuse instead (the edits stay in the local outbox).
  async function assertOwner() {
    let res;
    try {
      res = await client.auth.getSession();
    } catch (err) {
      throw new StoreError('Couldn’t check your session.', { retryable: true, cause: err });
    }
    // getSession() refreshes an expired token; a network failure there is transient.
    if (res.error) throw new StoreError(res.error.message || 'Session refresh failed', { retryable: true, cause: res.error });
    const current = res.data?.session?.user?.id;
    if (!current) throw new StoreError('You’re signed out. Sign in again to sync.', { retryable: false, code: 'signed-out' });
    if (current !== userId) {
      throw new StoreError('You switched accounts in another tab.', { retryable: false, code: 'session-changed' });
    }
  }
  const listeners = new Set();
  let last = 0;

  // "Polling-free" refresh: ask the app to re-list when the tab regains focus
  // or the network comes back (throttled).
  const hint = (type) => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (type !== 'online' && now - last < 4000) return;
    last = now;
    listeners.forEach((cb) => cb({ type }));
  };
  const onFocus = () => hint('focus');
  const onVisible = () => hint('focus');
  const onOnline = () => hint('online');

  return {
    kind: 'supabase',
    persistent: true,

    async list() {
      const out = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error, status } = await withTimeout(table()
          .select(COLS)
          .eq('user_id', userId)
          .order('id', { ascending: true }) // stable paging key; the UI sorts client-side
          .range(from, from + PAGE - 1));
        if (error) throw fail(error, status);
        out.push(...(data || []).map(normalize));
        if (!data || data.length < PAGE) break;
      }
      return out;
    },

    async get(id) {
      const { data, error, status } = await withTimeout(table().select(COLS).eq('id', id).maybeSingle());
      if (error) throw fail(error, status);
      return data ? normalize(data) : null;
    },

    // Upsert so a retried create (after a lost response) is idempotent.
    // user_id is filled by the column default auth.uid() and enforced by RLS.
    async create(note) {
      await assertOwner();
      // user_id is sent explicitly so the RLS WITH CHECK rejects a mismatched token.
      const row = { id: note.id, user_id: userId, ...clean(note) };
      if (note.created_at) row.created_at = note.created_at;
      const { data, error, status } = await withTimeout(table()
        .upsert(row, { onConflict: 'id' })
        .select(COLS)
        .single());
      if (error) throw fail(error, status);
      return normalize(data);
    },

    /** Bulk insert for import; keeps the notes' own timestamps. */
    async createMany(notes) {
      await assertOwner();
      const saved = [];
      for (let i = 0; i < notes.length; i += CHUNK) {
        const rows = notes.slice(i, i + CHUNK).map((n) => ({
          id: n.id, user_id: userId, ...clean(n), created_at: n.created_at, updated_at: n.updated_at,
        }));
        const { data, error, status } = await withTimeout(table().upsert(rows, { onConflict: 'id' }).select(COLS));
        if (error) { const err = fail(error, status); err.savedSoFar = saved; throw err; }
        saved.push(...(data || []).map(normalize));
      }
      return saved;
    },

    async update(id, patch) {
      const body = clean(patch);
      if (Object.keys(body).length === 0) return this.get(id);
      await assertOwner();
      const { data, error, status } = await withTimeout(table()
        .update(body)
        .eq('id', id)
        .select(COLS));
      if (error) throw fail(error, status);
      return data && data[0] ? normalize(data[0]) : null;
    },

    async delete(id) {
      await assertOwner();
      const { error, status } = await withTimeout(table().delete().eq('id', id));
      if (error) throw fail(error, status);
    },

    subscribe(cb) {
      if (listeners.size === 0) {
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', onOnline);
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) this.dispose();
      };
    },

    async refresh() {
      return this.list();
    },

    dispose() {
      listeners.clear();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    },
  };
}
