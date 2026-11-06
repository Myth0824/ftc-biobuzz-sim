/**
 * The simulator page. It boots the physics engine and the panels in `src/ui/`, and runs one frame at a time: it reads
 * the controls, steps the MATCH, and draws it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { AUTO_TREES, SOLO_AUTO, autoFor, previewAuto } from './auto/onboard';
import type { Coach } from './auto/coach';
import { FieldEditor } from './field-editor';
import { readInput, rumble, setXRSession } from './input';
import { View } from './render/view';
import { Review } from './review';
import { BOT_IDS, loadBots, saveBots } from './setup';
import { DT, NO_INPUT, type Inputs } from './sim/world';
import { loadBracket, record, saveBracket } from './tournament';
import { loadUserTrees } from './user-trees';
import { app, countMatch, focus, goLive, openReview, reset, running, saveTrace, startMatch } from './ui/app';
import { $, closeModals, initModals, toast } from './ui/dom';
import { initEditorUi, paintEditor, paintGhost } from './ui/editor-ui';
import { hud, initHud, paintBracket } from './ui/hud';
import { closeConfig, initRobotConfig, paintBots } from './ui/robot-config';
import { initSettings, sel } from './ui/settings';
import { initTransport, playPause, skip } from './ui/transport';
import { initTreeView, paintTree } from './ui/tree-ui';

await RAPIER.init();
app.rapier = RAPIER;
app.canvas = $<HTMLCanvasElement>('c');
app.view = new View(app.canvas, m => { app.loadMsg = m; });
app.review = new Review(app.view, () => app.sim, app.canvas);
// The AUTO plans that the field editor saved load first, so that a setup can name one. A setup that names a plan this
// browser doesn't have runs the default.
loadUserTrees();
app.bots = loadBots();
for (const b of app.bots) if (b.auto !== 'default' && b.auto !== 'none' && !AUTO_TREES[b.auto]) b.auto = 'default';
app.bracket = loadBracket();
// The field editor edits one robot's AUTO poses before the MATCH. An edit switches the robot to the edited copy.
app.editor = new FieldEditor({ view: app.view, canvas: app.canvas, bots: app.bots, sim: () => app.sim,
  setAuto: (k, id) => { app.bots[k].auto = id; saveBots(app.bots); if (app.coaches[k]) app.coaches[k].autoOverride = id === 'default' ? null : id; paintBots(); },
  changed: () => { sel.camera.value = app.view.mode; paintEditor(); paintTree(); } });

initModals(); initSettings(); initRobotConfig(); initTransport(); initTreeView(); initEditorUi(); initHud();
reset();
app.review.onEnd = () => { if (running()) goLive(); };
app.review.onOpen = openReview;

/**
 * Turns stick inputs in the driver's frame into the frame of robot `i`. The driver looks along heading `look`: from the
 * alliance wall, or along the third-person camera.
 */
function fieldCentric(inp: Inputs, i: number, look: number): Inputs {
  const a = look - app.sim.view(i).heading, f = inp.forward, s = inp.strafeRight;
  return { ...inp, forward: f * Math.cos(a) + s * Math.sin(a), strafeRight: s * Math.cos(a) - f * Math.sin(a) };
}

/** The end-of-MATCH chores: save the trace, count the MATCH, and record a tournament result. */
function finishMatch() {
  const { sim } = app;
  if (!app.traceSaved) { app.traceSaved = true; void saveTrace(); void countMatch(); }
  if (app.bracket && !app.recorded) { app.recorded = true; record(app.bracket, sim.score('red').total, sim.score('blue').total); saveBracket(app.bracket); paintBracket(); }
}

/** Steps the MATCH by fixed steps for the time that passed. AUTO runs each robot's plan; in TELEOP a person or the planner drives. */
function stepMatch(inF: ReturnType<typeof readInput>, acc: number): number {
  const { sim, bots, coaches, view } = app, fi = focus();
  // With no controller connected, the keyboard drives the controller's robot, unless another robot has the keyboard.
  const padInput = inF.pad?.inputs ?? (bots.some(q => q.driver === 'keyboard') ? NO_INPUT : inF.keyboard);
  for (; acc >= DT; acc -= DT) {
    // AUTO always runs the robot's plan: G401 allows no driver input.
    const inAuto = sim.phase === 'auto', inputs: Inputs[] = [], flags: boolean[] = [], drivers: (Coach | null)[] = [];
    bots.forEach((b, i) => {
      if (i >= sim.robots.length) return; // This robot isn't on the FIELD for this opponent count.
      const human = !inAuto && b.driver !== 'planner', src = human ? (b.driver === 'keyboard' ? inF.keyboard : padInput) : null;
      const look = i === fi && Number.isFinite(view.chaseYaw) ? view.chaseYaw : sim.robots[i].alliance === 'red' ? 0 : Math.PI;
      if (src) inputs.push({ ...(b.stickFrame === 'field' ? fieldCentric(src, i, look) : src), human: true }); else inputs.push(inAuto && b.auto === 'none' ? NO_INPUT : coaches[i].update(sim.view(i), DT));
      flags.push(!human); drivers.push(human ? null : coaches[i]);
    });
    sim.step(inputs, flags); app.referee?.update(sim, DT); app.recorder.record(sim, drivers, DT);
  }
  return acc;
}

/** Shows the referee's calls and the rule messages, such as G410, as toasts, and marks each FOUL on the timeline. */
function showCalls() {
  const { referee, recorder, review, bots, sim } = app;
  for (; referee && app.callsSeen < referee.calls.length; app.callsSeen++) {
    const c = referee.calls[app.callsSeen], fr = recorder.trace.frames[recorder.trace.frames.length - 1]; if (!fr) continue;
    review.mark(recorder.trace, fr.t, `REFEREE: ${c.kind} FOUL, ${c.rule}. ${bots[c.pinner].plate} pinned ${bots[c.victim].plate}.`, BOT_IDS[c.pinner]);
  }
  for (const m of sim.messages) if (!app.toasted.has(m)) { app.toasted.add(m); if (/^(REFEREE:|G\d{3})/.test(m.text)) toast(m.text, 'ref'); }
}

let autoPlan: ReturnType<typeof previewAuto> | null = null, autoPlanKey = '', carriedWas = 0;
/** Draws the FIELD for the focus robot: a person gets the shot preview, and a program gets its planned path and AUTO plan. */
function draw() {
  const { sim, bots, coaches, view, editor } = app, fi = focus(), me = sim.view(fi);
  const humanNow = bots[fi].driver !== 'planner' && sim.phase !== 'auto', next = me.carried[0], dual = me.cfg.shooter.type === 'dual';
  if (sim.phase === 'teleop' && bots[fi].driver === 'pad1' && me.carried.length !== carriedWas) rumble(me.carried.length < carriedWas);
  carriedWas = me.carried.length;
  const kind = !next ? null : dual ? (me.carried.includes('pollen') ? 'pollen' : 'nectar') : next === 'pollen' ? 'pollen' : 'nectar';
  const paths = sel.autopaths.value === 'on', previewKind = sel.showtraj.value === 'on' && humanNow ? kind : null;
  view.sync(me, previewKind, humanNow || !paths ? null : sim.phase === 'auto' ? coaches[fi].auto?.path ?? null : coaches[fi].executor.path);
  // The AUTO plan shows on the FIELD before and during AUTO. In the field editor it is the edited robot's, and it redraws after each edit.
  const pi = editor.active ? editor.robot : fi, pv = sim.view(pi);
  const name = bots[pi].auto === 'default' ? autoFor(pv, SOLO_AUTO) : bots[pi].auto, tree = AUTO_TREES[name];
  const showPlan = !!tree && (editor.active || (paths && (sim.mode === 'full' || sim.mode === 'auto') && (sim.phase === 'pre' || sim.phase === 'auto')));
  if (showPlan && sim.phase === 'pre') { const key = `${name}:${pi}:${app.seed}:${editor.rev}`; if (key !== autoPlanKey) { const p = pv.robot.translation(); autoPlan = previewAuto(tree, pv, { x: p.x, z: p.z }); autoPlanKey = key; } }
  view.showAutoPlan(showPlan ? autoPlan : null, autoPlanKey);
  paintGhost(pv, showPlan ? autoPlan : null);
}

let last = performance.now(), acc = 0, frame = 0;
function tick(now: number) {
  const { sim, review, view } = app, frameDt = (now - last) / 1000; acc = Math.min(acc + frameDt, 0.05); last = now;
  const inF = readInput();
  // A headset has no keyboard: its A button also resets the FIELD after the MATCH.
  if (inF.reset || (inF.start && view.vr && sim.phase === 'post')) reset(); else if (inF.start) startMatch();
  const frames = app.recorder.trace.frames; if (inF.mark && frames.length) review.mark(app.recorder.trace, frames[frames.length - 1].t);
  if (inF.review) { if (review.active) goLive(); else openReview(); }
  if (inF.play) playPause();
  // The arrows only drive: while live they steer the turret / shoot / intake (via the held keys), and while paused
  // they pan and zoom the camera. They never skip a mark or open the review. Previous/next mark are the `[` / `]`
  // keys (rebindable in Key bindings), so turning the turret can never restart into replay.
  if (app.livePaused) {
    for (const [on, key] of [[inF.camLeft, 'ArrowLeft'], [inF.camRight, 'ArrowRight'], [inF.camUp, 'ArrowUp'], [inF.camDown, 'ArrowDown']] as const) if (on) view.adjustView(key);
  }
  if (inF.prev) skip(-1);
  if (inF.next) skip(1);
  if (app.sim.phase === 'post') finishMatch();
  if (review.active) { review.tick(frameDt); acc = 0; if (frame++ % 6 === 0) hud(inF.pad); return; }
  if (app.startAt && now >= app.startAt) { app.startAt = 0; app.sim.start(); }
  for (const e of app.sim.events.splice(0)) app.audio.play(e);
  if (inF.camera) { view.cycleCamera(); sel.camera.value = view.mode; }
  if (app.livePaused) acc = 0;
  acc = stepMatch(inF, acc);
  showCalls(); draw();
  if (frame++ % 6 === 0) hud(inF.pad);
}
app.view.loop(tick);

// The built site works offline and installs as an app. The dev server doesn't register it, so edits always load.
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/sim/' }).catch(() => {});

// In a headset, you drive 32294 from the red alliance area with the headset's controllers.
const vrBtn = $<HTMLButtonElement>('tvr');
void (navigator as Navigator & { xr?: XRSystem }).xr?.isSessionSupported('immersive-vr').then(ok => vrBtn.classList.toggle('hidden', !ok)).catch(() => {});
vrBtn.onclick = async () => {
  vrBtn.blur(); if (app.review.active) goLive(); closeModals(); closeConfig(); if (app.editor.active) app.editor.close();
  try {
    const session = await app.view.enterVR(); setXRSession(session);
    session.addEventListener('end', () => setXRSession(null));
    if (app.bots[0].driver !== 'pad1') { app.bots[0].driver = 'pad1'; saveBots(app.bots); toast('32294 now drives with the headset controllers.'); }
  } catch (err) { toast(`Can't start VR: ${(err as Error).message}`, 'ref'); }
};
