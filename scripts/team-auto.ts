/** Import the actual team Java snapshots, regenerate its built-in plan, and measure isolated AUTO runs. */
import { readFileSync, writeFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { importPedroProject } from '../src/auto/pedro';
import { AUTO_TREES, AutoProgram, addAutoTree, removeAutoTree, alliancePose } from '../src/auto/onboard';
import { placeAutoStart } from '../src/auto/start-pose';
import { robotConfig, teamBot } from '../src/setup';
import { DT, Sim, NO_INPUT } from '../src/sim/world';

const sources = ['ParkAuto.java', 'LaunchParkAuto.java', 'AutoPaths.java', 'Field.java'].map(name => ({
  name, java: readFileSync(new URL(`../test/fixtures/pedro-biobuzz/${name}`, import.meta.url), 'utf8'),
}));
const launch = await importPedroProject(sources, { entryFile: 'LaunchParkAuto.java' });
if (process.argv.includes('--write-plan')) {
  const tree = { ...launch.tree, id: '32294-custom', name: '32294: rear preload shots and PARK', description: 'Team source route: legal audience-wall start, fixed rear FIFO shooter, three individual preloads at 0.9 s intervals, hive settling, then PARK. Fourth preload retained. Front intake runs only when commanded.' };
  writeFileSync(new URL('../src/auto/trees/auto/32294-custom.json', import.meta.url), JSON.stringify(tree, null, 1) + '\n');
  console.log('Regenerated 32294-custom from the Java source snapshots.');
  process.exit(0);
}
await RAPIER.init();
const results = [];
for (const entryFile of ['ParkAuto.java', 'LaunchParkAuto.java']) {
  const { tree } = entryFile === 'LaunchParkAuto.java' ? launch : await importPedroProject(sources, { entryFile });
  const def = addAutoTree(tree);
  try {
    for (const alliance of ['red', 'blue'] as const) for (const seed of [1, 3, 7]) {
      const sim = new Sim(RAPIER, undefined, 'auto', seed, { opponent: alliance === 'blue', configFor: () => robotConfig(teamBot()) });
      const index = alliance === 'blue' ? 1 : 0, view = sim.view(index);
      placeAutoStart(def, view);
      const start = alliancePose(view.robot.translation(), view.heading, alliance === 'blue');
      const auto = new AutoProgram(def), shots: { at: number; count: number }[] = [];
      let maxOwnX = -Infinity;
      sim.start();
      while (sim.phase !== 'post') {
        const before = view.carried.length;
        const commands = sim.robots.map((_, i) => i === index ? auto.update(view, DT) : NO_INPUT);
        sim.step(commands, sim.robots.map(() => true));
        if (before > view.carried.length) shots.push({ at: Number(sim.time.toFixed(3)), count: before - view.carried.length });
        const p = alliancePose(view.robot.translation(), view.heading, alliance === 'blue');
        maxOwnX = Math.max(maxOwnX, p.x);
      }
      const score = sim.score(alliance);
      results.push({ entryFile, alliance, seed, start, end: alliancePose(view.robot.translation(), view.heading, alliance === 'blue'), shots, retained: view.carried.length, parked: view.robotInLoadingZone(), maxOwnX, score });
      sim.world.free();
    }
  } finally { removeAutoTree(String(tree.id)); }
}
const output = process.argv.indexOf('--output');
if (output >= 0 && process.argv[output + 1]) { writeFileSync(process.argv[output + 1], JSON.stringify(results, null, 2) + '\n'); console.log(`Wrote ${results.length} team AUTO evaluations.`); }
else console.log(JSON.stringify(results, null, 2));
