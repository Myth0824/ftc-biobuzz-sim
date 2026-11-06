import type { Inputs } from './sim/world';

export interface KeyBindings {
  forward: string; back: string; strafeLeft: string; strafeRight: string;
  turnLeft: string; turnRight: string;
  shoot: string; intake: string; placeFlower: string;
  turretLeft: string; turretRight: string;
  prevMark: string; nextMark: string;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW', back: 'KeyS', strafeLeft: 'KeyA', strafeRight: 'KeyD',
  turnLeft: 'KeyQ', turnRight: 'KeyE',
  shoot: 'ArrowUp', intake: 'ArrowDown', placeFlower: 'KeyZ',
  turretLeft: 'ArrowLeft', turretRight: 'ArrowRight',
  // Previous/next timeline mark. Deliberately NOT the arrow keys: the arrows
  // only drive (turret/shoot/intake), and pan/zoom while paused, so that
  // turning the turret can never open the review/replay.
  prevMark: 'BracketLeft', nextMark: 'BracketRight',
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
  prevMark: 'Previous mark', nextMark: 'Next mark',
};

/** Converts a KeyboardEvent.code to a short readable label. */
const CODE_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  BracketLeft: '[', BracketRight: ']',
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
};
export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num');
}

let bindings = loadBindings();
export function getBindings() { return bindings; }
export function setBindings(b: KeyBindings) { bindings = b; saveBindings(b); }

// ---------------------------------------------------------------------------
// Gamepad bindings
// ---------------------------------------------------------------------------

/** Each action maps to a gamepad button index (0-based, standard mapping). */
export interface GamepadBindings {
  shoot: number;
  intake: number;
  placePollen: number;
  placeNectar: number;
  placeFlowerUp: number;
  takeFlowerDown: number;
  turretLeft: number;
  turretRight: number;
}

export const DEFAULT_GAMEPAD_BINDINGS: GamepadBindings = {
  shoot:          5,  // RB
  intake:         4,  // LB
  placePollen:    6,  // LT
  placeNectar:    7,  // RT
  placeFlowerUp:  12, // D-pad up  → put balls IN flower
  takeFlowerDown: 13, // D-pad down → take balls OUT of flower (intakeHeld)
  turretLeft:     14, // D-pad left
  turretRight:    15, // D-pad right
};

const GAMEPAD_BINDING_KEY = 'biobuzz.gamepadbindings.v1';

export function loadGamepadBindings(): GamepadBindings {
  try {
    const saved = JSON.parse(localStorage.getItem(GAMEPAD_BINDING_KEY) ?? '{}');
    return { ...DEFAULT_GAMEPAD_BINDINGS, ...saved };
  } catch { return { ...DEFAULT_GAMEPAD_BINDINGS }; }
}

export function saveGamepadBindings(b: GamepadBindings) {
  try { localStorage.setItem(GAMEPAD_BINDING_KEY, JSON.stringify(b)); } catch {}
}

export const GAMEPAD_BINDING_LABELS: Record<keyof GamepadBindings, string> = {
  shoot:          'Shoot (nectar & pollen)',
  intake:         'Intake',
  placePollen:    'Place POLLEN in FLOWER',
  placeNectar:    'Place NECTAR in FLOWER',
  placeFlowerUp:  'D-pad ↑ — Put balls in FLOWER',
  takeFlowerDown: 'D-pad ↓ — Take balls from FLOWER',
  turretLeft:     'Turret left',
  turretRight:    'Turret right',
};

/** Returns a short human-readable label for a gamepad button index. */
export function padButtonLabel(n: number): string {
  const LABELS: Record<number, string> = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y',
    4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
    8: 'View', 9: 'Start/Menu',
    10: 'L-Stick', 11: 'R-Stick',
    12: 'D-pad ↑', 13: 'D-pad ↓', 14: 'D-pad ←', 15: 'D-pad →',
  };
  return LABELS[n] ?? `Btn ${n}`;
}

let gamepadBindings = loadGamepadBindings();
export function getGamepadBindings() { return gamepadBindings; }
export function setGamepadBindings(b: GamepadBindings) { gamepadBindings = b; saveGamepadBindings(b); }

// Keys pressed since the last frame, for the app's one-shot commands.
const pressed = new Set<string>();
addEventListener('keydown', e => { if (!e.repeat && !(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) pressed.add(e.code); });

// Keys held now, for driving.
const held = new Set<string>();
addEventListener('keydown', e => { if (!(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) held.add(e.code); });
// If the timeline range slider has focus, the browser would move it natively
// on an arrow key, opening the review. Arrows must only drive the robot, so
// keep the slider's native arrow handling out of the way.
addEventListener('keydown', e => { if (e.code.startsWith('Arrow') && (e.target as HTMLElement | null)?.id === 'scrub') e.preventDefault(); });
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
  /** The previous/next timeline mark keys (the rebindable prevMark/nextMark bindings, default `[` and `]`). */
  play: boolean; prev: boolean; next: boolean;
  /** Raw arrow keys; the page pans/zooms the camera with them while paused. They never skip or open the review. */
  camLeft: boolean; camRight: boolean; camUp: boolean; camDown: boolean;
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

/** Reads the app-level one-shot keys and the controller. `prev`/`next` are the rebindable mark keys; the arrows are only the raw camera keys while paused, and otherwise only driving (via `keyboardInputs()`). */
export function readInput(): Frame {
  let start = pressed.has('Enter'), camera = pressed.has('KeyC');
  const reset = pressed.has('KeyR'), mark = pressed.has('KeyM'), review = pressed.has('KeyV'),
        play = pressed.has('Space'),
        prev = pressed.has(bindings.prevMark), next = pressed.has(bindings.nextMark);
  const camLeft = pressed.has('ArrowLeft'), camRight = pressed.has('ArrowRight'),
        camUp = pressed.has('ArrowUp'), camDown = pressed.has('ArrowDown');
  pressed.clear();

  // In a headset, its controllers drive.
  const xr = xrSession && xrPad(xrSession);
  if (xr) return { pad: xr.pad, keyboard: keyboardInputs(), start: start || xr.start, reset, camera: false, mark, review, play, prev, next, camLeft, camRight, camUp, camDown };

  // Only the first connected controller drives.
  const connected = [...navigator.getGamepads()].filter((g): g is Gamepad => !!g && g.connected);
  const raw = connected[0] ?? null;
  let pad: PadState | null = null;
  if (raw) {
    const gb = gamepadBindings;
    const btn = (n: number) => (raw.buttons[n]?.value ?? 0) > 0.4;
    if (btn(9) && !startWas[0]) start = true; startWas[0] = btn(9);
    if (btn(8) && !viewWas[0]) camera = true; viewWas[0] = btn(8);

    // D-pad up: place balls INTO a flower; D-pad down: take balls OUT (intakeHeld while driving into flower)
    const dpadUp   = btn(gb.placeFlowerUp);
    const dpadDown = btn(gb.takeFlowerDown);

    pad = {
      id: raw.id,
      inputs: {
        forward:     clamp(shape(-raw.axes[1])),
        strafeRight: clamp(shape(raw.axes[0])),
        turnRight:   clamp(shape(raw.axes[2]) * 0.85),
        shootNectar: btn(gb.shoot),
        shootPollen: btn(gb.shoot),
        placePollen: btn(gb.placePollen) || dpadUp,
        placeNectar: btn(gb.placeNectar) || dpadUp,
        turretLeft:  btn(gb.turretLeft),
        turretRight: btn(gb.turretRight),
        // LT axis (axes[6]) OR the configured intake button OR d-pad down
        intakeHeld:  (raw.axes[6] ?? 0) > 0.3 || btn(gb.intake) || dpadDown,
      },
    };
  }

  return { pad, keyboard: keyboardInputs(), start, reset, camera, mark, review, play, prev, next, camLeft, camRight, camUp, camDown };
}
