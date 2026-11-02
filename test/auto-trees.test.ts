import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { TELEOP_TREES } from '../src/auto/driver';
import { AUTO_TREES, previewAuto } from '../src/auto/onboard';
import { Coach } from '../src/auto/coach';
import { treeStateAt } from '../src/render/tree-view';
import { notesMarkdown, TraceRecorder } from '../src/trace';
import { DT, Sim } from '../src/sim/world';
import { defaultBot, robotConfig, sanitize } from '../src/setup';

beforeAll(async () => { await RAPIER.init(); });

/** A practice sim whose red robot 0 has a square chassis of `sizeIn` inches and a shooter facing `facing`. */
function simWith(sizeIn: number, facing: 'front' | 'rear' = 'rear') {
  const bot = sanitize({ ...defaultBot(0), sizeIn }, 0);
  return new Sim(RAPIER, undefined, 'full', 3, { configFor: () => { const c = robotConfig(bot); c.shooter.facing = facing; return c; } });
}

describe('AUTO trees', () => {
  it('loads all of the tree files, in the order of the AUTO list', () => {
    expect(Object.keys(AUTO_TREES)).toEqual(['wall-sweep-pair-right', 'wall-sweep-pair-left', 'lane-sweep-pair-right', 'lane-sweep-pair-left-no-park', 'lane-sweep-pair-left', 'solo-two-tip-sweep', 'solo-two-tip-sweep-no-park', 'leave-and-park', 'blank-right', 'blank-left', '32294-custom']);
    // A plan has no partner field: each red robot's plan is picked on its own. The Default setting pairs them in `autoFor`.
    for (const def of Object.values(AUTO_TREES)) expect(def.meta.partner).toBeUndefined();
    for (const def of Object.values(AUTO_TREES)) expect(def.env).toBe('onboard');
  });
  it('computes poses from the robot size and the shooter direction', () => {
    const plan = (sizeIn: number, facing: 'front' | 'rear' = 'rear') => { const s = simWith(sizeIn, facing), p = s.robot.translation(); return previewAuto(AUTO_TREES['solo-two-tip-sweep'], s, { x: p.x, z: p.z }).poses; };
    const small = plan(12), big = plan(18), front = plan(18, 'front');
    // The PARK pose keeps the chassis 9 cm off the alliance wall: half the length farther out for a smaller robot.
    const park = (poses: typeof small) => poses[poses.length - 1];
    expect(park(small).x - park(big).x).toBeCloseTo(-((18 - 12) * 0.0254) / 2, 6);
    // A front-facing shooter turns every launch pose around. The first pose is the audience launch spot.
    expect(Math.abs(Math.abs(front[0].heading - big[0].heading) - Math.PI)).toBeLessThan(1e-9);
    expect(small[0].shoots).toBe(true);
  });
});

describe('TELEOP tree', () => {
  it('loads the default tree in the driver environment, with its guards in priority order', () => {
    const def = TELEOP_TREES['teleop-default'];
    expect(def.env).toBe('driver');
    const nodes: { kind: string; path: string }[] = [], walk = (n: typeof def.root) => { nodes.push(n); n.children.forEach(walk); }; walk(def.root);
    expect(nodes.filter(n => n.kind === 'guard').map(n => n.path)).toEqual(['root/defend', 'root/defend/child/defend-park', 'root/defend/child/rest', 'root/defend/child/take-spot', 'root/match/endgame', 'root/match/endgame/child/last-launch', 'root/match/bump', 'root/match/yield', 'root/match/play/child/flowers', 'root/match/play/child/tip', 'root/match/play/child/launch']);
    expect(nodes.some(n => n.path === 'root/match/endgame/child/park-now')).toBe(true);
    expect(nodes.some(n => n.path === 'root/match/play/child/park')).toBe(true);
  });
});

describe('tree files', () => {
  it('names each file after its tree id, and keeps AUTO and TELEOP trees in their own folders', () => {
    const files = import.meta.glob<{ id: string; env: string }>('../src/auto/trees/*/*.json', { eager: true, import: 'default' });
    expect(Object.keys(files)).toHaveLength(12);
    for (const [path, tree] of Object.entries(files)) {
      const [folder, file] = path.split('/').slice(-2);
      expect(tree.id).toBe(file.replace(/\.json$/, ''));
      expect(tree.env).toBe(folder === 'auto' ? 'onboard' : 'driver');
    }
  });
});

describe('tree recording', () => {
  /** Plays the first `sec` seconds of a MATCH, with or without tree recording, and returns the trace and the final positions. */
  function play(sec: number, traceTrees: boolean) {
    const sim = new Sim(RAPIER, undefined, 'full', 5, { opponent: true, partners: true }); sim.start();
    const coaches = sim.robots.map(() => { const c = new Coach(); c.traceTrees = traceTrees; return c; }), rec = new TraceRecorder(sim, {});
    for (let k = 0; k < sec / DT; k++) { sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), coaches.map(() => true)); rec.record(sim, coaches, DT); }
    return { trace: rec.trace, at: sim.robots.map(r => r.body.translation()) };
  }
  it('records each robot\'s tree in the trace, and the review rebuilds its state from the frames', () => {
    const { trace } = play(6, true), last = trace.frames.length - 1, bt = trace.frames[last].robots[0].bt!;
    expect(bt.tree).toBe('wall-sweep-pair-right');
    expect(bt.leaf).toMatch(/^root\/steps\//);
    const def = AUTO_TREES['wall-sweep-pair-right'], nodes: { idx: number; path: string }[] = [], walk = (n: typeof def.root) => { nodes.push(n); n.children.forEach(walk); }; walk(def.root);
    const s1 = nodes.find(n => n.path.endsWith('/s1'))!, at = treeStateAt(trace, last, 0)!;
    expect(at.state.last.get(s1.idx)).toBe('s'); // The first drive is done within 6 s.
    expect([...at.state.running]).toEqual(bt.running);
    expect(notesMarkdown(trace, [{ t: trace.frames[last].t, clock: 24, phase: 'auto', robot: 'R0', text: 'x' }])).toContain(`tree wall-sweep-pair-right at ${bt.leaf}`);
  });
  it("doesn't change what the robots do", () => {
    expect(play(4, true).at).toEqual(play(4, false).at);
  });
});
