// Export (JSON / combined Markdown) and import (JSON).
import { download, fullDate, sanitizeNote, ts, uid } from './util.js';

const stamp = () => new Date().toISOString().slice(0, 10);

export function exportJson(notes) {
  const payload = {
    app: 'inkwell-notes',
    version: 1,
    exported_at: new Date().toISOString(),
    notes: notes.map(({ id, title, content, tags, pinned, created_at, updated_at }) => ({
      id, title, content, tags, pinned, created_at, updated_at,
    })),
  };
  download(`inkwell-notes-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

export function exportMarkdown(notes) {
  const parts = notes.map((n) => {
    const meta = [
      n.pinned ? 'pinned' : null,
      n.tags.length ? `tags: ${n.tags.map((t) => `#${t}`).join(' ')}` : null,
      `updated: ${fullDate(n.updated_at)}`,
    ].filter(Boolean).join(' · ');
    return `# ${n.title.trim() || 'Untitled'}\n\n_${meta}_\n\n${n.content.trim()}\n`;
  });
  const body = `<!-- Exported from Inkwell on ${new Date().toISOString()} — ${notes.length} notes -->\n\n${parts.join('\n---\n\n')}`;
  download(`inkwell-notes-${stamp()}.md`, body, 'text/markdown');
}

const MAX_IMPORT = 5000;
const MAX_FILE = 20 * 1024 * 1024;

/**
 * Parse an import file into fresh notes (new ids, so imports never collide with
 * another account's rows). Skips exact duplicates of existing notes.
 * @returns {Promise<{ notes: any[], skipped: number }>}
 */
export async function parseImport(file, existing) {
  if (file.size > MAX_FILE) throw new Error('That file is too large to import (20 MB max).');
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file isn’t valid JSON.');
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.notes) ? data.notes : null;
  if (!list) throw new Error('No notes found. Expected an Inkwell export or an array of notes.');

  const seen = new Set(existing.map((n) => `${n.title}\u0000${n.content}`));
  const out = [];
  let skipped = 0;
  for (const raw of list.slice(0, MAX_IMPORT)) {
    if (!raw || typeof raw !== 'object' || (typeof raw.title !== 'string' && typeof raw.content !== 'string')) {
      skipped += 1;
      continue;
    }
    const n = sanitizeNote({ ...raw, id: uid() });
    if (!ts(raw.updated_at)) n.updated_at = n.created_at;
    const key = `${n.title}\u0000${n.content}`;
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    out.push(n);
  }
  skipped += Math.max(0, list.length - MAX_IMPORT);
  return { notes: out, skipped };
}
