/**
 * The page's state: the MATCH and its robots, and the panels that share them. `main.ts` fills in the parts that need the
 * physics engine or the canvas, and then each panel reads and changes this one object.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { MatchAudio } from '../audio';
import { Coach } from '../auto/coach';
import { AUTO_PROBLEMS, AUTO_TREES, SOLO_AUTO, autoFor } from '../auto/onboard';
import { placeAutoStart } from '../auto/start-pose';
import type { FieldEditor } from '../field-editor';
import { Referee } from '../ref/referee';
import type { View } from '../render/view';
import type { Review, SystemMark } from '../review';
import { BOT_IDS, describe, robotConfig, type BotSetup } from '../setup';
import { MATCH } from '../sim/config';
import { Sim, type MatchMode } from '../sim/world';
import { TraceRecorder } from '../trace';
import { ROUNDS, TIERS, opponent, type Bracket } from '../tournament';
import type { Units } from '../units';
import { $, closeModals, toast } from './dom';
import { paintBots, closeConfig } from './robot-config';
import { sel } from './settings';

export const app = {
  rapier: undefined as unknown as typeof RAPIER,
  view: undefined as unknown as View,
  canvas: undefined as unknown as HTMLCanvasElement,
  review: undefined as unknown as Review,
  editor: undefined as unknown as FieldEditor,
  audio: new MatchAudio(),
  bots: [] as BotSetup[],
  units: 'metric' as Units,
  /** In a tournament, the bracket sets the blue robots, and the setups keep what the person chose for them. */
  bracket: null as Bracket | null,
  sim: undefined as unknown as Sim,
  coaches: [] as Coach[],
  referee: null as Referee | null,
  recorder: undefined as unknown as TraceRecorder,
  seed: 1,
  /** When the countdown ends and the MATCH starts, in `performance.now()` time, or 0. */
  startAt: 0,
  /** A paused MATCH doesn't step. */
  livePaused: false,
  /** The loading message for the banner, or null. */
  loadMsg: null as string | null,
  /** The robot whose config popup is open, or -1. */
  editing: -1,
  /** The robot that the tree view shows, or -1 to follow the focus robot. */
  treeRobot: -1,
  scoreOpen: true,
  // Per MATCH: whether the trace was saved and the result recorded, the results card closed, the referee calls that
  // have a note, the sim messages that had a toast, and the trace length at the last save.
  traceSaved: false, recorded: false, finalClosed: false, callsSeen: 0, toasted: new WeakSet<object>(), savedFrames: -1,
};

/** Gets robot `i`'s setup for this MATCH. */
export const entrant = (i: number): BotSetup => (app.bracket && i >= 2 ? opponent(app.bracket, i) : app.bots[i]);
/** The robot that the HUD, the third-person camera, and the shot preview follow: the first robot with a human driver, or R0. */
export const focus = () => Math.max(0, app.bots.findIndex(b => b.driver !== 'planner'));
/** True from the countdown to the end of TELEOP. */
export const running = () => app.startAt > 0 || app.sim.phase === 'auto' || app.sim.phase === 'transition' || app.sim.phase === 'teleop';

/** The settings that the trace records. */
function summary() {
  const b = app.bracket;
  return { match: sel.mode.value, stage: sel.stage.value, referee: sel.referee.value, ...(b ? { tournament: `${ROUNDS[b.round]}, ${TIERS[b.round].name}` } : {}), ...Object.fromEntries(BOT_IDS.map((id, i) => { const s = entrant(i); return [id, `plate ${s.plate} · ${describe(s)}`]; })) };
}

/**
 * Saves the trace into the repository's traces/ folder through the dev server. A trace that hasn't grown since the last
 * save isn't sent again. The game setup's "This match" line shows the result.
 */
export async function saveTrace() {
  const tr = app.recorder.trace, n = tr.frames.length; if (n === app.savedFrames) return; app.savedFrames = n;
  const status = (text: string) => { $('nsaved').textContent = text; };
  try { const res = await fetch(`/api/trace/${tr.name}`, { method: 'POST', body: JSON.stringify(tr) }); status(res.ok ? `Trace saved: traces/${tr.name}.json` : 'Export saves the trace and the notes as files.'); } catch { status('Export saves the trace and the notes as files.'); }
}
/** Adds this finished MATCH to the site's live counter, a Pages Function on the deployed site. The dev server has none. */
export async function countMatch() { if (import.meta.env.DEV) return; try { await fetch('/api/matches', { method: 'POST' }); } catch { /* No counter here. */ } }

/**
 * Gets the MATCH length in seconds for a match mode, and the fixed points that the timeline marks: the MATCH start, the
 * TELEOP start, FLOWERS open, the endgame, and the MATCH end. Practice has no clock, so only its start is marked. Each
 * mark after the start sits 0.1 s past its boundary: the frame just before a boundary still shows the old period, and
 * a jump to the mark lands on the first frame after the change.
 */
function timeline(mode: MatchMode): { span: number; marks: SystemMark[] } {
  const { auto, transition, teleop, flowerUnlock, endgame } = MATCH, past = 0.1;
  if (mode === 'practice') return { span: Infinity, marks: [{ t: 0, label: 'Start' }] };
  if (mode === 'auto') return { span: auto, marks: [{ t: 0, label: 'MATCH starts' }, { t: auto + past, label: 'MATCH ends' }] };
  const teleopAt = mode === 'full' ? auto + transition : 0, span = teleopAt + teleop;
  return { span, marks: [{ t: 0, label: 'MATCH starts' }, ...(teleopAt ? [{ t: teleopAt + past, label: 'TELEOP starts' }] : []), { t: span - flowerUnlock + past, label: 'FLOWERS open' }, { t: span - endgame + past, label: 'Endgame' }, { t: span + past, label: 'MATCH ends' }] };
}

/** Keep the pre-match robot at an edited source start too. Never reposition a running robot. */
export function placeSelectedAutoStarts(sim = app.sim) {
  if (sim?.phase !== 'pre') return;
  sim.robots.forEach((_, i) => {
    const view = sim.view(i), selected = entrant(i).auto;
    if (selected === 'none') return;
    const name = selected === 'default' ? autoFor(view, SOLO_AUTO) : selected;
    if (!AUTO_PROBLEMS[name]) placeAutoStart(AUTO_TREES[name] ?? AUTO_TREES[SOLO_AUTO], view);
  });
}

/** Builds a new FIELD for the next MATCH from the settings and the robots' setups. */
export function reset() {
  app.editor.close();
  // A tournament MATCH is a full playoff MATCH against a full blue alliance.
  const t = app.bracket, oc = t ? 3 : Number(sel.opponents.value), mode = t ? 'full' : sel.mode.value as MatchMode, playoff = !!t || sel.stage.value === 'playoff';
  const sim = app.sim = new Sim(app.rapier, undefined, mode, app.seed++, { opponentCount: oc, playoff, configFor: (a, slot) => robotConfig(entrant((a === 'red' ? 0 : 2) + slot)) });
  placeSelectedAutoStarts(sim);
  // Every robot has a Coach: it runs the robot's AUTO tree, and the planner in TELEOP unless a person drives the robot.
  // Coaches record their trees, for the tree view and the match trace. Recording doesn't change what a robot does.
  app.coaches = sim.robots.map((_, i) => { const c = new Coach(), b = entrant(i); c.flowerStartSec = b.flowerStartSec; c.defense = b.defense; c.autoOverride = b.auto === 'default' || b.auto === 'none' ? null : b.auto; c.traceTrees = true; return c; });
  app.referee = sel.referee.value === 'off' ? null : new Referee(); // The referee calls PINS (G421) by the fixed rule.
  app.view.plates = BOT_IDS.map((_, i) => entrant(i).plate); app.review.plates = Object.fromEntries(BOT_IDS.map((id, i) => [id, entrant(i).plate]));
  Object.assign(window, { sim, coaches: app.coaches, editor: app.editor, referee: app.referee });
  app.startAt = 0; app.review.exit(); app.review.notes = [];
  Object.assign(app, { traceSaved: false, finalClosed: false, recorded: false, livePaused: sim.mode === 'practice', callsSeen: 0, toasted: new WeakSet(), savedFrames: -1 });
  app.recorder = new TraceRecorder(sim, summary()); const tl = timeline(sim.mode); app.review.attach(app.recorder.trace, tl.span, tl.marks); paintBots();
}

/** Stops the current MATCH and returns to the start, without starting the next one. */
export function stopMatch() { app.livePaused = false; app.startAt = 0; app.view.exitFreeLook(); reset(); }

/** Starts the MATCH after the announcer's "3-2-1-go". Needs a person to drive your robot. */
export function startMatch() {
  if (app.sim.phase !== 'pre' || app.startAt) return;
  if (app.bots[0].driver === 'planner') { toast('Choose Controller or Keyboard in the robot config for team 32294 before starting.', 'ref'); return; }
  placeSelectedAutoStarts();
  closeConfig(); closeModals(); app.editor.close();
  if (!app.audio.enabled) { app.sim.start(); return; }
  app.audio.play('start_countdown'); app.startAt = performance.now() + 3000;
}

/** Opens the review. It saves the trace first, so that annotations always have their trace on disk. */
export function openReview() { closeConfig(); closeModals(); app.editor.close(); void saveTrace(); app.view.enterFreeLook(); app.review.enter(app.recorder.trace); }
/** Closes the review and lets the MATCH run. */
export function goLive() { app.review.exit(); app.livePaused = false; app.view.exitFreeLook(); }
/** Opens the AUTO editor on red robot `i`. After a MATCH, it resets the FIELD first, because the plan preview draws from the start positions. */
export function openEditor(i: number) { if (app.review.active || app.startAt) return; closeConfig(); closeModals(); if (app.sim.phase !== 'pre') reset(); app.editor.open(i); }
