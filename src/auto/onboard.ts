/**
 * AUTO as behavior trees: the onboard environment, the AUTO leaves, and `AutoProgram`, which runs one robot's AUTO
 * tree. See docs/behavior-trees.md.
 *
 * The onboard environment is what an FTC OpMode can know: the robot's own odometry, its transfer count, its size, the
 * clock, and the camera's AprilTag sightings of the CELLS. It has no balls and no other robots. Positions are in the
 * alliance frame, which is red's FIELD coordinates in x and y: a blue robot runs the same poses rotated 180° about the
 * FIELD center. `simPoint` converts a pose to the simulator's axes.
 *
 * Each AUTO leaf is one step of the kind that `ScriptRunner` ran, with the same timing: it ends on its condition or
 * on its `timeoutSec`, whichever comes first, and then the robot does nothing for one physics step before the next
 * step starts, as a state machine that advances on its next loop does.
 */
import { checkTree, defineLeaf, loadTree, t, TreeLoadError, type LoadIssue, TreeRunner, type Behavior, type CNode, type FnSpec, type Recorder, type Registry, type TreeDef } from '../bt';
import { seesRaisedCell } from '../sim/camera';
import { FIELD, HIVE } from '../sim/config';
import { NO_INPUT, type Inputs, type IntakeFilter, type Sim } from '../sim/world';
import { pursue } from './follow';
import wallSweepRight from './trees/auto/wall-sweep-pair-right.json';
import wallSweepLeft from './trees/auto/wall-sweep-pair-left.json';
import laneSweepRight from './trees/auto/lane-sweep-pair-right.json';
import laneSweepLeftNoPark from './trees/auto/lane-sweep-pair-left-no-park.json';
import laneSweepLeft from './trees/auto/lane-sweep-pair-left.json';
import soloSweep from './trees/auto/solo-two-tip-sweep.json';
import soloSweepNoPark from './trees/auto/solo-two-tip-sweep-no-park.json';
import leaveAndPark from './trees/auto/leave-and-park.json';
import custom32294 from './trees/auto/32294-custom.json';
import blankRight from './trees/auto/blank-right.json';
import blankLeft from './trees/auto/blank-left.json';
import { fieldObstacles, planPath, type Capsule, type Pt } from './planner';

/** Red's own FLOWER, which gives the FLOWER offsets of the `field` constants. */
const OWN_FLOWER = FIELD.flowers.find(f => f.id === 'red')!;
/**
 * The onboard environment's `field` constants, the same for every robot. Both alliances use red's HIVE pivot, as the
 * rotated scripts did: blue's own pivot is 0.4 mm farther out. See `ONBOARD_SCHEMA`.
 */
export const AUTO_FIELD: Readonly<OnboardEnv['field']> = { half: FIELD.half, flowerHalfSize: FIELD.flowerHalfSize, hiveX: HIVE.pivotX.red, flowerNear: Math.abs(OWN_FLOWER.z), flowerFar: Math.abs(OWN_FLOWER.x) };

/**
 * A pose in the alliance frame: red's FIELD coordinates. x runs from the red wall (negative) to the blue wall, y from the
 * audience wall (negative) to the rear wall, in meters, and the heading is in degrees counterclockwise from +x. A blue
 * robot runs the same tree rotated 180° about the FIELD center, so every tree is written for red.
 */
const POSE = t.object({ x: t.number('m'), y: t.number('m'), headingDeg: t.number('deg') });
const CELL = t.enum('rear', 'audience');
const INTAKE = t.enum('all', 'pollen', 'own_nectar', 'none');
export interface Pose { x: number; y: number; headingDeg: number }

/** The fields that expressions in an AUTO tree can read. */
export const ONBOARD_SCHEMA = t.object({
  clock: t.object({
    /** Seconds left in the period. */
    remaining: t.number('s'),
    /** The physics step count, and the step length in seconds. AUTO leaves time their steps with them. */
    step: t.number(), dt: t.number('s'),
  }),
  /**
   * FIELD constants in the alliance frame. `hiveX` is the x of the own HIVE's pivot, from `HIVE.pivotX.red`. Every FLOWER
   * center is at (±flowerFar, ±flowerNear) or (±flowerNear, ±flowerFar), from `FIELD.flowers`: the own FLOWER is at
   * (-flowerFar, -flowerNear). For red, (-flowerNear, flowerFar) is the rear FLOWER. A blue robot's frame is rotated
   * 180°, so for blue that spot is the audience FLOWER. The CAD values are in `cad/field-manifest.json`.
   */
  field: t.object({ half: t.number('m'), flowerHalfSize: t.number('m'), hiveX: t.number('m'), flowerNear: t.number('m'), flowerFar: t.number('m') }),
  bots: t.object({ me: t.object({
    dimensions: t.object({ length: t.number('m'), width: t.number('m') }),
    slot: t.number(),
    // The robot's subsystems, by their state. Leaves command them; expressions only read them.
    /** The drivetrain: the pose from odometry, in the alliance frame, and the speed. */
    drive: t.object({ pose: POSE, speed: t.number('m/s') }),
    /** The transfer: the elements that the robot holds between the intake and the shooter. */
    transfer: t.object({ count: t.number(), capacity: t.number(), full: t.boolean() }),
    /** The shooter. `aimed` is false while a turret still turns toward the raised CELL; a fixed shooter is always aimed. */
    shooter: t.object({ facing: t.enum('front', 'rear'), type: t.enum('catapult', 'fifo', 'dual'), aimed: t.boolean() }),
    /** The turret: current robot-relative angle in degrees, and whether the robot has a turret at all. */
    turret: t.object({ angleDeg: t.number('deg'), hasTurret: t.boolean() }),
    /** The camera: `seesRaised(cell)` is true while it reads that CELL's AprilTags in the raised position. */
    vision: t.object({ seesRaised: t.fn([CELL], t.boolean()) }),
  }) }),
});

/** Where an AUTO tree's output goes each step: the robot's inputs, and what the page and the tools show. */
export interface AutoOutput {
  inputs: Inputs;
  /** The planned path of the running drive, in FIELD coordinates. */
  path: Pt[];
  note: string;
  /** The kind and tag of the running step. `scripts/plan-sweeps.ts` looks for a wait tagged `sweep`. */
  step: { do: string; tag?: string } | null;
}

/** The onboard environment: the schema's fields, plus the subsystems that only leaves can use. */
export interface OnboardEnv {
  clock: { remaining: number; step: number; dt: number };
  field: { half: number; flowerHalfSize: number; hiveX: number; flowerNear: number; flowerFar: number };
  bots: { me: {
    dimensions: { length: number; width: number };
    slot: number;
    drive: DriveSubsystem;
    intake: IntakeSubsystem;
    transfer: { count: number; capacity: number; full: boolean };
    shooter: { facing: 'front' | 'rear'; type: 'catapult' | 'fifo' | 'dual'; aimed: boolean; fire(): void };
    vision: { seesRaised(cell: 'rear' | 'audience'): boolean };
    turret: TurretSubsystem;
  } };
  out: AutoOutput;
}

interface IntakeSubsystem {
  /** Runs the intake with `filter` for this physics step. A step that no command runs the intake gets the default command. */
  set(filter: IntakeFilter): void;
  /** Runs the default command for this physics step: `AUTO_TUNING.intakeDefault`. */
  stop(): void;
}

interface TurretSubsystem {
  /** Current robot-relative turret angle in degrees (0 = mount direction, positive = CCW). NaN before first step. */
  readonly angleDeg: number;
  /** True if the robot has a turret. */
  readonly hasTurret: boolean;
  /** Commands the turret to turn left (CCW) this step. */
  turnLeft(): void;
  /** Commands the turret to turn right (CW) this step. */
  turnRight(): void;
  /** Releases manual control this step: auto-aim resumes after the tree's last manual command. */
  release(): void;
  /** Pins the turret at its current angle this step: it keeps the angle instead of auto-aiming. */
  hold(): void;
}

interface DriveSubsystem {
  /** The pose from odometry, in the alliance frame. */
  readonly pose: Pose;
  /** Plans a path to a pose in the alliance's frame, around the FIELD elements and the AUTO center-line wall. */
  plan(goal: Pose): void;
  /** Sets the path to follow: from where the robot is, straight through `points` in the alliance frame, with no planner. */
  route(points: readonly { x: number; y: number }[]): void;
  /** Computes the command that follows the planned path and turns toward `headingDeg`, without sending it. */
  follow(headingDeg: number): { forward: number; strafeRight: number; turnRight: number; remaining: number; headingError: number };
  send(cmd: { forward: number; strafeRight: number; turnRight: number }): void;
  /** Pushes straight ahead at `power`, as a fraction of full power. */
  push(power: number): void;
  readonly speed: number;
}

/**
 * Converts a point in the alliance frame to the simulator's floor axes, which are three.js's x and z, where z is the
 * negative of FIELD y. `rotate` turns it 180° about the FIELD center, for a blue robot.
 */
export const simPoint = (p: { x: number; y: number }, rotate: boolean): Pt => (rotate ? { x: -p.x, z: p.y } : { x: p.x, z: -p.y });
/** Converts a heading in the alliance frame to the simulator's heading in radians. A blue robot's turns by 180°. */
export const simHeading = (headingDeg: number, rotate: boolean) => ((headingDeg + (rotate ? 180 : 0)) * Math.PI) / 180;
/** Converts a position and heading on the simulator's axes to a pose in the alliance frame. It undoes `simPoint` and `simHeading`. */
export const alliancePose = (p: Pt, heading: number, rotate: boolean): Pose => {
  const deg = (heading * 180) / Math.PI - (rotate ? 180 : 0);
  return { x: rotate ? -p.x : p.x, y: rotate ? p.z : -p.z, headingDeg: ((((deg + 180) % 360) + 360) % 360) - 180 };
};

/** The virtual wall on the FIELD center line. It keeps the robot's circumscribed circle on its own side (G402). */
export const centerWall = (rotate: boolean): Capsule => { const xw = (rotate ? -1 : 1) * 0.08; return { a: { x: xw, z: -2 }, b: { x: xw, z: 2 }, r: 0 }; };

/**
 * Builds the onboard environment over a robot's view of the simulator. `use` builds it for each step: nothing moves
 * while the planners run, so each field is read once per step.
 */
class OnboardAdapter implements OnboardEnv {
  out: AutoOutput = { inputs: { ...NO_INPUT }, path: [], note: '', step: null };
  /** The intake's default command: what it runs in a step that no command runs it. Undefined leaves it unset, which the simulator runs as `all`. */
  intakeDefault: IntakeFilter | undefined = 'none';
  clock!: OnboardEnv['clock']; bots!: OnboardEnv['bots'];
  readonly field = AUTO_FIELD;

  use(s: Sim, n: number, dt: number) {
    const out = this.out, rotate = s.alliance === 'blue';
    // Each subsystem starts the step with its default command: the drive and the shooter idle, and the intake runs its default.
    out.inputs = { ...NO_INPUT }; if (this.intakeDefault) out.inputs.intake = this.intakeDefault;
    this.clock = { remaining: s.timer, step: n, dt };
    const drive: DriveSubsystem = {
      pose: alliancePose(s.robot.translation(), s.heading, rotate),
      plan: goal => {
        const p = s.robot.translation(), R = Math.hypot(s.cfg.length, s.cfg.width) / 2;
        out.path = planPath({ x: p.x, z: p.z }, simPoint(goal, rotate), R, [...fieldObstacles(), centerWall(rotate)]);
      },
      route: points => { const p = s.robot.translation(); out.path = [{ x: p.x, z: p.z }, ...points.map(q => simPoint(q, rotate))]; },
      follow: headingDeg => pursue(s, out.path, simHeading(headingDeg, rotate)),
      send: cmd => { out.inputs.forward = cmd.forward; out.inputs.strafeRight = cmd.strafeRight; out.inputs.turnRight = cmd.turnRight; },
      push: power => { out.inputs.forward = power; },
      speed: s.telemetry.speed,
    };
    this.bots = { me: {
      dimensions: { length: s.cfg.length, width: s.cfg.width },
      slot: s.slot,
      drive,
      intake: { set: f => { out.inputs.intake = f; }, stop: () => { out.inputs.intake = this.intakeDefault; } },
      transfer: { count: s.carried.length, capacity: s.cfg.capacity, full: s.carried.length >= s.cfg.capacity },
      shooter: { facing: s.cfg.shooter.facing, type: s.cfg.shooter.type, aimed: s.turretAimed(), fire: () => { out.inputs.shootPollen = true; out.inputs.shootNectar = true; } },
      // Rotated 180°, blue's rear CELL is where red's audience CELL is, so a tree's `rear` means red's rear.
      vision: { seesRaised: cell => seesRaisedCell(s, rotate ? (cell === 'rear' ? 'audience' : 'rear') : cell) },
      turret: {
        get angleDeg() { const a = s.robots[s.me].turretAngle; return Number.isFinite(a) ? (a * 180) / Math.PI : NaN; },
        get hasTurret() { return s.hasTurret; },
        turnLeft:  () => { out.inputs.turretLeft = true;  out.inputs.turretRight = false; },
        turnRight: () => { out.inputs.turretLeft = false; out.inputs.turretRight = true; },
        release:   () => { out.inputs.turretLeft = false; out.inputs.turretRight = false; },
        hold:      () => { out.inputs.turretLeft = false; out.inputs.turretRight = false; out.inputs.turretHold = true; },
      },
    } };
  }
}

/** Experiment switches for AUTO, set from a script. */
export const AUTO_TUNING: {
  /** For scripts/plan-sweeps.ts: replace every path tagged `sweep-ROLE` with a wait of this many seconds, then a wait tagged `sweep`. */
  sweepSnapshotDelay: number | null;
  /**
   * If true, the robot does nothing for one physics step after each AUTO step ends, as `ScriptRunner` did, and the next
   * step starts on the step after. If false, the next step starts in the same physics step. Default: true.
   */
  idleAfterStep: boolean;
  /**
   * The intake's default command: the filter that it runs in a physics step that no `intake.run` leaf runs it. Null
   * leaves the intake input unset, which the simulator runs as `all`, as AUTO did before increment 7. Default: `none`.
   */
  intakeDefault: IntakeFilter | null;
} = { sweepSnapshotDelay: null, idleAfterStep: true, intakeDefault: 'none' };

// ---- Step timing ----

/**
 * Times one step. The step started on the step before its first update, as it did in `ScriptRunner`, so its time on
 * its first update is one step length. `over(sec)` is true once the step has run more than `sec` seconds.
 */
function stepTimer(e: OnboardEnv) {
  const start = e.clock.step - 1;
  return { over: (sec: number) => (e.clock.step - start) * e.clock.dt > sec + 1e-9 };
}
/** Ends a step: the robot does nothing for this physics step, and the next step starts on the next one. See `AUTO_TUNING`. */
function* idle(): Behavior<null> { if (AUTO_TUNING.idleAfterStep) yield; return null; }
const stepName = (path: string) => { const id = path.split('/').pop() ?? ''; const m = /^s(\d+)$/.exec(id); return m ? `step ${m[1]}` : id; };
const begin = (e: OnboardEnv, path: string, kind: string, tag?: string) => { e.out.note = `${stepName(path)}: ${kind}`; e.out.step = tag ? { do: kind, tag } : { do: kind }; };

/** Drives to a pose and turns to its heading. It ends on arrival or on its timeout. */
function* driveStep(e: OnboardEnv, pose: Pose, timeoutSec: number): Behavior<null> {
  const timer = stepTimer(e), me = () => e.bots.me; let plannedAt = -1; // `me` is rebuilt each step.
  for (;;) {
    if (timer.over(timeoutSec)) return yield* idle();
    // The robot replans every 0.15 s, which is 36 steps at 240 steps per second.
    if (plannedAt < 0 || (e.clock.step - plannedAt) * e.clock.dt >= 0.15 - 1e-9) { me().drive.plan(pose); plannedAt = e.clock.step; }
    const cmd = me().drive.follow(pose.headingDeg);
    if (cmd.remaining < 0.05 && Math.abs(cmd.headingError) < 0.05 && me().drive.speed < 0.15) return yield* idle();
    me().drive.send(cmd);
    yield;
  }
}

/** Waits `timeoutSec`. */
function* waitStep(e: OnboardEnv, timeoutSec: number): Behavior<null> {
  const timer = stepTimer(e);
  for (;;) { if (timer.over(timeoutSec)) return yield* idle(); yield; }
}

const leaf = defineLeaf<OnboardEnv>();
const NEEDS_CAMERA = ['bots.me.vision'];

const WAYPOINT = t.object({ x: t.number('m'), y: t.number('m'), headingDeg: t.nullable(t.number('deg')) });
const driveTo = leaf({
  id: 'drive.driveTo', version: 1, uses: ['drive'],
  doc: 'Drives to a pose on a path that the path planner picks around the FIELD elements and the AUTO center-line wall, and turns to the pose\'s heading. It ends on arrival or after `timeoutSec`. It leaves the intake as it is.',
  params: {
    pose: { type: POSE, doc: 'The goal, in the alliance frame: red\'s FIELD x and y in meters, and a heading in degrees counterclockwise from +x. Drag it on the FIELD.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'The longest drive. The step ends here even if the robot hasn\'t arrived.' },
    tag: { type: t.string(), default: '', doc: 'A label for tools.' },
  },
  *run(ctx) { const p = ctx.params; begin(ctx.env, ctx.path, 'drive', p.tag || undefined); return yield* driveStep(ctx.env, p.pose, p.timeoutSec); },
});

/** Where a follower moves on to the next waypoint: within this distance of it, in meters, or past it along the path. */
const WAYPOINT_REACHED = 0.15;
const followPath = leaf({
  id: 'drive.followPath', version: 1, uses: ['drive'],
  doc: 'Follows the path through `waypoints` in order, with no path planner: straight lines from where the robot starts, and through each waypoint without stopping. A waypoint with a heading turns the robot to it; one without faces along the path, so the intake leads. It ends at the last waypoint or after `timeoutSec`. It leaves the intake as it is.',
  params: {
    waypoints: { type: t.array(WAYPOINT), doc: 'The path, in the alliance frame. `scripts/plan-sweeps.ts` writes the waypoints of a path tagged `sweep-ROLE`.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'The longest drive along the path.' },
    tag: { type: t.string(), default: '', doc: 'A label for tools. `scripts/plan-sweeps.ts` finds its sweeps by the tags `sweep-solo`, `sweep-right`, and `sweep-left`.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, me = () => e.bots.me; // `me` is rebuilt each step.
    if (AUTO_TUNING.sweepSnapshotDelay !== null && p.tag.startsWith('sweep')) {
      begin(e, ctx.path, 'wait'); yield* waitStep(e, AUTO_TUNING.sweepSnapshotDelay);
      begin(e, ctx.path, 'wait', 'sweep'); return yield* waitStep(e, 30);
    }
    const wps = p.waypoints; if (!wps.length) return null;
    begin(e, ctx.path, 'follow', p.tag || undefined);
    const timer = stepTimer(e), start = { x: me().drive.pose.x, y: me().drive.pose.y };
    const prev = (i: number) => (i === 0 ? start : wps[i - 1]);
    const headings = wps.map((w, i) => w.headingDeg ?? (Math.atan2(w.y - prev(i).y, w.x - prev(i).x) * 180) / Math.PI);
    let k = 0; me().drive.route(wps);
    for (;;) {
      if (timer.over(p.timeoutSec)) return yield* idle();
      for (;;) {
        if (k >= wps.length - 1) break;
        const here = me().drive.pose, a = prev(k), b = wps[k], ux = b.x - a.x, uy = b.y - a.y, l2 = ux * ux + uy * uy;
        const passed = l2 > 0 && ((here.x - a.x) * ux + (here.y - a.y) * uy) / l2 >= 1;
        if (!passed && Math.hypot(here.x - b.x, here.y - b.y) >= WAYPOINT_REACHED) break;
        k++; me().drive.route(wps.slice(k));
      }
      const cmd = me().drive.follow(headings[k]);
      if (k === wps.length - 1 && cmd.remaining < 0.05 && Math.abs(cmd.headingError) < 0.05 && me().drive.speed < 0.15) return yield* idle();
      me().drive.send(cmd); yield;
    }
  },
});

const intakeRun = leaf({
  id: 'intake.run', version: 1, uses: ['intake'],
  doc: 'Runs the intake with `filter` for as long as this leaf runs. It never ends by itself: run it in a `parallel` node of policy `any` beside the steps that collect. When the parallel node ends, or a race halts it, the intake goes back to its default command, which stops it.',
  params: { filter: { type: INTAKE, doc: 'What the intake takes in.' } },
  *run(ctx) {
    try { for (;;) { ctx.env.bots.me.intake.set(ctx.params.filter); yield; } }
    finally { ctx.env.bots.me.intake.stop(); }
  },
});

const push = leaf({
  id: 'drive.push', version: 1, uses: ['drive'],
  doc: 'Pushes straight ahead for `timeoutSec`, for example against the bottom of a FLOWER to pick up its POLLEN. It leaves the intake as it is.',
  params: {
    power: { type: t.number(), min: -1, max: 1, doc: 'The drive power, from -1 to 1. Negative pushes backward.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'How long the push lasts.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e); begin(e, ctx.path, 'push');
    for (;;) { if (timer.over(p.timeoutSec)) return yield* idle(); e.bots.me.drive.push(p.power); yield; }
  },
});

const shoot = leaf({
  id: 'shooter.shoot', version: 1, uses: ['shooter'],
  doc: 'Launches open loop from where the robot stands until `count` elements are gone or the transfer is empty. With `cell`, it holds its fire until the camera sees that CELL raised. A turret holds its fire until it points at the raised CELL. A shooter that launches out of both ends uses the end that faces the robot\'s own HIVE.',
  params: {
    count: { type: t.number(), min: 1, doc: 'How many elements to launch.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'The longest the step lasts, counting the wait for the CELL.' },
    cell: { type: t.nullable(CELL), default: null, doc: 'The CELL to wait for. Null launches at once.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e); let startCount = -1; begin(e, ctx.path, 'shoot');
    for (;;) {
      if (timer.over(p.timeoutSec)) return yield* idle();
      if (p.cell && !e.bots.me.vision.seesRaised(p.cell)) { yield; continue; }
      // A turret holds fire until it points at the CELL: the shooter, not the tree, knows where it aims.
      if (!e.bots.me.shooter.aimed) { yield; continue; }
      if (startCount < 0) startCount = e.bots.me.transfer.count;
      if (e.bots.me.transfer.count === 0 || startCount - e.bots.me.transfer.count >= p.count) return yield* idle();
      e.bots.me.shooter.fire(); yield;
    }
  },
});

const waitUntil = leaf({
  id: 'waitUntil', version: 1,
  doc: 'Waits until `condition` is true, for example `bots.me.transfer.full` or `bots.me.vision.seesRaised(\'rear\')`. With `timeoutSec`, it also ends after that many seconds. It checks the condition on every physics step, and it ends in the step that the condition holds, with no idle step, so that a race against it ends in that step. Put it first in the race.',
  params: {
    condition: { type: t.boolean(), live: true, doc: 'An expression over the environment. It is evaluated on every step.' },
    timeoutSec: { type: t.nullable(t.number('s')), default: null, min: 0, unit: 's', doc: 'The longest wait. Null waits for as long as it takes.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e);
    for (;;) { if (p.condition() || (p.timeoutSec !== null && timer.over(p.timeoutSec))) return null; yield; }
  },
});

const waitTip = leaf({
  id: 'vision.waitTip', version: 1, needs: NEEDS_CAMERA,
  doc: 'Waits until `cell` tips: the camera saw it raised, and then no longer sees it raised. A CELL that isn\'t seen raised after 1 s counts as already tipping.',
  params: {
    cell: { type: CELL, doc: 'The CELL to watch.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'The longest wait.' },
  },
  *run(ctx) {
    const e = ctx.env, timer = stepTimer(e), cell = ctx.params.cell; let sawRaised = false; begin(e, ctx.path, 'waitTip');
    for (;;) {
      if (timer.over(ctx.params.timeoutSec)) return yield* idle();
      if (e.bots.me.vision.seesRaised(cell)) sawRaised = true;
      if ((sawRaised || timer.over(1)) && !e.bots.me.vision.seesRaised(cell)) return yield* idle();
      yield;
    }
  },
});

const wait = leaf({
  id: 'wait', version: 1,
  doc: 'Waits `timeoutSec`, as one step with its idle step. To skip a wait whose only purpose is a pickup that follows, race it against `waitUntil` on a full transfer.',
  params: { timeoutSec: { type: t.number('s'), min: 0, unit: 's', doc: 'How long to wait.' }, tag: { type: t.string(), default: '', doc: 'A label for tools.' } },
  *run(ctx) { begin(ctx.env, ctx.path, 'wait', ctx.params.tag || undefined); return yield* waitStep(ctx.env, ctx.params.timeoutSec); },
});

const FNS: Record<string, FnSpec> = {
  pose: { args: [t.number(), t.number(), t.number()], returns: POSE, impl: (x: number, y: number, headingDeg: number) => ({ x, y, headingDeg }) },
  // offset(p, dx, dy) moves a pose, and a fourth value turns it by that many degrees. The field editor writes it.
  offset: { args: [POSE, t.number(), t.number(), t.number()], required: 3, returns: POSE, impl: (p: Pose, dx: number, dy: number, dh?: number) => ({ x: p.x + dx, y: p.y + dy, headingDeg: dh === undefined ? p.headingDeg : p.headingDeg + dh }) },
};

const intakeSet = leaf({
  id: 'intake.set', version: 1, uses: ['intake'],
  doc: 'Turns the intake on or off for as long as this leaf runs. `on: true` runs the intake with the given `filter`; `on: false` stops it. Never ends by itself — run it in a `parallel any` beside the steps that need it.',
  params: {
    on: { type: t.boolean(), doc: 'True to run the intake, false to stop it.' },
    filter: { type: INTAKE, default: 'all', doc: 'Which elements to accept when on is true.' },
  },
  *run(ctx) {
    const e = ctx.env, { on, filter } = ctx.params;
    try {
      for (;;) {
        if (on) e.bots.me.intake.set(filter); else e.bots.me.intake.stop();
        yield;
      }
    } finally { e.bots.me.intake.stop(); }
  },
});

const intakeFilter = leaf({
  id: 'intake.filter', version: 1, uses: ['intake'],
  doc: 'Runs the intake with the given filter for as long as this leaf runs. Like `intake.run` but with a clearer name. `pollen` only picks up POLLEN; `own_nectar` only picks up your alliance\'s NECTAR; `all` takes everything. Never ends by itself.',
  params: { filter: { type: INTAKE, doc: 'Which elements the intake accepts: all, pollen, own_nectar, or none.' } },
  *run(ctx) {
    try { for (;;) { ctx.env.bots.me.intake.set(ctx.params.filter); yield; } }
    finally { ctx.env.bots.me.intake.stop(); }
  },
});

const turretAngle = leaf({
  id: 'turret.angle', version: 1, uses: ['turret'],
  doc: 'Turns the turret to a robot-relative angle in degrees (0 = mount direction, positive = CCW). Ends when it arrives within 2° or after `timeoutSec`. Has no effect on robots without a turret.',
  params: {
    degrees: { type: t.number('deg'), doc: 'Target angle from the mount direction in degrees. 0 = straight ahead, 90 = left, -90 = right, 180 = behind.' },
    timeoutSec: { type: t.number('s'), min: 0, unit: 's', default: 2, doc: 'Gives up after this many seconds.' },
  },
  *run(ctx) {
    const e = ctx.env, p = ctx.params, timer = stepTimer(e); begin(e, ctx.path, 'turret.angle');
    if (!e.bots.me.turret.hasTurret) return yield* idle();
    for (;;) {
      if (timer.over(p.timeoutSec)) { e.bots.me.turret.release(); return yield* idle(); }
      const cur = e.bots.me.turret.angleDeg;
      if (!Number.isFinite(cur)) { yield; continue; }
      // Shortest-path delta in [-180, 180]
      const diff = ((((p.degrees - cur) % 360) + 540) % 360) - 180;
      if (Math.abs(diff) < 2) { e.bots.me.turret.release(); return yield* idle(); }
      if (diff > 0) e.bots.me.turret.turnLeft(); else e.bots.me.turret.turnRight();
      yield;
    }
  },
});

const turretHold = leaf({
  id: 'turret.hold', version: 1, uses: ['turret'],
  doc: 'Pins the turret at its current robot-relative angle for as long as this leaf runs. For any turret, it keeps the angle instead of auto-aiming. Never ends by itself.',
  params: {},
  *run(ctx) {
    try { for (;;) { ctx.env.bots.me.turret.hold(); yield; } }
    finally { ctx.env.bots.me.turret.release(); }
  },
});

export const AUTO_REGISTRY: Registry = {
  envs: { onboard: ONBOARD_SCHEMA },
  leaves: Object.fromEntries([driveTo, followPath, push, intakeRun, intakeSet, intakeFilter, shoot, waitTip, waitUntil, wait, turretAngle, turretHold].map(l => [l.id, l])),
  fns: FNS,
};

// ---- Trees ----

/** Blank plans are templates with an empty root sequence: they load as drafts (recorded in `AUTO_PROBLEMS`), so the editor can clone them but a robot never runs them. Strict loading would throw on their empty `children` and take down the page. */
const DRAFT_TEMPLATES = new Set<unknown>([blankRight, blankLeft]);
/** The AUTO tree files in the order of the page's AUTO list. The catalog in D1 is seeded from them. */
export const AUTO_FILES: readonly unknown[] = [wallSweepRight, wallSweepLeft, laneSweepRight, laneSweepLeftNoPark, laneSweepLeft, soloSweep, soloSweepNoPark, leaveAndPark, blankRight, blankLeft, custom32294];
const trees: Record<string, TreeDef> = {}, sources: Record<string, Record<string, unknown>> = {}, builtIn = new Set<string>(), problems: Record<string, readonly LoadIssue[]> = {};
/** The AUTO trees by id: the tree files, then the trees that `addAutoTree` adds. A tree file that doesn't load throws with all of its problems. */
export const AUTO_TREES: Readonly<Record<string, TreeDef>> = trees;
/** The JSON source of each AUTO tree, by id, for the field editor, which edits a copy. */
export const AUTO_SOURCES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = sources;
/** The ids of the tree files. `removeAutoTree` can't remove them. */
export const BUILT_IN_AUTO: ReadonlySet<string> = builtIn;
/**
 * The problems of each draft in `AUTO_TREES` that has any, by id. A draft with problems is in `AUTO_TREES`, so that the
 * field editor can show it, but a robot doesn't run it: see `Coach.update`.
 */
export const AUTO_PROBLEMS: Readonly<Record<string, readonly LoadIssue[]>> = problems;
for (const src of AUTO_FILES) builtIn.add(addAutoTree(src, DRAFT_TEMPLATES.has(src)).id);

/**
 * Loads an AUTO tree and adds it to `AUTO_TREES`, or replaces the tree that has its id. The page adds the trees that
 * the field editor saves. A tree with a tree file's id can't replace that file.
 * @param draft If true, adds a tree that has problems too, and records them in `AUTO_PROBLEMS`. If false, throws.
 * @throws TreeLoadError If the tree doesn't load, with all of its problems. A draft throws only when it has no id, isn't
 *   an object, or names no known environment.
 */
export function addAutoTree(src: unknown, draft = false): TreeDef {
  const r = draft ? checkTree(src, AUTO_REGISTRY) : { def: loadTree(src, AUTO_REGISTRY), issues: [] };
  const def = r.def; if (!def || !def.id) throw new TreeLoadError(r.issues);
  if (builtIn.has(def.id)) throw new Error(`the tree '${def.id}' is built in and can't be replaced`);
  trees[def.id] = def; sources[def.id] = structuredClone(src as Record<string, unknown>);
  if (r.issues.length) problems[def.id] = r.issues; else delete problems[def.id];
  return def;
}

/** Removes an AUTO tree that `addAutoTree` added. Returns false for a built-in tree or an unknown id. */
export function removeAutoTree(id: string): boolean {
  if (builtIn.has(id) || !(id in trees)) return false;
  delete trees[id]; delete sources[id]; delete problems[id]; return true;
}

/** The default AUTO for a robot with no partner, and for a name that no tree has. */
export const SOLO_AUTO = 'solo-two-tip-sweep';

/** Gets where an AUTO tree starts: `right`, `left`, or `any`. The page lists only the trees for a robot's start position. */
export const autoStart = (def: TreeDef): 'right' | 'left' | 'any' => (def.meta.start === 'right' || def.meta.start === 'left' ? def.meta.start : 'any');

/**
 * Gets the AUTO tree for a robot. With a partner, the default is the wall-sweep pair: the right robot (slot 0) runs its
 * right half and the left robot (slot 1) its left half. Over 24 seeds, the right half scores 177 combined AUTO points
 * with its partner, where the lane-sweep pair's right robot scores 151.
 * @param selected The robot's AUTO setting. `SOLO_AUTO` means the default.
 */
export function autoFor(sim: Sim, selected: string): string {
  if (!sim.partner()) return selected;
  return sim.slot === 1 ? 'wall-sweep-pair-left' : selected === SOLO_AUTO ? 'wall-sweep-pair-right' : selected;
}

/** Runs one robot's AUTO tree. Call `update` once per physics step in AUTO. */
export class AutoProgram {
  private readonly env = new OnboardAdapter();
  private readonly runner: TreeRunner<OnboardEnv>;
  private n = 0;

  /** @param recorder If given, records a span each time a node runs, for the tree view and the match trace. */
  constructor(readonly def: TreeDef, readonly recorder?: Recorder) {
    this.env.intakeDefault = AUTO_TUNING.intakeDefault ?? undefined;
    this.runner = new TreeRunner(def, { env: this.env, now: () => this.n * this.dt, recorder });
  }
  private dt = 0;

  get path(): Pt[] { return this.env.out.path; }
  get note(): string { return this.env.out.note; }
  get step(): AutoOutput['step'] { return this.env.out.step; }

  update(sim: Sim, dt: number): Inputs {
    this.n++; this.dt = dt; this.env.use(sim, this.n, dt);
    const s = this.runner.step();
    if (s.state === 'running') return this.env.out.inputs;
    this.env.out.path = []; this.env.out.step = null;
    this.env.out.note = s.state === 'error' ? `AUTO error: ${String((s.error as Error)?.message ?? s.error)}` : 'script finished';
    return NO_INPUT;
  }
}

/**
 * Gets a tree's leaves in step order, each with its parameters as they are before the match for the robot that `sim`
 * views. A parameter that reads the clock, the transfer, or the camera gets its pre-match value.
 */
export function leafParams(def: TreeDef, sim: Sim): { node: CNode; params: Record<string, unknown> }[] {
  const env = new OnboardAdapter(); env.use(sim, 0, 0);
  const runner = new TreeRunner(def, { env, now: () => 0 }), out: { node: CNode; params: Record<string, unknown> }[] = [];
  // In a draft with problems, a parameter can fail to evaluate, for example `offset(p, 1, 0)` where `p` is null. Such a
  // leaf is left out.
  const walk = (n: CNode) => { if (n.leaf) { try { out.push({ node: n, params: runner.paramsOf(n)! }); } catch { /* A draft's broken parameter. */ } } n.children.forEach(walk); };
  walk(def.root);
  return out;
}

/** Checks whether a value is a pose with finite numbers. In a draft with problems, a pose parameter can be null. */
export const isPose = (p: unknown): p is Pose => {
  const q = p as Pose | null; return !!q && typeof q === 'object' && [q.x, q.y, q.headingDeg].every(Number.isFinite);
};

/** Checks whether a type is a pose: an object with the number fields `x`, `y`, and `headingDeg`. */
const isPoseType = (ty: { kind: string; fields?: Record<string, { kind: string }> }) =>
  ty.kind === 'object' && ['x', 'y', 'headingDeg'].every(k => ty.fields?.[k]?.kind === 'number');

/** Gets a tree's definitions whose value is a pose, with their values before the match for the robot that `sim` views. */
export function definedPoses(def: TreeDef, sim: Sim): { name: string; pose: Pose }[] {
  const env = new OnboardAdapter(); env.use(sim, 0, 0);
  const runner = new TreeRunner(def, { env, now: () => 0 }), out: { name: string; pose: Pose }[] = [];
  def.defs.forEach((d, i) => {
    if (!isPoseType(d.type as never)) return;
    try { const pose = runner.defValue(i) as Pose; if (isPose(pose)) out.push({ name: def.defNames[i], pose }); } catch { /* A draft's broken definition. */ }
  });
  return out;
}

/**
 * Gets the value of each of a tree's definitions before the match, for the robot that `sim` views, in file order. A
 * value that reads the clock, the transfer, or the camera is its pre-match value. A definition that fails to evaluate,
 * in a draft with problems, gives undefined.
 */
export function defValues(def: TreeDef, sim: Sim): unknown[] {
  const env = new OnboardAdapter(); env.use(sim, 0, 0);
  const runner = new TreeRunner(def, { env, now: () => 0 });
  return def.defs.map((_, i) => { try { return runner.defValue(i); } catch { return undefined; } });
}

/**
 * Gets an AUTO tree's whole trajectory before the match: the planned path through every drive pose, and the poses.
 * It follows the tree's steps in order and skips the race against the clock, so it shows the path of a full AUTO.
 * The plan uses only fixed FIELD geometry, so it is known before the MATCH, like a real AUTO path.
 */
export function previewAuto(def: TreeDef, sim: Sim, start: Pt): { path: Pt[]; poses: (Pt & { heading: number; shoots: boolean })[]; ends: number[] } {
  const rotate = sim.alliance === 'blue', R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
  const leaves = leafParams(def, sim).filter(l => l.node.label !== 'waitUntil' && l.node.label !== 'intake.run');
  // A goal is a pose that the planner routes to, or a waypoint that the robot drives to in a straight line.
  const goals: { pose: Pose; planned: boolean; next: CNode | undefined }[] = [];
  let at: { x: number; y: number } = alliancePose(start, 0, rotate);
  leaves.forEach(({ node: n, params: p }, i) => {
    if (n.label === 'drive.driveTo' && isPose(p.pose)) { const pose = p.pose; goals.push({ pose, planned: true, next: leaves[i + 1]?.node }); at = pose; }
    if (n.label === 'drive.followPath' && Array.isArray(p.waypoints)) {
      const wps = (p.waypoints as { x: number; y: number; headingDeg: number | null }[]).filter(w => w && Number.isFinite(w.x) && Number.isFinite(w.y));
      wps.forEach((w, k) => {
        goals.push({ pose: { x: w.x, y: w.y, headingDeg: w.headingDeg ?? (Math.atan2(w.y - at.y, w.x - at.x) * 180) / Math.PI }, planned: false, next: k === wps.length - 1 ? leaves[i + 1]?.node : undefined });
        at = w;
      });
    }
  });
  // `ends[i]` is the index in `path` where the robot reaches pose `i`, so that tools can find the path into each pose.
  const path: Pt[] = [start], poses: (Pt & { heading: number; shoots: boolean })[] = [], ends: number[] = []; let from = start;
  for (const { pose, planned, next } of goals) {
    const goal = simPoint(pose, rotate);
    path.push(...(planned ? planPath(from, goal, R, [...fieldObstacles(), centerWall(rotate)]).slice(1) : [goal])); from = goal;
    poses.push({ ...goal, heading: simHeading(pose.headingDeg, rotate), shoots: next?.label === 'shooter.shoot' }); ends.push(path.length - 1);
  }
  return { path, poses, ends };
}
