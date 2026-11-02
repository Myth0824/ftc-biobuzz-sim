import type RAPIER_NS from '@dimforge/rapier3d-compat';
import manifest from '../../cad/field-manifest.json';
import { BALL, DEFAULT_ROBOT, FIELD, HIVE, MATCH, POINTS, RP, TIP_LOAD, type LaunchParams, type RobotConfig } from './config';
import { mecanumForces, type DriveCommand } from './drivetrain';
import { GROUP, Hive, groups, type Alliance } from './hive';
import { Rng } from './rng';

type R = typeof RAPIER_NS;
export type BallKind = 'pollen' | 'nectar_red' | 'nectar_blue';
export type Phase = 'pre' | 'auto' | 'transition' | 'teleop' | 'post';
/** `auto` plays the 30 s AUTO period and ends the MATCH there. `practice` has no clock. */
export type MatchMode = 'practice' | 'teleop' | 'full' | 'auto';

export interface Ball { id: number; kind: BallKind; body: RAPIER_NS.RigidBody; radius: number; retryAt: number; airborne: boolean }
export interface Flower { id: string; x: number; z: number; stack: BallKind[] }
/** Driver inputs for one step. Buttons are level-triggered; the sim applies the rate limits. */
/** Which floor elements the intake accepts. A program sets it per tactic, like a color-sensor sorter. Default: all. */
export type IntakeFilter = 'all' | 'pollen' | 'own_nectar' | 'none';
export interface Inputs extends DriveCommand { shootNectar: boolean; shootPollen: boolean; placeNectar: boolean; placePollen: boolean; intake?: IntakeFilter; intakeHeld?: boolean; turretLeft?: boolean; turretRight?: boolean }
export const NO_INPUT: Inputs = { forward: 0, strafeRight: 0, turnRight: 0, shootNectar: false, shootPollen: false, placeNectar: false, placePollen: false, turretLeft: false, turretRight: false };

/** Gets the short code for a ball kind in traces and logs: P, RN, or BN. */
export const code = (k: BallKind) => (k === 'pollen' ? 'P' : k === 'nectar_red' ? 'RN' : 'BN');

export interface AllianceScore {
  leave: number; autoPark: number; autoTips: number; teleopTips: number; cell: number; flower: number;
  bottomNectar: number; garden: number; park: number; /** Points credited for the opponent's FOULS. */ fouls: number; total: number;
  rp: { swarm: boolean; pollinator1: boolean; pollinator2: boolean };
}

const radiusOf = (k: BallKind) => (k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius);
const massOf = (k: BallKind) => (k === 'pollen' ? BALL.pollenMass : BALL.nectarMass);
/**
 * Gets the bottom height of each element in a FLOWER stack, bottom to top. POLLEN falls to the floor
 * position, where a robot can remove it. NECTAR stops at the middle ring, so it plugs the FLOWER.
 */
export function flowerHeights(stack: BallKind[]): number[] {
  const out: number[] = []; let h = 0;
  for (const k of stack) { const b = k === 'pollen' ? h : Math.max(h, FIELD.flowerNectarSeat); out.push(b); h = b + 2 * radiusOf(k); }
  return out;
}
/** Checks whether a robot can remove POLLEN from the bottom of this stack. */
export const retrievable = (stack: BallKind[]) => stack[0] === 'pollen';
/** Gets the height of the top of a FLOWER stack. */
export const stackTop = (stack: BallKind[]) => { const h = flowerHeights(stack); return stack.length ? h[h.length - 1] + 2 * radiusOf(stack[stack.length - 1]) : 0; };
const inRect = (x: number, z: number, r: readonly number[], pad = 0) => x > r[0] - pad && x < r[1] + pad && z > r[2] - pad && z < r[3] + pad;

export type MatchEvent = 'match_start' | 'auto_end' | 'pick_up_controllers' | 'countdown' | 'teleop_start' | 'flowers_unlock' | 'endgame' | 'match_end' | 'foul';

export const DT = 1 / 240;

/** The state of one robot. */
export interface RobotState {
  alliance: Alliance; cfg: RobotConfig; body: RAPIER_NS.RigidBody; carried: BallKind[];
  telemetry: { busVoltage: number; speed: number };
  /** 0 for the first robot of its alliance, 1 for its partner. Partners use it to split launch spots and work. */
  slot: 0 | 1;
  /** What the robot's program is doing, for example `tip_hive` or `work_flower:rear`. Alliance partners read it, the way drive teams talk. */
  intent: string;
  /** What a drive team can see of a partner and what partners tell each other: the phase, the CELL they aim for, the load in hand, and the pickups they are going for. */
  plan: { phase: 'collect' | 'launch' | 'park' | 'other'; side: 'rear' | 'audience' | null; load: number; claims: string[]; goal: { x: number; z: number } | null; /** The half of the FIELD that this robot keeps to under the sides convention, or null. */ zone: 'rear' | 'audience' | null };
  placing: { until: number; kind: 'pollen' | 'nectar'; flower: Flower } | null;
  shotReadyAt: { nectar: number; pollen: number }; flowerReadyAt: number; lastForward: number; autoLeave: boolean; autoPark: boolean;
  /** A limited turret's angle from the shooter's mount direction, in radians, or NaN before its first step. */
  turretAngle: number;
  /** The drive command of the last step, for the referee: what the robot was trying to do. */
  lastCmd: Inputs;
}
export interface SimOptions {
  /** If true, the blue alliance plays. Default: false. */ opponent?: boolean;
  /** If true, every alliance that plays has two robots. Default: false. */ partners?: boolean;
  /**
   * Total number of AI opponent robots on the field (0–3). Overrides `opponent` and `partners` when set.
   * 0 = just your robot. 1 = one red partner. 2 = one red partner + one blue. 3 = one red partner + two blue.
   */
  opponentCount?: number;
  /** If true, the MATCH is a playoff MATCH: ranking points don't exist, so the planner maximizes points alone. Default: false. */ playoff?: boolean;
  /** Gets the configuration of one robot, for experiments that vary a design. Default: the constructor's `cfg` for all. */
  configFor?: (alliance: Alliance, slot: 0 | 1) => RobotConfig | undefined;
}

/** Switches for experiments on the pre-MATCH setup. */
export const STAGING = {
  /**
   * If false, the three NECTAR in each raised CELL start at the CAD staging spots: touching each other in a row against
   * the back skin, packed against the side wall nearest their own ALLIANCE AREA. The Event Field Setup Guide, section
   * 11.1, and the Competition Manual, section 10.3.1, place them there. If true, they drop in at random spots drawn from
   * the seed and settle before the MATCH starts, which a FIELD crew doesn't do. Default: false.
   */
  randomCellNectar: false,
  /** The seconds of physics that the constructor runs after a random drop, so that the NECTAR are at rest at the start. */
  settleSec: 1.5,
};

/** The BIOBUZZ match simulation. It has no rendering or DOM dependency, so it also runs headless. */
export class Sim {
  world: RAPIER_NS.World;
  balls = new Map<number, Ball>();
  flowers: Flower[] = [];
  hives: Record<Alliance, Hive>;
  /** Every robot on the FIELD. Index 0 is the player's robot. */
  robots: RobotState[] = [];
  /** The robot that `robot`, `carried`, `alliance`, `cfg`, and the pose helpers refer to. See `view`. */
  me = 0;
  phase: Phase = 'pre';
  time = 0;            // Seconds since the match started
  clock = 0;           // Seconds remaining in the current period
  messages: { t: number; text: string }[] = [];
  /** Match milestones since the last drain, in the order of Table 9-1. The page plays a sound for each. */
  events: MatchEvent[] = []; private endgameCued = false; private pickupCued = false; private countCued = false;
  stash: Record<Alliance, number> = { red: FIELD.nectarStash, blue: FIELD.nectarStash };
  /** Foul points credited to each alliance. A referee adds to it with `foul`. */
  foulPoints: Record<Alliance, number> = { red: 0, blue: 0 };
  private owed: Record<Alliance, { at: number }[]> = { red: [], blue: [] };
  private autoTips: Record<Alliance, number> = { red: 0, blue: 0 };
  // Counters live in an object so that a view, which inherits from the sim, updates the shared value.
  private shared = { nextId: 1, epoch: 0 };
  private simTime = 0; private views: Sim[] = [];
  /**
   * Ball positions and CELL tallies for the current epoch. The epoch changes after each world step and each time a ball
   * is added, removed, or moved by the sim, so between two steps, where all four planners run, Rapier is read once per
   * ball. Mutate this object; don't replace it, because views share it through the prototype.
   */
  private frame = { epoch: -1, pos: new Map<number, RAPIER_NS.Vector>(), cell: {} as Partial<Record<Alliance, { count: number; load: number }>> };
  /** Starts a new epoch. Call it after anything that moves, adds, or removes a ball, or that moves a HIVE. */
  private touch() { this.shared.epoch++; }
  private fresh() { const f = this.frame; if (f.epoch !== this.shared.epoch) { f.epoch = this.shared.epoch; f.pos.clear(); f.cell = {}; } return f; }

  get robot() { return this.robots[this.me].body; }
  get carried() { return this.robots[this.me].carried; } set carried(v: BallKind[]) { this.robots[this.me].carried = v; }
  get alliance() { return this.robots[this.me].alliance; }
  get cfg() { return this.robots[this.me].cfg; }
  get telemetry() { return this.robots[this.me].telemetry; } set telemetry(v) { this.robots[this.me].telemetry = v; }
  private get placing() { return this.robots[this.me].placing; } private set placing(v) { this.robots[this.me].placing = v; }
  private get shotReadyAt() { return this.robots[this.me].shotReadyAt; }
  private get flowerReadyAt() { return this.robots[this.me].flowerReadyAt; } private set flowerReadyAt(v) { this.robots[this.me].flowerReadyAt = v; }
  private get lastForward() { return this.robots[this.me].lastForward; } private set lastForward(v) { this.robots[this.me].lastForward = v; }

  /**
   * Gets the sim from another robot's point of view. The view shares all state with the sim; only `me` differs,
   * so `robot`, `carried`, `alliance`, and the pose helpers refer to that robot. Call `step` on the sim, not on a view.
   */
  view(i: number): Sim { return (this.views[i] ??= Object.assign(Object.create(this) as Sim, { me: i })); }
  /**
   * Gets the other robots as circles, for the path planner. The radius is the half width, not the half diagonal:
   * the two alliances' launch spots are 0.65 m apart, and square robots fit side by side there.
   */
  otherRobots() { return this.robots.filter((_, i) => i !== this.me).map(r => { const p = r.body.translation(); return { x: p.x, z: p.z, r: Math.min(r.cfg.length, r.cfg.width) / 2, alliance: r.alliance, carried: r.carried, intent: r.intent, slot: r.slot, plan: r.plan, speed: Math.hypot(r.body.linvel().x, r.body.linvel().z) }; }); }
  /** Gets the alliance partner, if there is one. */
  partner() { return this.otherRobots().find(o => o.alliance === this.alliance) ?? null; }
  get slot() { return this.robots[this.me].slot; }
  rng: Rng;

  constructor(private rapier: R, cfg: RobotConfig = structuredClone(DEFAULT_ROBOT), public mode: MatchMode = 'teleop', seed = 1, public options: SimOptions = {}) {
    this.rng = new Rng(seed);
    this.world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = DT; this.world.numSolverIterations = 8;
    this.buildField();
    this.hives = {
      red: new Hive(rapier, this.world, 'red', 'audience'),
      blue: new Hive(rapier, this.world, 'blue', 'rear'),
    };
    for (const h of Object.values(this.hives)) h.epoch = 0;
    // Order: the player's robot, its partner (if any), then the blue robots.
    // opponentCount overrides opponent/partners when provided: 0=solo, 1=+R1, 2=+R1+B0, 3=+R1+B0+B1
    const oc = options.opponentCount;
    const redSlots: (0|1)[] = oc !== undefined ? (oc >= 1 ? [0, 1] : [0]) : (options.partners ? [0, 1] : [0]);
    const blueSlots: (0|1)[] = oc !== undefined ? (oc >= 3 ? [0, 1] : oc >= 2 ? [0] : []) : (options.opponent ? (options.partners ? [0, 1] : [0]) : []);
    for (const slot of redSlots) this.robots.push(this.buildRobot('red', options.configFor?.('red', slot) ?? (this.robots.length ? structuredClone(cfg) : cfg), slot));
    for (const slot of blueSlots) this.robots.push(this.buildRobot('blue', options.configFor?.('blue', slot) ?? structuredClone(cfg), slot));
    this.stageElements(new Rng((seed ^ 0x5a17c3e5) >>> 0));
    if (mode === 'practice') { this.phase = 'teleop'; this.clock = Infinity; }
  }

  // ---------- setup ----------

  private fixed(hx: number, hy: number, hz: number, x: number, y: number, z: number, group = GROUP.struct, rot?: { x: number; y: number; z: number; w: number }) {
    const c = this.rapier.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.7).setRestitution(0.4)
      .setCollisionGroups(groups(group, 0xffff));
    if (rot) c.setRotation(rot);
    return this.world.createCollider(c);
  }

  private buildField() {
    const h = FIELD.half, t = FIELD.wallThickness, wh = FIELD.wallHeight / 2;
    this.fixed(h + 1, 0.05, h + 1, 0, -0.05, 0, GROUP.floor);
    for (const s of [-1, 1]) {
      this.fixed(t / 2, wh, h + t, s * (h + t / 2), wh, 0);
      this.fixed(h + t, wh, t / 2, 0, wh, s * (h + t / 2));
    }
    // HIVE frame: two foot bars on the TILES, and four legs that lean from each foot to the top corner.
    const fb = HIVE.footBar, a = HIVE.legFoot, t2 = HIVE.legTop;
    for (const sx of [-1, 1]) {
      this.fixed(fb.halfX, fb.height / 2, fb.halfZ, sx * fb.x, fb.height / 2, 0);
      for (const sz of [-1, 1]) {
        const d = { x: sx * (t2.x - a.x), y: t2.y - a.y, z: sz * (t2.z - a.z) }, len = Math.hypot(d.x, d.y, d.z);
        // Quaternion that rotates the cuboid's Y axis onto the leg direction.
        const u = { x: d.x / len, y: d.y / len, z: d.z / len }, w = 1 + u.y, n = Math.hypot(u.z, w, u.x);
        this.fixed(HIVE.legSize / 2, len / 2, HIVE.legSize / 2, sx * (a.x + t2.x) / 2, (a.y + t2.y) / 2, sz * (a.z + t2.z) / 2,
          GROUP.struct, { x: u.z / n, y: 0, z: -u.x / n, w: w / n });
      }
    }
    for (const f of FIELD.flowers) {
      this.fixed(FIELD.flowerHalfSize, FIELD.flowerTop / 2, FIELD.flowerHalfSize, f.x, FIELD.flowerTop / 2, f.z);
      this.flowers.push({ ...f, stack: ['pollen', 'pollen', 'pollen', 'pollen'] });
    }
  }

  /** Places the SCORING ELEMENTS. `rng` draws the CELL NECTAR layout. It is a separate stream, so the layout doesn't shift the MATCH's other draws. */
  private stageElements(rng: Rng) {
    const st = manifest.staging as Record<string, number[][]>;
    for (const p of st.pollen) if (Math.abs(p[2]) > 1.74 && Math.abs(p[0]) < 1.79) this.spawn('pollen', p[0], p[1], p[2]); // GARDENS
    for (const kind of ['nectar_red', 'nectar_blue'] as const) {
      const cell = st[kind].filter(p => p[1] > 1);                                                                     // CELLS
      if (!STAGING.randomCellNectar) { for (const p of cell) this.spawn(kind, p[0], p[1] + 0.004, p[2]); continue; }
      this.dropInCell(this.hives[kind === 'nectar_red' ? 'red' : 'blue'], kind, cell.length, rng);
    }
    if (STAGING.randomCellNectar) this.settle(STAGING.settleSec);
    // Absent robots: their pre-load POLLEN go in the LOADING ZONE against the wall (section 10.3.1).
    const absent = (['red', 'blue'] as Alliance[]).map(a => [a, 4 * (2 - this.robots.filter(r => r.alliance === a).length)] as [Alliance, number]);
    for (const [a, n] of absent) {
      const z = FIELD.loadingZone[a], sx = a === 'red' ? -1 : 1;
      for (let i = 0; i < n; i++) this.spawn('pollen', sx * (FIELD.half - 0.04 - 0.075 * (i % 2)), FIELD.pollenRadius, (z[2] + z[3]) / 2 + (Math.floor(i / 2) - n / 4 + 0.5) * 0.075);
    }
  }

  /**
   * Drops `n` balls at uniform random spots in the raised CELL of `hive`, 1 cm to 8 cm above its floor and clear of
   * each other. They then roll to wherever the CELL's slope and each other leave them.
   */
  private dropInCell(hive: Hive, kind: BallKind, n: number, rng: Rng) {
    const r = radiusOf(kind), placed: { lx: number; along: number; ly: number }[] = [];
    const u = (lo: number, hi: number) => lo + (hi - lo) * rng.next();
    for (let i = 0; i < n; i++) {
      let q = { lx: 0, along: 0, ly: 0 };
      for (let tries = 0; tries < 100; tries++) {
        q = { lx: u(-HIVE.cellHalfWidth + r + 0.005, HIVE.cellHalfWidth - r - 0.005), along: u(HIVE.cellBack + r + 0.005, HIVE.cellMouth - r - 0.01), ly: HIVE.cellFloorY + r + u(0.01, 0.08) };
        if (placed.every(o => Math.hypot(o.lx - q.lx, o.along - q.along, o.ly - q.ly) > 2 * r + 0.005)) break;
      }
      placed.push(q); const w = hive.raisedCellPoint(q.lx, q.ly, q.along); this.spawn(kind, w.x, w.y, w.z);
    }
  }

  /** Runs the physics for `sec` with no robot input and the clock stopped, as before a MATCH. */
  private settle(sec: number) {
    for (let i = 0; i < sec / DT; i++) {
      for (const h of Object.values(this.hives)) h.applyTorques();
      this.world.step(); this.touch();
      for (const h of Object.values(this.hives)) h.epoch!++;
    }
  }

  private buildRobot(alliance: Alliance, c: RobotConfig, slot: 0 | 1): RobotState {
    // G304: touching a perimeter wall on the own side, clear of the FLOWERS and of the LOADING ZONE. The first robot
    // starts on the alliance wall and faces the field. Its partner starts on the rear wall (red) or the audience
    // wall (blue), next to the FLOWER that its AUTO script uses. Blue is red rotated 180° about the FIELD center.
    const sx = alliance === 'red' ? -1 : 1, edge = FIELD.half - c.length / 2 - 0.002;
    const pose = slot === 0 ? { x: sx * edge, z: sx * -0.1, th: sx < 0 ? 0 : Math.PI } : { x: sx * 1.05, z: sx * edge, th: sx < 0 ? Math.PI / 2 : -Math.PI / 2 };
    const body = this.world.createRigidBody(this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, 0.02 + c.height / 2, pose.z)
      .setRotation({ x: 0, y: Math.sin(pose.th / 2), z: 0, w: Math.cos(pose.th / 2) })
      .enabledTranslations(true, false, true).enabledRotations(false, true, false).setCanSleep(false).setCcdEnabled(true));
    this.world.createCollider(this.rapier.ColliderDesc.cuboid(c.length / 2, c.height / 2, c.width / 2)
      .setMassProperties(c.mass, { x: 0, y: 0, z: 0 }, { x: c.yawInertia, y: c.yawInertia, z: c.yawInertia }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.25).setRestitution(0.1)
      .setCollisionGroups(groups(GROUP.robot, GROUP.struct | GROUP.ball | GROUP.robot)), body);
    // G304.G: four pre-loaded POLLEN.
    return { alliance, slot, intent: '', plan: { phase: 'other', side: null, load: 0, claims: [], goal: null, zone: null }, cfg: c, body, carried: ['pollen', 'pollen', 'pollen', 'pollen'], telemetry: { busVoltage: 12.8, speed: 0 }, placing: null,
      shotReadyAt: { nectar: 0, pollen: 0 }, flowerReadyAt: 0, lastForward: 0, autoLeave: false, autoPark: false, turretAngle: Number.NaN, lastCmd: { ...NO_INPUT } };
  }

  spawn(kind: BallKind, x: number, y: number, z: number, vel?: { x: number; y: number; z: number }, spin?: { x: number; y: number; z: number }): Ball {
    const r = radiusOf(kind);
    const body = this.world.createRigidBody(this.rapier.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setLinearDamping(BALL.linearDamping).setAngularDamping(BALL.angularDamping).setCcdEnabled(true));
    if (vel) body.setLinvel(vel, true); if (spin) body.setAngvel(spin, true);
    this.world.createCollider(this.rapier.ColliderDesc.ball(r).setMass(massOf(kind)).setFriction(BALL.friction)
      .setRestitution(BALL.restitution).setCollisionGroups(groups(GROUP.ball, 0xffff)), body);
    const b: Ball = { id: this.shared.nextId++, kind, body, radius: r, retryAt: 0, airborne: !!vel };
    this.balls.set(b.id, b); this.touch(); return b;
  }

  private remove(b: Ball) { this.world.removeRigidBody(b.body); this.balls.delete(b.id); this.touch(); }
  say(text: string) { this.messages.push({ t: this.simTime, text }); if (this.messages.length > 6) this.messages.shift(); }

  // ---------- robot pose helpers ----------

  get heading(): number { const q = this.robot.rotation(); return 2 * Math.atan2(q.y, q.w); }
  private axes() { const th = this.heading; return { fwd: { x: Math.cos(th), z: -Math.sin(th) }, left: { x: -Math.sin(th), z: -Math.cos(th) } }; }
  /** Converts a robot-frame point (forward, left) to world X and Z. */
  toWorld(f: number, l: number) { const p = this.robot.translation(), a = this.axes(); return { x: p.x + a.fwd.x * f + a.left.x * l, z: p.z + a.fwd.z * f + a.left.z * l }; }
  /** Converts world X and Z to the robot frame (forward, left). */
  toRobot(x: number, z: number) { const p = this.robot.translation(), a = this.axes(), dx = x - p.x, dz = z - p.z; return { f: dx * a.fwd.x + dz * a.fwd.z, l: dx * a.left.x + dz * a.left.z }; }

  // ---------- match flow ----------

  start() {
    if (this.phase !== 'pre') return;
    const hasAuto = this.mode === 'full' || this.mode === 'auto';
    if (hasAuto) { this.phase = 'auto'; this.clock = MATCH.auto; } else { this.phase = 'teleop'; this.clock = MATCH.teleop; }
    this.say(hasAuto ? 'AUTO begins' : 'TELEOP begins'); this.events.push('match_start');
  }

  /** Seconds remaining in the MATCH as shown on the FIELD timer (TELEOP counts from 2:00). */
  get timer(): number { return this.phase === 'pre' ? (this.mode === 'full' || this.mode === 'auto' ? MATCH.auto : MATCH.teleop) : this.clock; }
  get flowersUnlocked(): boolean { return this.mode === 'practice' || (this.phase === 'teleop' && this.clock <= MATCH.flowerUnlock) || this.phase === 'post'; }
  get driverEnabled(): boolean { return this.phase === 'teleop'; }

  private advanceClock() {
    if (this.phase === 'pre' || this.phase === 'post' || this.mode === 'practice') return;
    this.time += DT; this.clock -= DT;
    if (this.phase === 'transition' && !this.pickupCued) { this.pickupCued = true; this.events.push('pick_up_controllers'); }
    if (this.phase === 'transition' && this.clock <= 3 && !this.countCued) { this.countCued = true; this.events.push('countdown'); }
    if (this.phase === 'teleop' && this.clock <= MATCH.endgame && !this.endgameCued) { this.endgameCued = true; this.events.push('endgame'); }
    if (this.clock > 0) return;
    if (this.phase === 'auto') {
      this.robots.forEach((r, i) => {
        const p = r.body.translation(), reach = Math.max(r.cfg.length, r.cfg.width) / 2 + 0.02;
        r.autoLeave = FIELD.half - Math.max(Math.abs(p.x), Math.abs(p.z)) > reach; r.autoPark = this.view(i).robotInLoadingZone();
      });
      this.autoTips = { red: this.hives.red.tips, blue: this.hives.blue.tips };
      if (this.mode === 'auto') { this.phase = 'post'; this.clock = 0; this.say('AUTO ends'); this.events.push('match_end'); return; }
      this.phase = 'transition'; this.clock = MATCH.transition; this.say('AUTO ends'); this.events.push('auto_end');
    } else if (this.phase === 'transition') { this.phase = 'teleop'; this.clock = MATCH.teleop; this.say('TELEOP begins'); this.events.push('teleop_start'); }
    else if (this.phase === 'teleop') { this.phase = 'post'; this.clock = 0; this.say('MATCH ends'); this.events.push('match_end'); }
  }

  // ---------- one physics step ----------

  /**
   * Advances the simulation by DT.
   * @param input The controller state for robot 0, or one entry per robot.
   * @param fromProgram If true, the input comes from code, so it also applies during AUTO.
   *   If false, it comes from a human and applies only during TELEOP (G401). One flag, or one per robot.
   */
  step(input: Inputs | Inputs[], fromProgram: boolean | boolean[] = false) {
    this.simTime += DT;
    const wasLocked = !this.flowersUnlocked;
    this.advanceClock();
    if (wasLocked && this.flowersUnlocked && this.mode !== 'practice') { this.say('FLOWERS unlocked: all remaining NECTAR can enter'); this.events.push('flowers_unlock'); }
    const inputs = Array.isArray(input) ? input : [input], prog = Array.isArray(fromProgram) ? fromProgram : [fromProgram];
    const per = this.robots.map((_, i) => {
      const active = this.driverEnabled || ((prog[i] ?? false) && this.phase === 'auto');
      return { v: this.view(i), active, inp: active ? inputs[i] ?? NO_INPUT : NO_INPUT };
    });
    for (const r of per) r.v.driveRobot(r.inp);
    for (const h of Object.values(this.hives)) h.applyTorques();
    this.aero();
    this.world.step(); this.touch();
    for (const h of Object.values(this.hives)) h.epoch!++;
    for (const a of ['red', 'blue'] as Alliance[]) {
      if (this.hives[a].pollTip()) { this.say(`${a.toUpperCase()} HIVE TIP (${this.hives[a].tips})`); this.owed[a].push({ at: this.simTime + 2 }); }
    }
    this.humanPlayers();
    for (const r of per) { r.v.aimTurret(); r.v.intake(r.active && r.inp.intakeHeld !== undefined && !r.inp.intakeHeld ? 'none' : (r.inp.intake ?? 'all')); if (r.active) { r.v.shoot(r.inp); r.v.place(r.inp); } }
    this.housekeeping(); this.touch();
  }

  private driveRobot(inp: Inputs) {
    const v = this.robot.linvel(), a = this.axes();
    const vel = { vf: v.x * a.fwd.x + v.z * a.fwd.z, vl: v.x * a.left.x + v.z * a.left.z, w: this.robot.angvel().y };
    const out = mecanumForces(this.cfg, inp, vel); this.lastForward = inp.forward;
    this.robots[this.me].lastCmd = { ...inp };
    // Rolling and scrub resistance, opposing the direction of travel.
    const sp = Math.hypot(v.x, v.z), rr = this.cfg.rollingResistance * this.cfg.mass * 9.81;
    const c = this.cfg.viscousLoss, k = this.cfg.halfWheelbase + this.cfg.halfTrack;
    const fx = a.fwd.x * out.forceF + a.left.x * out.forceL - (sp > 0.02 ? (v.x / sp) * rr : 0) - c * v.x;
    const fz = a.fwd.z * out.forceF + a.left.z * out.forceL - (sp > 0.02 ? (v.z / sp) * rr : 0) - c * v.z;
    this.robot.resetForces(true); this.robot.resetTorques(true);
    this.robot.addForce({ x: fx, y: 0, z: fz }, true); this.robot.addTorque({ x: 0, y: out.torque - c * k * k * vel.w, z: 0 }, true);
    this.telemetry = { busVoltage: out.busVoltage, speed: sp };
  }

  /** Applies quadratic drag and Magnus lift to airborne balls. */
  private aero() {
    for (const b of this.balls.values()) {
      b.body.resetForces(true);
      if (!b.airborne) continue;
      const v = b.body.linvel(), sp = Math.hypot(v.x, v.y, v.z);
      if (sp < 0.8 || b.body.translation().y < b.radius + 0.01) { b.airborne = false; continue; }
      const area = Math.PI * b.radius * b.radius, q = 0.5 * BALL.airDensity * area * sp;
      const w = b.body.angvel(), wm = Math.hypot(w.x, w.y, w.z);
      let fx = -q * BALL.dragCd * v.x, fy = -q * BALL.dragCd * v.y, fz = -q * BALL.dragCd * v.z;
      if (wm > 1) {
        const cl = Math.min(0.35, (b.radius * wm) / sp), k = (q * cl * sp) / (wm * sp);
        fx += k * (w.y * v.z - w.z * v.y); fy += k * (w.z * v.x - w.x * v.z); fz += k * (w.x * v.y - w.y * v.x);
      }
      b.body.addForce({ x: fx, y: fy, z: fz }, true);
    }
  }

  private humanPlayers() {
    for (const a of ['red', 'blue'] as Alliance[]) {
      if (this.flowersUnlocked && this.mode !== 'practice' && this.stash[a] > 0 && this.owed[a].length === 0) this.owed[a].push({ at: this.simTime + 0.8 });
      const due = this.owed[a][0];
      if (!due || due.at > this.simTime) continue;
      this.owed[a].shift();
      if (this.stash[a] <= 0) continue;
      this.stash[a]--;
      const z = FIELD.loadingZone[a];
      this.spawn(a === 'red' ? 'nectar_red' : 'nectar_blue', this.rng.gauss((z[0] + z[1]) / 2, 0.04), 0.25, this.rng.gauss((z[2] + z[3]) / 2, 0.12), { x: 0, y: -0.5, z: 0 });
      if (a === this.robots[0].alliance) this.say(`HUMAN PLAYER entered NECTAR (${this.stash[a]} left)`);
    }
  }

  private intake(filter: IntakeFilter) {
    const c = this.cfg; if (this.carried.length >= c.capacity || filter === 'none') return;
    const opp: BallKind = this.alliance === 'red' ? 'nectar_blue' : 'nectar_red';
    // intakeHeld is only set by human input. AI always uses undefined (see NO_INPUT).
    const humanDriven = (this.robots[this.me].lastCmd as Inputs).intakeHeld !== undefined;
    for (const b of this.balls.values()) {
      if (this.carried.length >= c.capacity) break;
      const p = b.body.translation(); if (p.y > 0.13 || b.retryAt > this.simTime) continue;
      const isOppNectar = b.kind === opp;
      // AI obeys G408 and never picks up opponent nectar; human can but gets a penalty
      if (isOppNectar && !humanDriven) continue;
      if ((filter === 'pollen' && b.kind !== 'pollen') || (filter === 'own_nectar' && b.kind === 'pollen')) continue;
      const r = this.toRobot(p.x, p.z);
      const ahead = c.intake.dualSided ? Math.abs(r.f) : r.f;
      if (ahead < c.length / 2 - 0.01 || ahead > c.length / 2 + c.intake.reach + b.radius || Math.abs(r.l) > c.intake.width / 2) continue;
      if (this.rng.bernoulli(c.intake.successP)) {
        this.carried.push(b.kind); this.remove(b);
        if (isOppNectar) {
          // G408: minor foul — 5 points to the opponent alliance
          const oppAlliance = this.alliance === 'red' ? 'blue' : 'red';
          this.foulPoints[oppAlliance] = (this.foulPoints[oppAlliance] ?? 0) + 5;
          this.say(`G408: MINOR FOUL — picked up opponent NECTAR (+5 pts to ${oppAlliance.toUpperCase()})`);
        }
      }
      else b.retryAt = this.simTime + c.intake.retrySec;
    }
    // POLLEN can also be removed from the bottom of a FLOWER (G418.B).
    // Pulling from a FLOWER needs driver intent: the robot must be pushing forward into it.
    if (filter !== 'own_nectar' && this.carried.length < c.capacity && this.simTime >= this.flowerReadyAt && !this.placing && this.lastForward > 0.15) {
      for (const f of this.flowers) {
        const r = this.toRobot(f.x, f.z);
        if (r.f < 0 || r.f > c.length / 2 + c.intake.flowerReach + FIELD.flowerHalfSize || Math.abs(r.l) > c.intake.width / 2 || f.stack[0] !== 'pollen') continue;
        this.flowerReadyAt = this.simTime + c.intake.flowerPeriodSec;
        if (this.rng.bernoulli(c.intake.successP)) { f.stack.shift(); this.carried.push('pollen'); }
        break;
      }
    }
  }

  /** Checks whether a shot leaves the rear end. A dual-sided shooter uses the end that faces the own HIVE from the given pose. */
  launchesRear(pose?: { x: number; z: number; heading: number }): boolean {
    if (!this.cfg.shooter.dualSided) return this.cfg.shooter.facing === 'rear';
    const p = pose ?? { x: this.robot.translation().x, z: this.robot.translation().z, heading: this.heading }, m = this.hives[this.alliance].mouthCenter();
    return Math.cos(p.heading) * (m.x - p.x) - Math.sin(p.heading) * (m.z - p.z) < 0;
  }

  /**
   * Gets the heading in radians that a turret launches along from the robot's pose, or from `pose`: toward the raised
   * CELL's mouth of the own HIVE. See `ShooterConfig.turret`.
   */
  turretHeading(pose?: { x: number; z: number }): number {
    const p = pose ?? this.robot.translation(), m = this.hives[this.alliance].mouthCenter();
    return Math.atan2(-(m.z - p.z), m.x - p.x);
  }

  /** True for a turret with a limited range of motion or slew rate: it has an angle that `aimTurret` turns. */
  get turretLimited(): boolean {
    const s = this.cfg.shooter; return !!s.turret && ((s.turretRangeDeg ?? 360) < 360 || Number.isFinite(s.turretSlewDegPerSec ?? Infinity));
  }

  /** True for any turret robot — turretAngle is always tracked, whether limited or full 360. */
  get hasTurret(): boolean { return !!this.cfg.shooter.turret; }

  /** Gets the direction that the shooter's mount faces, in radians: the robot's heading, turned 180° for a rear shooter. */
  mountHeading(heading = this.heading): number { return heading + (this.cfg.shooter.facing === 'rear' ? Math.PI : 0); }

  /**
   * Turns a limited turret toward the raised CELL's mouth by at most its slew rate for one step, within its range of
   * motion. A turret with less than a full turn of range can't pass its stops, so it takes the long way around.
   * If the current robot's input has turretLeft or turretRight set, manual control overrides auto-aim.
   */
  private aimTurret() {
    if (!this.hasTurret) return;
    const s = this.cfg.shooter, st = this.robots[this.me];
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    // For a manual 360° turret: turretAngle stores robot-relative offset (0 = facing same as robot front).
    // Arrow right turns the turret clockwise (negative in math convention) = subtract from angle.
    const isFullManual = !this.turretLimited;
    const MANUAL_SLEW = Math.PI * DT; // 180°/s — one full turn in 2 s

    if (!Number.isFinite(st.turretAngle)) {
      if (isFullManual) {
        // Start pointing straight forward (robot-relative offset = 0)
        st.turretAngle = 0;
      } else {
        // Limited: initialise aimed at the HIVE mouth (mount-relative)
        const half = ((s.turretRangeDeg ?? 360) * Math.PI) / 360;
        st.turretAngle = Math.max(-half, Math.min(half, wrap(this.turretHeading() - this.mountHeading())));
      }
      return;
    }

    const inp = this.robots[this.me].lastCmd as Inputs;
    if (inp.turretLeft || inp.turretRight) {
      // Right arrow = clockwise = subtract; left arrow = counterclockwise = add
      const dir = (inp.turretLeft ? 1 : 0) - (inp.turretRight ? 1 : 0);
      if (isFullManual) {
        st.turretAngle = wrap(st.turretAngle + dir * MANUAL_SLEW);
      } else {
        const half = ((s.turretRangeDeg ?? 360) * Math.PI) / 360;
        const step = (((s.turretSlewDegPerSec ?? 720) * Math.PI) / 180) * DT;
        st.turretAngle = Math.max(-half, Math.min(half, st.turretAngle + dir * step));
      }
      return;
    }

    // Auto-aim: only for limited turrets (full 360 holds last manual position)
    if (isFullManual) return;
    const half = ((s.turretRangeDeg ?? 360) * Math.PI) / 360;
    const step = (((s.turretSlewDegPerSec ?? 720) * Math.PI) / 180) * DT;
    const want = Math.max(-half, Math.min(half, wrap(this.turretHeading() - this.mountHeading())));
    const d = half >= Math.PI ? wrap(want - st.turretAngle) : want - st.turretAngle;
    st.turretAngle += Math.max(-step, Math.min(step, d));
    if (half >= Math.PI) st.turretAngle = wrap(st.turretAngle);
  }

  /**
   * Checks whether the shooter points at the raised CELL's mouth, within `tolRad`. A fixed shooter and an ideal turret
   * always count as aimed: the robot's heading aims the one, and the other aims at once.
   */
  turretAimed(tolRad = 0.02): boolean {
    if (!this.hasTurret) return true;
    if (!this.turretLimited) return true; // Full 360 turret: always considered aimed (manual control)
    const d = this.mountHeading() + this.robots[this.me].turretAngle - this.turretHeading();
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) < tolRad;
  }

  /** Gets where a launch goes now, as a heading in radians before launch error: a turret's aim, or the shooter's facing. */
  private launchAim(pose?: { x: number; z: number; heading: number }): number {
    if (this.cfg.shooter.turret) {
      const st = this.robots[this.me];
      // turretAngle is robot-relative (offset from mountHeading).
      // When NaN (not yet initialised by a step), fall back to turretHeading so previewShot works before the match.
      if (!pose && Number.isFinite(st.turretAngle)) return this.mountHeading() + st.turretAngle;
      return this.turretHeading(pose);
    }
    return (pose?.heading ?? this.heading) + (this.launchesRear(pose) ? Math.PI : 0);
  }

  private launch(kind: BallKind, lateral = 0) {
    const lp: LaunchParams = kind === 'pollen' ? this.cfg.shooter.pollen : this.cfg.shooter.nectar;
    const el = (this.rng.gauss(lp.elevationDeg.mean, lp.elevationDeg.std) * Math.PI) / 180;
    const yaw = (this.rng.gauss(0, lp.yawStdDeg) * Math.PI) / 180, sp = this.rng.gauss(lp.speed.mean, lp.speed.std);
    const spin = (this.rng.gauss(lp.backspinRpm.mean, lp.backspinRpm.std) * 2 * Math.PI) / 60;
    if (this.cfg.shooter.turret) {
      // The turret sits at the robot's center and turns the whole shooter, so the offsets are along the launch heading.
      const aim = this.launchAim(), th = aim + yaw, fx = Math.cos(th), fz = -Math.sin(th), lx = -Math.sin(th), lz = -Math.cos(th), p = this.robot.translation(), rv = this.robot.linvel();
      const side = lp.offset[1] + lateral, o = { x: p.x + Math.cos(aim) * lp.offset[0] - Math.sin(aim) * side, z: p.z - Math.sin(aim) * lp.offset[0] - Math.cos(aim) * side };
      const b = this.spawn(kind, o.x, 0.02 + lp.offset[2], o.z,
        { x: rv.x + sp * Math.cos(el) * fx, y: sp * Math.sin(el), z: rv.z + sp * Math.cos(el) * fz },
        { x: -spin * lx, y: 0, z: -spin * lz });
      b.retryAt = this.simTime + 1;
      return;
    }
    const rear = this.launchesRear(), dir = rear ? -1 : 1;
    const th = this.heading + yaw + (rear ? Math.PI : 0), fx = Math.cos(th), fz = -Math.sin(th), lx = -Math.sin(th), lz = -Math.cos(th);
    const o = this.toWorld(dir * lp.offset[0], dir * (lp.offset[1] + lateral)), rv = this.robot.linvel();
    const b = this.spawn(kind, o.x, 0.02 + lp.offset[2], o.z,
      { x: rv.x + sp * Math.cos(el) * fx, y: sp * Math.sin(el), z: rv.z + sp * Math.cos(el) * fz },
      { x: -spin * lx, y: 0, z: -spin * lz });
    b.retryAt = this.simTime + 1;
  }

  private shoot(inp: Inputs) {
    const s = this.cfg.shooter, any = inp.shootNectar || inp.shootPollen;
    if (!any || this.carried.length === 0 || this.placing) return;
    const take = (pred: (k: BallKind) => boolean) => { const i = this.carried.findIndex(pred); return i < 0 ? null : this.carried.splice(i, 1)[0]; };
    if (s.type === 'catapult') {
      if (this.simTime < this.shotReadyAt.pollen) return;
      const n = this.carried.length; this.carried.splice(0).forEach((k, i) => this.launch(k, (i - (n - 1) / 2) * 0.095));
      this.shotReadyAt.pollen = this.simTime + Math.max(1, s.cycleSec * 3);
    } else if (s.type === 'fifo') {
      if (this.simTime < this.shotReadyAt.pollen) return;
      this.launch(this.carried.shift()!); this.shotReadyAt.pollen = this.simTime + s.cycleSec;
    } else {
      if (inp.shootNectar && this.simTime >= this.shotReadyAt.nectar) { const k = take(k => k !== 'pollen'); if (k) { this.launch(k, 0.09); this.shotReadyAt.nectar = this.simTime + s.cycleSec; } }
      if (inp.shootPollen && this.simTime >= this.shotReadyAt.pollen) { const k = take(k => k === 'pollen'); if (k) { this.launch(k, -0.09); this.shotReadyAt.pollen = this.simTime + s.cycleSec; } }
    }
  }

  /** Gets the FLOWER that the robot front can reach, if any. */
  reachableFlower(): Flower | null {
    const pl = this.cfg.place;
    for (const f of this.flowers) {
      const r = this.toRobot(f.x, f.z), d = Math.hypot(r.f - this.cfg.length / 2, r.l);
      if (r.f > 0 && d < pl.range && Math.abs(Math.atan2(r.l, r.f)) < (pl.maxBearingDeg * Math.PI) / 180) return f;
    }
    return null;
  }


  private place(inp: Inputs) {
    if (this.placing) {
      if (this.simTime < this.placing.until) return;
      const { kind, flower } = this.placing; this.placing = null;
      this.flowerReadyAt = this.simTime + 0.5;
      const i = this.carried.findIndex(k => (kind === 'pollen') === (k === 'pollen')); if (i < 0) return;
      const ball = this.carried.splice(i, 1)[0];
      if (this.rng.bernoulli(this.cfg.place.successP)) { flower.stack.push(ball); this.say(`Placed ${kind.toUpperCase()} in the ${flower.id} FLOWER`); }
      else { const o = this.toWorld(this.cfg.length / 2 + 0.06, this.rng.gauss(0, 0.05)); this.spawn(ball, o.x, 0.4, o.z); this.say('Placement missed'); }
      return;
    }
    const kind = inp.placeNectar ? 'nectar' : inp.placePollen ? 'pollen' : null; if (!kind) return;
    if (!this.carried.some(k => (kind === 'pollen') === (k === 'pollen'))) return;
    const f = this.reachableFlower(); if (!f) return;
    if (kind === 'nectar' && !this.flowersUnlocked) { if (!this.messages.some(m => m.text.startsWith('G410') && this.simTime - m.t < 2)) this.say('G410: NECTAR can enter a FLOWER only in the last 60 seconds'); return; }
    if (stackTop(f.stack) > FIELD.flowerPlaceLimit) return;
    this.placing = { until: this.simTime + this.cfg.place.durationSec, kind, flower: f };
  }

  private housekeeping() {
    for (const b of this.balls.values()) {
      const p = b.body.translation();
      if (Math.abs(p.x) > FIELD.half + 0.05 || Math.abs(p.z) > FIELD.half + 0.05 || p.y < -0.2) {
        // FIELD STAFF return SCORING ELEMENTS that leave the FIELD (section 10.8.2).
        const nx = Math.max(-1.5, Math.min(1.5, p.x)), nz = Math.max(-1.5, Math.min(1.5, p.z));
        b.body.setTranslation({ x: nx, y: 0.2, z: nz }, true); b.body.setLinvel({ x: 0, y: 0, z: 0 }, true); b.airborne = false; this.touch();
      }
    }
  }

  /** Assesses a FOUL against an alliance: the points go to the opponent (section 10.6). MAJOR is 20, MINOR is 5. */
  foul(against: Alliance, kind: 'MAJOR' | 'MINOR', rule: string) {
    const to: Alliance = against === 'red' ? 'blue' : 'red'; this.foulPoints[to] += kind === 'MAJOR' ? 20 : 5;
    this.say(`REFEREE: ${kind} FOUL on ${against.toUpperCase()}, ${rule}`); this.events.push('foul');
  }

  // ---------- scoring ----------

  /** Checks whether the robot is at least partly in its LOADING ZONE, which is what PARK requires (section 10.5.4). */
  robotInLoadingZone(): boolean {
    // A 7 x 7 grid of points across the chassis. Testing only the corners misses a robot that overlaps the zone
    // with an edge, for example one that parks at an angle.
    const hl = this.cfg.length / 2, hw = this.cfg.width / 2, z = FIELD.loadingZone[this.alliance];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) { const p = this.toWorld((i / 3) * hl, (j / 3) * hw); if (inRect(p.x, p.z, z)) return true; }
    return false;
  }

  /**
   * Gets a ball's position. Rapier is read once per ball per epoch (see `frame`), and later calls in the same epoch
   * return that object. Don't mutate it. Code that moves a ball body directly must call `step` before it reads again.
   */
  ballPos(b: Ball): Readonly<RAPIER_NS.Vector> {
    const f = this.fresh(); let p = f.pos.get(b.id);
    if (!p) { p = b.body.translation(); f.pos.set(b.id, p); }
    return p;
  }

  private cell(a: Alliance) {
    const f = this.fresh(); let c = f.cell[a];
    if (!c) {
      c = { count: 0, load: 0 };
      for (const b of this.balls.values()) if (this.hives[a].containsInUpCell(this.ballPos(b), b.radius)) { c.count++; c.load += b.kind === 'pollen' ? TIP_LOAD.pollen : TIP_LOAD.nectar; }
      f.cell[a] = c;
    }
    return c;
  }

  /** Gets the number of elements in the raised CELL. Computed once per epoch. */
  cellCount(a: Alliance): number { return this.cell(a).count; }

  /** Gets the load in the raised CELL in POLLEN equivalents. Compare it with TIP_LOAD.threshold. Computed once per epoch. */
  cellLoad(a: Alliance): number { return this.cell(a).load; }

  /** Gets per-FLOWER scoring: the owner, the bottom-NECTAR alliance, and the scored element count. */
  flowerStatus(f: Flower) {
    const hs = flowerHeights(f.stack); let owner: Alliance | null = null, bottom: Alliance | null = null, scored = 0;
    f.stack.forEach((k, i) => {
      if (hs[i] + 2 * radiusOf(k) <= FIELD.flowerScoreBottom || hs[i] >= FIELD.flowerTop) return;
      scored++;
      if (k !== 'pollen') { const a: Alliance = k === 'nectar_red' ? 'red' : 'blue'; bottom ??= a; owner = a; }
    });
    return { owner, bottom, scored };
  }

  score(a: Alliance): AllianceScore {
    const team = this.robots.map((r, i) => ({ r, v: this.view(i) })).filter(q => q.r.alliance === a), auto = this.autoTips[a], tips = this.hives[a].tips;
    const autoTips = this.phase === 'auto' ? tips : auto;
    let flower = 0, bottomNectar = 0;
    for (const f of this.flowers) { const s = this.flowerStatus(f); if (s.owner === a) flower += s.scored * POINTS.flower; if (s.bottom === a) bottomNectar += POINTS.bottomNectar; }
    let garden = 0;
    for (const b of this.balls.values()) { const p = b.body.translation(); if (p.y < 0.12 && inRect(p.x, p.z, FIELD.garden[a], b.radius)) garden += POINTS.garden; }
    const s = {
      leave: team.filter(q => q.r.autoLeave).length * POINTS.leave, autoPark: team.filter(q => q.r.autoPark).length * POINTS.park,
      autoTips: autoTips * POINTS.tip, teleopTips: (tips - autoTips) * POINTS.tip,
      cell: this.cellCount(a) * POINTS.cell, flower, bottomNectar, garden,
      park: this.phase !== 'auto' && this.mode !== 'auto' ? team.filter(q => q.v.robotInLoadingZone()).length * POINTS.park : 0,
      fouls: this.foulPoints[a],
    };
    const total = Object.values(s).reduce((x, y) => x + y, 0);
    return { ...s, total, rp: { swarm: s.leave + s.autoPark + s.park >= RP.swarm, pollinator1: tips >= RP.pollinator1, pollinator2: tips >= RP.pollinator2 } };
  }

  /** Predicts the mean shot path for the next ball, for the aiming overlay and fire control. Points are world coordinates. */
  previewShot(kind: 'pollen' | 'nectar', pose?: { x: number; z: number; heading: number }): { points: number[][]; scores: boolean } {
    const lp = kind === 'pollen' ? this.cfg.shooter.pollen : this.cfg.shooter.nectar, r = kind === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius;
    const m = kind === 'pollen' ? BALL.pollenMass : BALL.nectarMass, el = (lp.elevationDeg.mean * Math.PI) / 180, speed = lp.speed.mean;
    // For preview: turret always shows where it's currently pointing (launchAim uses held turretAngle).
    const th = this.launchAim(pose), base = pose ?? { x: this.robot.translation().x, z: this.robot.translation().z };
    const o = { x: base.x + Math.cos(th) * lp.offset[0], z: base.z - Math.sin(th) * lp.offset[0] };
    const rv = pose ? { x: 0, y: 0, z: 0 } : this.robot.linvel();
    const p = [o.x, 0.02 + lp.offset[2], o.z], v = [rv.x + speed * Math.cos(el) * Math.cos(th), speed * Math.sin(el), rv.z - speed * Math.cos(el) * Math.sin(th)];
    const k = (0.5 * BALL.airDensity * Math.PI * r * r * BALL.dragCd) / m, pts: number[][] = []; let scores = false; const h = 1 / 120;
    for (let i = 0; i < 240 && p[1] > 0; i++) {
      const sp = Math.hypot(v[0], v[1], v[2]);
      const q = [...p];
      for (let a = 0; a < 3; a++) { v[a] += (-k * sp * v[a] - (a === 1 ? 9.81 : 0)) * h; p[a] += v[a] * h; }
      if (i % 4 === 0) pts.push([...p]);
      if (this.hives[this.alliance].entersMouth({ x: q[0], y: q[1], z: q[2] }, { x: p[0], y: p[1], z: p[2] }, r)) { scores = true; pts.push([...p]); break; }
    }
    return { points: pts, scores };
  }
}
