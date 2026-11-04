import type { Inputs } from './sim/world';

export interface KeyBindings {
  forward: string; back: string; strafeLeft: string; strafeRight: string;
  turnLeft: string; turnRight: string;
  shoot: string; intake: string; placeFlower: string;
  turretLeft: string; turretRight: string;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW', back: 'KeyS', strafeLeft: 'KeyA', strafeRight: 'KeyD',
  turnLeft: 'KeyQ', turnRight: 'KeyE',
  shoot: 'ArrowUp', intake: 'ArrowDown', placeFlower: 'KeyZ',
  turretLeft: 'ArrowLeft', turretRight: 'ArrowRight',
};

const BINDING_KEY = 'biobuzz.keybindings.v1';

export function loadBindings(): KeyBindings {
  try {
    const saved = JSON.parse(localStorage.getItem(BINDING_KEY) ?? '{}');
    return { ...DEFAULT_BINDINGS, ...saved };
  } catch { return { ...DEFAULT_BINDINGS }; }
}

export function saveBindings(b: KeyBindings) {
  try { localStorage.setItem(BINDING_KEY, JSON.stringify(b)); } catch { /* storage is a convenience */ }
}

/** Human-readable labels for each binding action. */
export const BINDING_LABELS: Record<keyof KeyBindings, string> = {
  forward: 'Drive forward', back: 'Drive back',
  strafeLeft: 'Strafe left', strafeRight: 'Strafe right',
  turnLeft: 'Turn left', turnRight: 'Turn right',
  shoot: 'Shoot', intake: 'Intake',
  placeFlower: 'Place in FLOWER',
  turretLeft: 'Turret left', turretRight: 'Turret right',
};

/** Converts a KeyboardEvent.code to a short readable label. */
const CODE_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
};
export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num');
}

let bindings = loadBindings();
export function getBindings() { return bindings; }
export function setBindings(b: KeyBindings) { bindings = b; saveBindings(b); }

// Keys pressed since the last frame, for the app's one-shot commands.
const pressed = new Set<string>();
addEventListener('keydown', e => { if (!e.repeat && !(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) pressed.add(e.code); });

// Keys held now, for driving.
const held = new Set<string>();
addEventListener('keydown', e => { if (!(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) held.add(e.code); });
addEventListener('keyup', e => held.delete(e.code));
// A key released while the window is in the background sends no keyup.
addEventListener('blur', () => held.clear());

export function keyboardInputs(): Inputs {
  const b = bindings;
  return {
    forward:     (held.has(b.forward)     ? 1 : 0) - (held.has(b.back)       ? 1 : 0),
    strafeRight: (held.has(b.strafeRight) ? 1 : 0) - (held.has(b.strafeLeft) ? 1 : 0),
    turnRight:   (held.has(b.turnRight)   ? 1 : 0) - (held.has(b.turnLeft)   ? 1 : 0),
    shootPollen: held.has(b.shoot),
    shootNectar: held.has(b.shoot),
    placePollen: held.has(b.placeFlower),
    placeNectar: held.has(b.placeFlower),
    turretLeft:  held.has(b.turretLeft),
    turretRight: held.has(b.turretRight),
    intakeHeld:  held.has(b.intake),
  };
}

const shape = (v: number) => { const d = 0.08, a = Math.abs(v); return a < d ? 0 : Math.sign(v) * ((a - d) / (1 - d)) ** 2; };
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const startWas: boolean[] = [], viewWas: boolean[] = [];

/** One controller's state. `id` is the name that the browser reports for it. */
export interface PadState { inputs: Inputs; id: string }
export interface Frame {
  /** The single connected gamepad, or null if none connected. */
  pad: PadState | null;
  /** Keyboard driving inputs (always present, zero when no keys held). */
  keyboard: Inputs;
  start: boolean; reset: boolean; camera: boolean; mark: boolean; review: boolean;
  /** Raw arrow keys. While paused the page pans/zooms the camera; otherwise they skip timeline marks, unless the keyboard driver's turret is bound to them. */
  play: boolean; prev: boolean; next: boolean;
  /** Raw Up/Down arrow keys; the page zooms the camera with them while paused. */
  camUp: boolean; camDown: boolean;
}

let xrSession: XRSession | null = null;
/** Sets the headset session whose controllers drive, or null when it ends. */
export function setXRSession(s: XRSession | null) { xrSession = s; startWas[1] = true; }

/**
 * Reads a headset's two controllers as one gamepad (the xr-standard mapping): the left stick drives, the right stick turns,
 * the left trigger runs the intake, the right trigger launches POLLEN and the right grip NECTAR, the left grip places
 * POLLEN and X places NECTAR, Y and B turn the turret, and A starts the MATCH.
 */
function xrPad(s: XRSession): { pad: PadState; start: boolean } | null {
  let l: Gamepad | undefined, r: Gamepad | undefined;
  for (const src of s.inputSources) { if (src.handedness === 'left') l = src.gamepad ?? l; if (src.handedness === 'right') r = src.gamepad ?? r; }
  if (!l && !r) return null;
  const btn = (g: Gamepad | undefined, n: number) => (g?.buttons[n]?.value ?? 0) > 0.4, axis = (g: Gamepad | undefined, n: number) => g?.axes[n] ?? 0;
  const a = btn(r, 4), start = a && !startWas[1]; startWas[1] = a;
  return {
    start,
    pad: {
      id: 'Headset controllers',
      inputs: {
        forward: clamp(shape(-axis(l, 3))), strafeRight: clamp(shape(axis(l, 2))), turnRight: clamp(shape(axis(r, 2)) * 0.85),
        shootPollen: btn(r, 0), shootNectar: btn(r, 1), placePollen: btn(l, 1), placeNectar: btn(l, 4),
        turretLeft: btn(l, 5), turretRight: btn(r, 5), intakeHeld: btn(l, 0),
      },
    },
  };
}

/** Rumbles the driving controller, where the browser supports it: `strong` for a launch, weak for a pickup. */
export function rumble(strong: boolean) {
  if (xrSession) {
    for (const src of xrSession.inputSources) if (src.handedness === (strong ? 'right' : 'left')) (src.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): Promise<boolean> }[] }) | undefined)?.hapticActuators?.[0]?.pulse(strong ? 0.6 : 0.3, strong ? 90 : 40).catch(() => {});
    return;
  }
  const raw = [...navigator.getGamepads()].find(g => !!g && g.connected) as (Gamepad & { vibrationActuator?: { playEffect(t: string, p: object): Promise<unknown> } }) | undefined;
  raw?.vibrationActuator?.playEffect('dual-rumble', { duration: strong ? 90 : 40, strongMagnitude: strong ? 0.6 : 0, weakMagnitude: strong ? 0.3 : 0.5 }).catch(() => {});
}

/** Reads the app-level one-shot keys and the controller. `prev`/`next`/`camUp`/`camDown` are the raw arrow keys; the page decides what they mean (timeline, camera pan, or the turret) from the phase and the bindings. */
export function readInput(): Frame {
  let start = pressed.has('Enter'), camera = pressed.has('KeyC');
  const reset = pressed.has('KeyR'), mark = pressed.has('KeyM'), review = pressed.has('KeyV'),
        play = pressed.has('Space'),
        prev = pressed.has('ArrowLeft'), next = pressed.has('ArrowRight');
  const camUp = pressed.has('ArrowUp'), camDown = pressed.has('ArrowDown');
  pressed.clear();

  // In a headset, its controllers drive.
  const xr = xrSession && xrPad(xrSession);
  if (xr) return { pad: xr.pad, keyboard: keyboardInputs(), start: start || xr.start, reset, camera: false, mark, review, play, prev, next, camUp, camDown };

  // Only the first connected controller drives.
  const connected = [...navigator.getGamepads()].filter((g): g is Gamepad => !!g && g.connected);
  const raw = connected[0] ?? null;
  let pad: PadState | null = null;
  if (raw) {
    const btn = (n: number) => (raw.buttons[n]?.value ?? 0) > 0.4;
    if (btn(9) && !startWas[0]) start = true; startWas[0] = btn(9);
    if (btn(8) && !viewWas[0]) camera = true; viewWas[0] = btn(8);
    pad = {
      id: raw.id,
      inputs: {
        forward:     clamp(shape(-raw.axes[1])),
        strafeRight: clamp(shape(raw.axes[0])),
        turnRight:   clamp(shape(raw.axes[2]) * 0.85),
        shootNectar: btn(5), shootPollen: btn(5),
        placePollen: btn(6), placeNectar: btn(7),
        turretLeft:  btn(14), turretRight: btn(15),
        intakeHeld:  (raw.axes[6] ?? 0) > 0.3 || btn(4), // LT axis or LB button (intake only)
      },
    };
  }

  return { pad, keyboard: keyboardInputs(), start, reset, camera, mark, review, play, prev, next, camUp, camDown };
}
