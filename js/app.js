// Inkwell — app bootstrap, mode switching (demo ↔ cloud), list + editor UI.
import {
  cleanAuthUrl, initSupabase, isConfigured, mountAuthView, mountPasswordDialog, readAuthRedirect,
} from './auth.js';
import { exportJson, exportMarkdown, parseImport } from './io.js';
import { preloadMarkdown, renderMarkdown } from './markdown.js';
import { createLocalStore, createSupabaseStore } from './store/index.js';
import { peekLocalNotes } from './store/localStore.js';
import { Syncer } from './sync.js';
import { toast } from './toast.js';
import {
  $, NOTE_FIELDS, el, fullDate, isMac, normalizeTag, nowIso, relativeTime, safeStorage, snippet, ts, uid, wordCount,
} from './util.js';

const LS_MODE = 'notes-app:mode';
const LS_THEME = 'notes-app:theme';
const LS_SORT = 'notes-app:sort';
const LS_DEMO_OFFER = 'notes-app:demo-offer:';
const LS_OUTBOX = 'notes-app:outbox:'; // + 'demo' | user id

const AUTH_ERRORS = {
  otp_expired: 'That email link has expired or was already used.',
  access_denied: 'That email link is no longer valid.',
  bad_jwt: 'That email link is invalid.',
};

const state = {
  mode: null,          // 'demo' | 'cloud' | null (auth screen / booting)
  user: null,
  store: null,
  syncer: null,
  unsub: null,
  gen: 0,              // bumps on every mode switch; stale async results are dropped
  notes: new Map(),
  touched: new Map(),  // id -> performance.now() of last local change / confirmed save
  activeId: null,
  query: '',
  tag: null,
  sort: safeStorage.get(LS_SORT) || 'updated',
  preview: false,
  loading: false,
  loadError: null,
  outbox: new Map(),   // id -> { note, del } : unsynced work, mirrored to localStorage
};

const els = {
  boot: $('#boot'),
  app: $('#app-view'),
  list: $('#note-list'),
  listEmpty: $('#list-empty'),
  listTitle: $('#list-title'),
  listCount: $('#list-count'),
  tagFilter: $('#tag-filter'),
  search: $('#search'),
  sort: $('#sort'),
  badge: $('#mode-badge'),
  badgeText: $('#mode-badge-text'),
  editor: $('#editor'),
  editorEmpty: $('#editor-empty'),
  title: $('#note-title'),
  body: $('#note-body'),
  preview: $('#note-preview'),
  tagsList: $('#tags-list'),
  tagInput: $('#tag-input'),
  pinBtn: $('#pin-btn'),
  modeEdit: $('#mode-edit'),
  modePreview: $('#mode-preview'),
  status: $('#save-status'),
  statusText: $('#save-status-text'),
  words: $('#word-count'),
  readTime: $('#read-time'),
  editedAt: $('#edited-at'),
  menuBtn: $('#menu-btn'),
  menuPanel: $('#menu-panel'),
  menuWho: $('#menu-who'),
  menuToAuth: $('#menu-to-auth'),
  menuSignOut: $('#menu-sign-out'),
  importFile: $('#import-file'),
  liveStatus: $('#live-status'),
  menuChangePw: $('#menu-change-pw'),
  menuCopyDemo: $('#menu-copy-demo'),
  shortcuts: $('#shortcuts-dialog'),
};

const phoneMq = matchMedia('(max-width: 759px)');
const isPhone = () => phoneMq.matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let authView = null;
let passwordDialog = null;
let bootRedirect = { present: false };
let pendingRecovery = false;
let transition = Promise.resolve();

/** Serialize mode transitions so overlapping auth events can't interleave. */
function enqueue(fn) {
  transition = transition.then(fn).catch((err) => {
    console.error(err);
    toast(err?.message || 'Something went wrong.', { type: 'error' });
  });
  return transition;
}

/* ------------------------------------------------------------------ *
 * Boot & modes
 * ------------------------------------------------------------------ */

async function boot() {
  applyTheme(safeStorage.get(LS_THEME) || 'system');
  els.sort.value = state.sort;
  if (isMac) document.querySelectorAll('[data-mod], #search-kbd').forEach((k) => {
    k.textContent = k.id === 'search-kbd' ? '⌘K' : '⌘';
    if (k.id === 'search-kbd') k.setAttribute('aria-label', 'Shortcut: Command K');
  });
  bindUI();

  if (!isConfigured()) {
    cleanAuthUrl();
    await enqueue(() => enterDemo({ reason: 'unconfigured' }));
    return;
  }

  bootRedirect = readAuthRedirect();
  pendingRecovery = bootRedirect.type === 'recovery' && !bootRedirect.error;
  const getClient = () => initSupabase(onAuthEvent);
  authView = mountAuthView({ getClient, onDemo: () => enqueue(() => enterDemo({ chosen: true })) });
  passwordDialog = mountPasswordDialog({ getClient, toast });

  try {
    await getClient(); // INITIAL_SESSION arrives via onAuthEvent
  } catch (err) {
    console.error(err);
    cleanAuthUrl();
    toast('Couldn’t load cloud sync — running in demo mode.', { type: 'error' });
    await enqueue(() => enterDemo({ reason: 'offline' }));
  }
}

function onAuthEvent(event, session) {
  enqueue(async () => {
    if (event === 'INITIAL_SESSION') cleanAuthUrl();
    // PASSWORD_RECOVERY is broadcast to every open tab; only the tab that opened
    // the recovery link (pendingRecovery from its URL) shows the dialog.
    const user = session?.user ?? null;

    if (user) {
      if (state.mode === 'cloud' && state.user?.id === user.id) {
        state.user = user; // token refresh / user updated
        updateChrome();
      } else {
        if (state.mode === 'cloud') toast('Switched account in another tab.');
        await enterCloud(user);
      }
      if (pendingRecovery) { pendingRecovery = false; passwordDialog.open(); }
      return;
    }

    if (event === 'INITIAL_SESSION') {
      const err = bootRedirect.error
        ? (AUTH_ERRORS[bootRedirect.errorCode] || 'That email link didn’t work.') : null;
      if (safeStorage.get(LS_MODE) === 'demo' && !err) await enterDemo();
      else showAuth(err ? `${err} Request a new one below.` : '', err ? 'error' : 'info');
    } else if (event === 'SIGNED_OUT' && state.mode === 'cloud') {
      // Involuntary or from another tab: requests would now fail, so keep the
      // unsynced work in the outbox for the next sign-in instead of flushing.
      await teardown({ flush: false });
      showAuth('You’re signed out.');
    }
  });
}

async function enterDemo({ chosen = false, reason } = {}) {
  if (state.mode === 'demo') return;
  if (chosen) safeStorage.set(LS_MODE, 'demo');
  await switchStore('demo', createLocalStore(), null);
  if (reason === 'unconfigured') els.badgeText.textContent = 'Demo mode — notes stay in this browser';
  if (!state.store.persistent) {
    toast('Browser storage is blocked, so notes will disappear when you close this tab.', { type: 'error', duration: 10000 });
  }
}

async function enterCloud(user) {
  const client = await initSupabase(onAuthEvent);
  safeStorage.remove(LS_MODE);
  // Never flush another account's queue with this user's token.
  await teardown({ flush: state.mode === 'demo' });
  await switchStore('cloud', createSupabaseStore(client, user), user);
  offerDemoCopy(user);
}

async function switchStore(mode, store, user) {
  await teardown();
  const gen = ++state.gen;
  state.mode = mode;
  state.user = user;
  state.store = store;
  state.syncer = new Syncer(store, {
    getLocal: (id) => state.notes.get(id),
    onSaved: handleSaved,
    onDone: (id) => state.touched.set(id, performance.now()),
    onIdle: (id) => outboxDrop(id),
    onStatus: renderStatus,
    onError: (id, err) => toast(`Couldn’t save: ${err.message}`, {
      type: 'error', action: { label: 'Retry', run: () => state.syncer?.retryAll() },
    }),
  });
  state.unsub = store.subscribe(() => refresh());
  state.outbox = new Map();
  renderStatus({ state: 'saved' });
  showApp();
  updateChrome();
  await loadNotes(gen, { replay: true });
}

/* ---- Outbox: unsynced notes survive tab close, crashes and sign-out ----
 * Stored per account as { [noteId]: { note?, del?, base, tab, at } }:
 *   base = server updated_at the local edit started from (null for new notes)
 *   tab  = id of the tab that owns the entry (tabs heartbeat their liveness)
 * Writes are batched (≤250ms) and merged with what other tabs stored.
 */

const TAB_ID = uid();
const LS_TAB = 'notes-app:tab:';
const LEASE_MS = 30000;
const outboxOps = new Map(); // id -> entry | null (pending writes from this tab)
let outboxTimer = null;
let outboxWarned = false;

const outboxKey = () => (state.mode ? LS_OUTBOX + (state.mode === 'cloud' ? state.user.id : 'demo') : null);

function heartbeat() { safeStorage.set(LS_TAB + TAB_ID, String(Date.now())); }
function tabAlive(tab) {
  if (!tab || tab === TAB_ID) return tab === TAB_ID;
  return Date.now() - Number(safeStorage.get(LS_TAB + tab) || 0) < LEASE_MS;
}
heartbeat();
setInterval(heartbeat, 10000);
window.addEventListener('pagehide', () => safeStorage.remove(LS_TAB + TAB_ID));

function outboxRead(key = outboxKey()) {
  if (!key) return {};
  try {
    const obj = JSON.parse(safeStorage.get(key) || '{}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function outboxFlush() {
  clearTimeout(outboxTimer);
  outboxTimer = null;
  const key = outboxKey();
  if (!key || !outboxOps.size) { outboxOps.clear(); return; }
  const stored = outboxRead(key);
  for (const [id, entry] of outboxOps) {
    if (entry) stored[id] = entry;
    // Never drop work owned by another *open* tab; entries from dead tabs were taken over by us.
    else if (stored[id] && (stored[id].tab === TAB_ID || !tabAlive(stored[id].tab))) delete stored[id];
  }
  outboxOps.clear();
  const ok = Object.keys(stored).length === 0 ? (safeStorage.remove(key), true) : safeStorage.set(key, JSON.stringify(stored));
  if (!ok && !outboxWarned) {
    outboxWarned = true;
    toast('Browser storage is full — unsynced changes can’t be backed up locally.', { type: 'error' });
  }
}

function outboxQueue(id, entry) {
  if (!state.mode) return;
  outboxOps.set(id, entry);
  if (!outboxTimer) outboxTimer = setTimeout(outboxFlush, 250);
}

function outboxPut(id, { del = false, base } = {}) {
  const note = state.notes.get(id);
  if (!del && !note) return;
  const prev = state.outbox.get(id);
  const entry = {
    ...(del ? { del: true } : { note }),
    base: prev ? prev.base : (base !== undefined ? base : null),
    tab: TAB_ID,
    at: Date.now(),
  };
  state.outbox.set(id, entry);
  outboxQueue(id, entry);
}

function outboxDrop(id) {
  if (state.outbox.delete(id)) outboxQueue(id, null);
}

/** Take over entries whose tab is gone, and re-queue them without clobbering newer server data. */
function replayOutbox() {
  const stored = outboxRead();
  let synced = 0;
  let conflicts = 0;
  for (const [id, item] of Object.entries(stored)) {
    // Skip our own entries and those of other tabs that are still open.
    if (!item || !(item.del || item.note?.id) || tabAlive(item.tab)) continue;
    const remote = state.notes.get(id);
    const serverMoved = remote && item.base && ts(remote.updated_at) > ts(item.base);
    const entry = { ...item, tab: TAB_ID };
    state.touched.set(id, performance.now());
    if (item.del) {
      if (serverMoved) { outboxQueue(id, null); continue; } // edited elsewhere since: keep it
      state.outbox.set(id, entry);
      outboxQueue(id, entry);
      state.notes.delete(id);
      state.syncer.remove(id);
      continue;
    }
    const local = item.note;
    if (remote && sameContent(remote, local)) { outboxQueue(id, null); continue; } // already saved
    // (base null = created in that tab; ids are client-generated, so the row is ours.)
    if (serverMoved) {
      // Changed on the server since this edit started: keep both versions.
      outboxQueue(id, null);
      const copy = { ...local, id: uid(), title: `${local.title || 'Untitled'} (conflicted copy)` };
      if ([...state.notes.values()].some((n) => sameContent(n, copy))) continue; // replayed before
      state.notes.set(copy.id, copy);
      state.syncer.create(copy.id);
      outboxPut(copy.id);
      conflicts += 1;
      continue;
    }
    state.notes.set(id, { ...local });
    state.outbox.set(id, entry);
    outboxQueue(id, entry);
    state.syncer.create(id);
    synced += 1;
  }
  if (!synced && !conflicts) return;
  renderAll();
  if (conflicts) toast(`${conflicts} note${conflicts === 1 ? '' : 's'} changed elsewhere while you were away — kept both versions as “conflicted copy”.`, { duration: 9000 });
  else if (state.mode === 'cloud') toast(`Syncing ${synced} unsaved change${synced === 1 ? '' : 's'} from your last visit…`);
}

const sameContent = (a, b) => a.title === b.title && a.content === b.content && Boolean(a.pinned) === Boolean(b.pinned)
  && (a.tags || []).join('\u0000') === (b.tags || []).join('\u0000');

async function loadNotes(gen = state.gen, { replay = false } = {}) {
  state.loading = true;
  state.loadError = null;
  renderList();
  const started = performance.now();
  try {
    const notes = await state.store.list();
    if (gen !== state.gen) return;
    // Merge, don't replace: keep anything created or edited while loading.
    const next = new Map(notes.map((n) => [n.id, n]));
    for (const [id, local] of state.notes) {
      if (state.syncer.isDirty(id) || importing.has(id) || (state.touched.get(id) ?? 0) >= started) next.set(id, local);
    }
    for (const id of [...next.keys()]) {
      // deleted while loading (still queued, or already done after list() snapshotted)
      if (!state.notes.has(id) && (state.syncer.isDirty(id) || (state.touched.get(id) ?? 0) >= started)) next.delete(id);
    }
    state.notes = next;
  } catch (err) {
    if (gen !== state.gen) return;
    console.error(err);
    state.loadError = err;
  }
  state.loading = false;
  if (replay && gen === state.gen) replayOutbox(); // also when offline: recovered work stays visible
  renderAll();
  if (!state.loadError && !isPhone() && !state.activeId) {
    const first = visibleNotes()[0];
    if (first) openNote(first.id, { focus: null });
  }
}

/** Optionally flush, then drop everything belonging to the current mode. */
async function teardown({ flush = true } = {}) {
  if (!state.store) return;
  const { syncer, store, unsub } = state;
  state.gen += 1;
  els.app.inert = true; // no edits into a store that is going away
  closeEditor({ silent: true, flush });
  if (flush && syncer?.hasUnsaved()) await Promise.race([syncer.flushAll(), sleep(3000)]);
  outboxFlush();
  unsub?.();
  store.dispose?.();
  syncer?.dispose();
  Object.assign(state, {
    mode: null, user: null, store: null, syncer: null, unsub: null,
    notes: new Map(), touched: new Map(), activeId: null, tag: null, query: '', loadError: null,
    outbox: new Map(), loading: false,
  });
  refreshing = null;
  closeEditor({ silent: true });
  els.search.value = '';
  els.list.replaceChildren();
}

function showApp() {
  const hadFocusInAuth = document.activeElement?.closest?.('#auth-view');
  els.boot.hidden = true;
  authView?.hide();
  els.app.hidden = false;
  els.app.inert = false;
  if (hadFocusInAuth || document.activeElement === document.body) requestAnimationFrame(() => els.search.focus());
}

function showAuth(message, kind) {
  els.boot.hidden = true;
  els.app.hidden = true;
  authView.show(message, kind);
}

function updateChrome() {
  const demo = state.mode === 'demo';
  els.badge.hidden = !demo;
  els.menuWho.textContent = demo ? 'Demo mode · this browser only' : `Signed in as ${state.user?.email ?? ''}`;
  els.menuToAuth.hidden = !(demo && isConfigured());
  els.menuSignOut.hidden = demo;
  els.menuChangePw.hidden = demo;
  els.menuCopyDemo.hidden = demo || peekLocalNotes().length === 0;
  document.title = 'Inkwell — Notes';
}

function offerDemoCopy(user) {
  const key = LS_DEMO_OFFER + user.id;
  if (safeStorage.get(key)) return;
  const local = peekLocalNotes();
  if (!local.length) return;
  safeStorage.set(key, '1');
  const gen = state.gen;
  toast(`You have ${local.length} note${local.length === 1 ? '' : 's'} from demo mode. Copy them into your account?`, {
    duration: 15000,
    action: {
      label: 'Copy',
      run: () => {
        if (gen !== state.gen) return;
        copyDemoNotes();
      },
    },
  });
}

function copyDemoNotes() {
  const local = peekLocalNotes();
  if (!local.length) { toast('There are no demo notes in this browser.'); return; }
  importFile(new File([JSON.stringify(local)], 'demo.json', { type: 'application/json' }), 'Copied');
}

/* ------------------------------------------------------------------ *
 * Sync callbacks & refresh
 * ------------------------------------------------------------------ */

function handleSaved(id, saved) {
  const local = state.notes.get(id);
  if (!local) return; // deleted meanwhile
  const pending = new Set(state.syncer.pendingFields(id));
  const merged = { ...saved };
  // Never let a save response clobber edits typed after the request was sent.
  for (const f of NOTE_FIELDS) if (pending.has(f)) merged[f] = local[f];
  if (pending.size) merged.updated_at = local.updated_at;
  state.notes.set(id, merged);
  state.touched.set(id, performance.now());
  if (id === state.activeId) syncEditor(merged, pending);
  scheduleRender();
}

const sameNote = (a, b) => a.title === b.title && a.content === b.content && a.pinned === b.pinned
  && a.updated_at === b.updated_at && a.tags.join('\u0000') === b.tags.join('\u0000');

let refreshing = null;
const importing = new Set();
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { store, syncer, gen } = state;
    if (!store || state.loading) return;
    if (state.loadError) { await loadNotes(gen); return; }
    const started = performance.now();
    let remote;
    try {
      remote = await store.list();
    } catch (err) {
      if (err.retryable === false) toast(`Couldn’t refresh: ${err.message}`, { type: 'error' });
      return;
    }
    if (gen !== state.gen) return;
    const fresh = (id) => !syncer.isDirty(id) && !importing.has(id) && (state.touched.get(id) ?? 0) < started;
    const seen = new Set();
    for (const r of remote) {
      seen.add(r.id);
      if (!fresh(r.id)) continue;
      const l = state.notes.get(r.id);
      if (l && sameNote(l, r)) continue;
      state.notes.set(r.id, r);
      if (r.id === state.activeId) syncEditor(r, new Set());
    }
    let activeGone = false;
    for (const id of [...state.notes.keys()]) {
      if (seen.has(id) || !fresh(id)) continue;
      state.notes.delete(id);
      if (id === state.activeId) activeGone = true;
    }
    replayOutbox(); // picks up work orphaned by a crashed tab once its lease expires
    if (activeGone) {
      closeEditor();
      toast('The note you had open was deleted elsewhere.');
    }
    scheduleRender();
  })();
  const mine = refreshing;
  mine.finally(() => { if (refreshing === mine) refreshing = null; });
  return mine;
}

function renderStatus({ state: s, error }) {
  const labels = {
    saving: 'Saving…',
    saved: state.mode === 'demo' ? 'Saved in this browser' : 'Saved',
    offline: navigator.onLine ? 'Connection problem — retrying' : 'Offline — retrying',
    error: 'Not saved',
  };
  els.status.dataset.state = s;
  els.statusText.textContent = labels[s] || '';
  els.status.title = error?.message || '';
  // Only announce problems (and recovery) to screen readers, not every autosave.
  const announce = s === 'offline' || s === 'error' ? labels[s]
    : (s === 'saved' && renderStatus.last && renderStatus.last !== 'saving' && renderStatus.last !== 'saved') ? 'All changes saved' : null;
  if (announce && els.liveStatus.textContent !== announce) els.liveStatus.textContent = announce;
  if (s === 'saved' || s === 'saving') { if (!announce) els.liveStatus.textContent = ''; }
  renderStatus.last = s;
  els.app.dataset.sync = s;
}

/* ------------------------------------------------------------------ *
 * Notes: CRUD
 * ------------------------------------------------------------------ */

function createNote() {
  if (!state.store) return;
  const now = nowIso();
  const note = {
    id: uid(), title: '', content: '', tags: state.tag ? [state.tag] : [], pinned: false,
    created_at: now, updated_at: now,
  };
  state.notes.set(note.id, note);
  state.touched.set(note.id, performance.now());
  state.syncer.create(note.id);
  outboxPut(note.id);
  if (state.query) { state.query = ''; els.search.value = ''; }
  setPreview(false);
  openNote(note.id, { focus: 'title' });
  scheduleRender();
}

/** Optimistic local change + queued save. */
function applyLocal(id, patch) {
  const n = state.notes.get(id);
  if (!n || !state.syncer) return;
  const next = { ...n, ...patch, updated_at: nowIso() };
  state.notes.set(id, next);
  state.touched.set(id, performance.now());
  state.syncer.patch(id, patch);
  outboxPut(id, { base: n.updated_at });
  if (id === state.activeId) renderMeta(next);
  scheduleRender();
}

function deleteNote(id) {
  const snap = state.notes.get(id);
  if (!snap) return;
  const order = visibleNotes().map((n) => n.id);
  const nextId = order[order.indexOf(id) + 1] ?? order[order.indexOf(id) - 1];
  state.notes.delete(id);
  state.touched.set(id, performance.now());
  state.syncer.remove(id);
  outboxPut(id, { del: true, base: snap.updated_at });
  const wasActive = state.activeId === id;
  if (wasActive) closeEditor();
  renderAll();
  if (wasActive && nextId && !isPhone()) openNote(nextId, { focus: null });
  focusListItem(wasActive && !isPhone() ? nextId : null) || $('#new-btn').focus();

  const gen = state.gen;
  toast(`Deleted “${snap.title.trim() || 'Untitled'}”`, {
    action: {
      label: 'Undo',
      run: () => {
        if (gen !== state.gen || !state.syncer) return;
        state.notes.set(snap.id, { ...snap });
        state.touched.set(snap.id, performance.now());
        state.syncer.create(snap.id);
        outboxPut(snap.id);
        renderAll();
        openNote(snap.id, { focus: 'body' });
      },
    },
  });
}

async function importFile(file, verb = 'Imported') {
  if (!state.store) return;
  const gen = state.gen;
  try {
    const { notes, skipped } = await parseImport(file, [...state.notes.values()]);
    if (gen !== state.gen) return;
    if (!notes.length) { toast(`Nothing new to import${skipped ? ` (${skipped} duplicates or invalid)` : ''}.`); return; }
    for (const n of notes) {
      state.notes.set(n.id, n);
      state.touched.set(n.id, performance.now());
      importing.add(n.id); // shield from refresh() until the bulk write settles
    }
    renderAll();
    const { syncer, store } = state;
    try {
      const saved = await store.createMany(notes); // one request per 200 notes, keeps timestamps
      if (gen !== state.gen) return;
      for (const r of saved) {
        if (syncer.isDirty(r.id)) continue; // edited meanwhile: keep the local copy
        state.notes.set(r.id, r);
        state.touched.set(r.id, performance.now());
      }
    } catch (err) {
      if (gen !== state.gen) return;
      if (err.retryable !== true) {
        for (const n of notes) state.notes.delete(n.id);
        for (const r of err.savedSoFar || []) state.notes.set(r.id, r);
        renderAll();
        throw err;
      }
      // Network trouble: fall back to the per-note queue (with retry + outbox).
      const done = new Set((err.savedSoFar || []).map((r) => r.id));
      for (const n of notes) if (!done.has(n.id) && state.notes.has(n.id)) { syncer.create(n.id); outboxPut(n.id); }
    } finally {
      for (const n of notes) importing.delete(n.id);
    }
    renderAll();
    const extra = skipped ? ` (${skipped} skipped as duplicates or invalid)` : '';
    toast(`${verb} ${notes.length} note${notes.length === 1 ? '' : 's'}${extra}.`, { type: 'success' });
  } catch (err) {
    toast(err.message || 'Import failed.', { type: 'error' });
  }
}

/* ------------------------------------------------------------------ *
 * List rendering
 * ------------------------------------------------------------------ */

function visibleNotes() {
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const n of state.notes.values()) {
    if (state.tag && !n.tags.includes(state.tag)) continue;
    if (tokens.length) {
      const hay = `${n.title}\n${n.content}\n${n.tags.map((t) => `#${t}`).join(' ')}`.toLowerCase();
      const ok = tokens.every((t) => (t.startsWith('#') && t.length > 1
        ? n.tags.some((tag) => tag.startsWith(t.slice(1)))
        : hay.includes(t)));
      if (!ok) continue;
    }
    out.push(n);
  }
  const by = {
    updated: (a, b) => ts(b.updated_at) - ts(a.updated_at),
    created: (a, b) => ts(b.created_at) - ts(a.created_at),
    title: (a, b) => (a.title.trim() || '￿').localeCompare(b.title.trim() || '￿', undefined, { sensitivity: 'base' }),
  }[state.sort] || ((a, b) => ts(b.updated_at) - ts(a.updated_at));
  return out.sort((a, b) => (b.pinned - a.pinned) || by(a, b) || a.id.localeCompare(b.id));
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

function renderAll() {
  renderTagFilter();
  renderList();
}

const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5zM12 14v6"/></svg>';

function noteItem(n) {
  const btn = el('button', {
    type: 'button',
    class: 'note-item',
    dataset: { id: n.id },
    'aria-current': n.id === state.activeId ? 'true' : null,
  },
  el('span', { class: 'note-item__top' },
    el('span', { class: `note-item__title${n.title.trim() ? '' : ' is-untitled'}`, text: n.title.trim() || 'Untitled' })),
  el('span', { class: 'note-item__snippet', text: snippet(n.content) || 'No content' }),
  el('span', { class: 'note-item__meta' },
    el('time', { datetime: n.updated_at, text: relativeTime(n.updated_at) }),
    ...n.tags.slice(0, 3).map((t) => el('span', { class: 'chip chip--xs', text: `#${t}` })),
    n.tags.length > 3 ? el('span', { class: 'chip chip--xs', text: `+${n.tags.length - 3}` }) : null));
  if (n.pinned) {
    const pin = el('span', { class: 'note-item__pin', title: 'Pinned' });
    pin.innerHTML = PIN_SVG; // static, trusted markup
    pin.append(el('span', { class: 'sr-only', text: ' (pinned)' }));
    btn.querySelector('.note-item__top').append(pin);
  }
  return el('li', {}, btn);
}

function renderList() {
  const focusedId = document.activeElement?.closest?.('.note-item')?.dataset.id;
  els.list.setAttribute('aria-busy', String(state.loading));

  if (state.loading) {
    els.listEmpty.hidden = true;
    els.list.replaceChildren(...Array.from({ length: 5 }, () => el('li', { class: 'skeleton', 'aria-hidden': 'true' },
      el('span', { class: 'skeleton__line skeleton__line--title' }),
      el('span', { class: 'skeleton__line' }),
      el('span', { class: 'skeleton__line skeleton__line--short' }))));
    els.listCount.textContent = 'Loading notes…';
    return;
  }

  const list = visibleNotes();
  els.list.replaceChildren(...list.map(noteItem));
  els.listTitle.textContent = state.tag ? `#${state.tag}` : state.query ? 'Search results' : 'All notes';
  const total = state.notes.size;
  els.listCount.textContent = list.length === total
    ? `${total} note${total === 1 ? '' : 's'}`
    : `${list.length} of ${total} notes`;

  if (state.loadError) {
    showListEmpty('Couldn’t load your notes', state.loadError.message, 'Try again', () => loadNotes());
  } else if (total === 0) {
    showListEmpty('Your notebook is empty', 'Write your first note — it saves as you type.', 'New note', createNote);
  } else if (list.length === 0) {
    showListEmpty('No matching notes', state.query ? `Nothing matches “${state.query}”.` : 'No notes with this tag.', 'Clear filters', clearFilters);
  } else {
    els.listEmpty.hidden = true;
  }

  if (focusedId) focusListItem(focusedId);
}

function showListEmpty(title, text, label, action) {
  els.listEmpty.replaceChildren(
    el('p', { class: 'empty__title', text: title }),
    el('p', { class: 'empty__text', text }),
    el('button', { type: 'button', class: 'btn btn--sm', text: label, onclick: action }),
  );
  els.listEmpty.hidden = false;
}

function renderTagFilter() {
  const counts = new Map();
  for (const n of state.notes.values()) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (state.tag && !counts.has(state.tag)) state.tag = null;
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const focusedTag = document.activeElement?.closest?.('.tag-filter')
    ? document.activeElement.dataset.tag : undefined;

  const item = (tag, label, count) => el('li', {},
    el('button', {
      type: 'button',
      class: 'chip chip--filter',
      dataset: { tag: tag ?? '' },
      'aria-pressed': String(state.tag === tag),
      'aria-label': tag ? `#${tag}, ${count} note${count === 1 ? '' : 's'}` : 'All notes',
      onclick: () => { state.tag = state.tag === tag ? null : tag; renderAll(); },
    }, label, count != null ? el('span', { class: 'chip__count', text: count }) : null));

  els.tagFilter.replaceChildren(
    ...(tags.length ? [item(null, 'All')] : []),
    ...tags.map(([t, c]) => item(t, `#${t}`, c)),
  );
  els.tagFilter.parentElement.hidden = tags.length === 0;
  if (focusedTag !== undefined) els.tagFilter.querySelector(`[data-tag="${CSS.escape(focusedTag)}"]`)?.focus();
}

function focusListItem(id) {
  if (!id) return false;
  const btn = els.list.querySelector(`.note-item[data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.focus(); return true; }
  return false;
}

function clearFilters() {
  state.query = '';
  state.tag = null;
  els.search.value = '';
  renderAll();
  els.search.focus();
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

function openNote(id, { focus = 'body' } = {}) {
  const n = state.notes.get(id);
  if (!n) return;
  if (state.activeId && state.activeId !== id) state.syncer?.flush(state.activeId);
  state.activeId = id;
  els.title.value = n.title;
  els.body.value = n.content;
  renderEditorTags(n);
  renderMeta(n);
  els.editorEmpty.hidden = true;
  els.editor.hidden = false;
  setPreview(state.preview);
  if (isPhone()) setPane('editor', true);
  scheduleRender();
  if (focus === 'title') els.title.focus();
  else if (focus === 'body') (state.preview ? els.preview : els.body).focus();
}

function closeEditor({ silent = false, flush = true } = {}) {
  if (flush && state.activeId) state.syncer?.flush(state.activeId);
  state.activeId = null;
  els.editor.hidden = true;
  els.editorEmpty.hidden = false;
  setPane('list', false);
  popEditorHistory();
  if (!silent) scheduleRender();
}

/** Bring the editor in line with a note without disturbing fields the user is editing. */
function syncEditor(n, skip) {
  const setValue = (input, value) => {
    if (input.value === value) return;
    const focused = document.activeElement === input;
    const { selectionStart: s, selectionEnd: e } = input;
    input.value = value;
    if (focused) input.setSelectionRange(Math.min(s, value.length), Math.min(e, value.length));
  };
  if (!skip.has('title')) setValue(els.title, n.title);
  if (!skip.has('content')) {
    setValue(els.body, n.content);
    if (state.preview) renderPreview();
  }
  if (!skip.has('tags')) renderEditorTags(n);
  renderMeta(n);
}

function renderMeta(n) {
  const words = wordCount(n.content);
  els.words.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
  els.readTime.textContent = `${Math.max(1, Math.ceil(words / 220))} min read`;
  els.editedAt.textContent = `Edited ${relativeTime(n.updated_at)}`;
  els.editedAt.title = fullDate(n.updated_at);
  els.pinBtn.setAttribute('aria-pressed', String(n.pinned));
  els.pinBtn.setAttribute('aria-label', n.pinned ? 'Unpin note' : 'Pin note');
}

function renderEditorTags(n) {
  els.tagsList.replaceChildren(...n.tags.map((t) => el('li', { class: 'chip chip--tag' },
    el('span', { text: `#${t}` }),
    el('button', {
      type: 'button', class: 'chip__remove', 'aria-label': `Remove tag ${t}`, text: '×',
      onclick: () => removeTag(t, true),
    }))));
}

function addTag(raw) {
  const n = state.notes.get(state.activeId);
  if (!n) return;
  const tags = String(raw).split(',').map(normalizeTag).filter(Boolean);
  const next = [...n.tags];
  for (const t of tags) if (!next.includes(t) && next.length < 20) next.push(t);
  if (next.length !== n.tags.length) {
    applyLocal(n.id, { tags: next });
    renderEditorTags(state.notes.get(n.id));
  }
}

function removeTag(tag, refocus) {
  const n = state.notes.get(state.activeId);
  if (!n) return;
  applyLocal(n.id, { tags: n.tags.filter((t) => t !== tag) });
  renderEditorTags(state.notes.get(n.id));
  if (refocus) els.tagInput.focus();
}

let previewToken = 0;
function renderPreview() {
  const token = ++previewToken;
  const target = els.preview;
  const md = els.body.value;
  if (!md.trim()) {
    target.replaceChildren(el('p', { class: 'muted', text: 'Nothing to preview yet.' }));
    return;
  }
  const scratch = document.createElement('div');
  renderMarkdown(md, scratch).then(() => {
    if (token === previewToken) target.replaceChildren(...scratch.childNodes);
  });
}

function setPreview(on) {
  state.preview = on;
  els.body.hidden = on;
  els.preview.hidden = !on;
  els.modeEdit.setAttribute('aria-pressed', String(!on));
  els.modePreview.setAttribute('aria-pressed', String(on));
  if (on) renderPreview();
}

// Phones: opening a note pushes one history entry so hardware Back returns to
// the list. Leaving the editor any other way pops it (once — traversal is async).
let backPending = false;
let pushAfterBack = false;

function setPane(pane, push) {
  if (els.app.dataset.pane === pane) return;
  els.app.dataset.pane = pane;
  if (pane === 'editor' && push && isPhone()) {
    if (backPending) pushAfterBack = true;
    else history.pushState({ notesPane: 'editor' }, '');
  }
  if (pane === 'list') pushAfterBack = false;
}

function popEditorHistory() {
  if (history.state?.notesPane === 'editor' && !backPending) {
    backPending = true;
    history.back();
  }
}

function onPopState() {
  if (backPending) {
    backPending = false;
    if (pushAfterBack && els.app.dataset.pane === 'editor') history.pushState({ notesPane: 'editor' }, '');
    pushAfterBack = false;
    return;
  }
  // User pressed Back / swiped back while the editor was showing.
  if (els.app.dataset.pane === 'editor') showListPane(state.activeId);
}

function backToList() {
  showListPane(state.activeId);
}

function showListPane(id) {
  if (state.activeId) state.syncer?.flush(state.activeId);
  setPane('list', false);
  popEditorHistory();
  requestAnimationFrame(() => focusListItem(id) || els.search.focus());
}

/* ------------------------------------------------------------------ *
 * Menu, theme, shortcuts
 * ------------------------------------------------------------------ */

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  $('#theme-label').textContent = { light: 'Light', dark: 'Dark' }[mode] || 'System';
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = safeStorage.get(LS_THEME) || 'system';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  safeStorage.set(LS_THEME, next);
  applyTheme(next);
}

function setMenu(open, { focus = true } = {}) {
  els.menuPanel.hidden = !open;
  els.menuBtn.setAttribute('aria-expanded', String(open));
  if (open && focus) els.menuPanel.querySelector('.menu__item:not([hidden])')?.focus();
  if (!open && focus) els.menuBtn.focus();
}

async function signOut() {
  const { syncer } = state;
  if (syncer?.hasUnsaved()) {
    await Promise.race([syncer.flushAll(), sleep(4000)]);
    if (syncer.hasUnsaved() && !window.confirm('Some changes haven’t synced yet and will be lost. Sign out anyway?')) return;
  }
  // The user chose to sign out: don't leave their unsynced notes in this browser.
  if (state.mode === 'cloud') {
    outboxOps.clear();
    state.outbox.clear();
    safeStorage.remove(outboxKey());
  }
  let client;
  try { client = await initSupabase(onAuthEvent); } catch (err) {
    toast(`Couldn’t sign out: ${err.message || err}`, { type: 'error' });
    return;
  }
  let error = null;
  try {
    ({ error } = await client.auth.signOut({ scope: 'local' }));
  } catch (err) {
    error = err;
  }
  if (error) {
    // auth-js keeps the session when /logout can't be reached (offline). On a
    // shared computer that's not acceptable: drop the stored session ourselves.
    console.warn('signOut failed, clearing local session', error);
    safeStorage.remove('notes-app-auth');
    enqueue(async () => {
      if (state.mode !== 'cloud') return;
      await teardown({ flush: false });
      showAuth('You’re signed out on this device.');
    });
  }
  // On success, SIGNED_OUT → onAuthEvent tears down cloud mode.
}

async function runMenuAction(action) {
  const notes = visibleNotesAll();
  switch (action) {
    case 'export-json':
      if (!notes.length) { toast('No notes to export yet.'); return; }
      exportJson(notes);
      toast(`Exported ${notes.length} notes as JSON.`, { type: 'success' });
      break;
    case 'export-md':
      if (!notes.length) { toast('No notes to export yet.'); return; }
      exportMarkdown(notes);
      toast(`Exported ${notes.length} notes as Markdown.`, { type: 'success' });
      break;
    case 'import-json': els.importFile.click(); break;
    case 'theme': cycleTheme(); return; // keep the menu open
    case 'shortcuts': els.shortcuts.showModal(); break;
    case 'to-auth':
      safeStorage.remove(LS_MODE);
      enqueue(async () => { await teardown(); showAuth('Sign in to sync your notes across devices.'); });
      break;
    case 'sign-out': signOut(); break;
    case 'change-pw': passwordDialog?.open(); break;
    case 'copy-demo': copyDemoNotes(); break;
    default: break;
  }
}

/** All notes (ignoring filters), pinned first then newest — export order. */
function visibleNotesAll() {
  return [...state.notes.values()].sort((a, b) => (b.pinned - a.pinned) || ts(b.updated_at) - ts(a.updated_at));
}

const isTyping = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function onKeydown(e) {
  if (els.app.hidden || els.app.inert || document.querySelector('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mod && !e.shiftKey && !e.altKey && key === 'k') {
    e.preventDefault();
    if (isPhone()) showListPane(null);
    els.search.focus();
    els.search.select();
  } else if ((mod && !e.shiftKey && key === 'n')
    || (e.altKey && !mod && e.code === 'KeyN' && !(isMac && isTyping(e.target)))) { // ⌥N types ñ on macOS
    e.preventDefault();
    createNote();
  } else if (mod && key === 's') {
    e.preventDefault();
    state.syncer?.flushAll();
  } else if (mod && key === 'e' && state.activeId) {
    e.preventDefault();
    setPreview(!state.preview);
    (state.preview ? els.preview : els.body).focus();
  } else if (e.key === 'Escape') {
    if (!els.menuPanel.hidden) { setMenu(false); return; }
    if (e.target === els.search) {
      if (els.search.value) { els.search.value = ''; state.query = ''; renderAll(); } else focusListItem(state.activeId) || els.list.focus();
      return;
    }
    if (isPhone() && els.app.dataset.pane === 'editor') { backToList(); return; }
    if (els.editor.contains(e.target)) focusListItem(state.activeId);
  } else if (e.key === '?' && !mod && !isTyping(e.target)) {
    e.preventDefault();
    els.shortcuts.showModal();
  }
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */

function bindUI() {
  $('#new-btn').addEventListener('click', createNote);
  $('#empty-new-btn').addEventListener('click', createNote);
  $('#back-btn').addEventListener('click', backToList);
  $('#delete-btn').addEventListener('click', () => state.activeId && deleteNote(state.activeId));
  els.pinBtn.addEventListener('click', () => {
    const n = state.notes.get(state.activeId);
    if (n) applyLocal(n.id, { pinned: !n.pinned });
  });
  els.modeEdit.addEventListener('click', () => { setPreview(false); els.body.focus(); });
  els.modePreview.addEventListener('click', () => setPreview(true));

  els.title.addEventListener('input', () => state.activeId && applyLocal(state.activeId, { title: els.title.value }));
  els.title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); els.body.focus(); }
  });
  els.body.addEventListener('input', () => state.activeId && applyLocal(state.activeId, { content: els.body.value }));

  els.tagInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
      e.preventDefault();
      if (els.tagInput.value.trim()) { addTag(els.tagInput.value); els.tagInput.value = ''; }
    } else if (e.key === 'Backspace' && !els.tagInput.value) {
      const n = state.notes.get(state.activeId);
      if (n?.tags.length) removeTag(n.tags[n.tags.length - 1], false);
    }
  });
  els.tagInput.addEventListener('blur', () => {
    if (els.tagInput.value.trim()) { addTag(els.tagInput.value); els.tagInput.value = ''; }
  });

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = els.search.value.trim(); renderAll(); }, 80);
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.isComposing)) {
      clearTimeout(searchTimer);
      if (state.query !== els.search.value.trim()) { state.query = els.search.value.trim(); renderAll(); }
      const first = els.list.querySelector('.note-item');
      if (first) { e.preventDefault(); if (e.key === 'Enter') first.click(); else first.focus(); }
    }
  });
  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    safeStorage.set(LS_SORT, state.sort);
    renderAll();
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.note-item');
    if (btn) openNote(btn.dataset.id, { focus: isPhone() ? null : 'body' });
  });
  els.list.addEventListener('keydown', (e) => {
    const btn = e.target.closest('.note-item');
    if (!btn) return;
    const items = [...els.list.querySelectorAll('.note-item')];
    const i = items.indexOf(btn);
    let next = null;
    if (e.key === 'ArrowDown') next = items[i + 1];
    else if (e.key === 'ArrowUp') next = items[i - 1] ?? els.search;
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Delete' && !isTyping(e.target)) { e.preventDefault(); deleteNote(btn.dataset.id); return; }
    if (next) { e.preventDefault(); next.focus(); }
  });

  els.menuBtn.addEventListener('click', () => setMenu(els.menuPanel.hidden));
  els.menuPanel.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    const action = item.dataset.action;
    if (action !== 'theme') setMenu(false, { focus: action !== 'shortcuts' && action !== 'import-json' });
    runMenuAction(action);
  });
  els.menuPanel.addEventListener('keydown', (e) => {
    const items = [...els.menuPanel.querySelectorAll('.menu__item:not([hidden])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Tab') setMenu(false, { focus: false });
  });
  document.addEventListener('click', (e) => {
    if (!els.menuPanel.hidden && !e.target.closest('#account-menu')) setMenu(false, { focus: false });
  });

  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files?.[0];
    els.importFile.value = '';
    if (file) importFile(file);
  });

  document.addEventListener('keydown', onKeydown);

  window.addEventListener('popstate', onPopState);
  phoneMq.addEventListener('change', () => {
    if (!isPhone()) setPane('list', false);
    else if (state.activeId) setPane('editor', false);
  });

  // Save eagerly when the page is being hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { outboxFlush(); state.syncer?.flushAll(); }
  });
  window.addEventListener('pagehide', () => { outboxFlush(); state.syncer?.flushAll(); });
  window.addEventListener('beforeunload', (e) => {
    outboxFlush();
    if (!state.syncer?.hasUnsaved()) return;
    state.syncer.flushAll(); // local store writes synchronously
    if (state.mode === 'cloud') { e.preventDefault(); e.returnValue = ''; }
  });

  // Keep relative timestamps fresh.
  setInterval(() => { if (!els.app.hidden && !document.hidden) scheduleRender(); }, 60000);

  preloadMarkdown();
}

boot();
