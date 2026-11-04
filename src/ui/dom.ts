/** Small helpers that every panel of the page uses. */

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Formats seconds as m:ss, rounding up, as the FIELD clock shows them. */
export const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}` : '--:--');

/** Reads a value that this browser keeps. Storage is a convenience: when it fails, the value is missing. */
export function stored(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
/** Keeps a value in this browser, if it can. */
export function store(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Storage is a convenience. */ } }

/** Keeps the page's shortcuts out of a text field or a select: its key presses go to the field alone. */
export function ownKeys(el: HTMLElement, onEnter?: () => void) {
  for (const ev of ['keydown', 'keyup'] as const) el.addEventListener(ev, e => { e.stopPropagation(); if (onEnter && ev === 'keydown' && e.key === 'Enter') onEnter(); });
}

/** Shows a message at the bottom edge for 4 s. At most three show at a time. */
export function toast(text: string, cls = '') {
  const box = $('toasts'), el = document.createElement('div'); el.textContent = text; el.className = cls; box.append(el);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(() => el.classList.add('out'), 3500); setTimeout(() => el.remove(), 4000);
}

// The game setup, the help, and the key bindings are modals. The close button, a click on the scrim, or Esc closes them.
const MODALS = ['setup', 'helpbox', 'keybinds'];
export function closeModals() { for (const id of MODALS) $(id).classList.add('hidden'); }
export function toggleModal(id: string) { const open = $(id).classList.contains('hidden'); closeModals(); $(id).classList.toggle('hidden', !open); }
export function initModals() {
  for (const id of MODALS) $(id).addEventListener('click', e => { const t = e.target as HTMLElement; if (t === $(id) || t.closest('[data-close]')) closeModals(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
}
