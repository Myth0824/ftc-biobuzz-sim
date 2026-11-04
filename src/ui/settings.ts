/**
 * The game setup's selects. This browser keeps them under one key, and a change to the MATCH settings rebuilds the
 * FIELD, or, mid-MATCH, pauses it and applies at the next reset.
 */
import type { CameraMode } from '../render/view';
import { getUnits, setUnits, type Units } from '../units';
import { app, reset } from './app';
import { $, store, stored, toast } from './dom';
import { openConfig, paintBots } from './robot-config';
import { paintTree } from './tree-ui';

const KEY = 'biobuzz.settings.v1';
const select = (id: string) => $<HTMLSelectElement>(id);
export const sel = {
  mode: select('mode'), stage: select('stage'), opponents: select('opponents'), referee: select('referee'),
  camera: select('camera'), units: select('units'), sound: select('sound'), treeview: select('treeview'), autopaths: select('autopaths'), showtraj: select('showtraj'),
};
type Name = keyof typeof sel;

function save() { store(KEY, JSON.stringify(Object.fromEntries(Object.entries(sel).map(([k, el]) => [k, el.value])))); }

/** Applies a change to the MATCH settings: before or after a MATCH it rebuilds the FIELD; mid-MATCH it pauses. */
function applySetup() {
  if (app.sim.phase !== 'pre' && app.sim.phase !== 'post') { app.livePaused = true; toast('Saved. It applies after Reset; Play continues this MATCH.'); }
  else reset();
}

/** What a change to each select does, besides being saved. */
const onChange: Partial<Record<Name, () => void>> = {
  mode: applySetup, stage: applySetup, opponents: applySetup, referee: applySetup,
  camera: () => { app.view.mode = sel.camera.value as CameraMode; },
  units: () => { app.units = sel.units.value as Units; setUnits(app.units); paintBots(); if (app.editing >= 0) openConfig(app.editing); },
  sound: () => { app.audio.enabled = sel.sound.value === 'on'; },
  treeview: () => paintTree(),
};

/** Loads the saved settings into the selects, before the first reset, so that the first FIELD is built with them. */
export function initSettings() {
  sel.units.value = getUnits();
  try {
    const s = JSON.parse(stored(KEY) ?? '{}') as Partial<Record<Name, string>>;
    for (const [k, el] of Object.entries(sel)) { const v = s[k as Name]; if (v && Array.from(el.options).some(o => o.value === v)) el.value = v; }
  } catch (e) { console.warn('Could not load the saved settings; starting with the defaults.', e); }
  app.view.mode = sel.camera.value as CameraMode; app.audio.enabled = sel.sound.value === 'on';
  app.units = sel.units.value as Units; setUnits(app.units);
  for (const [k, el] of Object.entries(sel)) el.addEventListener('change', () => { el.blur(); save(); onChange[k as Name]?.(); });
}
