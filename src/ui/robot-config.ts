/**
 * The robot cards in the game setup, the plates in the scoreboard, and the robot config popup. Every MATCH has two full
 * alliances, R0, R1, B0, and B1, and each robot has its own setup. Importing a Pedro Pathing OpMode makes a new AUTO
 * plan for a red robot.
 */
import { AUTO_PROBLEMS, AUTO_TREES, addAutoTree, autoStart } from '../auto/onboard';
import { importPedroProject, listPedroOpModes, type PedroJavaFile } from '../auto/pedro';
import { BOT_IDS, MAIN_ROBOT_INDEX, REF_ERR, assignDriver, defaultBot, teamBot, describe, describeLines, metaBot, sanitize, saveBots, startSide, type BotSetup, type DriverKind } from '../setup';
import { TIERS } from '../tournament';
import { massFromInput, massToInput, sizeFromInput, sizeToInput, speedFromInput, speedToInput } from '../units';
import { saveUserTree } from '../user-trees';
import { app, entrant, openEditor, reset } from './app';
import { $, closeModals, ownKeys, toast } from './dom';

const bc = {
  plate: $<HTMLInputElement>('bcplate'), driver: $<HTMLSelectElement>('bcdriver'), drive: $<HTMLSelectElement>('bcdrive'), shooter: $<HTMLSelectElement>('bcshooter'),
  auto: $<HTMLSelectElement>('bcauto'), plan: $<HTMLSelectElement>('bcplan'), rpm: $<HTMLInputElement>('bcrpm'), size: $<HTMLInputElement>('bcsize'), mass: $<HTMLInputElement>('bcmass'),
  intake: $<HTMLSelectElement>('bcintake'), ends: $<HTMLSelectElement>('bcends'), turretRange: $<HTMLInputElement>('bcturretrange'), turretSlew: $<HTMLInputElement>('bcturretslew'),
  defense: $<HTMLSelectElement>('bcdefense'), elev: $<HTMLInputElement>('bcelev'), azim: $<HTMLInputElement>('bcazim'), speed: $<HTMLInputElement>('bcspeed'), intakeP: $<HTMLInputElement>('bcintakep'),
};
const EDIT_TIP = $('bcedit').title;

/** Lists the AUTO plans for one start position. A plan named for the other position starts from the wrong wall, so the list leaves it out. */
function autoOptions(i: number) {
  const side = startSide(i), other = side === 'right' ? 'left' : 'right';
  return `<option value="default">Default: wall-sweep pair, ${side} robot</option>` +
    Object.entries(AUTO_TREES).filter(([, d]) => autoStart(d) !== other).map(([k, d]) => `<option value="${k}" title="${d.description ?? ''}">${d.name}${AUTO_PROBLEMS[k] ? ' (has problems, doesn\'t run)' : ''}</option>`).join('') +
    '<option value="none">None</option>';
}
const gear = (i: number) => `<button class="gear" data-bot="${i}" title="Robot config for ${app.bots[i].plate}">&#9881;</button>`;
const badge = (i: number) => (i === MAIN_ROBOT_INDEX ? '<span class="you">You</span>' : '');

/** Draws the robot rows in the scoreboard and the robot cards in the game setup. Called when a setup changes, not on every frame, so that the buttons stay clickable. */
export function paintBots() {
  const t = app.bracket;
  document.body.classList.toggle('paused', app.livePaused);
  $('tred').innerHTML = [0, 1].map(i => `<div>${app.bots[i].plate}${badge(i)}${gear(i)}</div>`).join('');
  $('tblue').innerHTML = [2, 3].map(i => `<div>${entrant(i).plate}${t ? '' : gear(i)}</div>`).join('');
  $('botlist').innerHTML = BOT_IDS.map((_, i) => {
    const b = entrant(i), side = i < 2 ? 'red' : 'blue';
    return `<div class="bot ${side}" data-bot="${i}" title="${describe(b, app.units)}"><div class="bothead"><b class="${side}">${b.plate}</b>${badge(i)}<span>${BOT_IDS[i]} · ${startSide(i)} start</span>${gear(i)}</div><div class="botdesc">${describeLines(b, app.units).map(l => `<div>${l}</div>`).join('')}</div></div>`;
  }).join('');
  document.querySelectorAll<HTMLElement>('button.gear, #botlist .bot').forEach(el => { el.onclick = e => { e.stopPropagation(); openConfig(Number(el.dataset.bot)); }; });
}

/** Opens the robot config popup, before or after a MATCH, or while a MATCH is paused. */
export function openConfig(i: number) {
  const { sim, review } = app;
  if ((sim.phase !== 'pre' && sim.phase !== 'post' && !app.livePaused) || app.startAt) return;
  if (app.bracket && i >= 2) { toast(`In a tournament the bracket sets the blue robots: ${TIERS[app.bracket.round].blurb}.`); return; }
  if (review.active) review.exit();
  closeModals(); app.editing = i;
  $('bcpedrochoice').classList.toggle('hidden', !pendingPedro || pendingPedro.robot !== i || i >= 2);
  const b = app.bots[i], isMain = i === MAIN_ROBOT_INDEX, us = app.units === 'us';
  $('bchead').textContent = `Robot config: ${b.plate} (${BOT_IDS[i]}), ${i < 2 ? 'red' : 'blue'} alliance, ${startSide(i)} start`; bc.auto.innerHTML = autoOptions(i);
  bc.plate.value = b.plate; bc.plate.disabled = isMain;
  bc.shooter.disabled = isMain;
  bc.shooter.title = isMain ? 'Team32294: one-ball rear shooter,0.9s between loaded shots.' : '';
  bc.driver.value = b.driver; bc.drive.value = b.stickFrame; bc.shooter.value = b.shooter; bc.auto.value = b.auto; bc.plan.value = String(b.flowerStartSec);
  bc.rpm.value = String(b.driveRpm); bc.size.value = String(sizeToInput(b.sizeIn, app.units)); bc.mass.value = String(massToInput(b.massLb, app.units));
  $('bcsizelabel').textContent = `Chassis, square, ${us ? 'in.' : 'cm'}`; $('bcmasslabel').textContent = `Mass, ${us ? 'lb' : 'kg'}`; $('bcspeedlabel').textContent = `Launch speed, ${us ? 'ft/s' : 'm/s'}`;
  bc.intake.value = b.dualIntake ? 'dual' : 'front'; bc.ends.value = b.turret ? 'turret' : b.dualShooter ? 'both' : 'one';
  bc.turretRange.value = String(b.turretRangeDeg ?? 360); bc.turretSlew.value = b.turretSlewDegPerSec ? String(b.turretSlewDegPerSec) : '';
  bc.defense.value = b.defense; bc.elev.value = String(b.errElevDeg); bc.azim.value = String(b.errAzimDeg); bc.speed.value = String(speedToInput(b.errSpeed, app.units)); bc.intakeP.value = String(Math.round(100 * b.intakeP));
  $<HTMLButtonElement>('bcpedro').disabled = i >= 2;
  const edit = $<HTMLButtonElement>('bcedit'); edit.disabled = i >= 2; edit.title = i >= 2 ? 'Edit AUTO trees from a red robot. Blue robots run the same trees rotated 180° about the FIELD center.' : EDIT_TIP;
  // Only R0 has a human driver. Its intake and turret are fixed, and it needs no TELEOP plan.
  $('bcdriverrow').classList.toggle('hidden', !isMain);
  $('bcdriverow').classList.toggle('hidden', b.driver === 'planner');
  $('bcnote').textContent = isMain ? 'Team 32294, your robot. Choose Controller or Keyboard to drive.' : 'This robot is always driven by the AI planner.';
  for (const id of ['bcinrow', 'bcendsrow']) $(id).classList.add('hidden');
  for (const id of ['bcturretrow', 'bcslewrow']) $(id).classList.toggle('hidden', isMain || !b.turret);
  $('bcplanrow').classList.toggle('hidden', isMain);
  $('botcfg').classList.remove('hidden');
}
export function closeConfig() { app.editing = -1; $('botcfg').classList.add('hidden'); }

/** Reads the popup into the setup and saves it. Before or after a MATCH it rebuilds the FIELD; mid-MATCH it stays paused. */
function applyConfig() {
  const i = app.editing; if (i < 0) return;
  Object.assign(app.bots[i], {
    plate: bc.plate.value, stickFrame: bc.drive.value, shooter: bc.shooter.value, auto: bc.auto.value, flowerStartSec: Number(bc.plan.value), driveRpm: Number(bc.rpm.value),
    sizeIn: sizeFromInput(Number(bc.size.value), app.units), massLb: massFromInput(Number(bc.mass.value), app.units), dualIntake: bc.intake.value === 'dual',
    dualShooter: bc.ends.value === 'both', turret: bc.ends.value === 'turret', turretRangeDeg: Number(bc.turretRange.value) || 360, turretSlewDegPerSec: Number(bc.turretSlew.value) || null,
    defense: bc.defense.value, errElevDeg: Number(bc.elev.value), errAzimDeg: Number(bc.azim.value), errSpeed: speedFromInput(Number(bc.speed.value), app.units), intakeP: Number(bc.intakeP.value) / 100,
  });
  assignDriver(app.bots, i, bc.driver.value as DriverKind); app.bots[i] = sanitize(app.bots[i], i); saveBots(app.bots);
  if (app.sim.phase !== 'pre' && app.sim.phase !== 'post') { app.livePaused = true; toast('Saved. Press Play to continue.'); paintBots(); }
  else reset();
  openConfig(i);
}

/** Replaces the open robot's setup with a preset build, keeping its plate and its driver. */
function applyPreset(make: (i: number) => BotSetup) {
  const i = app.editing; if (i < 0) return;
  const b = app.bots[i]; app.bots[i] = { ...make(i), plate: b.plate, driver: b.driver, stickFrame: b.stickFrame }; saveBots(app.bots); reset(); openConfig(i);
}

let pendingPedro: { files: PedroJavaFile[]; robot: number } | null = null;

/** Reads one chosen routine into a saved AUTO plan, and gives it to red robot `i`. */
async function importPedroFiles(files: PedroJavaFile[], i: number, entryFile?: string) {
  try {
    const { tree, warnings } = await importPedroProject(files, { entryFile });
    addAutoTree(tree); saveUserTree(tree); app.bots[i].auto = String(tree.id); saveBots(app.bots); reset(); openConfig(i);
    pendingPedro = null; $('bcpedrochoice').classList.add('hidden');
    toast([`Imported ${tree.name} for ${app.bots[i].plate}.`, ...warnings].join(' '));
  } catch (err) { toast(`Can't import ${entryFile ?? files[0].name}: ${(err as Error).message}`, 'ref'); }
}

/** Keeps companion sources together; multiple OpModes need an explicit routine choice. */
async function readPedroFiles(files: File[], i: number) {
  pendingPedro = null; $('bcpedrochoice').classList.add('hidden');
  if (i < 0 || i >= 2 || !files.length) return;
  const invalid = files.find(f => !/\.java$/i.test(f.name));
  if (invalid) { toast(`Select an OpMode and its companion .java files. ${invalid.name} isn't a Java file.`, 'ref'); return; }
  try {
    const sources = await Promise.all(files.map(async f => ({ name: f.name, java: await f.text() })));
    if (sources.length === 1) { await importPedroFiles(sources, i); return; }
    const entries = await listPedroOpModes(sources);
    if (!entries.length) throw new Error('Include a concrete @Autonomous OpMode with the companion files.');
    if (entries.length === 1) { await importPedroFiles(sources, i, entries[0].fileName); return; }
    pendingPedro = { files: sources, robot: i };
    const select = $<HTMLSelectElement>('bcpedroentry');
    select.replaceChildren(...entries.map(e => new Option(e.name, e.fileName)));
    openConfig(i); $('bcpedrochoice').classList.remove('hidden'); select.focus();
    toast(`Read ${sources.length} Java files. Choose the routine to import.`);
  } catch (err) { toast(`Can't read Pedro files: ${(err as Error).message}`, 'ref'); }
}

export function initRobotConfig() {
  for (const el of Object.values(bc)) { el.onchange = applyConfig; ownKeys(el); }
  // The 1x, 3x, and 5x chips fill in the reference launcher's errors times that factor.
  document.querySelectorAll<HTMLButtonElement>('[data-err]').forEach(el => {
    el.onclick = () => { const k = Number(el.dataset.err); bc.elev.value = String(+(REF_ERR.errElevDeg * k).toFixed(2)); bc.azim.value = String(+(REF_ERR.errAzimDeg * k).toFixed(2)); bc.speed.value = String(speedToInput(+(REF_ERR.errSpeed * k).toFixed(3), app.units)); applyConfig(); };
  });
  $('bcedit').onclick = () => { if (app.editing >= 0 && app.editing < 2) openEditor(app.editing); };
  $('bcdone').onclick = closeConfig;
  $('bcdefault').onclick = () => applyPreset(i => i === MAIN_ROBOT_INDEX ? teamBot(i) : metaBot(i)); $('bcbaseline').onclick = () => applyPreset(defaultBot);
  $('bcpedro').onclick = () => $('bcpedrofile').click();
  ownKeys($('bcpedroentry'));
  $('bcpedroconfirm').onclick = () => { if (pendingPedro && pendingPedro.robot === app.editing) void importPedroFiles(pendingPedro.files, pendingPedro.robot, $<HTMLSelectElement>('bcpedroentry').value); };
  $<HTMLInputElement>('bcpedrofile').onchange = e => { const input = e.target as HTMLInputElement, files = Array.from(input.files ?? []); input.value = ''; if (files.length) void readPedroFiles(files, app.editing); };
  // Java files dropped together import for the red robot whose setup is open, or for your robot.
  addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer?.files ?? []); if (!files.length) return; e.preventDefault();
    void readPedroFiles(files, app.editing === 1 ? 1 : 0);
  });
}
