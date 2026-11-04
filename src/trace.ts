import type { Coach } from './auto/coach';
import { code, type AllianceScore, type BallKind, type Sim } from './sim/world';

/** One robot at one instant: where it is, what it carries, and what its program is trying to do. */
export interface RobotFrame {
  id: string; x: number; z: number; h: number; speed: number; carried: string[];
  driver: string; tactic: string; status: string; note: string; goalKey: string; goal: [number, number] | null; path: [number, number][];
  phase: string; side: string | null; load: number; stall: string | null;
  /** The robot's behavior tree at this instant, if its coach records trees. Traces recorded before September 23, 2026 lack it. */
  bt?: TreeFrame;
}
/**
 * A robot's behavior tree at one instant. `running` holds the numbers of the running nodes, from the root to the running
 * leaf, and `leaf` is that leaf's path. `ended` holds the nodes that ended since the previous frame, with their result:
 * `s` for success, `f:TAG` for a failure, `h` for halted, or `e` for an error.
 */
export interface TreeFrame { tree: string; running: number[]; leaf: string; ended?: [number, string][] }
export interface Frame {
  t: number; phase: string; clock: number; score: { red: number; blue: number };
  /** The full score breakdown and ranking point flags, so that the scoreboard can scrub. Traces recorded before September 20, 2026 lack it. */
  scores?: Record<'red' | 'blue', AllianceScore>;
  hives: Record<'red' | 'blue', { phi: number; up: string; tips: number; load: number }>;
  flowers: string[][]; robots: RobotFrame[];
  /** Ball id, kind code, and position in centimeters. Present on every second frame to keep the file small. */
  balls?: [number, string, number, number, number][];
}
export interface Note { t: number; clock: number; phase: string; robot: string | null; text: string }
export interface Trace { name: string; startedAt: string; settings: Record<string, string>; flowerSites: { id: string; x: number; z: number }[]; robotSize: [number, number]; frames: Frame[] }

const r2 = (v: number) => Math.round(v * 100) / 100, cm = (v: number) => Math.round(v * 100);
const KIND: Record<string, BallKind> = { P: 'pollen', RN: 'nectar_red', BN: 'nectar_blue' };

/** Records a match at 10 Hz so that it can be replayed, annotated, and analyzed afterward. */
export class TraceRecorder {
  trace: Trace; private nextAt = 0; private t = 0; private n = 0;
  /** For each robot: the tree recorder that it read last, and how many of its ended spans it has read. */
  private treeRead: { rec: unknown; seen: number }[] = [];
  constructor(sim: Sim, settings: Record<string, string>) {
    const d = new Date(), pad = (v: number) => String(v).padStart(2, '0');
    this.trace = { name: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`, startedAt: d.toISOString(), settings,
      flowerSites: sim.flowers.map(f => ({ id: f.id, x: f.x, z: f.z })), robotSize: [sim.cfg.length, sim.cfg.width], frames: [] };
  }

  /** Call once per physics step. `coaches[i]` drives robot i, or is null for a human. */
  record(sim: Sim, coaches: (Coach | null)[], dt: number) {
    if (sim.phase === 'pre') return; this.t += dt; if (this.t < this.nextAt) return; this.nextAt = this.t + 0.1;
    const robots = sim.robots.map((r, i) => {
      const p = r.body.translation(), v = r.body.linvel(), c = coaches[i], inAuto = sim.phase === 'auto', ex = c?.executor, goalKey = (ex as unknown as { goalKey?: string } | undefined)?.goalKey ?? '';
      const path = (inAuto ? c?.auto?.path : ex?.path) ?? [];
      return { id: `${r.alliance === 'red' ? 'R' : 'B'}${r.slot}`, x: r2(p.x), z: r2(p.z), h: r2(sim.view(i).heading), speed: r2(Math.hypot(v.x, v.z)), carried: r.carried.map(code),
        driver: !c ? 'human' : inAuto ? 'auto script' : 'planner', tactic: !c ? '' : inAuto ? c.auto?.note ?? '' : ex!.tactic + (ex!.flowerId ? `:${ex!.flowerId}` : ''), status: ex?.status ?? '', note: inAuto ? '' : ex?.note ?? '',
        goalKey, goal: r.plan.goal ? [r2(r.plan.goal.x), r2(r.plan.goal.z)] as [number, number] : null, path: path.slice(0, 8).map(q => [r2(q.x), r2(q.z)] as [number, number]),
        phase: r.plan.phase, side: r.plan.side, load: r2(r.plan.load), stall: !inAuto && ex?.stall && ex.avoided().includes(ex.stall.target) ? `${ex.stall.target}: ${ex.stall.reason}` : null,
        ...this.treeFrame(i, c) };
    });
    const red = sim.score('red'), blue = sim.score('blue');
    const frame: Frame = { t: r2(this.t), phase: sim.phase, clock: r2(sim.timer), score: { red: red.total, blue: blue.total }, scores: { red, blue },
      hives: { red: this.hive(sim, 'red'), blue: this.hive(sim, 'blue') }, flowers: sim.flowers.map(f => f.stack.map(code)), robots };
    if (this.n++ % 2 === 0) frame.balls = [...sim.balls.values()].map(b => { const q = b.body.translation(); return [b.id, code(b.kind), cm(q.x), cm(q.y), cm(q.z)]; });
    this.trace.frames.push(frame);
  }
  /** Reads what a robot's tree did since the previous frame. */
  private treeFrame(i: number, c: Coach | null): { bt?: TreeFrame } {
    const cur = c?.currentTree(); if (!cur) return {};
    const read = (this.treeRead[i] ??= { rec: null, seen: 0 }); if (read.rec !== cur.recorder) { read.rec = cur.recorder; read.seen = 0; }
    const ended = cur.recorder.closed.slice(read.seen).map(s => [s.node, s.result === 'success' ? 's' : s.result === 'failure' ? `f:${s.tag ?? ''}` : s.result === 'halted' ? 'h' : 'e'] as [number, string]);
    read.seen = cur.recorder.closed.length;
    const running = cur.recorder.running();
    return { bt: { tree: cur.def.id, running: running.map(s => s.node), leaf: running.length ? running[running.length - 1].path : '', ...(ended.length ? { ended } : {}) } };
  }

  private hive(sim: Sim, a: 'red' | 'blue') { const h = sim.hives[a]; return { phi: r2(h.phi), up: h.upCell, tips: h.tips, load: r2(sim.cellLoad(a)) }; }
}

/** Builds the minimal sim-shaped object that the view needs to draw one trace frame. Balls come from the latest frame that has them. */
export function frameAsSim(trace: Trace, index: number, template: Sim): Sim {
  const f = trace.frames[index]; let bi = index; while (bi > 0 && !trace.frames[bi].balls) bi--;
  const robots = f.robots.map((r, i) => ({ alliance: r.id[0] === 'R' ? 'red' : 'blue', slot: Number(r.id[1]), cfg: template.robots[Math.min(i, template.robots.length - 1)].cfg, carried: r.carried.map(k => KIND[k]),
    body: { translation: () => ({ x: r.x, y: 0.17, z: r.z }) }, heading: r.h }));
  const view = (i: number) => ({ cfg: robots[i].cfg, robot: robots[i].body, heading: robots[i].heading, alliance: robots[i].alliance, carried: robots[i].carried });
  const balls = new Map((trace.frames[bi].balls ?? []).map(([id, k, x, y, z]) => [id, { id, kind: KIND[k], body: { translation: () => ({ x: x / 100, y: y / 100, z: z / 100 }) } }]));
  return { robots, view, balls, flowers: trace.flowerSites.map((s, i) => ({ ...s, stack: f.flowers[i].map(k => KIND[k]) })), hives: { red: { phi: f.hives.red.phi }, blue: { phi: f.hives.blue.phi } },
    // A trace has no turret angle, so a third-person camera in the review follows the chassis.
    ...view(0), cfg: robots[0].cfg, previewShot: () => ({ points: [], scores: false }), aimHeading: () => robots[0].heading } as unknown as Sim;
}

/** Writes the notes as Markdown, with what every robot was doing at each marked moment. */
export function notesMarkdown(trace: Trace, notes: Note[]): string {
  const lines = [`# Match annotations: ${trace.name}`, '', `Settings: ${Object.entries(trace.settings).map(([k, v]) => `${k}=${v}`).join(', ')}`, '',
    'Positions are field coordinates (x, y) in meters: the origin is the FIELD center, +x is the blue wall, and +y is the rear wall. Field y is the negative of the z value in the trace JSON.', ''];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const f = trace.frames.reduce((best, q) => (Math.abs(q.t - n.t) < Math.abs(best.t - n.t) ? q : best), trace.frames[0]);
    lines.push(`## t=${n.t.toFixed(1)} s (${n.phase}, clock ${n.clock.toFixed(0)})${n.robot ? `, robot ${n.robot}` : ''}`, '', n.text || '(marked, no text)', '', 'State at that moment:', '');
    for (const r of f.robots) lines.push(`- ${r.id} at (${r.x}, ${-r.z}) heading ${Math.round((r.h * 180) / Math.PI)}°, ${r.speed} m/s, carrying [${r.carried.join(',')}], ${r.driver} ${r.tactic} ${r.status}, goal ${r.goalKey || '-'}${r.goal ? ` (${r.goal[0]}, ${-r.goal[1]})` : ''}${r.bt ? `, tree ${r.bt.tree} at ${r.bt.leaf || '-'}` : ''}${r.note ? `, ${r.note}` : ''}${r.stall ? `, STALL ${r.stall}` : ''}`);
    lines.push(`- HIVES: red ${f.hives.red.up} CELL up, load ${f.hives.red.load}, ${f.hives.red.tips} TIPS; blue ${f.hives.blue.up} CELL up, load ${f.hives.blue.load}, ${f.hives.blue.tips} TIPS. Score ${f.score.red} to ${f.score.blue}.`, '');
  }
  return lines.join('\n');
}
