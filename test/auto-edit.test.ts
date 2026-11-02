import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { addReference, changedDefs, deleteDef, changedSteps, clonePlan, editHandles, makeAbsolute, moveReference, referenceOf, referencePoints, referTo, findNode, isEdited, moveHandle, planId, poseText, resetHandle, sharedWith, shiftPose, sourceOf, turnHandle } from '../src/auto/auto-edit';
import { AUTO_SOURCES, AUTO_TREES, BUILT_IN_AUTO, addAutoTree, removeAutoTree } from '../src/auto/onboard';
import { Coach } from '../src/auto/coach';
import { literalNumber, splitCall, type CNode } from '../src/bt';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });

type Json = Record<string, unknown>;
const newSim = () => new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true });
const source = (id: string) => AUTO_SOURCES[id] as Json;
const copy = (id: string) => clonePlan(source(id), { id: `${id}-test`, name: `${source(id).name} (test)`, description: 'A copy for a test.' });
const leaves = (n: CNode, out: CNode[] = []) => { if (n.leaf) out.push(n); n.children.forEach(c => leaves(c, out)); return out; };

describe('expression helpers', () => {
  it('splits a call into its arguments as written', () => {
    expect(splitCall('offset(launch, 0.2, -(a + b))')).toEqual({ name: 'offset', args: ['launch', '0.2', '-(a + b)'] });
    expect(splitCall('pose(min(1, 2), y, 90)')).toEqual({ name: 'pose', args: ['min(1, 2)', 'y', '90'] });
    expect(splitCall('launch')).toBeNull(); expect(splitCall('a.b(1)')).toBeNull(); expect(splitCall('pose(1, 2')).toBeNull();
    expect(literalNumber('-0.25')).toBe(-0.25); expect(literalNumber('1 + 2')).toBeNull();
  });
});

describe('shiftPose', () => {
  it('edits the literals of a pose() call, and keeps the values that do not move', () => {
    expect(shiftPose('pose(-1.2, 0.6, 180)', 0.1, -0.2, 0)).toBe('pose(-1.1, 0.4, 180)');
    expect(shiftPose('pose(hiveX, 1.32, -90 + flip)', 0, 0.1, 0)).toBe('pose(hiveX, 1.42, -90 + flip)');
  });
  it('wraps an expression in offset() when a value that moves is not a literal', () => {
    expect(shiftPose('launchAudience', 0.2, -0.1, 0)).toBe('offset(launchAudience, 0.2, -0.1)');
    expect(shiftPose('pose(hiveX, 1.32, -90 + flip)', 0.1, 0, 0)).toBe('offset(pose(hiveX, 1.32, -90 + flip), 0.1, 0)');
    expect(shiftPose('launchAudience', 0, 0, 30)).toBe('offset(launchAudience, 0, 0, 30)');
  });
  it('edits an offset() that is already there, and removes it when it comes back to zero', () => {
    expect(shiftPose('offset(ownFlower, 0.2, 0)', 0.05, 0.1, 10)).toBe('offset(ownFlower, 0.25, 0.1, 10)');
    expect(shiftPose('offset(ownFlower, 0.2, 0)', -0.2, 0, 0)).toBe('ownFlower');
  });
});

describe('findNode', () => {
  it('finds the JSON of every leaf of every AUTO tree by its path', () => {
    let count = 0;
    for (const [id, def] of Object.entries(AUTO_TREES)) {
      for (const n of leaves(def.root)) { expect(findNode(source(id), n.path)?.ref, `${id} ${n.path}`).toBe(n.label); count++; }
    }
    expect(count).toBeGreaterThan(100);
  });
  it('returns null for a path that no node has', () => {
    expect(findNode(source('solo-two-tip-sweep'), 'root/steps/1.sequence/nope')).toBeNull();
    expect(findNode(source('solo-two-tip-sweep'), 'tree/steps')).toBeNull();
  });
});

describe('field edits', () => {
  it('writes poses in field x and y, with +y toward the rear wall', () => {
    // The audience launch spot is on the audience side, where y is negative, and the robot's rear faces the audience.
    const s1 = editHandles(AUTO_TREES['solo-two-tip-sweep'], newSim().view(0))[0];
    expect(s1.pose.y).toBeCloseTo(-1.32, 6); expect(s1.pose.headingDeg).toBe(-90);
    // The simulator's z is the negative of y.
    expect(s1.sim.z).toBeCloseTo(1.32, 6);
  });
  it('rotates a blue robot 180° about the FIELD center', () => {
    const sim = newSim(), red = editHandles(AUTO_TREES['solo-two-tip-sweep'], sim.view(0)), blue = editHandles(AUTO_TREES['solo-two-tip-sweep'], sim.view(2));
    expect(blue[0].pose).toEqual(red[0].pose);
    expect(blue[0].sim.x).toBeCloseTo(-red[0].sim.x, 9); expect(blue[0].sim.z).toBeCloseTo(-red[0].sim.z, 9);
    expect(Math.cos(blue[0].sim.heading! - red[0].sim.heading! - Math.PI)).toBeCloseTo(1, 9);
  });
  it('moves and turns a drive pose, and moves a waypoint', () => {
    const view = newSim().view(0), id = 'solo-two-tip-sweep', tree = copy(id); addAutoTree(tree);
    try {
      const at = (t: Json) => editHandles(AUTO_TREES[String(t.id)], view);
      const drive = at(tree)[0], lane = at(tree).find(h => h.kind === 'waypoint')!;
      let t = moveHandle(tree, drive, { x: drive.pose.x + 0.2, y: drive.pose.y - 0.1 }); addAutoTree(t);
      // The shared definition stays as it is written, and the step gets an offset.
      expect(poseText(t, drive)).toBe('offset(launchAudience, 0.2, -0.1)');
      t = turnHandle(t, at(t)[0], drive.pose.headingDeg + 30); addAutoTree(t);
      expect(poseText(t, drive)).toBe('offset(launchAudience, 0.2, -0.1, 30)');
      t = moveHandle(t, lane, { x: lane.pose.x - 0.15, y: lane.pose.y + 0.05 }); addAutoTree(t);
      const d = at(t)[0], l = at(t).find(h => h.path === lane.path && h.index === lane.index)!;
      expect(d.pose.x).toBeCloseTo(drive.pose.x + 0.2, 3); expect(d.pose.y).toBeCloseTo(drive.pose.y - 0.1, 3); expect(d.pose.headingDeg).toBeCloseTo(drive.pose.headingDeg + 30, 6);
      expect(l.pose.x).toBeCloseTo(lane.pose.x - 0.15, 3); expect(l.pose.y).toBeCloseTo(lane.pose.y + 0.05, 3);
      expect(isEdited(t, d, source(id))).toBe(true); expect(isEdited(t, l, source(id))).toBe(true);
      const back = resetHandle(resetHandle(t, d, source(id)), l, source(id));
      expect(isEdited(back, d, source(id))).toBe(false); expect(isEdited(back, l, source(id))).toBe(false);
    } finally { removeAutoTree(String(tree.id)); }
  });
  it('lists the steps that differ from the plan that this one was copied from', () => {
    const view = newSim().view(0), id = 'solo-two-tip-sweep', tree = copy(id); addAutoTree(tree);
    try {
      expect(changedSteps(AUTO_TREES[String(tree.id)], tree, source(id)).size).toBe(0);
      const h = editHandles(AUTO_TREES[String(tree.id)], view)[0], t = moveHandle(tree, h, { x: h.pose.x + 0.1, y: h.pose.y }); addAutoTree(t);
      expect([...changedSteps(AUTO_TREES[String(t.id)], t, source(id))]).toEqual([h.path]);
    } finally { removeAutoTree(`${id}-test`); }
  });
  it('names the other steps that share a definition', () => {
    const def = AUTO_TREES['wall-sweep-pair-right'], s1 = editHandles(def, newSim().view(0))[0];
    expect(sharedWith(source('wall-sweep-pair-right'), def, s1)).toEqual(['s6', 's11']);
  });
});

describe('reference points', () => {
  it('lists the definitions that are poses, and names the one that a pose is built on', () => {
    const refs = referencePoints(AUTO_TREES['wall-sweep-pair-right'], newSim().view(0)).map(r => r.name);
    expect(refs).toEqual(expect.arrayContaining(['launchAudience', 'launchRear', 'ownFlower', 'park', 'parkRight']));
    expect(refs).not.toContain('stand');
    expect([referenceOf('launchAudience'), referenceOf('offset(ownFlower, 0.2, 0)'), referenceOf('pose(park.x, 1, 0)')]).toEqual(['launchAudience', 'ownFlower', null]);
  });
  it('moves every step that names a reference point, and keeps a step in place when it changes reference or goes absolute', () => {
    const view = newSim().view(0), id = 'wall-sweep-pair-right', tree = copy(id); addAutoTree(tree);
    try {
      const at = (t: Json) => editHandles(AUTO_TREES[String(t.id)], view), refs = (t: Json) => referencePoints(AUTO_TREES[String(t.id)], view);
      const launch = refs(tree).find(r => r.name === 'launchAudience')!, users = at(tree).filter(h => poseText(tree, h) === 'launchAudience');
      expect(users.length).toBe(3);
      let t = moveReference(tree, launch, { x: launch.pose.x + 0.1, y: launch.pose.y }); addAutoTree(t);
      for (const u of users) expect(at(t).find(h => h.path === u.path)!.pose.x).toBeCloseTo(launch.pose.x + 0.1, 6);
      expect(changedDefs(t, source(id))).toEqual(new Set(['launchAudience']));
      // s3 is offset(ownFlower, 0.2, 0). Refer it to launchRear instead: it stays where it is.
      const s3 = at(t).find(h => h.path.endsWith('/s3'))!, rear = refs(t).find(r => r.name === 'launchRear')!;
      t = referTo(t, s3, rear); addAutoTree(t);
      expect(poseText(t, s3)).toMatch(/^offset\(launchRear, /);
      const moved = at(t).find(h => h.path === s3.path)!;
      expect(moved.pose.x).toBeCloseTo(s3.pose.x, 3); expect(moved.pose.y).toBeCloseTo(s3.pose.y, 3); expect(moved.pose.headingDeg).toBeCloseTo(s3.pose.headingDeg, 1);
      t = makeAbsolute(t, moved); addAutoTree(t);
      expect(poseText(t, s3)).toMatch(/^pose\(-?[\d.]+, -?[\d.]+, -?[\d.]+\)$/);
      expect(at(t).find(h => h.path === s3.path)!.pose.x).toBeCloseTo(s3.pose.x, 3);
    } finally { removeAutoTree(`${id}-test`); }
  });
  it('adds a reference point with a name that expressions can use', () => {
    const tree = copy('leave-and-park');
    expect(addReference(tree, '2fast', { x: 0, y: 0 })).toEqual({ error: expect.stringMatching(/letters/) });
    expect(addReference(tree, 'park', { x: 0, y: 0 })).toEqual({ error: expect.stringMatching(/already/) });
    const r = addReference(tree, 'midField', { x: -0.5, y: 0.25 }); if (!('tree' in r)) throw new Error(r.error);
    expect((r.tree.defs as Json).midField).toBe('pose(-0.5, 0.25, 0)');
    addAutoTree(r.tree);
    try { expect(referencePoints(AUTO_TREES[String(r.tree.id)], newSim().view(0)).map(q => q.name)).toContain('midField'); } finally { removeAutoTree(String(r.tree.id)); }
  });
});

describe('deleting a reference point', () => {
  it('makes the steps that name it absolute where they are, and refuses while a definition still uses it', () => {
    const view = newSim().view(0), id = 'wall-sweep-pair-right', tree = copy(id); addAutoTree(tree);
    try {
      const handles = editHandles(AUTO_TREES[String(tree.id)], view), users = handles.filter(h => h.kind === 'drive' && /^(offset\()?ownFlower\b/.test(poseText(tree, h) ?? ''));
      expect(users.length).toBeGreaterThanOrEqual(2);
      const r = deleteDef(tree, handles, 'ownFlower'); if (!('tree' in r)) throw new Error(r.error);
      expect((r.tree.defs as Json).ownFlower).toBeUndefined();
      expect(r.madeAbsolute).toEqual(users.map(u => u.path.split('/').pop()));
      addAutoTree(r.tree);
      const after = editHandles(AUTO_TREES[String(tree.id)], view);
      for (const u of users) {
        expect(poseText(r.tree, u)).toMatch(/^pose\(/);
        const a = after.find(h => h.path === u.path)!; expect(a.pose.x).toBeCloseTo(u.pose.x, 2); expect(a.pose.y).toBeCloseTo(u.pose.y, 2); // 1 mm rounding
      }
      // parkRight is pose(park.x, …, park.headingDeg), so park can't go until parkRight changes.
      const p = deleteDef(tree, handles, 'park'); expect(p).toEqual({ error: expect.stringMatching(/^parkRight still uses park\./) });
      expect(deleteDef(tree, handles, 'nothing')).toEqual({ error: expect.stringMatching(/no definition/) });
    } finally { removeAutoTree(`${id}-test`); }
  });
});

describe('plans', () => {
  it('gets an id from its name, and names the plan that it was copied from', () => {
    const taken = new Set(['rear-sweep-first']);
    expect(planId('Rear sweep first!', id => taken.has(id))).toBe('rear-sweep-first-2');
    expect(planId('  Élan: 2 TIPS  ', () => false)).toBe('elan-2-tips');
    expect(planId('***', () => false)).toBe('plan');
    const c = clonePlan(source('leave-and-park'), { id: 'my-park', name: 'My PARK', description: 'Parks.' });
    expect([c.id, c.name, c.description, sourceOf(c)]).toEqual(['my-park', 'My PARK', 'Parks.', 'leave-and-park']);
    expect(sourceOf(clonePlan(c, { id: 'my-park-2', name: 'My PARK 2', description: 'Parks again.' }))).toBe('my-park');
    expect(sourceOf(source('leave-and-park'))).toBeNull();
  });
  it("can't replace or remove a built-in tree", () => {
    expect(() => addAutoTree(source('leave-and-park'))).toThrow(/built in/);
    expect(removeAutoTree('leave-and-park')).toBe(false);
    expect(BUILT_IN_AUTO.size).toBe(11);
  });
  it('runs in the match: a moved first pose moves where the robot launches', () => {
    const id = 'solo-two-tip-sweep', plan = copy(id), s1 = editHandles(AUTO_TREES[id], newSim().view(0))[0];
    // Move the first launch pose 0.25 m toward the center line.
    const moved = moveHandle(plan, s1, { x: s1.pose.x + 0.25, y: s1.pose.y }); addAutoTree(moved);
    try {
      const at = (tree: string) => {
        const sim = newSim(); sim.start(); const c = new Coach(); c.autoOverride = tree;
        for (let k = 0; k < 2.0 / DT; k++) sim.step(sim.robots.map((_, i) => (i === 0 ? c.update(sim.view(0), DT) : NO_INPUT)), sim.robots.map(() => true));
        return sim.view(0).robot.translation();
      };
      const base = at(id), edited = at(String(moved.id));
      expect(edited.x - base.x).toBeGreaterThan(0.2); expect(Math.abs(edited.z - base.z)).toBeLessThan(0.05);
    } finally { removeAutoTree(String(moved.id)); }
  });
});
