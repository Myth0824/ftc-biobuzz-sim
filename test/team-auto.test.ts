import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { Coach } from '../src/auto/coach';
import { AUTO_TREES, alliancePose } from '../src/auto/onboard';
import { placeAutoStart } from '../src/auto/start-pose';
import { metaBot, robotConfig, teamBot } from '../src/setup';
import { DT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });
describe('team32294 source route in a four-robot AUTO', () => {
  it('fires individual preloads, stays on its half and parks with normal partner/opponent autos running', () => {
    const bots = [teamBot(0), metaBot(1), metaBot(2), metaBot(3)];
    const sim = new Sim(RAPIER, undefined, 'auto', 3, { opponentCount: 3, configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) });
    placeAutoStart(AUTO_TREES['32294-custom'], sim);
    const coaches = sim.robots.map((_, i) => { const c = new Coach(); if (i === 0) c.autoOverride = '32294-custom'; return c; });
    const shots: { at: number; count: number }[] = [];
    let maxX = -Infinity;
    sim.start();
    while (sim.phase !== 'post') {
      const before = sim.carried.length;
      sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), sim.robots.map(() => true));
      if (before > sim.carried.length) shots.push({ at: sim.time, count: before - sim.carried.length });
      maxX = Math.max(maxX, alliancePose(sim.robot.translation(), sim.heading, false).x);
    }
    expect(shots).toHaveLength(3);
    expect(shots.every(s => s.count === 1)).toBe(true);
    expect(shots[1].at - shots[0].at).toBeGreaterThanOrEqual(0.9);
    expect(shots[2].at - shots[1].at).toBeGreaterThanOrEqual(0.9);
    expect(maxX + sim.cfg.width / 2).toBeLessThan(0);
    expect(sim.robotInLoadingZone()).toBe(true);
    expect(sim.carried).toHaveLength(1);
    sim.world.free();
  }, 30000);
});
