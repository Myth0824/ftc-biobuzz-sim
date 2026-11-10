import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUTO_TREES, addAutoTree, previewAuto, removeAutoTree } from '../src/auto/onboard';
import { Sim } from '../src/sim/world';
import { importPedroProject, listPedroOpModes } from '../src/auto/pedro';

import launch from './fixtures/pedro-biobuzz/LaunchParkAuto.java?raw';
import park from './fixtures/pedro-biobuzz/ParkAuto.java?raw';
import base from './fixtures/pedro-biobuzz/BiobuzzAuto.java?raw';
import paths from './fixtures/pedro-biobuzz/AutoPaths.java?raw';
import field from './fixtures/pedro-biobuzz/Field.java?raw';

const files = [
  { name: 'LaunchParkAuto.java', java: launch }, { name: 'ParkAuto.java', java: park },
  { name: 'BiobuzzAuto.java', java: base }, { name: 'AutoPaths.java', java: paths }, { name: 'Field.java', java: field },
];
const steps = (tree: Record<string, unknown>) => (tree.root as { sequence: { children: { ref: string; params: { tag?: string; waypoints?: { x: number; y: number; headingDeg: number }[]; timeoutSec?: number } }[] } }).sequence.children;

beforeAll(async () => { await RAPIER.init(); });

describe('multi-file Pedro import', () => {
  it('offers only annotated concrete OpModes as entry files', async () => {
    expect(await listPedroOpModes(files)).toEqual([
      { fileName: 'LaunchParkAuto.java', name: 'Launch Park Auto' },
      { fileName: 'ParkAuto.java', name: 'Park Auto' },
    ]);
  });

  it('imports only the selected Park routine, resolving companion constants and pose helpers', async () => {
    const { tree, warnings } = await importPedroProject(files, { entryFile: 'ParkAuto.java' });
    expect(tree.name).toBe('Pedro: Park Auto');
    expect(tree.defs).toEqual({ start: 'pose(-1.6, 0.318, 0)' });
    expect(steps(tree).map(s => s.ref)).toEqual(['drive.driveTo', 'drive.followPath']);
    expect(steps(tree)[1].params).toMatchObject({ tag: 'pedro-wallToPark', waypoints: [{ x: -1.499, y: 0.914, headingDeg: 0 }] });
    expect(warnings.join(' ')).not.toMatch(/Skipped|never calls/);
    expect(() => { addAutoTree(tree); removeAutoTree(String(tree.id)); }).not.toThrow();
  });

  it('imports Launch Park in follow order, without inventing a launcher action or timeout wait', async () => {
    const { tree } = await importPedroProject([...files].reverse(), { entryFile: 'LaunchParkAuto.java' });
    expect(tree.defs).toEqual({ start: 'pose(-0.305, -1.6, 90)' });
    const c = steps(tree);
    expect(c.map(s => s.ref)).toEqual(['drive.driveTo', 'drive.followPath', 'drive.followPath']);
    expect(c.slice(1).map(s => s.params.tag)).toEqual(['pedro-startToLaunch', 'pedro-launchToPark']);
    expect(c[2].params.waypoints).toHaveLength(6);
    expect(c[2].params.waypoints?.at(-1)).toEqual({ x: -1.499, y: 0.914, headingDeg: 90 });
    expect(() => { addAutoTree(tree); removeAutoTree(String(tree.id)); }).not.toThrow();
  });

  it('normalizes the blue enum helper result to the same red-frame route', async () => {
    const red = await importPedroProject(files, { entryFile: 'LaunchParkAuto.java', alliance: 'RED' });
    const blue = await importPedroProject(files, { entryFile: 'LaunchParkAuto.java', alliance: 'BLUE' });
    expect(blue.tree.defs).toEqual(red.tree.defs);
    expect(steps(blue.tree)).toEqual(steps(red.tree));
    expect(blue.warnings.join(' ')).toMatch(/rotated 180/);
  });

  it('requires an entry when multiple routines are supplied', async () => {
    await expect(importPedroProject(files)).rejects.toThrow(/choose.*OpMode/i);
  });

  it('automatically selects the sole OpMode regardless of upload order', async () => {
    const { tree } = await importPedroProject(files.filter(f => f.name !== 'LaunchParkAuto.java').reverse());
    expect(tree.name).toBe('Pedro: Park Auto');
  });

  it('reports missing companions instead of importing other paths', async () => {
    await expect(importPedroProject(files.filter(f => f.name !== 'Field.java'), { entryFile: 'ParkAuto.java' })).rejects.toThrow(/wallToPark|companion/i);
  });

  it('identifies an invalid companion by file name and line', async () => {
    await expect(importPedroProject([...files, { name: 'Broken.java', java: 'class Broken {\n void f() { x = ; }\n}' }], { entryFile: 'ParkAuto.java' })).rejects.toThrow(/Broken.java.*line 2/);
  });

  it('requires a real entry file and rejects ambiguous duplicate filenames', async () => {
    await expect(importPedroProject(files, { entryFile: 'Missing.java' })).rejects.toThrow(/Missing.java/);
    await expect(importPedroProject([...files, files[0]], { entryFile: 'ParkAuto.java' })).rejects.toThrow(/duplicate/i);
  });

  it('does not offer annotated abstract base classes as routines', async () => {
    expect(await listPedroOpModes([{ name: 'Base.java', java: '@Autonomous(name="Base") public abstract class Base {}' }])).toEqual([]);
  });

  it('keeps another uploaded OpMode from replacing the selected routine path', async () => {
    const src = [
      { name: 'Auto.java', java: '@Autonomous(name="Auto") class Auto { void run() { follower.follow(paths.go); } }' },
      { name: 'Paths.java', java: 'class Paths { Path go = line(new Pose(10,10,0), new Pose(20,20,0)); }' },
      { name: 'ZOther.java', java: '@Autonomous(name="Other") class Other { Path go = line(new Pose(40,40,0), new Pose(50,50,0)); void run() { follower.follow(go); } }' },
    ];
    const result = await importPedroProject(src, { entryFile: 'Auto.java' });
    const alone = await importPedroProject(src.slice(0, 2), { entryFile: 'Auto.java' });
    expect(result.tree).toEqual(alone.tree);
  });

  it('does not duplicate qualified aliases when falling back to declaration order', async () => {
    const { tree, warnings } = await importPedroProject([
      { name: 'Auto.java', java: '@Autonomous(name="Auto") class Auto { Path go = line(new Pose(10,10,0), new Pose(20,20,0)); }' },
      { name: 'Constants.java', java: 'class Constants { double scale = 2; }' },
    ]);
    expect(steps(tree).filter(s => s.ref === 'drive.followPath')).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/never calls/);
  });

  it('resolves a pose helper constant in its declaring class scope', async () => {
    const extras = [...files, { name: 'ZConstants.java', java: 'class ZConstants { double SIZE = 10; }' }];
    const red = await importPedroProject(extras, { entryFile: 'ParkAuto.java', alliance: 'RED' });
    const blue = await importPedroProject(extras, { entryFile: 'ParkAuto.java', alliance: 'BLUE' });
    expect(blue.tree.defs).toEqual(red.tree.defs);
    expect(steps(blue.tree)).toEqual(steps(red.tree));
  });

  it.each(['ParkAuto.java', 'LaunchParkAuto.java'])('previews %s with just its path and field companions', async entryFile => {
    const { tree } = await importPedroProject(files.filter(f => [entryFile, 'AutoPaths.java', 'Field.java'].includes(f.name)));
    addAutoTree(tree);
    try {
      const sim = new Sim(RAPIER, undefined, 'full', 3, { opponent: true, partners: true });
      const preview = previewAuto(AUTO_TREES[String(tree.id)], sim, sim.robot.translation());
      expect(preview.poses).toHaveLength(entryFile === 'ParkAuto.java' ? 2 : 8);
      expect(preview.poses.every(p => !p.shoots)).toBe(true);
      expect(preview.path.at(-1)).toEqual({ x: -1.499, z: -0.914 });
    } finally { removeAutoTree(String(tree.id)); }
  });

  it('retains single-file imports through the project API used by the picker', async () => {
    const { tree, warnings } = await importPedroProject([{ name: 'Solo.java', java: `
      @Autonomous(name="Solo") class Solo {
        Pose a = new Pose(9,20,0), b = new Pose(13,108,0);
        Path go = line(a,b).linear(a,b);
        void run() { follower.follow(go); }
      }` }]);
    expect(tree.name).toBe('Pedro: Solo');
    expect(steps(tree)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('preserves the owner of an explicitly qualified companion path', async () => {
    const { tree } = await importPedroProject([
      { name: 'Auto.java', java: '@Autonomous(name="Auto") class Auto { void run() { follower.follow(First.go); } }' },
      { name: 'First.java', java: 'class First { static Path go = line(new Pose(10,10,0), new Pose(20,20,0)); }' },
      { name: 'Second.java', java: 'class Second { static Path go = line(new Pose(40,40,0), new Pose(50,50,0)); }' },
    ]);
    expect(tree.defs).toEqual({ start: 'pose(-1.575, -1.575, 0)' });
    expect(steps(tree)[1].params.waypoints).toEqual([{ x: -1.321, y: -1.321, headingDeg: null }]);
  });

  it.each(['paths.go', 'go'])('refuses an ambiguous path %s instead of guessing geometry', async expr => {
    await expect(importPedroProject([
      { name: 'Auto.java', java: `@Autonomous(name="Auto") class Auto { void run() { follower.follow(${expr}); } }` },
      { name: 'First.java', java: 'class First { Path go = line(new Pose(10,10,0), new Pose(20,20,0)); }' },
      { name: 'Second.java', java: 'class Second { Path go = line(new Pose(40,40,0), new Pose(50,50,0)); }' },
    ])).rejects.toThrow(/ambiguous.*go/i);
  });

  it('keeps callbacks in different companion files independent', async () => {
    const { tree } = await importPedroProject([
      { name: 'Auto.java', java: '@Autonomous(name="Auto") class Auto { void run() { follower.follow(first); follower.follow(second); } }' },
      { name: 'First.java', java: 'class First { Path first = line(new Pose(10,10,0), new Pose(20,20,0)).addCallback(() -> intake.start()); }' },
      { name: 'Second.java', java: 'class Second { Path second = line(new Pose(20,20,0), new Pose(30,30,0)).addCallback(() -> shooter.fire()); }' },
    ]);
    const c = steps(tree);
    expect(c.map(s => s.ref ?? 'parallel')).toEqual(['drive.driveTo', 'parallel', 'drive.followPath', 'shooter.shoot']);
  });

});
