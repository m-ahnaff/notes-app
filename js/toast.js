// Toasts: polite live region for info, assertive (role=alert) for errors.
import { el } from './util.js';

const politeRegion = () => document.getElementById('toasts');
const alertRegion = () => document.getElementById('toasts-alert');

/**
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error', action?: {label:string, run:()=>void}, duration?: number }} [opts]
 * @returns {{ dismiss: () => void }}
 */
export function toast(message, { type = 'info', action, duration } = {}) {
  const region = type === 'error' ? alertRegion() : politeRegion();
  const ms = duration ?? (action ? 7000 : type === 'error' ? 8000 : 3500);
  let timer = null;
  let gone = false;

  const node = el('div', { class: `toast toast--${type}` },
    el('span', { class: 'toast__msg', text: message }));

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    node.classList.add('toast--leaving');
    setTimeout(() => node.remove(), 180);
  };

  if (action) {
    node.append(el('button', {
      type: 'button', class: 'toast__action', text: action.label,
      onclick: () => { dismiss(); action.run(); },
    }));
  }
  node.append(el('button', {
    type: 'button', class: 'toast__close', 'aria-label': 'Dismiss notification', text: '×',
    onclick: dismiss,
  }));

  const arm = () => { timer = setTimeout(dismiss, ms); };
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', arm);
  node.addEventListener('focusin', () => clearTimeout(timer));
  node.addEventListener('focusout', arm);

  region.append(node);
  while (region.children.length > 4) region.firstElementChild.remove();
  arm();
  return { dismiss };
}
