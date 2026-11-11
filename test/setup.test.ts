import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REF_ERR, defaultBot, loadBots, metaBot, robotConfig, sanitize, saveBots, teamBot, type BotSetup } from '../src/setup';
import { DEFAULT_ROBOT } from '../src/sim/config';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });
afterEach(() => vi.unstubAllGlobals());

function storage() {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v) });
}

describe('team robot defaults', () => {
  it('loads the team robot with reference drive and an 18 inch chassis, leaving opponents on the meta preset', () => {
    storage();
    const bots = loadBots(), cfg = robotConfig(bots[0]);
    expect(bots[0]).toMatchObject(teamBot(0));
    expect(bots[0].auto).toBe('32294-custom');
    expect(bots[0].sizeIn).toBe(18);
    expect(cfg.motor.freeRpm).toBe(DEFAULT_ROBOT.motor.freeRpm);
    expect(cfg.mass).toBeCloseTo(DEFAULT_ROBOT.mass, 1);
    expect(cfg.intake.dualSided).toBe(false);
    expect(cfg.shooter).toMatchObject({ type: 'fifo', facing: 'rear', cycleSec: 0.9, turret: false, dualSided: false });
    expect(bots[1]).toMatchObject({ shooter: 'catapult', driveRpm: 500, sizeIn: 12, massLb: 15.4, dualIntake: true });
    expect(robotConfig(metaBot(1)).shooter.cycleSec).toBe(DEFAULT_ROBOT.shooter.cycleSec);
  });

  it('migrates the old main meta preset once while preserving unrelated saved settings', () => {
    storage();
    const bots = [metaBot(0), { ...metaBot(1), sizeIn: 17, auto: 'leave-and-park' }, metaBot(2), metaBot(3)];
    bots[0] = { ...bots[0], driver: 'keyboard', stickFrame: 'robot', errAzimDeg: 3, intakeP: 0.8, turret: true };
    saveBots(bots);
    const loaded = loadBots();
    expect(loaded[0]).toMatchObject({ auto: '32294-custom', shooter: 'fifo', sizeIn: 18, driveRpm: 435, driver: 'keyboard', stickFrame: 'robot', errAzimDeg: 3, intakeP: 0.8, turret: false });
    expect(loaded[1]).toEqual(sanitize(bots[1], 1));
    loaded[0].auto = 'default'; saveBots(loaded);
    expect(loadBots()[0].auto).toBe('default');
  });

  it('preserves custom dimensions and AUTO while replacing a saved main catapult', () => {
    storage();
    const custom = { ...metaBot(0), sizeIn: 16, massLb: 30, driveRpm: 700, auto: 'pedro-own-plan', turret: true, dualShooter: true };
    saveBots([custom, metaBot(1), metaBot(2), metaBot(3)]);
    expect(loadBots()[0]).toMatchObject({ sizeIn: 16, massLb: 30, driveRpm: 700, auto: 'pedro-own-plan', shooter: 'fifo', turret: false, dualShooter: false });
  });

  it('retains custom drive tuning while migrating any saved main shooter to one-ball FIFO', () => {
    storage();
    saveBots([{ ...metaBot(0), shooter: 'dual' }, metaBot(1), metaBot(2), metaBot(3)]);
    expect(loadBots()[0]).toMatchObject({ sizeIn: 12, massLb: 15.4, driveRpm: 500, shooter: 'fifo' });
  });

  it('fires loaded balls individually with at least 0.9 seconds between shots', () => {
    const sim = new Sim(RAPIER, undefined, 'practice', 1, { configFor: () => robotConfig(teamBot(0)) });
    const shots: number[] = [];
    for (let step = 0; step < 3 / DT; step++) {
      const held = sim.carried.length;
      sim.step({ ...NO_INPUT, shootPollen: true });
      if (sim.carried.length < held) {
        expect(held - sim.carried.length).toBe(1);
        shots.push(step * DT);
      }
    }
    expect(shots).toHaveLength(4);
    for (let i = 1; i < shots.length; i++) expect(shots[i] - shots[i - 1]).toBeGreaterThanOrEqual(0.9 - 1e-9);
    sim.world.free();
  });
});

describe('sanitize', () => {
  it('maps a stored spreadX to the three launcher errors once, and then drops it', () => {
    const stored = { ...defaultBot(0), spreadX: 2 } as BotSetup & { spreadX?: number };
    const once = sanitize(stored, 0);
    expect([once.errElevDeg, once.errAzimDeg, once.errSpeed]).toEqual([REF_ERR.errElevDeg * 2, REF_ERR.errAzimDeg * 2, REF_ERR.errSpeed * 2]);
    expect('spreadX' in once).toBe(false);
    // The robot config popup writes the chip values into the setup and sanitizes it again (#8).
    const edited = sanitize({ ...once, errElevDeg: 3, errAzimDeg: 3.6, errSpeed: 0.24 }, 0);
    expect([edited.errElevDeg, edited.errAzimDeg, edited.errSpeed]).toEqual([3, 3.6, 0.24]);
  });
});
