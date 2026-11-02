import type { Inputs } from './sim/world';

// ---------- configurable key bindings ----------
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

// Live bindings — updated by the config panel, used immediately
let bindings = loadBindings();
export function getBindings() { return bindings; }
export function setBindings(b: KeyBindings) { bindings = b; saveBindings(b); }

// ---------- one-shot keys (cleared each frame) ----------
const pressed = new Set<string>();
addEventListener('keydown', e => { if (!e.repeat && !(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) pressed.add(e.code); });

// ---------- held keys (for smooth driving) ----------
const held = new Set<string>();
addEventListener('keydown', e => { if (!(e.target as HTMLElement | null)?.closest?.('input:not([type=range]), select, textarea, [contenteditable]')) held.add(e.code); });
addEventListener('keyup', e => held.delete(e.code));
// Always release all keys when window loses focus to prevent stuck keys
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

export function keyboardActive(): boolean {
  const b = bindings;
  return held.has(b.forward) || held.has(b.back) || held.has(b.strafeLeft) || held.has(b.strafeRight) ||
         held.has(b.turnLeft) || held.has(b.turnRight) || held.has(b.shoot) || held.has(b.intake) ||
         held.has(b.placeFlower) || held.has(b.turretLeft) || held.has(b.turretRight);
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

/** Reads the app-level one-shot keys and the controller. `prev`/`next`/`camUp`/`camDown` are the raw arrow keys; the page decides what they mean (timeline, camera pan, or the turret) from the phase and the bindings. */
export function readInput(): Frame {
  // App-level keys
  let start = pressed.has('Enter'), camera = pressed.has('KeyC');
  const reset = pressed.has('KeyR'), mark = pressed.has('KeyM'), review = pressed.has('KeyV'),
        play = pressed.has('Space'),
        prev = pressed.has('ArrowLeft'), next = pressed.has('ArrowRight');
  const camUp = pressed.has('ArrowUp'), camDown = pressed.has('ArrowDown');
  pressed.clear();

  // Single controller: only the first connected gamepad
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
        shootNectar: btn(4), shootPollen: btn(5),
        placePollen: btn(6), placeNectar: btn(7),
        turretLeft:  btn(14), turretRight: btn(15),
        intakeHeld:  (raw.axes[6] ?? 0) > 0.3 || btn(4), // LT axis or LB button
      },
    };
  }

  return { pad, keyboard: keyboardInputs(), start, reset, camera, mark, review, play, prev, next, camUp, camDown };
}
