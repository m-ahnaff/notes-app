// Markdown → sanitized DOM. marked never sees the DOM; DOMPurify always runs
// on its output and returns a DocumentFragment, so no unsanitized string is
// ever assigned to innerHTML.
import { DOMPURIFY_URL, MARKED_URL } from './vendor.js';

let libs = null;

async function load() {
  if (!libs) {
    libs = Promise.all([import(MARKED_URL), import(DOMPURIFY_URL)]).then(([m, p]) => {
      const marked = m.marked;
      const DOMPurify = p.default;
      marked.setOptions({ gfm: true, breaks: true, async: false });

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          const href = node.getAttribute('href') || '';
          if (/^https?:|^mailto:/i.test(href)) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer nofollow');
          } else if (!href.startsWith('#')) {
            node.removeAttribute('href');
          }
        }
        if (node.tagName === 'IMG') {
          node.setAttribute('loading', 'lazy');
          node.setAttribute('referrerpolicy', 'no-referrer');
        }
        if (node.tagName === 'INPUT') {
          // GFM task-list checkboxes: display only.
          node.setAttribute('disabled', '');
        }
      });
      return { marked, DOMPurify };
    }).catch((err) => {
      libs = null; // allow a later retry
      throw err;
    });
  }
  return libs;
}

const PURIFY_OPTS = {
  USE_PROFILE: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'formaction'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

/** Render markdown into `target`. Falls back to plain text if the CDN is unreachable. */
export async function renderMarkdown(md, target) {
  try {
    const { marked, DOMPurify } = await load();
    const html = marked.parse(String(md ?? ''));
    const frag = DOMPurify.sanitize(html, PURIFY_OPTS);
    target.replaceChildren(frag);
    return true;
  } catch (err) {
    console.warn('Markdown renderer unavailable', err);
    const pre = document.createElement('pre');
    pre.className = 'md-fallback';
    pre.textContent = String(md ?? '');
    target.replaceChildren(pre);
    return false;
  }
}

export function preloadMarkdown() {
  load().catch(() => {});
}
