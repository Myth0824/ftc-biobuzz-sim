import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTree } from '../src/bt';
import { AUTO_REGISTRY, AUTO_TREES, AutoProgram, leafParams, previewAuto } from '../src/auto/onboard';
import { autoStartPose, placeAutoStart } from '../src/auto/start-pose';
import { DT, Sim, NO_INPUT } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });
const plan = (id = 'imported-start', meta: Record<string, unknown> = { startAtFirstPose: true }) => loadTree({
  kind: 'bt.tree', id, name: id, env: 'onboard', meta,
  defs: { start: 'pose(-1.2, -0.9, 35)', next: 'pose(-0.8, -0.9, 35)' },
  root: { sequence: { children: [
    { id: 'start', ref: 'drive.driveTo', params: { pose: 'start', timeoutSec: 1 } },
    { id: 'next', ref: 'drive.driveTo', params: { pose: 'next', timeoutSec: 2 } },
  ] } },
}, AUTO_REGISTRY);

describe('AUTO start placement', () => {
  it('places red and blue at the source start pose before preview, preserving height and clearing velocity', () => {
    const sim = new Sim(RAPIER, undefined, 'full', 3, { opponent: true });
    const def = plan();
    for (let i = 0; i < 2; i++) {
      const view = sim.view(i), y = view.robot.translation().y;
      view.robot.setLinvel({ x: 1, y: 2, z: 3 }, true);
      view.robot.setAngvel({ x: 2, y: 1, z: 3 }, true);
      expect(placeAutoStart(def, view)).toBe(true);
      expect(view.robot.translation()).toEqual(expect.objectContaining({ y }));
      expect(view.robot.translation().x).toBeCloseTo(i ? 1.2 : -1.2);
      expect(view.robot.translation().z).toBeCloseTo(i ? -0.9 : 0.9);
      expect(view.heading).toBeCloseTo((35 + (i ? 180 : 0)) * Math.PI / 180);
      expect(view.robot.linvel()).toEqual({ x: 0, y: 0, z: 0 });
      expect(view.robot.angvel()).toEqual({ x: 0, y: 0, z: 0 });
      const p = view.robot.translation(), preview = previewAuto(def, view, p);
      expect(preview.path[0].x).toBeCloseTo(preview.poses[0].x);
      expect(preview.path[0].z).toBeCloseTo(preview.poses[0].z);
    }
    sim.world.free();
  });

  it('keeps system plans at their normal spawn and recognizes older Pedro imports', () => {
    const sim = new Sim(RAPIER, undefined, 'full');
    const original = sim.robot.translation();
    expect(placeAutoStart(AUTO_TREES['solo-two-tip-sweep'], sim)).toBe(false);
    expect(sim.robot.translation()).toEqual(original);
    expect(autoStartPose(plan('pedro-old-import', {}), sim)).toEqual({ x: -1.2, y: -0.9, headingDeg: 35 });
    expect(autoStartPose(plan('unrelated', {}), sim)).toBeNull();
    expect(autoStartPose(plan('pedro-opt-out', { startAtFirstPose: false }), sim)).toBeNull();
    sim.world.free();
  });

  it('uses the built-in team plan first drive pose as its spawn', () => {
    const sim = new Sim(RAPIER, undefined, 'full'), def = AUTO_TREES['32294-custom'];
    expect(autoStartPose(def, sim)).toEqual(leafParams(def, sim)[0].params.pose);
    expect(placeAutoStart(def, sim)).toBe(true);
    sim.world.free();
  });

  it('begins the first AUTO step at the initial source pose without an approach drive', () => {
    const sim = new Sim(RAPIER, undefined, 'full'), def = plan();
    placeAutoStart(def, sim);
    sim.start();
    const command = new AutoProgram(def).update(sim, DT);
    expect([command.forward, command.strafeRight, command.turnRight]).toEqual([0, 0, 0]);
    sim.world.free();
  });

  it('never teleports after the match starts or while AUTO runs', () => {
    const sim = new Sim(RAPIER, undefined, 'full'), def = plan();
    expect(placeAutoStart(def, sim)).toBe(true);
    sim.start();
    const before = sim.robot.translation();
    sim.robot.setTranslation({ ...before, x: -1.1 }, true);
    expect(placeAutoStart(def, sim)).toBe(false);
    expect(sim.robot.translation().x).toBeCloseTo(-1.1);
    const program = new AutoProgram(def);
    // Placement itself is strictly a setup operation; AUTO never reapplies it.
    for (let i = 0; i < 10; i++) sim.step(program.update(sim, DT), true);
    expect(sim.robot.translation().x).not.toBeCloseTo(-1.2, 4);
    sim.world.free();
  });
  it('keeps the source intake off unless an imported plan commands it', () => {
    const sim = new Sim(RAPIER, undefined, 'auto');
    const def = plan('pedro-no-intake', { startAtFirstPose: true });
    placeAutoStart(def, sim); sim.start();
    expect(new AutoProgram(def).update(sim, DT).intake).toBe('none');
    sim.world.free();
  });

  it('leaves the intake off after a source program finishes', () => {
    const sim = new Sim(RAPIER, undefined, 'auto');
    const def = loadTree({ kind: 'bt.tree', id: 'pedro-finished', name: 'Finished', env: 'onboard', meta: { startAtFirstPose: true }, root: { ref: 'wait', params: { timeoutSec: 0 } } }, AUTO_REGISTRY);
    sim.start();
    const program = new AutoProgram(def);
    for (let i = 0; i < 5; i++) program.update(sim, DT);
    expect(program.update(sim, DT).intake).toBe('none');
    sim.world.free();
  });

  it('does not run the intake when the AUTO clock has expired', () => {
    const sim = new Sim(RAPIER, undefined, 'auto');
    sim.carried = [];
    sim.cfg.intake.successP = 1;
    const p = sim.toWorld(sim.cfg.length / 2 + 0.03, 0);
    sim.spawn('pollen', p.x, 0.04, p.z);
    sim.start(); sim.clock = DT / 2;
    sim.step({ ...NO_INPUT, intake: 'none' }, true);
    expect(sim.phase).toBe('post');
    expect(sim.carried).toHaveLength(0);
    sim.world.free();
  });

  it('uses an edited first drive pose instead of a stale source start definition', () => {
    const sim = new Sim(RAPIER, undefined, 'full');
    const def = loadTree({ kind: 'bt.tree', id: 'pedro-edited', name: 'Edited', env: 'onboard', meta: { startAtFirstPose: true },
      defs: { start: 'pose(-1.2, -0.9, 35)' }, root: { ref: 'drive.driveTo', params: { pose: 'pose(-1.0, -0.8, 65)', timeoutSec: 2 } } }, AUTO_REGISTRY);
    expect(autoStartPose(def, sim)).toEqual({ x: -1, y: -0.8, headingDeg: 65 });
    sim.world.free();
  });

});
