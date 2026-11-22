/**
 * Storage layer contract. Both implementations expose the same async API so the
 * UI and the sync engine never know where notes live.
 *
 * @typedef {Object} Note
 * @property {string}   id          uuid (generated client-side for optimistic UI)
 * @property {string}   title
 * @property {string}   content     markdown source
 * @property {string[]} tags
 * @property {boolean}  pinned
 * @property {string}   created_at  ISO timestamp
 * @property {string}   updated_at  ISO timestamp (authoritative value comes from the store)
 *
 * @typedef {Object} NoteStore
 * @property {'local'|'supabase'} kind
 * @property {boolean} persistent                    false if notes will not survive a reload
 * @property {() => Promise<Note[]>} list            all notes for the current user
 * @property {(id: string) => Promise<Note|null>} get
 * @property {(note: Note) => Promise<Note>} create  idempotent upsert by id (safe to retry)
 * @property {(id: string, patch: Partial<Note>) => Promise<Note|null>} update
 *           resolves null if the note no longer exists
 * @property {(id: string) => Promise<void>} delete  deleting a missing note is not an error
 * @property {(cb: (hint: {type: string}) => void) => () => void} subscribe
 *           notifies when notes may have changed elsewhere (other tab / device / focus)
 * @property {() => Promise<Note[]>} refresh         alias of list(), for symmetry
 * @property {() => void} dispose
 *
 * Errors thrown by a store carry `retryable: boolean` so the sync engine knows
 * whether to back off and retry (network) or surface the error (validation, RLS).
 */

export { createLocalStore } from './localStore.js';
export { createSupabaseStore } from './supabaseStore.js';

export { StoreError } from './errors.js';
