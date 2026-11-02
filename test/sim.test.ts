import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROBOT, HIVE } from '../src/sim/config';
import { mecanumForces } from '../src/sim/drivetrain';
import { cameraSightings, seesRaisedCell } from '../src/sim/camera';
import { DT, NO_INPUT, Sim } from '../src/sim/world';

beforeAll(async () => { await RAPIER.init(); });
const run = (s: Sim, sec: number, inp = NO_INPUT) => { for (let i = 0; i < sec / DT; i++) s.step(inp); };

describe('drivetrain', () => {
  it('produces no net force at rest with no command', () => {
    const o = mecanumForces(DEFAULT_ROBOT, { forward: 0, strafeRight: 0, turnRight: 0 }, { vf: 0, vl: 0, w: 0 });
    expect(Math.abs(o.forceF) + Math.abs(o.forceL) + Math.abs(o.torque)).toBe(0);
  });
  it('reaches a top speed below the 2.37 m/s wheel free speed and strafes slower', () => {
    const s = new Sim(RAPIER, undefined, 'practice');
    s.robot.setTranslation({ x: -1.2, y: s.robot.translation().y, z: 1.2 }, true); // Clear of the HIVE foot bars.
    const t0 = s.robot.translation().x; let t1 = 0;
    let fwd = 0;
    for (let i = 0; i < 1.3 / DT; i++) { s.step({ ...NO_INPUT, forward: 1 }); fwd = Math.max(fwd, s.telemetry.speed); if (!t1 && s.robot.translation().x - t0 > 1) t1 = i * DT; }
    console.log('forward top speed', fwd.toFixed(2), 'm/s; time to 1 m', t1.toFixed(2), 's; bus', s.telemetry.busVoltage.toFixed(1), 'V');
    expect(fwd).toBeGreaterThan(1.7); expect(fwd).toBeLessThan(2.2);
    const s2 = new Sim(RAPIER, undefined, 'practice');
    s2.robot.setTranslation({ x: 0.9, y: s2.robot.translation().y, z: 1.2 }, true);
    run(s2, 1.2, { ...NO_INPUT, strafeRight: -1 });
    console.log('strafe top speed', s2.telemetry.speed.toFixed(2));
    expect(s2.telemetry.speed).toBeLessThan(fwd);
  });
  it('stops within 1 s in BRAKE mode', () => {
    const s = new Sim(RAPIER, undefined, 'practice');
    s.robot.setTranslation({ x: -1.2, y: s.robot.translation().y, z: 1.2 }, true);
    run(s, 1, { ...NO_INPUT, forward: 1 }); run(s, 1);
    expect(s.telemetry.speed).toBeLessThan(0.1);
  });
});

describe('shooting and HIVE TIP', () => {
  it('tips the red HIVE with POLLEN launched from the aiming distance', () => {
    const s = new Sim(RAPIER, undefined, 'practice', 7);
    const y = s.robot.translation().y;
    // The shooter faces the rear of the robot, so the robot faces the audience (+Z) with its back to the red HIVE.
    let zOk = 0;
    for (let z = 0.8; z < 1.6; z += 0.02) {
      s.robot.setTranslation({ x: HIVE.pivotX.red, y, z }, true); s.robot.setRotation({ x: 0, y: -Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true);
      if (s.previewShot('pollen').scores) { zOk = z; break; }
    }
    console.log('first scoring robot z', zOk.toFixed(2));
    expect(zOk).toBeGreaterThan(0);
    s.robot.setTranslation({ x: HIVE.pivotX.red, y, z: zOk + 0.15 }, true);
    let shots = 0;
    while (s.hives.red.tips === 0 && shots < 16) {
      s.carried = ['pollen']; run(s, 0.05, { ...NO_INPUT, shootPollen: true }); run(s, 1.2); shots++;
    }
    console.log('shots to tip', shots, 'tips', s.hives.red.tips);
    // 3 NECTAR are staged in the CELL, so the calibration standard predicts a tip on the third POLLEN that stays in.
    expect(s.hives.red.tips).toBe(1); expect(shots).toBeLessThanOrEqual(6);
    run(s, 3);
    expect(s.hives.red.upCell).toBe('rear');
    expect(s.stash.red).toBe(4); // The HUMAN PLAYER entered one NECTAR after the TIP.
    expect(s.score('red').teleopTips).toBe(20);
  });
  it('a manual full-360 turret holds its angle while the robot turns, and previewShot shows auto-aim', () => {
    const turret = () => { const c = structuredClone(DEFAULT_ROBOT); c.shooter.turret = true; return c; };
    const t = new Sim(RAPIER, undefined, 'practice', 7, { configFor: turret }), f = new Sim(RAPIER, undefined, 'practice', 7);
    const y = t.robot.translation().y, at = { x: HIVE.pivotX.red, y, z: 1.3 };
    const face = (s: Sim, heading: number) => { s.robot.setTranslation(at, true); s.robot.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true); };
    // previewShot always shows auto-aim (turretHeading) — scores from any heading before first step
    const scores = (s: Sim) => [0, 1, 2, 3].map(q => { face(s, (q * Math.PI) / 2); return s.previewShot('pollen').scores; });
    expect(scores(t)).toEqual([true, true, true, true]);
    expect(scores(f).filter(Boolean).length).toBe(1);
    // A real launch: aim the turret manually at the HIVE, then shoot
    face(t, Math.PI / 2);
    // Set turretAngle to point at HIVE (robot-relative: HIVE is behind the robot facing +Z, so angle = PI)
    t.robots[0].turretAngle = Math.PI;
    let shots = 0;
    while (t.hives.red.tips === 0 && shots < 16) { t.carried = ['pollen']; run(t, 0.05, { ...NO_INPUT, shootPollen: true }); run(t, 1.2); shots++; }
    expect(t.hives.red.tips).toBe(1); expect(shots).toBeLessThanOrEqual(6);
  });
  it('turns a limited turret at its slew rate and stops it at the end of its range', () => {
    const limited = (rangeDeg: number, slew: number) => () => { const c = structuredClone(DEFAULT_ROBOT); c.shooter.turret = true; c.shooter.turretRangeDeg = rangeDeg; c.shooter.turretSlewDegPerSec = slew; return c; };
    const face = (s: Sim, heading: number) => s.robot.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
    // A full-range turret at 90°/s, aimed at the start. Then the robot turns half a turn, and the turret needs 2 s.
    const s = new Sim(RAPIER, undefined, 'practice', 7, { configFor: limited(360, 90) }), y = s.robot.translation().y;
    s.robot.setTranslation({ x: HIVE.pivotX.red, y, z: 1.4 }, true); face(s, -Math.PI / 2); run(s, 0.1);
    expect(s.previewShot('pollen').scores).toBe(true);
    face(s, Math.PI / 2); run(s, 0.5); expect(s.previewShot('pollen').scores).toBe(false);
    run(s, 2); expect(s.previewShot('pollen').scores).toBe(true);
    // A 90° turret can't reach a CELL half a turn away from its mount.
    const n = new Sim(RAPIER, undefined, 'practice', 7, { configFor: limited(90, 3600) });
    n.robot.setTranslation({ x: HIVE.pivotX.red, y, z: 1.4 }, true); face(n, Math.PI / 2); run(n, 1);
    expect(n.previewShot('pollen').scores).toBe(false);
  });
});

describe('initial state', () => {
  it('stages 3 NECTAR in each raised CELL and scores 4 POLLEN per GARDEN', () => {
    const s = new Sim(RAPIER, undefined, 'teleop'); run(s, 1.5);
    expect(s.cellCount('red')).toBe(3); expect(s.cellCount('blue')).toBe(3);
    expect(s.hives.red.tips + s.hives.blue.tips).toBe(0);
    expect(s.score('red').garden).toBe(4); expect(s.score('blue').garden).toBe(4);
  });
});

describe('AUTO', () => {
  it('ignores human input, accepts program input, and scores LEAVE', () => {
    const human = new Sim(RAPIER, undefined, 'full'); human.start(); const x0 = human.robot.translation().x;
    run(human, 2, { ...NO_INPUT, forward: 1 });
    // The wall contact pushes the robot out by about 1 cm as it settles. That isn't a LEAVE.
    expect(human.robot.translation().x - x0).toBeLessThan(0.02);
    run(human, 29); expect(human.phase).toBe('transition'); expect(human.score('red').leave).toBe(0);
    const prog = new Sim(RAPIER, undefined, 'full'); prog.start();
    for (let i = 0; i < 1 / DT; i++) prog.step({ ...NO_INPUT, forward: 0.6 }, true);
    for (let i = 0; i < 30 / DT; i++) prog.step(NO_INPUT, true);
    expect(prog.phase).toBe('transition'); expect(prog.score('red').leave).toBe(3);
  });
});

describe('AprilTag camera', () => {
  const at = (s: Sim, x: number, z: number, headingDeg: number) => { const h = (headingDeg * Math.PI) / 180; s.robot.setTranslation({ x, y: s.robot.translation().y, z }, true); s.robot.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true); };
  it('reads the raised CELL from both launch spots, and nothing from the starting pose or with its back turned', () => {
    const s = new Sim(RAPIER, undefined, 'practice'); run(s, 0.5); // The red HIVE starts with the audience CELL raised.
    at(s, HIVE.pivotX.red, 1.32, -90); const straight = cameraSightings(s).find(q => q.alliance === 'red' && q.cell === 'audience');
    expect(straight?.tags).toBe(4); expect(seesRaisedCell(s, 'audience')).toBe(true); expect(seesRaisedCell(s, 'rear')).toBe(false);
    at(s, HIVE.pivotX.red - 0.62, 1.17, -129.4); expect(seesRaisedCell(s, 'audience')).toBe(true);   // The partner's angled spot.
    at(s, HIVE.pivotX.red, 1.32, 90); expect(cameraSightings(s).length).toBe(0);                      // Shooter side turned away.
    at(s, -1.57, -0.1, 0); expect(seesRaisedCell(s, 'audience')).toBe(false);                         // The starting pose on the wall.
  });
});
