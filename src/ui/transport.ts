/**
 * The control bar: the timeline, play and pause, the marks, the game setup and help buttons, the score toggle, and the
 * key bindings panel that the help opens.
 */
import { BINDING_LABELS, DEFAULT_BINDINGS, codeLabel, getBindings, setBindings, type KeyBindings } from '../input';
import { app, goLive, openReview, running, startMatch, stopMatch } from './app';
import { $, closeModals, fmt, store, stored, toggleModal } from './dom';
import { paintTree } from './tree-ui';

/**
 * The play button. Before the MATCH it starts the MATCH, and during the MATCH it pauses the MATCH or resumes it. In the
 * review it plays the recording, and at the live edge it goes back to live. After the MATCH, it replays the MATCH from
 * the start.
 */
export function playPause() {
  const { review, sim } = app;
  if (review.active) { if (running() && review.at >= review.end && !review.isPlaying) goLive(); else review.toggle(); }
  else if (sim.phase === 'pre') startMatch();
  else if (app.startAt) return;
  else if (running() || sim.mode === 'practice') app.livePaused = !app.livePaused;
  else if (review.end >= 0) { openReview(); review.seek(0); review.toggle(); }
}

/** Moves the cursor to the previous stop or the next one. Past the last stop, it goes back to live, or to the end of the recording. */
export function skip(dir: -1 | 1) {
  const { review } = app, end = review.end; if (end < 0) return;
  if (dir < 0) { const to = review.prevStop(review.active ? review.at : end); if (!review.active) openReview(); review.seek(to); return; }
  if (!review.active) return; const to = review.nextStop(review.at);
  if (to === null && running()) goLive(); else review.seek(to ?? end);
}

/** Draws the control bar: the timeline, the time at the cursor, and each button's state. */
export function paintTransport() {
  const { review, sim } = app, live = running(), pre = sim.phase === 'pre' && !app.startAt;
  review.paintTrack();
  if (!review.active) $('scrubtime').textContent = pre ? 'Ready' : app.startAt ? 'Starting' : `${{ auto: 'AUTO', transition: 'TRANSITION', teleop: 'TELEOP', post: 'FINAL', pre: '' }[sim.phase]} ${fmt(sim.timer)}`;
  const on = review.active ? review.isPlaying : live && !app.livePaused, play = $('tplay'), label = on ? 'Pause' : pre ? 'Start the MATCH' : 'Play';
  play.classList.toggle('on', on); play.title = `${label} (Space)`; play.setAttribute('aria-label', label);
  const pill = $('tlive'); pill.classList.toggle('hidden', !live); pill.classList.toggle('behind', review.active);
  pill.querySelector('span')!.textContent = review.active ? 'Go live' : app.livePaused ? 'Paused' : 'Live';
  // A live MATCH runs at 1x. The speed applies to the recording.
  const speed = $<HTMLSelectElement>('rspeed'); speed.disabled = live && !review.active; speed.title = speed.disabled ? 'A live MATCH runs at 1x. The speed applies when you review the recording.' : 'Playback speed of the recording';
  $<HTMLButtonElement>('tprev').disabled = review.end < 0; $<HTMLButtonElement>('tnext').disabled = !review.active;
  const sc = $('tscore'), scLabel = app.scoreOpen ? 'Hide the score' : 'Show the score'; sc.setAttribute('aria-expanded', String(app.scoreOpen)); sc.title = scLabel; sc.setAttribute('aria-label', scLabel);
}

// ---- Key bindings ----
let rebinding: keyof KeyBindings | null = null;
function paintKeyBindings() {
  const b = getBindings();
  $('kbtable').innerHTML = (Object.keys(DEFAULT_BINDINGS) as (keyof KeyBindings)[]).map(action => {
    const active = rebinding === action;
    return `<tr data-action="${action}"${active ? ' class="on"' : ''}><td>${BINDING_LABELS[action]}</td><td><kbd>${active ? 'press a key…' : codeLabel(b[action])}</kbd></td></tr>`;
  }).join('');
  $('kbtable').querySelectorAll<HTMLTableRowElement>('tr[data-action]').forEach(row => { row.onclick = () => { rebinding = row.dataset.action as keyof KeyBindings; paintKeyBindings(); }; });
}

export function initTransport() {
  /** Binds a control bar button. The button gives up the focus, so that Space and the arrow keys don't press it again. */
  const bind = (id: string, fn: () => void) => { const el = $<HTMLButtonElement>(id); el.onclick = () => { fn(); el.blur(); paintTransport(); }; };
  bind('tplay', playPause); bind('tprev', () => skip(-1)); bind('tnext', () => skip(1)); bind('treset', stopMatch); bind('tlive', goLive);
  bind('tsetup', () => toggleModal('setup')); bind('thelp', () => toggleModal('helpbox'));
  // The score table under the bar opens and closes. On a narrow screen, such as a tablet, it starts hidden: it would
  // cover the FIELD. This browser keeps the choice.
  const saved = stored('biobuzz.score'); app.scoreOpen = saved ? saved === 'on' : innerWidth >= 1000;
  bind('tscore', () => { app.scoreOpen = !app.scoreOpen; store('biobuzz.score', app.scoreOpen ? 'on' : 'off'); $('left').classList.toggle('hidden', !app.scoreOpen); paintTree(); });
  // A drag back from the live edge opens the review. The thumb can't go past the newest frame. Letting go at the live
  // edge of a running MATCH goes back to live.
  const scrub = $<HTMLInputElement>('scrub'), { review } = app;
  scrub.oninput = () => {
    const end = review.end, i = review.frameAt(Number(scrub.value)); if (end < 0) return;
    if (!review.active) { if (i >= end) { review.paintTrack(); return; } openReview(); }
    review.seek(i);
  };
  scrub.onchange = () => { if (review.active && running() && review.at >= review.end) goLive(); scrub.blur(); paintTransport(); };
  $('rspeed').onchange = () => $('rspeed').blur();

  addEventListener('keydown', e => {
    if (!rebinding) return;
    if (e.key === 'Escape') { rebinding = null; paintKeyBindings(); return; }
    e.preventDefault(); e.stopPropagation();
    setBindings({ ...getBindings(), [rebinding]: e.code }); rebinding = null; paintKeyBindings();
  }, true);
  $('openkeybinds').onclick = () => { closeModals(); paintKeyBindings(); $('keybinds').classList.remove('hidden'); };
  $('kbreset').onclick = () => { setBindings({ ...DEFAULT_BINDINGS }); paintKeyBindings(); };
}
