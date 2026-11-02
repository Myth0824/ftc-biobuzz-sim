import RAPIER from '@dimforge/rapier3d-compat';
import { readInput, keyboardActive, type Frame } from './input';
import { AUTO_PROBLEMS, AUTO_TREES, SOLO_AUTO, autoFor, autoStart, previewAuto } from './auto/onboard';
import { findNode } from './auto/auto-edit';
import { FieldEditor } from './field-editor';
import { loadUserTrees } from './user-trees';
import { BOT_IDS, REF_ERR, MAIN_ROBOT_INDEX, startSide, assignDriver, defaultBot, metaBot, describe, describeLines, loadBots, robotConfig, sanitize, saveBots, type BotSetup, type DriverKind } from './setup';
import { setBindings, getBindings, DEFAULT_BINDINGS, BINDING_LABELS, codeLabel, type KeyBindings } from './input';
import { MatchAudio } from './audio';
import { Coach } from './auto/coach';
import { Referee } from './ref/referee';
import { Review, clockText, type SystemMark } from './review';
import { TraceRecorder } from './trace';
import { Inspector } from './render/inspector';
import { LiveTreeState, TreePanel, treeStateAt } from './render/tree-view';
import { TELEOP_TREES } from './auto/driver';
import { CAMERAS, View, type CameraMode } from './render/view';
import { MATCH, RP } from './sim/config';
import { fmtPos, getUnits, massFromInput, massToInput, setUnits, sizeFromInput, sizeToInput, speedFromInput, speedToInput, type Units } from './units';
import { DT, NO_INPUT, Sim, type AllianceScore, type Inputs, type MatchMode } from './sim/world';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}` : '--:--');

await RAPIER.init();
const banner = $('banner'); let loadMsg: string | null = null;
const canvas = $<HTMLCanvasElement>('c'), view = new View(canvas, m => { loadMsg = m; });
const stageSel = $<HTMLSelectElement>('stage'), modeSel = $<HTMLSelectElement>('mode'), camSel = $<HTMLSelectElement>('camera'), refSel = $<HTMLSelectElement>('referee'), opponentsSel = $<HTMLSelectElement>('opponents');
try { opponentsSel.value = localStorage.getItem('biobuzz.opponents') ?? '3'; } catch { opponentsSel.value = '3'; }
const audio = new MatchAudio(), soundSel = $<HTMLSelectElement>('sound'); soundSel.onchange = () => { audio.enabled = soundSel.value === 'on'; soundSel.blur(); };
// The tree view shows one robot's behavior tree. The setting is a convenience that this browser keeps.
const treeSel = $<HTMLSelectElement>('treeview'), treePanel = new TreePanel($('treebody'), $('treehead')), liveTrees = [0, 1, 2, 3].map(() => new LiveTreeState());
try { treeSel.value = localStorage.getItem('biobuzz.treeview') === 'on' ? 'on' : 'off'; } catch { /* Storage is a convenience. */ }
treeSel.onchange = () => { try { localStorage.setItem('biobuzz.treeview', treeSel.value); } catch { /* Storage is a convenience. */ } treeSel.blur(); paintTree(); };
// AUTO paths draws the focus robot's AUTO plan and its planned path. The AUTO editor draws them whatever the setting.
const pathsSel = $<HTMLSelectElement>('autopaths');
try { pathsSel.value = localStorage.getItem('biobuzz.autopaths') === 'off' ? 'off' : 'on'; } catch { /* Storage is a convenience. */ }
pathsSel.onchange = () => { try { localStorage.setItem('biobuzz.autopaths', pathsSel.value); } catch { /* Storage is a convenience. */ } pathsSel.blur(); };
const trajSel = $<HTMLSelectElement>('showtraj');
try { trajSel.value = localStorage.getItem('biobuzz.showtraj') === 'off' ? 'off' : 'on'; } catch { /* default on */ }
trajSel.onchange = () => { try { localStorage.setItem('biobuzz.showtraj', trajSel.value); } catch { /* Storage is a convenience. */ } trajSel.blur(); };
let treeRobot = -1; // -1 follows the focus robot.
// One handler for the robot buttons. The buttons are rebuilt only when the robots or the choice change: a button that is
// replaced between the press and the release of a click never receives the click.
let treeBotsKey = '';
// In the AUTO editor, the buttons pick which red robot's plan the editor shows.
$('treebots').onclick = e => { const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k]'); if (!btn) return; if (editor.active) editor.showRobot(Number(btn.dataset.k)); else { treeRobot = Number(btn.dataset.k); paintTree(); } };

// Every MATCH has two full alliances: R0, R1, B0, and B1. Each robot has its own setup, edited in the robot config popup.
// The AUTO trees that the field editor saved load first, so that a setup can name one. A setup that names a tree this
// browser doesn't have runs the default.
loadUserTrees();
const bots: BotSetup[] = loadBots();
for (const b of bots) if (b.auto !== 'default' && b.auto !== 'none' && !AUTO_TREES[b.auto]) b.auto = 'default';
let units: Units = getUnits(); const unitsSel = $<HTMLSelectElement>('units'); unitsSel.value = units;
unitsSel.onchange = () => { units = unitsSel.value as Units; setUnits(units); unitsSel.blur(); paintBots(); if (editing >= 0) openConfig(editing); };
let sim: Sim; let seed = 1; let startAt = 0; let recorder: TraceRecorder; let traceSaved = false; let coaches: Coach[] = [], referee: Referee | null = null;
// A paused MATCH doesn't step. `callsSeen` counts the referee's calls that have a note, and `toasted` holds the sim messages that had a toast.
let livePaused = false, callsSeen = 0, toasted = new WeakSet<object>(), savedFrames = -1;
const review = new Review(view, () => sim, canvas); let finalClosed = false;
// The field editor edits one robot's AUTO poses before the MATCH. An edit switches the robot to the edited copy.
const editor = new FieldEditor({ view, canvas, bots, sim: () => sim,
  setAuto: (k, id) => { bots[k].auto = id; saveBots(bots); if (coaches[k]) coaches[k].autoOverride = id === 'default' ? null : id; paintBots(); },
  changed: () => { camSel.value = view.mode; paintEditor(); paintTree(); } });
/** The robot that the HUD, the chase camera, and the shot preview follow: the first robot with a human driver, or R0. */
const focus = () => Math.max(0, bots.findIndex(b => b.driver !== 'planner'));
const settings = () => ({ match: modeSel.value, stage: stageSel.value, referee: refSel.value, ...Object.fromEntries(bots.map((b, i) => [BOT_IDS[i], `plate ${b.plate} · ${describe(b)}`])) });
/**
 * Saves the trace into the repository's traces/ folder through the dev server. A trace that hasn't grown since the last
 * save isn't sent again. The game setup's "This match" line shows the result.
 */
async function saveTrace() {
  const tr = recorder.trace, n = tr.frames.length; if (n === savedFrames) return; savedFrames = n;
  const status = (text: string) => { $('nsaved').textContent = text; };
  try { const res = await fetch(`/api/trace/${tr.name}`, { method: 'POST', body: JSON.stringify(tr) }); status(res.ok ? `Trace saved: traces/${tr.name}.json` : 'Export saves the trace and the notes as files.'); } catch { status('Export saves the trace and the notes as files.'); }
}
/** Adds this finished MATCH to the site's live counter. The dev server has no counter, so a failure is silent. */
async function countMatch() { try { await fetch('/api/matches', { method: 'POST' }); } catch { /* No counter here. */ } }
/** Starts the MATCH after the announcer's "3-2-1-go". Requires the main robot to have a human driver. */
function startMatch() {
  if (sim.phase !== 'pre' || startAt) return;
  // Require a human driver on the main robot before starting
  const main = bots[0];
  if (main.driver === 'planner') { toast('Choose Controller or Keyboard in the robot config for team 32294 before starting.', 'ref'); return; }
  closeConfig(); closeModals(); editor.close();
  if (!audio.enabled) { sim.start(); return; }
  audio.play('start_countdown'); startAt = performance.now() + 3000;
}
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
function reset() {
  editor.close();
  const oc = Number(opponentsSel.value);
  sim = new Sim(RAPIER, undefined, modeSel.value as MatchMode, seed++, { opponentCount: oc, playoff: stageSel.value === 'playoff', configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) });
  // Every robot has a Coach: it runs the robot's AUTO tree, and the planner in TELEOP unless a controller drives the robot.
  // Coaches record their trees, for the tree view and the match trace. Recording doesn't change what a robot does.
  coaches = sim.robots.map((_, i) => { const c = new Coach(), b = bots[i]; c.flowerStartSec = b.flowerStartSec; c.defense = b.defense; c.autoOverride = b.auto === 'default' || b.auto === 'none' ? null : b.auto; c.traceTrees = true; return c; });
  referee = refSel.value === 'off' ? null : new Referee(); // The referee calls PINS (G421) by the fixed rule.
  view.plates = bots.map(b => b.plate); review.plates = Object.fromEntries(bots.map((b, i) => [BOT_IDS[i], b.plate]));
  Object.assign(window, { sim, coaches, editor, referee }); startAt = 0; review.exit(); review.notes = []; traceSaved = false; finalClosed = false;
  livePaused = sim.mode === 'practice'; callsSeen = 0; toasted = new WeakSet(); savedFrames = -1;
  recorder = new TraceRecorder(sim, settings()); const tl = timeline(sim.mode); review.attach(recorder.trace, tl.span, tl.marks); paintBots();
}

/** Stops the current match and returns to pre-match state without auto-starting. */
function stopMatch() {
  livePaused = false; startAt = 0;
  view.exitFreeLook();
  reset();
}

// ---------- robot config ----------
let editing = -1; const EDIT_TIP = $('bcedit').title;
const bc = { plate: $<HTMLInputElement>('bcplate'), driver: $<HTMLSelectElement>('bcdriver'), drive: $<HTMLSelectElement>('bcdrive'), shooter: $<HTMLSelectElement>('bcshooter'), auto: $<HTMLSelectElement>('bcauto'), plan: $<HTMLSelectElement>('bcplan'), rpm: $<HTMLInputElement>('bcrpm'), size: $<HTMLInputElement>('bcsize'), mass: $<HTMLInputElement>('bcmass'), intake: $<HTMLSelectElement>('bcintake'), ends: $<HTMLSelectElement>('bcends'), turretRange: $<HTMLInputElement>('bcturretrange'), turretSlew: $<HTMLInputElement>('bcturretslew'), defense: $<HTMLSelectElement>('bcdefense'), elev: $<HTMLInputElement>('bcelev'), azim: $<HTMLInputElement>('bcazim'), speed: $<HTMLInputElement>('bcspeed'), intakeP: $<HTMLInputElement>('bcintakep') };
/** Lists the AUTO plans for one start position. A plan named for the other position starts from the wrong wall, so the list leaves it out. */
const autoOptions = (i: number) => { const side = startSide(i);
  return `<option value="default">Default: wall-sweep pair, ${side} robot</option>` + Object.entries(AUTO_TREES).filter(([, d]) => autoStart(d) !== (side === 'right' ? 'left' : 'right')).map(([k, d]) => `<option value="${k}" title="${d.description ?? ''}">${d.name}${AUTO_PROBLEMS[k] ? ' (has problems, doesn\'t run)' : ''}</option>`).join('') + `<option value="none">None</option>`; };
const gear = (i: number) => `<button class="gear" data-bot="${i}" title="Robot config for ${bots[i].plate}">&#9881;</button>`;
const badge = (i: number) => `<span style="font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px;background:${i === MAIN_ROBOT_INDEX ? 'var(--ok)' : 'rgba(255,255,255,.18)'};color:${i === MAIN_ROBOT_INDEX ? '#0b1a10' : 'var(--dim)'};margin-left:4px;vertical-align:middle;flex-shrink:0">${i === MAIN_ROBOT_INDEX ? 'H' : 'B'}</span>`;
/** Draws the robot rows in the scoreboard and the robot cards in the game setup. Called when a setup changes, not on every frame, so that the buttons stay clickable. */
function paintBots() {
  // Keep paused class in sync so gear buttons show/hide correctly
  document.body.classList.toggle('paused', livePaused);
  // Scoreboard rows: flex so the badge sits vertically centred next to the plate
  $('tred').innerHTML = [0, 1].map(i => `<div style="display:flex;align-items:center;gap:2px">${bots[i].plate}${badge(i)}${gear(i)}</div>`).join('');
  $('tblue').innerHTML = [2, 3].map(i => `<div style="display:flex;align-items:center;gap:2px">${bots[i].plate}${badge(i)}${gear(i)}</div>`).join('');
  $('botlist').innerHTML = bots.map((b, i) => { const side = i < 2 ? 'red' : 'blue';
    return `<div class="bot ${side}" data-bot="${i}" title="${describe(b, units)}"><div class="bothead"><b style="background:var(--${side});display:inline-flex;align-items:center;gap:2px">${b.plate}${badge(i)}</b><span>${BOT_IDS[i]} · ${startSide(i)} start</span>${gear(i)}</div><div class="botdesc">${describeLines(b, units).map(l => `<div>${l}</div>`).join('')}</div></div>`; }).join('');
  document.querySelectorAll<HTMLElement>('button.gear, #botlist .bot').forEach(el => { el.onclick = e => { e.stopPropagation(); openConfig(Number(el.dataset.bot)); }; });
}
/** Opens the robot config popup. Allowed before/after match, and while paused mid-match. */
function openConfig(i: number) {
  const canEdit = sim.phase === 'pre' || sim.phase === 'post' || livePaused;
  if (!canEdit || startAt) return;
  // If mid-match and not yet paused, pause first
  if (sim.phase !== 'pre' && sim.phase !== 'post' && !livePaused) livePaused = true;
  if (review.active) review.exit(); closeModals(); editing = i; const b = bots[i];
  const isMain = i === MAIN_ROBOT_INDEX;
  $('bchead').textContent = `Robot config: ${b.plate} (${BOT_IDS[i]}), ${i < 2 ? 'red' : 'blue'} alliance, ${startSide(i)} start`; bc.auto.innerHTML = autoOptions(i);
  bc.plate.value = b.plate;
  // Lock plate for main robot
  ($<HTMLInputElement>('bcplate')).disabled = isMain;
  bc.driver.value = b.driver; bc.drive.value = b.stickFrame; bc.shooter.value = b.shooter; bc.auto.value = b.auto; bc.plan.value = String(b.flowerStartSec); bc.rpm.value = String(b.driveRpm); bc.size.value = String(sizeToInput(b.sizeIn, units)); bc.mass.value = String(massToInput(b.massLb, units)); $('bcsizelabel').textContent = `Chassis, square, ${units === 'us' ? 'in.' : 'cm'}`; $('bcmasslabel').textContent = `Mass, ${units === 'us' ? 'lb' : 'kg'}`; bc.intake.value = b.dualIntake ? 'dual' : 'front'; bc.ends.value = b.turret ? 'turret' : b.dualShooter ? 'both' : 'one'; bc.turretRange.value = String(b.turretRangeDeg ?? 360); bc.turretSlew.value = b.turretSlewDegPerSec ? String(b.turretSlewDegPerSec) : ''; for (const id of ['bcturretrow', 'bcslewrow']) $(id).classList.toggle('hidden', !b.turret); bc.defense.value = b.defense; bc.elev.value = String(b.errElevDeg); bc.azim.value = String(b.errAzimDeg); bc.speed.value = String(speedToInput(b.errSpeed, units)); bc.intakeP.value = String(Math.round(100 * b.intakeP)); $('bcspeedlabel').textContent = `Launch speed, ${units === 'us' ? 'ft/s' : 'm/s'}`;
  const edit = $<HTMLButtonElement>('bcedit'); edit.disabled = i >= 2; edit.title = i >= 2 ? 'Edit AUTO trees from a red robot. Blue robots run the same trees rotated 180° about the FIELD center.' : EDIT_TIP;
  // Only show driver row for the main robot (R0); all others are always AI
  $('bcdriverrow').classList.toggle('hidden', !isMain);
  $('bcdriverow').classList.toggle('hidden', b.driver === 'planner');
  $('bcnote').textContent = isMain
    ? 'Team 32294 — your robot. Choose Controller or Keyboard to drive.'
    : 'This robot is always driven by the AI planner.';
  // bcinrow/bcendsrow always hidden (locked for main, irrelevant for AI)
  // bcturretrow/bcslewrow hidden for main robot (always 360 instant) and for non-turret AI bots
  // bcplanrow hidden for main robot (human driver, no planner TELEOP plan needed)
  for (const id of ['bcinrow', 'bcendsrow']) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
  for (const id of ['bcturretrow', 'bcslewrow']) { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', isMain || !b.turret); }
  const planRow = document.getElementById('bcplanrow'); if (planRow) planRow.classList.toggle('hidden', isMain);
  $('botcfg').classList.remove('hidden');
}
function closeConfig() { editing = -1; $('botcfg').classList.add('hidden'); }
/** Reads the popup into the setup, saves it. If mid-match (paused), keeps running — rebuilds only from pre/post. */
function applyConfig() {
  if (editing < 0) return; const i = editing, b = bots[i];
  Object.assign(b, { plate: bc.plate.value, stickFrame: bc.drive.value, shooter: bc.shooter.value, auto: bc.auto.value, flowerStartSec: Number(bc.plan.value), driveRpm: Number(bc.rpm.value), sizeIn: sizeFromInput(Number(bc.size.value), units), massLb: massFromInput(Number(bc.mass.value), units), dualIntake: bc.intake.value === 'dual', dualShooter: bc.ends.value === 'both', turret: bc.ends.value === 'turret', turretRangeDeg: Number(bc.turretRange.value) || 360, turretSlewDegPerSec: Number(bc.turretSlew.value) || null, defense: bc.defense.value, errElevDeg: Number(bc.elev.value), errAzimDeg: Number(bc.azim.value), errSpeed: speedFromInput(Number(bc.speed.value), units), intakeP: Number(bc.intakeP.value) / 100 });
  assignDriver(bots, i, bc.driver.value as DriverKind); bots[i] = sanitize(bots[i], i); saveBots(bots);
  const midMatch = sim.phase !== 'pre' && sim.phase !== 'post';
  if (midMatch) {
    // Stay paused — changes take effect but field isn't rebuilt mid-match
    livePaused = true;
    toast('Setting changed — press Play to continue.', '');
    paintBots();
    openConfig(i);
  } else {
    reset(); openConfig(i);
  }
}
for (const el of Object.values(bc)) { el.onchange = applyConfig; for (const ev of ['keydown', 'keyup']) el.addEventListener(ev, e => e.stopPropagation()); }
// The 1x, 3x, and 5x chips fill in the reference launcher's errors times that factor.
document.querySelectorAll<HTMLButtonElement>('[data-err]').forEach(el => { el.onclick = () => { const k = Number(el.dataset.err); bc.elev.value = String(+(REF_ERR.errElevDeg * k).toFixed(2)); bc.azim.value = String(+(REF_ERR.errAzimDeg * k).toFixed(2)); bc.speed.value = String(speedToInput(+(REF_ERR.errSpeed * k).toFixed(3), units)); applyConfig(); }; });
/** Opens the AUTO editor on red robot `i`. After a MATCH, it resets the FIELD first, because the plan preview draws from the start positions. */
function openEditor(i: number) { if (review.active || startAt) return; closeConfig(); closeModals(); if (sim.phase !== 'pre') reset(); editor.open(i); }
$('bcedit').onclick = () => { if (editing >= 0 && editing < 2) openEditor(editing); };
$('editauto').onclick = () => { $('editauto').blur(); closeModals(); if (editor.active) editor.close(); else openEditor(treeRobot === 1 ? 1 : 0); };
$('bcdone').onclick = closeConfig; const applyPreset = (make: (i: number) => BotSetup) => { if (editing < 0) return; const i = editing, keep = { plate: bots[i].plate, driver: bots[i].driver, stickFrame: bots[i].stickFrame }; bots[i] = { ...make(i), ...keep }; saveBots(bots); reset(); openConfig(i); };
$('bcdefault').onclick = () => applyPreset(metaBot); $('bcbaseline').onclick = () => applyPreset(defaultBot);
// A click on the FIELD floor shows the position in a toast, in the coordinate system that the floor labels show.
// In the review, a click on a robot adds a note instead.
canvas.addEventListener('click', e => {
  if (editor.takeClick()) return;
  // In the editor, a click on the other red robot shows that robot's plan. A click on a handle never gets here.
  if (editor.active) {
    // Only a click on the robot itself counts: in the overhead view a robot is a large target, and its path passes near it.
    const other = 1 - editor.robot; if (view.pickRobot(e.clientX, e.clientY, 0) === other) { editor.showRobot(other); return; }
  }
  if (review.active && view.pickRobot(e.clientX, e.clientY) !== null) return; const q = view.pickFloor(e.clientX, e.clientY); if (!q) return;
  toast(`Field position: ${fmtPos(q.x, q.y, units)}`);
});
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  // In the editor, a right-click on the FIELD floor offers a reference point there.
  if (editor.active) {
    // It always offers a new reference point. On a reference point it also offers to delete the point, and on a step
    // built on one, to make the step absolute.
    const q = view.pickFloor(e.clientX, e.clientY); if (!q) return; refAt = q; menuFor = editor.menuAt(e.clientX, e.clientY);
    const menu = $('aemenu'); menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`; menu.classList.remove('hidden');
    const readOnly = editor.editing ? '' : 'Edit a plan that you made to change it.';
    const add = $<HTMLButtonElement>('aeaddref'), drive = $<HTMLButtonElement>('aedrivetoref'), abs = $<HTMLButtonElement>('aeabs'), del = $<HTMLButtonElement>('aedelref');
    add.disabled = !editor.editing; abs.classList.toggle('hidden', !menuFor || !('step' in menuFor)); del.classList.toggle('hidden', !menuFor || !('ref' in menuFor) || 'step' in menuFor);
    // "Drive to ref" appears when right-clicking a reference point while editing
    const isRef = menuFor && !('step' in menuFor) && 'ref' in menuFor;
    drive.classList.toggle('hidden', !isRef || !editor.editing);
    if (isRef) { drive.textContent = `Go to reference point ${(menuFor as {ref: string}).ref}`; drive.disabled = !editor.editing; }
    if (menuFor && 'step' in menuFor) { abs.textContent = menuFor.ref ? `Make ${menuFor.id} absolute (stop following ${menuFor.ref})` : `${menuFor.id} is already absolute`; abs.disabled = !editor.editing || !menuFor.ref; }
    if (menuFor && !('step' in menuFor)) { del.textContent = `Delete reference point ${menuFor.ref}`; del.disabled = !editor.editing; }
    for (const b of [add, drive, abs, del]) b.title = readOnly;
    // Keep the menu in the window: near the right or bottom edge it opens to the left of or above the pointer.
    const box = menu.getBoundingClientRect();
    if (box.right > innerWidth - 4) menu.style.left = `${Math.max(4, e.clientX - box.width)}px`;
    if (box.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, e.clientY - box.height)}px`;
    return;
  }
  const i = view.pickRobot(e.clientX, e.clientY); if (i !== null) openConfig(i);
});
// The reference-point menu and its name dialog.
let refAt: { x: number; y: number } | null = null, menuFor: ReturnType<typeof editor.menuAt> = null;
addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest?.('#aemenu')) $('aemenu').classList.add('hidden'); }, true);
$('aeaddref').onclick = () => { $('aemenu').classList.add('hidden'); $<HTMLInputElement>('aerefinput').value = ''; $('aereferr').textContent = ''; $('aerefname').classList.remove('hidden'); $('aerefinput').focus(); };
$('aeabs').onclick = () => { $('aemenu').classList.add('hidden'); if (menuFor && 'step' in menuFor) editor.makeStepAbsolute(menuFor.step); };
$('aedelref').onclick = () => { $('aemenu').classList.add('hidden'); if (menuFor && !('step' in menuFor)) editor.deleteRef(menuFor.ref); };
$('aedrivetoref').onclick = () => { $('aemenu').classList.add('hidden'); if (menuFor && !('step' in menuFor)) { const err = editor.addDriveToRef(menuFor.ref); if (err) toast(err); } };
$('aerefcancel').onclick = () => $('aerefname').classList.add('hidden');
$('aerefadd').onclick = () => { if (!refAt) return; const err = editor.addReferenceAt($<HTMLInputElement>('aerefinput').value, refAt); $('aereferr').textContent = err ?? ''; if (!err) $('aerefname').classList.add('hidden'); };
for (const ev of ['keydown', 'keyup']) $('aerefinput').addEventListener(ev, e => { e.stopPropagation(); if (ev === 'keydown' && (e as KeyboardEvent).key === 'Enter') $('aerefadd').click(); });

// Load saved settings BEFORE the first reset so the sim is built with the right mode/opponents
loadAllSettings();
reset();
// Entering the review saves the trace first, so that annotations always have their trace on disk.
function openReview() { closeConfig(); closeModals(); editor.close(); void saveTrace(); review.enter(recorder.trace); view.enterFreeLook(); }
/** Applies a game-setup change. Mid-match: pauses and notes change takes effect next reset. Pre/post: resets immediately. */
function applySetup() {
  saveAllSettings();
  if (sim.phase !== 'pre' && sim.phase !== 'post') {
    livePaused = true;
    toast('Setting changed — press Reset to apply, or Play to continue.', '');
  } else {
    reset();
  }
}
modeSel.onchange = applySetup; refSel.onchange = applySetup; stageSel.onchange = applySetup;
opponentsSel.onchange = () => { try { localStorage.setItem('biobuzz.opponents', opponentsSel.value); } catch { /* ok */ } opponentsSel.blur(); applySetup(); };

// ---------- persistent settings (auto-save to localStorage on every change) ----------
const SETTINGS_KEY = 'biobuzz.settings.v1';

function saveAllSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: modeSel.value, stage: stageSel.value, opponents: opponentsSel.value,
      camera: camSel.value, units: unitsSel.value, sound: soundSel.value,
      treeview: treeSel.value, autopaths: pathsSel.value, showtraj: trajSel.value,
      referee: refSel.value,
    }));
  } catch { /* storage is a convenience */ }
}

function loadAllSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    if (s.mode) modeSel.value = s.mode;
    if (s.stage) stageSel.value = s.stage;
    if (s.opponents) { opponentsSel.value = s.opponents; }
    if (s.camera) { camSel.value = s.camera; view.mode = s.camera; }
    if (s.units) { unitsSel.value = s.units; setUnits(s.units as Units); units = s.units as Units; }
    if (s.sound) { soundSel.value = s.sound; audio.enabled = s.sound === 'on'; }
    if (s.treeview) treeSel.value = s.treeview;
    if (s.autopaths) pathsSel.value = s.autopaths;
    if (s.showtraj) trajSel.value = s.showtraj;
    if (s.referee) refSel.value = s.referee;
  } catch { /* storage is a convenience */ }
}

// Auto-save whenever any setting changes
for (const el of [modeSel, stageSel, opponentsSel, camSel, unitsSel, soundSel, treeSel, pathsSel, trajSel, refSel]) {
  el.addEventListener('change', saveAllSettings);
}

// ---------- control bar ----------
/** True from the countdown to the end of TELEOP. */
const running = () => startAt > 0 || sim.phase === 'auto' || sim.phase === 'transition' || sim.phase === 'teleop';
/** Closes the review and lets the MATCH run. */
function goLive() { review.exit(); livePaused = false; view.exitFreeLook(); }
review.onEnd = () => { if (running()) goLive(); }; review.onOpen = openReview;
/**
 * The play button. Before the MATCH it starts the MATCH, and during the MATCH it pauses the MATCH or resumes it. In the
 * review it plays the recording, and at the live edge it goes back to live. After the MATCH, it replays the MATCH from
 * the start.
 */
function playPause() {
  if (review.active) { if (running() && review.at >= review.end && !review.isPlaying) goLive(); else review.toggle(); }
  else if (sim.phase === 'pre') startMatch();
  else if (startAt) return;
  else if (running() || sim.mode === 'practice') livePaused = !livePaused;
  else if (review.end >= 0) { openReview(); review.seek(0); review.toggle(); }
}
/** Moves the cursor to the previous stop or the next one. Past the last stop, it goes back to live, or to the end of the recording. */
function skip(dir: -1 | 1) {
  const end = review.end; if (end < 0) return;
  if (dir < 0) { const to = review.prevStop(review.active ? review.at : end); if (!review.active) openReview(); review.seek(to); return; }
  if (!review.active) return; const to = review.nextStop(review.at);
  if (to === null && running()) goLive(); else review.seek(to ?? end);
}
/** Binds a control bar button. The button gives up the focus, so that Space and the arrow keys don't press it again. */
const bind = (id: string, fn: () => void) => { const el = $<HTMLButtonElement>(id); el.onclick = () => { fn(); el.blur(); paintTransport(); }; };
bind('tplay', playPause); bind('tprev', () => skip(-1)); bind('tnext', () => skip(1)); bind('treset', stopMatch); bind('tlive', goLive);
// A drag back from the live edge opens the review. The thumb can't go past the newest frame. Letting go at the live edge
// of a running MATCH goes back to live.
const scrub = $<HTMLInputElement>('scrub');
scrub.oninput = () => {
  const end = review.end, i = review.frameAt(Number(scrub.value)); if (end < 0) return;
  if (!review.active) { if (i >= end) { review.paintTrack(); return; } openReview(); }
  review.seek(i);
};
scrub.onchange = () => { if (review.active && running() && review.at >= review.end) goLive(); scrub.blur(); paintTransport(); };
$('rspeed').onchange = () => $('rspeed').blur();
// The game setup and the help are modals. The close button, a click on the scrim, or Esc closes them.
function closeModals() { for (const id of ['setup', 'helpbox', 'keybinds']) $(id).classList.add('hidden'); }
const toggleModal = (id: string) => { const open = $(id).classList.contains('hidden'); closeModals(); $(id).classList.toggle('hidden', !open); };
bind('tsetup', () => toggleModal('setup')); bind('thelp', () => toggleModal('helpbox'));
for (const id of ['setup', 'helpbox', 'keybinds']) $(id).addEventListener('click', e => { const t = e.target as HTMLElement; if (t === $(id) || t.closest('[data-close]')) closeModals(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

// ---------- key binding panel ----------
let rebindingAction: keyof KeyBindings | null = null;

function paintKeyBindings() {
  const b = getBindings();
  const rows = (Object.keys(DEFAULT_BINDINGS) as (keyof KeyBindings)[]).map(action => {
    const active = rebindingAction === action;
    return `<tr data-action="${action}" style="cursor:pointer;background:${active ? 'rgba(77,125,255,.25)' : 'transparent'}">
      <td style="padding:4px 6px;color:var(--dim)">${BINDING_LABELS[action]}</td>
      <td style="padding:4px 6px;text-align:right"><kbd style="background:#232831;border:1px solid var(--line);border-radius:4px;padding:1px 7px;font:12px ui-monospace,monospace;color:${active ? 'var(--blue)' : 'var(--fg)'}">${active ? 'press a key…' : codeLabel(b[action])}</kbd></td>
    </tr>`;
  }).join('');
  $('kbtable').innerHTML = rows;
  $('kbtable').querySelectorAll<HTMLTableRowElement>('tr[data-action]').forEach(row => {
    row.onclick = () => { rebindingAction = row.dataset.action as keyof KeyBindings; paintKeyBindings(); };
  });
}

// Listen for the rebind key press
addEventListener('keydown', e => {
  if (!rebindingAction) return;
  if (e.key === 'Escape') { rebindingAction = null; paintKeyBindings(); return; }
  e.preventDefault(); e.stopPropagation();
  const next = { ...getBindings(), [rebindingAction]: e.code };
  setBindings(next); rebindingAction = null; paintKeyBindings();
}, true);

$('openkeybinds').onclick = () => { closeModals(); paintKeyBindings(); $('keybinds').classList.remove('hidden'); };
$('kbreset').onclick = () => { setBindings({ ...DEFAULT_BINDINGS }); paintKeyBindings(); };
$('keybinds').addEventListener('click', e => { const t = e.target as HTMLElement; if (t === $('keybinds') || t.closest('[data-close]')) closeModals(); });
// The score table under the bar opens and closes. This browser keeps the choice.
let scoreOpen = true; try { scoreOpen = localStorage.getItem('biobuzz.score') !== 'off'; } catch { /* Storage is a convenience. */ }
bind('tscore', () => { scoreOpen = !scoreOpen; try { localStorage.setItem('biobuzz.score', scoreOpen ? 'on' : 'off'); } catch { /* Storage is a convenience. */ } $('left').classList.toggle('hidden', !scoreOpen); paintTree(); });
/** Shows a message at the bottom edge for 4 s. At most three show at a time. */
function toast(text: string, cls = '') {
  const box = $('toasts'), el = document.createElement('div'); el.textContent = text; el.className = cls; box.append(el);
  while (box.children.length > 3) box.firstElementChild!.remove();
  setTimeout(() => el.classList.add('out'), 3500); setTimeout(() => el.remove(), 4000);
}
/** Draws the control bar: the timeline, the time at the cursor, and each button's state. */
function paintTransport() {
  review.paintTrack();
  const live = running(), pre = sim.phase === 'pre' && !startAt;
  if (!review.active) $('scrubtime').textContent = pre ? 'Ready' : startAt ? 'Starting' : `${{ auto: 'AUTO', transition: 'TRANSITION', teleop: 'TELEOP', post: 'FINAL', pre: '' }[sim.phase]} ${fmt(sim.timer)}`;
  const on = review.active ? review.isPlaying : live && !livePaused, play = $('tplay'), label = on ? 'Pause' : pre ? 'Start the MATCH' : 'Play';
  play.classList.toggle('on', on); play.title = `${label} (Space)`; play.setAttribute('aria-label', label);
  const pill = $('tlive'); pill.classList.toggle('hidden', !live); pill.classList.toggle('behind', review.active);
  pill.querySelector('span')!.textContent = review.active ? 'Go live' : livePaused ? 'Paused' : 'Live';
  // A live MATCH runs at 1x. The speed applies to the recording.
  const speed = $<HTMLSelectElement>('rspeed'); speed.disabled = live && !review.active; speed.title = speed.disabled ? 'A live MATCH runs at 1x. The speed applies when you review the recording.' : 'Playback speed of the recording';
  $<HTMLButtonElement>('tprev').disabled = review.end < 0; $<HTMLButtonElement>('tnext').disabled = !review.active;
  const sc = $('tscore'), scLabel = scoreOpen ? 'Hide the score' : 'Show the score'; sc.setAttribute('aria-expanded', String(scoreOpen)); sc.title = scLabel; sc.setAttribute('aria-label', scLabel);
}
camSel.onchange = () => { view.mode = camSel.value as CameraMode; };
for (const el of [modeSel, camSel, refSel, stageSel, opponentsSel]) el.addEventListener('change', () => el.blur());

/** Rotates stick input from the driver's point of view into the frame of robot `i`. */
function fieldCentric(inp: Inputs, i: number): Inputs {
  const v = sim.view(i), side = v.alliance === 'red' ? 1 : -1, f = inp.forward * side, s = inp.strafeRight * side, th = v.heading;
  return { ...inp, forward: f * Math.cos(th) - s * Math.sin(th), strafeRight: f * Math.sin(th) + s * Math.cos(th) };
}

type ScoreKey = Exclude<keyof AllianceScore, 'rp' | 'total'>;
const ROWS: [string, ScoreKey][] = [['LEAVE', 'leave'], ['AUTO PARK', 'autoPark'], ['AUTO TIPS', 'autoTips'], ['TELEOP TIPS', 'teleopTips'], ['In CELL', 'cell'], ['FLOWERS', 'flower'], ['Bottom NECTAR', 'bottomNectar'], ['GARDEN', 'garden'], ['PARK', 'park'], ['Opponent FOULS', 'fouls']];
const RP_ROWS: [string, keyof AllianceScore['rp']][] = [['SWARM RP', 'swarm'], ['POLLINATOR 1 RP', 'pollinator1'], ['POLLINATOR 2 RP', 'pollinator2']];
/** Builds the rows of an FTC-style score table: red at one side, the category in the middle, blue at the other side. A trace without a breakdown shows dashes. */
function scoreRows(r: AllianceScore | null, b: AllianceScore | null, totals: { red: number; blue: number }, final: boolean) {
  const row = (cls: string, n: string, x: string | number, y: string | number) => `<tr class="${cls}"><td class="r">${x}</td><td>${n}</td><td class="b">${y}</td></tr>`;
  let html = row('head', '', 'RED', 'BLUE') + ROWS.map(([n, k]) => row('', n, r?.[k] ?? '–', b?.[k] ?? '–')).join('') + row('total', 'TOTAL', totals.red, totals.blue);
  if (r && b && !sim.options.playoff) {
    html += RP_ROWS.map(([n, k], i) => row(i ? 'rprow' : 'rprow sep', n, r.rp[k] ? '+1' : '', b.rp[k] ? '+1' : '')).join('');
    if (final) {
      const result = (mine: number, theirs: number) => (mine > theirs ? RP.win : mine === theirs ? RP.tie : 0), bonus = (q: AllianceScore) => RP_ROWS.filter(([, k]) => q.rp[k]).length;
      const wr = result(r.total, b.total), wb = result(b.total, r.total), label = r.total === b.total ? 'TIE RP' : 'WIN RP';
      html += row('rprow', label, wr ? `+${wr}` : '', wb ? `+${wb}` : '') + row('total', 'RANKING POINTS', wr + bonus(r), wb + bonus(b));
    }
  }
  return html;
}
// ---------- step settings panel ----------
// Shown when a drive.driveTo step (orange dot) is selected in the AUTO editor.
// If the step is already wrapped in a parallel, reads/writes the siblings directly.
// If bare, wraps it on first change.

let stepSettingsKey = '';

type JsonObj = Record<string, unknown>;

/** Recursively finds the children array that directly contains a node with the given id. */
function findChildrenContaining(obj: unknown, id: string): JsonObj[] | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as JsonObj;
  for (const key of Object.keys(o)) {
    if (key === 'children' && Array.isArray(o[key])) {
      const arr = o[key] as JsonObj[];
      if (arr.some(c => (c as JsonObj).id === id)) return arr;
    }
    const r = findChildrenContaining(o[key], id);
    if (r) return r;
  }
  return null;
}

/**
 * Given a selected path, returns:
 * - driveNodeId: the id of the drive.driveTo node
 * - siblings: the array of children of the parallel wrapper (or null if bare drive)
 * - parentChildren: the array that contains the step (for wrapping)
 * - stepIdx: index of the step in parentChildren
 * - isWrapped: whether already in a parallel
 */
function resolveStepContext(tree: JsonObj, path: string, node: ReturnType<typeof editor.selectedNode>) {
  if (!path) return null;
  const segId = path.split('/').pop()!;

  // Case 1: selected node is a bare drive.driveTo
  if (node?.label === 'drive.driveTo') {
    const parentArr = findChildrenContaining(tree, segId);
    if (!parentArr) return null;
    const idx = parentArr.findIndex(c => (c as JsonObj).id === segId);
    return { driveNodeId: segId, siblings: null as JsonObj[] | null, parentChildren: parentArr, stepIdx: idx, isWrapped: false };
  }

  // Case 2: selected node is a parallel wrapping a drive.driveTo
  if (node?.label === 'parallel') {
    const rawNode = findNode(tree, path) as JsonObj | null;
    if (!rawNode || !('parallel' in rawNode)) return null;
    const par = rawNode.parallel as JsonObj;
    if (!Array.isArray(par.children)) return null;
    const siblings = par.children as JsonObj[];
    const driveChild = siblings.find(c => (c as JsonObj).ref === 'drive.driveTo') as JsonObj | undefined;
    if (!driveChild) return null;
    const parentArr = findChildrenContaining(tree, segId);
    if (!parentArr) return null;
    const idx = parentArr.findIndex(c => (c as JsonObj).id === segId);
    return { driveNodeId: (driveChild.id ?? segId + '-drive') as string, siblings, parentChildren: parentArr, stepIdx: idx, isWrapped: true };
  }

  return null;
}

/** Wraps a bare drive.driveTo in a parallel any and returns the siblings array. */
function wrapInParallel(parentChildren: JsonObj[], stepIdx: number): JsonObj[] {
  const step = parentChildren[stepIdx];
  const stepId = (step as JsonObj).id as string;
  const driveChild = { ...step, id: `${stepId}-drive` };
  const wrapper: JsonObj = { id: stepId, parallel: { policy: 'any', children: [driveChild] } };
  parentChildren[stepIdx] = wrapper;
  return (wrapper.parallel as JsonObj).children as JsonObj[];
}

function paintStepSettings() {
  const node = editor.selectedNode();
  const isDrive = node?.label === 'drive.driveTo' || node?.label === 'parallel';
  const panel = document.getElementById('stepSettings');
  if (!panel) return;

  if (!isDrive || !editor.active || !editor.selected) { panel.classList.add('hidden'); stepSettingsKey = ''; return; }

  // For parallel, only show if it wraps a drive step
  if (node?.label === 'parallel') {
    const t = editor.cloneTree();
    const rawNode = findNode(t, editor.selected) as JsonObj | null;
    const par = rawNode?.parallel as JsonObj | undefined;
    const hasDrive = Array.isArray(par?.children) && (par!.children as JsonObj[]).some(c => (c as JsonObj).ref === 'drive.driveTo');
    if (!hasDrive) { panel.classList.add('hidden'); stepSettingsKey = ''; return; }
  }

  const key = `${editor.def?.id ?? ''}|${editor.selected}|${editor.rev}`;
  if (key === stepSettingsKey) return;
  stepSettingsKey = key;
  panel.classList.remove('hidden');

  // Read current siblings
  const tree = editor.cloneTree();
  const ctx = resolveStepContext(tree, editor.selected, node);
  const siblings: JsonObj[] = ctx?.siblings ?? [];

  const intakeNode  = siblings.find(c => c.ref === 'intake.set' || c.ref === 'intake.run') ?? null;
  const turretNode  = siblings.find(c => c.ref === 'turret.angle') ?? null;
  // Shoot is placed as a separate step after this one in the parent sequence, not inside the parallel
  const stepId = editor.selected!.split('/').pop()!;
  const parentTree = editor.cloneTree();
  const parentArr = findChildrenContaining(parentTree, stepId);
  const parentIdx = parentArr ? parentArr.findIndex(c => (c as JsonObj).id === stepId) : -1;
  const nextStep = parentArr && parentIdx >= 0 ? parentArr[parentIdx + 1] as JsonObj | undefined : undefined;
  const shootNode = (nextStep?.id === `${stepId}-shoot` && nextStep?.ref === 'shooter.shoot') ? nextStep : null;

  const intakeOn     = !!intakeNode;
  const intakeFilter = ((intakeNode?.params as JsonObj)?.filter as string) ?? 'pollen';
  const turretOn     = !!turretNode;
  const turretDeg    = ((turretNode?.params as JsonObj)?.degrees as number) ?? 0;
  const shootOn      = !!shootNode;
  const shootCount   = ((shootNode?.params as JsonObj)?.count as number) ?? 3;
  const shootTimeout = ((shootNode?.params as JsonObj)?.timeoutSec as number) ?? 3;
  const readOnly     = !editor.editing;
  const dis          = readOnly ? 'disabled' : '';
  const stepLabel    = editor.selected.split('/').pop() ?? 'step';

  panel.innerHTML = `
    <h3 style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)">Step settings — ${stepLabel}</h3>
    ${readOnly ? `<p style="color:var(--dim);font-size:11px;margin:0 0 8px">Click <b>Edit</b> in the editor bar to change settings.</p>` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="checkbox" id="ss-intake-on" ${intakeOn ? 'checked' : ''} ${dis}>
      <label for="ss-intake-on" style="font-size:12px;font-weight:600;min-width:44px">Intake</label>
      <select id="ss-intake-filter" style="flex:1;font-size:12px" ${!intakeOn || readOnly ? 'disabled' : ''}>
        <option value="pollen"     ${intakeFilter === 'pollen'     ? 'selected' : ''}>POLLEN only</option>
        <option value="own_nectar" ${intakeFilter === 'own_nectar' ? 'selected' : ''}>Own NECTAR only</option>
        <option value="all"        ${intakeFilter === 'all'        ? 'selected' : ''}>All elements</option>
        <option value="none"       ${intakeFilter === 'none'       ? 'selected' : ''}>Off</option>
      </select>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="checkbox" id="ss-turret-on" ${turretOn ? 'checked' : ''} ${dis}>
      <label for="ss-turret-on" style="font-size:12px;font-weight:600;min-width:44px">Turret</label>
      <input id="ss-turret-deg" type="number" min="-180" max="180" step="5" value="${turretDeg}"
        style="width:64px;font-size:12px" ${!turretOn || readOnly ? 'disabled' : ''}>
      <span style="font-size:11px;color:var(--dim)">° &nbsp;0=fwd · 90=left · −90=right</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="ss-shoot-on" ${shootOn ? 'checked' : ''} ${dis}>
      <label for="ss-shoot-on" style="font-size:12px;font-weight:600;min-width:44px">Shoot</label>
      <input id="ss-shoot-count" type="number" min="1" max="4" step="1" value="${shootCount}"
        style="width:44px;font-size:12px" ${!shootOn || readOnly ? 'disabled' : ''}>
      <span style="font-size:11px;color:var(--dim)">balls,</span>
      <input id="ss-shoot-timeout" type="number" min="0.5" max="10" step="0.5" value="${shootTimeout}"
        style="width:50px;font-size:12px" ${!shootOn || readOnly ? 'disabled' : ''}>
      <span style="font-size:11px;color:var(--dim)">s timeout</span>
    </div>`;

  if (readOnly) return;

  function applySettings() {
    const on_i = (document.getElementById('ss-intake-on')     as HTMLInputElement).checked;
    const filt = (document.getElementById('ss-intake-filter') as HTMLSelectElement).value;
    const on_t = (document.getElementById('ss-turret-on')     as HTMLInputElement).checked;
    const deg  = Number((document.getElementById('ss-turret-deg')     as HTMLInputElement).value);
    const on_s = (document.getElementById('ss-shoot-on')      as HTMLInputElement).checked;
    const cnt  = Number((document.getElementById('ss-shoot-count')    as HTMLInputElement).value);
    const tout = Number((document.getElementById('ss-shoot-timeout')  as HTMLInputElement).value);

    const t   = editor.cloneTree();
    const ctx2 = resolveStepContext(t, editor.selected ?? '', node);
    if (!ctx2) return;

    // Get or create the siblings array
    const sibs: JsonObj[] = ctx2.isWrapped
      ? ctx2.siblings!
      : wrapInParallel(ctx2.parentChildren, ctx2.stepIdx);

    const rm = (ref: string) => { const i = sibs.findIndex(c => c.ref === ref); if (i >= 0) sibs.splice(i, 1); };

    // Intake — use intake.run (same as existing plans), not intake.set, to avoid double-intake conflict
    rm('intake.set'); rm('intake.run');
    if (on_i) sibs.push({ ref: 'intake.run', params: { filter: filt } });

    // Turret — runs in parallel alongside drive
    rm('turret.angle');
    if (on_t) sibs.push({ ref: 'turret.angle', params: { degrees: deg, timeoutSec: 2 } });

    // Shoot — must NOT be in the same parallel as drive (shooter subsystem conflict).
    // Instead the parallel wraps only drive+intake+turret, and shoot is added as
    // a separate step right after in the parent sequence.
    rm('shooter.shoot');

    // If only the drive child remains, unwrap back to a bare step
    if (sibs.length === 1 && (sibs[0] as JsonObj).ref === 'drive.driveTo' && ctx2.isWrapped) {
      const { parentChildren, stepIdx } = ctx2;
      const driveChild = sibs[0];
      const stepId = (parentChildren[stepIdx] as JsonObj).id;
      parentChildren[stepIdx] = { ...driveChild, id: stepId };
    }

    // Handle shoot: add/remove a shoot step immediately after this step in the parent sequence
    const { parentChildren, stepIdx } = ctx2;
    // Find actual step index after possible unwrap
    const currentStepId = editor.selected!.split('/').pop()!;
    const actualIdx = parentChildren.findIndex(c => (c as JsonObj).id === currentStepId);
    const shootIdx = actualIdx + 1;
    // Remove existing shoot step that was added by this panel (tagged with ss-shoot)
    if (shootIdx < parentChildren.length && (parentChildren[shootIdx] as JsonObj).id === `${currentStepId}-shoot`) {
      parentChildren.splice(shootIdx, 1);
    }
    if (on_s) {
      parentChildren.splice(actualIdx + 1, 0, {
        id: `${currentStepId}-shoot`,
        note: 'Shoots after the drive step above. Added by step settings.',
        ref: 'shooter.shoot',
        params: { count: cnt, timeoutSec: tout },
      });
    }

    editor.applyTree(t);
    stepSettingsKey = ''; // force redraw on next paintEditor
  }

  // Checkbox toggles enable/disable dependent fields immediately
  document.getElementById('ss-intake-on')!.onchange = () => {
    (document.getElementById('ss-intake-filter') as HTMLSelectElement).disabled =
      !(document.getElementById('ss-intake-on') as HTMLInputElement).checked;
    applySettings();
  };
  document.getElementById('ss-turret-on')!.onchange = () => {
    (document.getElementById('ss-turret-deg') as HTMLInputElement).disabled =
      !(document.getElementById('ss-turret-on') as HTMLInputElement).checked;
    applySettings();
  };
  document.getElementById('ss-shoot-on')!.onchange = () => {
    const on = (document.getElementById('ss-shoot-on') as HTMLInputElement).checked;
    (document.getElementById('ss-shoot-count')   as HTMLInputElement).disabled = !on;
    (document.getElementById('ss-shoot-timeout') as HTMLInputElement).disabled = !on;
    applySettings();
  };
  for (const id of ['ss-intake-filter', 'ss-turret-deg', 'ss-shoot-count', 'ss-shoot-timeout']) {
    const el = document.getElementById(id)!;
    el.onchange = applySettings;
    for (const ev of ['keydown', 'keyup']) el.addEventListener(ev, e => e.stopPropagation());
  }
}

// ---------- field editor ----------
$('aedone').onclick = () => { closeNewPlan(); editor.close(); }; $('aeundo').onclick = () => editor.undo(); $('aeredo').onclick = () => editor.redo();
$('aehelp').onclick = () => { editor.close(); toggleModal('helpbox'); // scroll to the AUTO section
  setTimeout(() => { const el = $('helpbox').querySelector('h2:last-of-type'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 80); };
// The snap checkbox is a convenience that this browser keeps. The reference point under the pointer shows its name.
const snapBox = $<HTMLInputElement>('aesnap');
try { snapBox.checked = localStorage.getItem('biobuzz.snap') === 'on'; } catch { /* Storage is a convenience. */ }
editor.snapGrid = snapBox.checked;
snapBox.onchange = () => { editor.snapGrid = snapBox.checked; try { localStorage.setItem('biobuzz.snap', snapBox.checked ? 'on' : 'off'); } catch { /* Storage is a convenience. */ } snapBox.blur(); };
editor.hoverRef = (ref, x, y) => { const tip = $('aehover'); tip.classList.toggle('hidden', !ref); if (ref) { tip.textContent = ref.name; tip.style.left = `${x + 12}px`; tip.style.top = `${y + 10}px`; } };
// Undo and redo keys, and Delete for a selected offset line or reference point, while you edit a plan. They leave text
// fields to the browser, and CodeMirror's expression fields, which are contenteditable, to CodeMirror.
addEventListener('keydown', e => {
  if (!editor.active || !editor.editing || (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedLink) { e.preventDefault(); editor.deleteLink(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedRef) { e.preventDefault(); editor.deleteRef(); return; }
  const z = e.key === 'z' || e.key === 'Z';
  if ((e.metaKey || e.ctrlKey) && z) { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
  else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); editor.redo(); }
}, true); $('aereset').onclick = () => editor.resetSelected(); $('aeedit').onclick = () => editor.edit();
$('aedelete').onclick = () => { const d = editor.def; if (d && confirm(`Delete the plan "${d.name}"? This browser keeps no other copy of it.`)) editor.deletePlan(); };
// The new-plan dialog asks for the plan to copy (or blank), a name, and a description, and the editor checks them.
const newPlan = { mode: $<HTMLSelectElement>('aemode'), fromRow: $('aefromrow'), from: $<HTMLSelectElement>('aefrom'), name: $<HTMLInputElement>('aename'), desc: $<HTMLTextAreaElement>('aedesc') };
for (const el of [newPlan.from, newPlan.name, newPlan.desc]) for (const ev of ['keydown', 'keyup']) el.addEventListener(ev, e => e.stopPropagation());
function closeNewPlan() { $('aenew').classList.add('hidden'); }
newPlan.mode.onchange = () => { newPlan.fromRow.classList.toggle('hidden', newPlan.mode.value === 'blank'); };
$('aecreate').onclick = () => {
  const current = editor.def?.id ?? '', esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  newPlan.from.innerHTML = editor.sources().map(s => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  newPlan.mode.value = 'copy'; newPlan.fromRow.classList.remove('hidden');
  newPlan.name.value = ''; newPlan.desc.value = ''; $('aeerr').textContent = ''; $('aenew').classList.remove('hidden'); newPlan.name.focus();
};
$('aecancel').onclick = closeNewPlan;
$('aemake').onclick = () => {
  const err = newPlan.mode.value === 'blank'
    ? editor.createBlank(newPlan.name.value, newPlan.desc.value)
    : editor.create(newPlan.from.value, newPlan.name.value, newPlan.desc.value);
  $('aeerr').textContent = err ?? ''; if (!err) closeNewPlan();
};
// In the editor, a click on a step in the tree view selects it, and its handles on the FIELD light up.
// The definitions and constants at the root are groups that open and close. A click on a definition selects it.
$('treebody').addEventListener('click', e => {
  if (!editor.active) return; const t = e.target as HTMLElement;
  const grp = t.closest<HTMLElement>('.tv[data-grp]'); if (grp) { const k = grp.dataset.grp as 'defs' | 'constants'; treePanel.open[k] = !treePanel.open[k]; paintTree(); return; }
  const d = t.closest<HTMLElement>('.tv[data-def]'); if (d) { editor.selectRef(d.dataset.def!); return; }
  if (t.closest('.tv[data-adddef]')) { editor.startAddDef(); return; }
  const row = t.closest<HTMLElement>('.tv[data-path]'); if (row) editor.select(row.dataset.path!);
});
// The settings panel: the plan's problems, the selected step's parameters, and the definitions.
const inspector = new Inspector($('aeinsp'), {
  setParam: (path, key, text) => editor.setParamText(path, key, text),
  setDef: (name, text) => editor.setDefText(name, text),
  addDef: (name, text) => editor.addDefinition(name, text),
  cancelAdd: () => editor.cancelAddDef(),
  deleteDef: name => editor.deleteRef(name),
  selectNode: path => editor.select(path),
  selectDef: name => editor.selectRef(name),
});
/** Draws the editor bar: the tree, the selected step's pose, and the buttons. */
function paintEditor() {
  document.body.classList.toggle('editing', editor.active); $('autoedit').classList.toggle('hidden', !editor.active);
  // The settings panel closes with the editor. It opens again below, when there is a plan to show.
  if (!editor.active) { $('aeinsp').classList.add('hidden'); $('stepSettings').classList.add('hidden'); $('stepOrder').classList.add('hidden'); stepSettingsKey = ''; stepOrderKey = ''; return; }
  const def = editor.def, plate = bots[editor.robot].plate, wrong = editor.wrongStart;
  $('aehead').textContent = `${plate} · ${def?.name ?? 'No AUTO plan'}`;
  const status = $('aestatus'); status.classList.toggle('warn', !!wrong);
  const n = editor.changed.size, r = editor.changedRefs.size, parts = [n ? `${n} step${n === 1 ? '' : 's'}` : '', r ? `${r} definition${r === 1 ? '' : 's'}` : ''].filter(Boolean);
  const changes = parts.length ? ` · ${parts.join(' and ')} changed` : '';
  const bad = editor.problems.count, problems = bad ? ` · ${bad} problem${bad === 1 ? '' : 's'}: it doesn't run` : '';
  status.classList.toggle('warn', !!wrong || bad > 0);
  status.textContent = !def ? '' : wrong ? `This plan is for the ${wrong} start position.` : editor.isUserPlan ? `${editor.editing ? 'Your plan · editing' : 'Your plan'}${changes}${problems}` : 'System plan · read-only';
  const insp = $('aeinsp'); insp.classList.toggle('hidden', !def);
  if (def) inspector.paint({ editing: editor.editing, problems: editor.problems, path: editor.selected, node: editor.selectedNode(), fields: editor.fields(), def: editor.selectedDef(), adding: editor.addingDef, ctx: before => editor.exprContext(before), valueOf: path => editor.valueOf(path) },
    `${def.id}:${editor.robot}|${editor.rev}|${editor.selected}|${editor.editing}|${editor.selectedRef}|${editor.addingDef}`);

  // Step settings panel: shown when a drive.driveTo step (orange dot) is selected
  paintStepSettings();

  $<HTMLButtonElement>('aeundo').disabled = !editor.canUndo; $<HTMLButtonElement>('aeredo').disabled = !editor.canRedo;
  $('aeframe').textContent = 'Red alliance frame: +x toward the blue wall, +y toward the rear wall. Blue robots run this tree rotated 180°.';
  // The bar cuts long lines short, so each line's tooltip holds the whole text.
  for (const [id, text] of [['aeframe', $('aeframe').textContent ?? ''], ['aesel', editor.describe((x, y) => fmtPos(x, y, units))]] as const) { $(id).textContent = text; $(id).title = text; }
  $<HTMLButtonElement>('aereset').disabled = !editor.selectedEdited();
  const edit = $<HTMLButtonElement>('aeedit'); edit.disabled = !editor.isUserPlan || editor.editing;
  edit.title = editor.isUserPlan ? 'Lets you drag the poses of this plan.' : 'System plans are read-only. Create a copy to change it.';
  $<HTMLButtonElement>('aedelete').disabled = !editor.isUserPlan;

  // Step order panel: shows the root sequence when editing a user plan
  paintStepOrder();
}

let stepOrderKey = '';
function paintStepOrder() {
  const panel = $('stepOrder'); if (!panel) return;
  if (!editor.active || !editor.editing || !editor.isUserPlan) { panel.classList.add('hidden'); stepOrderKey = ''; return; }
  const key = `${editor.def?.id ?? ''}|${editor.rev}|${editor.selected}`;
  if (key === stepOrderKey) return;
  stepOrderKey = key;
  const steps = editor.rootSteps();
  if (!steps.length) {
    panel.classList.remove('hidden');
    panel.innerHTML = `<h3 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)">Steps</h3><p style="color:var(--dim);margin:0;font-size:11px">No steps yet. Right-click a reference point to add a drive step.</p>`;
    return;
  }
  panel.classList.remove('hidden');
  const rows = steps.map(s => {
    const isSel = editor.selected === s.path;
    const shortLabel = s.label.replace('drive.driveTo', '→ drive to').replace('shooter.shoot', '⬤ shoot').replace('intake.run', '◎ intake').replace('wait', '⏱ wait');
    return `<div class="step-row${isSel ? ' sel' : ''}" data-idx="${s.index}" data-path="${s.path}" style="display:flex;align-items:center;gap:4px;padding:2px 0;cursor:pointer;border-radius:3px${isSel ? ';background:rgba(255,167,38,.22)' : ''}">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:${isSel ? '#ffd54f' : 'var(--fg)'}" title="${s.id}: ${s.label}">${s.id} <span style="color:var(--dim)">${shortLabel}</span></span>
      <button data-move="-1" data-idx="${s.index}" title="Move up" style="width:18px;height:18px;padding:0;font-size:10px;margin:0;border-radius:3px;flex-shrink:0">↑</button>
      <button data-move="1" data-idx="${s.index}" title="Move down" style="width:18px;height:18px;padding:0;font-size:10px;margin:0;border-radius:3px;flex-shrink:0">↓</button>
      <button data-del="${s.index}" title="Remove step" style="width:18px;height:18px;padding:0;font-size:11px;margin:0;border-radius:3px;flex-shrink:0;color:#ff8a80">✕</button>
    </div>`;
  }).join('');
  panel.innerHTML = `<h3 style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)">Steps (${steps.length})</h3>${rows}`;
  panel.querySelectorAll<HTMLElement>('.step-row').forEach(row => {
    row.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('button')) return;
      const path = row.dataset.path; if (path) editor.select(path);
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('button[data-move]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); const err = editor.moveStepAt(Number(btn.dataset.idx), Number(btn.dataset.move) as -1 | 1); if (err) toast(err); });
  });
  panel.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); const err = editor.removeStepAt(Number(btn.dataset.del)); if (err) toast(err); });
  });
}

// The tree view sits under the dock, so it moves when the dock changes size: when the score table fills on the first
// frame, or when the score opens or closes.
new ResizeObserver(() => paintTree()).observe($('dock'));
/** Draws the tree view for the chosen robot: live during a match, and at the cursor in the review. */
function paintTree() {
  const el = $('tree'), on = treeSel.value === 'on' || editor.active; el.classList.toggle('hidden', !on);
  if (!editor.active) { view.insetLeft = 0; view.insetRight = 0; }
  if (!on) return;
  const i = treeRobot >= 0 ? treeRobot : focus(), plate = bots[i].plate;
  // The buttons are built in one place and only when they change: a button that is replaced between the press and the
  // release of a click never receives the click. In the editor they are the two red robots, in the order that the
  // drivers see them on the FIELD: R1 starts on the left, and R0 on the right.
  const order = editor.active ? [1, 0] : [0, 1, 2, 3], picked = editor.active ? editor.robot : i;
  const botsKey = `${editor.active ? 'edit' : 'view'}:${picked}:${bots.map(b => b.plate).join(',')}`;
  if (botsKey !== treeBotsKey) {
    treeBotsKey = botsKey;
    $('treebots').innerHTML = order.map(k => `<button data-k="${k}" class="${k === picked ? 'on' : ''}" style="border-color:var(--${k < 2 ? 'red' : 'blue'})">${bots[k].plate}</button>`).join('');
  }
  // The panel fills the space under the control bar and the score, down to the editor bar or the bottom edge.
  el.style.top = `${$('dock').getBoundingClientRect().bottom + 8}px`; el.style.bottom = editor.active ? `${innerHeight - $('autoedit').getBoundingClientRect().top + 8}px` : '12px';
  if (editor.active) {
    // The overhead view keeps the FIELD clear of this panel, because the rear-side plans run under it.
    view.insetLeft = el.getBoundingClientRect().right + 8;
    const insp = $('aeinsp'); view.insetRight = insp.classList.contains('hidden') ? 0 : innerWidth - insp.getBoundingClientRect().left + 8;
    treePanel.paint(`${bots[editor.robot].plate} · AUTO plan`, editor.def, { running: new Set(), last: new Map() }, 'This robot runs no AUTO plan.', editor.treeEdit());
    return;
  }
  const cur = review.cursor, human = bots[i].driver !== 'planner';
  if (cur) {
    const at = treeStateAt(cur.trace, cur.index, i), def = at ? AUTO_TREES[at.tree] ?? TELEOP_TREES[at.tree] ?? null : null;
    treePanel.paint(`${plate} · ${def?.name ?? 'Tree'} · at the cursor`, def, at?.state ?? null, at ? `This trace names the tree ${at.tree}, which this version doesn't have.` : 'No tree ran at this moment, or the trace predates tree recording.');
    return;
  }
  if (human && (sim.phase === 'teleop' || sim.phase === 'post')) { treePanel.paint(`${plate} · Tree`, null, null, 'A person drives this robot in TELEOP.'); return; }
  const t = coaches[i]?.currentTree();
  if (!t) { treePanel.paint(`${plate} · Tree`, null, null, 'The tree starts with the MATCH.'); return; }
  treePanel.paint(`${plate} · ${t.period === 'auto' ? 'AUTO' : 'TELEOP'} · ${t.def.name}`, t.def, liveTrees[i].read(t.recorder));
}

function hud(pad: Frame['pad']) {
  paintTree();
  // In the review, the scoreboard, the clock, and the score table show the trace frame at the cursor.
  const f = review.frame, r = f ? f.scores?.red ?? null : sim.score('red'), b = f ? f.scores?.blue ?? null : sim.score('blue');
  const totals = f ? f.score : { red: r!.total, blue: b!.total }, phase = (f ? f.phase : sim.phase) as Sim['phase'], clock = f ? f.clock : sim.timer;
  $('sred').textContent = String(totals.red); $('sblue').textContent = String(totals.blue);
  $('clock').textContent = f ? clockText(clock) : fmt(clock);
  const flowersOpen = f ? phase === 'teleop' && clock <= 60 : sim.flowersUnlocked;
  $('phase').textContent = { pre: 'Ready', auto: 'AUTO', transition: 'Transition', teleop: sim.mode === 'practice' ? 'Practice' : flowersOpen ? 'TELEOP · FLOWERS open' : 'TELEOP', post: 'Final' }[phase];
  document.body.classList.toggle('playing', !f && (sim.phase === 'auto' || sim.phase === 'transition' || sim.phase === 'teleop' || startAt > 0));
  document.body.classList.toggle('paused', livePaused);
  $('scoretable').innerHTML = scoreRows(r, b, totals, phase === 'post');
  // At the end of the MATCH, a results card shows the final score, the breakdown, and the ranking points.
  const showFinal = !f && sim.phase === 'post' && !finalClosed; $('final').classList.toggle('hidden', !showFinal); $('left').classList.toggle('hidden', showFinal || !scoreOpen);
  if (showFinal && r && b && $('final').dataset.key !== `${r.total}-${b.total}`) {
    const win = r.total > b.total ? 'RED WINS' : b.total > r.total ? 'BLUE WINS' : 'TIE', bg = r.total > b.total ? 'var(--red)' : b.total > r.total ? 'var(--blue)' : '#5b6370';
    $('final').dataset.key = `${r.total}-${b.total}`;
    $('final').innerHTML = `<div class="win" style="background:${bg}">${win}</div><div class="big"><div style="background:var(--red)">${r.total}</div><div style="background:var(--blue)">${b.total}</div></div>` +
      `<div class="body"><table class="ftc">${scoreRows(r, b, totals, true)}</table><div class="btns"><button id="freview" class="primary">Review and annotate (V)</button><button id="fclose">Close</button></div><div style="color:var(--dim);margin-top:6px;text-align:center">Press R to reset the field.</div></div>`;
    $('freview').onclick = openReview; $('fclose').onclick = () => { finalClosed = true; };
  }
  $('pad').textContent = (() => { const who = bots.find(q => q.driver === 'pad1'); return `Controller: ${pad ? pad.id.slice(0, 28) : 'not connected'}${who ? `, drives ${who.plate}` : ''}`; })();
  // Persistent status bar: single controller + keyboard + who drives what
  const sb = $('statusbar');
  const kbDriver = bots.find(b => b.driver === 'keyboard');
  const kbActive = keyboardActive();
  const items: string[] = [];
  const ctrlWho = bots.find(b => b.driver === 'pad1');
  const dotCls = pad ? 'dot-ok' : 'dot-off', labelCls = pad ? 'ok' : '';
  const ctrlLabel = pad ? pad.id.slice(0, 28) : 'not connected';
  const ctrlDrives = ctrlWho ? ` → <b>${ctrlWho.plate}</b>` : '';
  items.push(`<span class="sb-item"><span class="sb-dot ${dotCls}"></span><span class="${labelCls}">Controller: ${ctrlLabel}${ctrlDrives}</span></span>`);
  const kbDotCls = kbActive ? 'dot-kb' : (kbDriver ? 'dot-ok' : 'dot-off');
  const kbLabel = kbDriver ? ` → <b>${kbDriver.plate}</b>` : ' (not assigned)';
  const kbCls = kbDriver ? 'ok' : '';
  items.push(`<span class="sb-item"><span class="sb-dot ${kbDotCls}"></span><span class="${kbCls}">Keyboard WASD${kbLabel}</span></span>`);
  sb.innerHTML = items.join('<span style="color:var(--line)">|</span>');
  const humans = bots.filter(q => q.driver !== 'planner').map(q => q.plate), who = humans.length ? `Drivers of ${humans.join(' and ')}, you have the controls. The planner drives the other robots.` : 'The planner drives every robot.';
  const text = loadMsg ?? (startAt ? 'This MATCH begins in 3, 2, 1…'
    : sim.phase === 'pre' ? `Press Play or Enter to begin<small>Click a gear icon or right-click a robot to configure it.${pathsSel.value === 'on' ? ` The dashed orange line is the AUTO plan of ${bots[focus()].plate}.` : ''}</small>`
    : sim.phase === 'transition' ? `Drivers, pick up your controllers<small>${who}</small>`
    : null);
  banner.classList.toggle('hidden', !text || editing >= 0 || editor.active); if (text) banner.innerHTML = text;
  // The scoreboard moves right when, centered, it would reach the control bar.
  document.body.classList.toggle('narrow', innerWidth / 2 - $('top').offsetWidth / 2 < $('dock').getBoundingClientRect().right + 12);
  paintTransport();
}

/**
 * In the editor, shows a see-through robot at the selected point, and runs another one along the path into the point and
 * out of it. The preview has a pose for each handle, in the same order, and `ends` marks where the path reaches each.
 */
function paintGhost(me: Sim, plan: ReturnType<typeof previewAuto> | null) {
  const i = editor.point;
  if (!editor.active || !plan || i < 0 || plan.poses.length !== editor.handles.length) { view.showGhost(null, null); return; }
  // Headings turn evenly by distance between two poses, the short way.
  const ramp = (pts: { x: number; z: number }[], h0: number, h1: number) => {
    const d = pts.map((_, k) => (k ? Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z) : 0)), total = d.reduce((a, b) => a + b, 0) || 1, dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    let run = 0; return pts.map((q, k) => { run += d[k]; return { x: q.x, z: q.z, heading: h0 + (dh * run) / total }; });
  };
  const at = plan.poses[i], from = i ? plan.ends[i - 1] : 0, to = plan.ends[i], next = plan.ends[i + 1];
  const into = ramp(plan.path.slice(from, to + 1), i ? plan.poses[i - 1].heading : me.heading, at.heading);
  const out = next === undefined ? [] : ramp(plan.path.slice(to, next + 1), at.heading, plan.poses[i + 1].heading);
  view.showGhost({ x: at.x, z: at.z, heading: at.heading }, me.cfg, into, out);
}

let last = performance.now(), acc = 0, frame = 0, autoPlan: ReturnType<typeof previewAuto> | null = null, autoPlanKey = '';
function tick(now: number) {
  const frameDt = (now - last) / 1000; acc = Math.min(acc + frameDt, 0.05); last = now;
  const inF = readInput();
  if (inF.reset) reset(); if (inF.start) startMatch();
  if (inF.mark && recorder.trace.frames.length) { const fr = recorder.trace.frames[recorder.trace.frames.length - 1]; review.mark(recorder.trace, fr.t); }
  if (inF.review) { if (review.active) goLive(); else openReview(); }
  if (inF.play) playPause();
  // The arrows serve three masters, by context: while paused they pan and zoom the camera; in TELEOP with a keyboard
  // driver they steer the turret (only while the turret is bound to them); otherwise they skip timeline marks.
  const b = getBindings(), kbTeleop = sim.phase === 'teleop' && bots.some(bot => bot.driver === 'keyboard');
  const leftTurret = kbTeleop && b.turretLeft === 'ArrowLeft', rightTurret = kbTeleop && b.turretRight === 'ArrowRight';
  if (livePaused) {
    if (inF.prev) view.adjustView('ArrowLeft');
    if (inF.next) view.adjustView('ArrowRight');
    if (inF.camUp) view.adjustView('ArrowUp');
    if (inF.camDown) view.adjustView('ArrowDown');
  } else {
    if (inF.prev && !leftTurret) skip(-1);
    if (inF.next && !rightTurret) skip(1);
  }
  if (sim.phase === 'post' && !traceSaved) { traceSaved = true; void saveTrace(); void countMatch(); }
  if (review.active) { review.tick(frameDt); acc = 0; if (frame++ % 6 === 0) hud(inF.pad); requestAnimationFrame(tick); return; }
  if (startAt && now >= startAt) { startAt = 0; sim.start(); }
  for (const e of sim.events.splice(0)) audio.play(e);
  if (inF.camera) { view.cycleCamera(); camSel.value = view.mode; }
  const fi = focus();
  if (livePaused) acc = 0;
  while (acc >= DT) {
    // AUTO always runs the robot's script (G401 allows no driver input). In TELEOP, a controller or the planner drives.
    const inAuto = sim.phase === 'auto', inputs: Inputs[] = [], flags: boolean[] = [], drivers: (Coach | null)[] = [];
    bots.forEach((b, i) => {
      if (i >= sim.robots.length) return; // robot not on field for this opponent count
      const human = !inAuto && b.driver !== 'planner', pad = human ? (b.driver === 'keyboard' ? inF.keyboard : inF.pad?.inputs ?? NO_INPUT) : NO_INPUT;
      if (human) inputs.push(b.stickFrame === 'field' ? fieldCentric(pad, i) : pad); else inputs.push(inAuto && b.auto === 'none' ? NO_INPUT : coaches[i].update(sim.view(i), DT));
      flags.push(!human); drivers.push(human ? null : coaches[i]);
    });
    sim.step(inputs, flags); referee?.update(sim, DT); recorder.record(sim, drivers, DT); acc -= DT;
  }
  // Each FOUL gets a note on the robot that it was called on, so that the timeline marks it.
  for (; referee && callsSeen < referee.calls.length; callsSeen++) {
    const c = referee.calls[callsSeen], fr = recorder.trace.frames[recorder.trace.frames.length - 1]; if (!fr) continue;
    review.mark(recorder.trace, fr.t, `REFEREE: ${c.kind} FOUL, ${c.rule}. ${bots[c.pinner].plate} pinned ${bots[c.victim].plate}.`, BOT_IDS[c.pinner]);
  }
  // Referee calls and rule messages, such as G410, show as toasts. The sim's other messages don't show.
  for (const m of sim.messages) if (!toasted.has(m)) { toasted.add(m); if (/^(REFEREE:|G\d{3})/.test(m.text)) toast(m.text, 'ref'); }
  // The shot preview and the planned path belong to the focus robot. A human driver gets the preview, and a program gets the path.
  const me = sim.view(fi), humanNow = bots[fi].driver !== 'planner' && sim.phase !== 'auto', next = me.carried[0], dual = me.cfg.shooter.type === 'dual';
  const kind = !next ? null : dual ? (me.carried.includes('pollen') ? 'pollen' : 'nectar') : next === 'pollen' ? 'pollen' : 'nectar';
  const paths = pathsSel.value === 'on';
  const showTraj = trajSel.value === 'on';
  // Show the trajectory arc for a human driver whenever trajectory is enabled, before and during the match.
  const previewKind = showTraj && humanNow ? kind : null;
  view.sync(me, previewKind, humanNow || !paths ? null : sim.phase === 'auto' ? coaches[fi].auto?.path ?? null : coaches[fi].executor.path);
  // Project the focus robot's AUTO trajectory onto the FIELD before and during AUTO.
  // In the field editor, the plan is the edited robot's, and it redraws after each edit.
  const pi = editor.active ? editor.robot : fi, pv = sim.view(pi);
  const name = bots[pi].auto === 'default' ? autoFor(pv, SOLO_AUTO) : bots[pi].auto, tree = AUTO_TREES[name], showPlan = !!tree && (editor.active || (paths && (sim.mode === 'full' || sim.mode === 'auto') && (sim.phase === 'pre' || sim.phase === 'auto')));
  if (showPlan && sim.phase === 'pre') { const key = `${name}:${pi}:${seed}:${editor.rev}`; if (key !== autoPlanKey) { const p = pv.robot.translation(); autoPlan = previewAuto(tree, pv, { x: p.x, z: p.z }); autoPlanKey = key; } }
  view.showAutoPlan(showPlan ? autoPlan : null, autoPlanKey);
  paintGhost(pv, showPlan ? autoPlan : null);
  if (frame++ % 6 === 0) hud(inF.pad);
  requestAnimationFrame(tick);
}
void CAMERAS; requestAnimationFrame(tick);
