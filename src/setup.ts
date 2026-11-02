import { fmtMass, fmtSize, fmtSpeed, type Units } from './units';
import { DEFAULT_ROBOT, setDriveRpm, setMass, setSquareSize, type RobotConfig, type ShooterType } from './sim/config';

export type DriverKind = 'planner' | 'pad1' | 'keyboard';

/** The main robot is always R0, always driven by the human, always team 32294. */
export const MAIN_ROBOT_PLATE = '32294';
export const MAIN_ROBOT_INDEX = 0;

/** Everything that a team sets for one robot before a MATCH. The robot config popup edits it. */
export interface BotSetup {
  /** The number plate text, for example a team number. */ plate: string;
  driver: DriverKind;
  /** For a human driver: whether the sticks move the robot in the driver's frame or in the robot's frame. Default: field. */ stickFrame: 'field' | 'robot';
  shooter: ShooterType;
  /** An AUTO tree id, `default` for the tree that fits the robot's start position, or `none`. */ auto: string;
  /** The TELEOP plan: FLOWER work starts when this many seconds remain. 0 means TIPS only. */ flowerStartSec: number;
  /** The drive motor's free speed at the wheel, in rpm. Default: 600. */ driveRpm: number;
  /** The side of the square chassis, in inches. Default: 15. R101 allows 18. */ sizeIn: number;
  /** The robot mass, in pounds. Default: 22. R102 allows 42. */ massLb: number;
  /** If true, the robot has an intake on the rear face too. Default: false. */ dualIntake: boolean;
  /** If true, the robot can launch out of either end. Default: false. */ dualShooter: boolean;
  /** If true, the shooter is on a turret that tracks the raised CELL. It overrides `dualShooter`. Default: false. */ turret?: boolean;
  /** The turret's range of motion in degrees, from 30 to 360. Default: 360. */ turretRangeDeg?: number;
  /** The turret's top turn rate in degrees per second, or null for an instant slew. Default: null. */ turretSlewDegPerSec?: number | null;
  /**
   * The launcher's shot-to-shot error, as one standard deviation: elevation and azimuth in degrees, and launch speed in
   * meters per second. The values are for POLLEN. NECTAR scales by the same ratios from its own reference errors.
   * Default: the reference launcher, 1.0 degree, 1.2 degrees, and 0.08 m/s.
   */
  errElevDeg: number; errAzimDeg: number; errSpeed: number;
  /** The probability that the intake takes an element that it reaches, from 0 to 1. A miss costs a retry. Default: 0.95. */ intakeP: number;
  /** The defense policy in TELEOP. See `Coach.defense`. Default: none. */ defense: 'none' | 'full' | 'opportunistic';
}

/** The robots in `sim.robots` order: R0, R1, B0, B1. */
export const BOT_IDS = ['R0', 'R1', 'B0', 'B1'] as const;
// The storage key changed when the simulator's default became the meta build, so that a browser with the old default gets the new one.
const IN = 0.0254, LB = 0.45359237, KEY = 'biobuzz.bots.v2';
/**
 * The default robot is small, light, and fast: 15 in., 22 lb, and 600 rpm. Over 24 seeds with the planner on all four
 * robots, it scores 31.9 combined points more than the reference robot in `DEFAULT_ROBOT` (16.9 in., 28.7 lb, 435 rpm),
 * with a standard error of 10.0, and it stalls less. See e17 in experiments/policy-loop.md.
 */
export const DEFAULT_SETUP = { driveRpm: 600, sizeIn: 15, massLb: 22 };
/** The reference launcher's errors, from `DEFAULT_ROBOT.shooter.pollen`. The 1x, 3x, and 5x chips in the robot config multiply them. */
export const REF_ERR = { errElevDeg: DEFAULT_ROBOT.shooter.pollen.elevationDeg.std, errAzimDeg: DEFAULT_ROBOT.shooter.pollen.yawStdDeg, errSpeed: DEFAULT_ROBOT.shooter.pollen.speed.std };
export const defaultBot = (i: number): BotSetup => ({ plate: i === MAIN_ROBOT_INDEX ? MAIN_ROBOT_PLATE : BOT_IDS[i], driver: i === MAIN_ROBOT_INDEX ? 'pad1' : 'planner', stickFrame: 'field', shooter: 'dual', auto: 'default', flowerStartSec: 0, dualIntake: false, dualShooter: false, defense: 'none', ...REF_ERR, intakeP: DEFAULT_ROBOT.intake.successP, ...DEFAULT_SETUP });

/**
 * The robot that the simulator opens with: the combined build that the experiments point to. It is a four-element
 * catapult, 12 in., 15.4 lb, and 500 rpm, with intakes at both ends. Red with this build beat the baseline robot by 96
 * points over 24 seeds (e24 in experiments/policy-loop.md). `defaultBot` stays the baseline of every experiment, so the
 * tables in the Match Lab and in the post keep their reference.
 */
export const metaBot = (i: number): BotSetup => ({ ...defaultBot(i), shooter: 'catapult', driveRpm: 500, sizeIn: 12, massLb: 15.4, dualIntake: true });

/** The team numbers that the simulator deals to the four robots: the three NCSSM teams, and 772, a friend team that one of our mentors also works with. */
export const TEAM_NUMBERS = ['5064', '8569', '22377', '772'];

/** Loads the four robot setups from the browser's storage. Missing or unreadable entries fall back to the defaults. */
export function loadBots(): BotSetup[] {
  let saved: Partial<BotSetup>[] = []; try { saved = JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { saved = []; }
  // A browser with no stored setups gets the team numbers as number plates, in a random order on every visit. The
  // shuffle only names the robots: R0, R1, B0, and B1 stay the robot ids in traces, and match seeds don't depend on it.
  const plates = [...TEAM_NUMBERS]; for (let i = plates.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [plates[i], plates[k]] = [plates[k], plates[i]]; }
  return BOT_IDS.map((_, i) => sanitize({ ...metaBot(i), plate: plates[i], ...(saved[i] ?? {}) }, i));
}
export function saveBots(bots: BotSetup[]) { try { localStorage.setItem(KEY, JSON.stringify(bots)); } catch { /* Storage is a convenience. The setups still apply to this page. */ } }

/** Older AUTO names that a stored setup can still hold: script names from before September 20, 2026, and tree names from before September 23, 2026. */
const RENAMED: Record<string, string> = {
  lead_with_partner: 'lane-sweep-pair-right', partner_rear: 'lane-sweep-pair-left', partner_rear_no_park: 'lane-sweep-pair-left-no-park',
  lead_harvest: 'wall-sweep-pair-right', partner_harvest: 'wall-sweep-pair-left',
  right_harvest: 'wall-sweep-pair-right', left_harvest: 'wall-sweep-pair-left', right_cycle: 'lane-sweep-pair-right', left_cycle: 'lane-sweep-pair-left',
  left_cycle_no_park: 'lane-sweep-pair-left-no-park', cycle_and_park: 'solo-two-tip-sweep', cycle_no_park: 'solo-two-tip-sweep-no-park', leave_only: 'leave-and-park',
};
/** Gets the start position of robot `i`, as its drivers see it: R0 and B0 start at the right, on the alliance wall, and R1 and B1 at the left, on the rear wall (red) or the audience wall (blue). */
export const startSide = (i: number): 'right' | 'left' => (i % 2 === 0 ? 'right' : 'left');

/** Clamps a setup to what the simulator accepts. Only the red robots can have a human driver. */
export function sanitize(b: BotSetup, i: number): BotSetup {
  // A setup that was stored with the single `spreadX` multiplier maps to the three errors. The result drops `spreadX`:
  // if it stayed, then every later call would reset the three errors, and the 1x, 3x, and 5x chips would do nothing (#8).
  const { spreadX: old, ...rest } = b as BotSetup & { spreadX?: number }; b = rest;
  if (old) b = { ...b, errElevDeg: REF_ERR.errElevDeg * old, errAzimDeg: REF_ERR.errAzimDeg * old, errSpeed: REF_ERR.errSpeed * old };
  const num = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { ...b, auto: RENAMED[b.auto] ?? b.auto, plate: i === MAIN_ROBOT_INDEX ? MAIN_ROBOT_PLATE : (b.plate || BOT_IDS[i]).trim().slice(0, 6) || BOT_IDS[i], driver: i === MAIN_ROBOT_INDEX ? (b.driver === 'planner' ? 'pad1' : b.driver) : 'planner',
    // Main robot is always: front intake only, full 360 turret
    ...(i === MAIN_ROBOT_INDEX ? { dualIntake: false, turret: true, turretRangeDeg: 360, turretSlewDegPerSec: null } : {}), driveRpm: Math.round(num(b.driveRpm, 100, 1200, DEFAULT_SETUP.driveRpm)), sizeIn: Math.round(num(b.sizeIn, 10, 18, DEFAULT_SETUP.sizeIn) * 10) / 10, massLb: Math.round(num(b.massLb, 10, 42, DEFAULT_SETUP.massLb) * 10) / 10,
    errElevDeg: Math.round(num(b.errElevDeg, 0, 15, REF_ERR.errElevDeg) * 100) / 100, errAzimDeg: Math.round(num(b.errAzimDeg, 0, 15, REF_ERR.errAzimDeg) * 100) / 100, errSpeed: Math.round(num(b.errSpeed, 0, 1.5, REF_ERR.errSpeed) * 1000) / 1000,
    intakeP: Math.round(num(b.intakeP, 0.2, 1, DEFAULT_ROBOT.intake.successP) * 100) / 100,
    turretRangeDeg: Math.round(num(b.turretRangeDeg ?? 360, 30, 360, 360)), turretSlewDegPerSec: b.turretSlewDegPerSec && b.turretSlewDegPerSec > 0 ? Math.round(num(b.turretSlewDegPerSec, 10, 3600, 360)) : null };
}

/** Assigns a driver to robot `i`. Only the main robot (R0) can have a human driver. */
export function assignDriver(bots: BotSetup[], i: number, driver: DriverKind) {
  if (i !== MAIN_ROBOT_INDEX) { bots[i].driver = 'planner'; return; }
  bots[i].driver = driver === 'planner' ? 'pad1' : driver; // R0 must always have a human driver
}

/** Builds the simulator's robot configuration from a setup. */
export function robotConfig(b: BotSetup): RobotConfig {
  const c = structuredClone(DEFAULT_ROBOT); c.shooter.type = b.shooter; setDriveRpm(c, b.driveRpm); setSquareSize(c, b.sizeIn * IN); setMass(c, b.massLb * LB); c.intake.dualSided = !!b.dualIntake; c.shooter.dualSided = !!b.dualShooter; c.shooter.turret = !!b.turret; c.shooter.turretRangeDeg = b.turretRangeDeg ?? 360; c.shooter.turretSlewDegPerSec = b.turretSlewDegPerSec ?? Infinity;
  for (const lp of [c.shooter.pollen, c.shooter.nectar]) { lp.elevationDeg.std *= b.errElevDeg / REF_ERR.errElevDeg; lp.yawStdDeg *= b.errAzimDeg / REF_ERR.errAzimDeg; lp.speed.std *= b.errSpeed / REF_ERR.errSpeed; }
  c.intake.successP = b.intakeP;
  return c;
}

/** Gets the phrases that describe a setup. A phrase is empty when the setup has the default for it. */
function phrases(b: BotSetup, units: Units) {
  const turret = (b.turretRangeDeg ?? 360) < 360 || b.turretSlewDegPerSec ? ` ${b.turretRangeDeg ?? 360}°${b.turretSlewDegPerSec ? `, ${b.turretSlewDegPerSec}°/s` : ''}` : '';
  const errored = b.errElevDeg !== REF_ERR.errElevDeg || b.errAzimDeg !== REF_ERR.errAzimDeg || b.errSpeed !== REF_ERR.errSpeed;
  return {
    driver: b.driver === 'planner' ? 'Planner' : b.driver === 'keyboard' ? 'Keyboard (WASD)' : 'Controller',
    shooter: b.shooter, auto: `AUTO ${b.auto.replace(/[_-]/g, ' ')}`, teleop: b.flowerStartSec ? `FLOWERS from ${b.flowerStartSec} s` : 'tips only',
    rpm: `${b.driveRpm} rpm`, size: fmtSize(b.sizeIn, units), mass: fmtMass(b.massLb, units), intake: b.dualIntake ? 'dual intake' : '',
    ends: b.turret ? `turret${turret}` : b.dualShooter ? 'launches from both ends' : '', defense: b.defense !== 'none' ? `${b.defense} defense` : '',
    error: errored ? `launch error ${b.errElevDeg}°, ${b.errAzimDeg}°, ${fmtSpeed(b.errSpeed, units === 'us' ? 'usft' : units)}` : '',
    intakeP: b.intakeP !== DEFAULT_ROBOT.intake.successP ? `intake ${Math.round(100 * b.intakeP)}%` : '',
  };
}

/** Describes a setup in one line, for tooltips and the trace. The trace always uses metric units. */
export function describe(b: BotSetup, units: Units = 'metric'): string {
  const p = phrases(b, units);
  return [p.driver, p.shooter, p.auto, p.teleop, p.rpm, p.size, p.mass, p.intake, p.ends, p.defense, p.error, p.intakeP].filter(Boolean).join(' · ');
}

const SHOOTER_NAME: Record<ShooterType, string> = { catapult: 'Catapult', fifo: 'Single shooter, FIFO', dual: 'Dual shooter' };
/**
 * Describes a setup in lines for the robot cards in the game setup: the driver, the plans, the mechanisms, and the
 * drivetrain, and then the launcher error and the intake success if they differ from the reference.
 */
export function describeLines(b: BotSetup, units: Units = 'metric'): string[] {
  const p = phrases(b, units);
  return [[p.driver, p.defense], [p.auto, p.teleop], [SHOOTER_NAME[b.shooter], p.ends, p.intake], [p.rpm, p.size, p.mass], [p.error, p.intakeP]].map(line => line.filter(Boolean).join(' · ')).filter(Boolean);
}
