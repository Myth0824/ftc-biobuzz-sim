# Contribute to the BIOBUZZ simulator

Thanks for helping. This project is run by the students and mentors of three FTC teams, and it welcomes changes from
any team. This page says how to set up, what the project's rules are, and how a change gets accepted.

## Set up

You need Node.js 20 or later. Python 3 is needed only to rebuild the Match Lab and the lessons page.

1. To install the dependencies, run `npm install`.
2. To start the simulator, run `npm run dev`, and open the URL that Vite prints.
3. To run the tests, run `npm test`. They take about 80 seconds. `npm run test:watch` reruns them as you edit,
   `npm run check` type-checks, and `npm run preview` serves the production build, with offline mode, at port 4173.

The field model, `public/field.glb`, is in the repository, so you don't need the CAD to run anything. To rebuild it,
download the official field STEP file to `cad/field-cad-step.step`, and run `node scripts/convert-step.mjs`.

## Rules of the code

- **`src/sim/` runs headless.** It has no DOM and no three.js dependency, so that a match runs in Node.js. Rendering
  lives in `src/render/`, and the page logic in `src/main.ts`, which boots the page and runs the frame loop, the panels in `src/ui/`, and `src/review.ts`.
- **Every game constant cites its source.** Field geometry comes from `cad/field-manifest.json`, and rules and points
  from the Competition Manual or the Event Field Setup Guide. Say which, in a comment, when you add one.
- **Mark assumptions.** If a number isn't measured or published, the comment says `ASSUMPTION`, as the camera range in
  `src/sim/config.ts` does.
- **After a change to `src/sim/hive.ts` or to `BALL` in `src/sim/config.ts`, run `npm test`.** The six calibration
  rows of the Event Field Setup Guide must pass. `docs/hive-calibration.md` says how to calibrate again.
- **No Node-only code in `src/`.** The same files run in the browser, where `process` doesn't exist. A switch for an
  experiment goes in an exported tuning object, such as `EXEC` in `src/auto/executor.ts`, and a script sets it.
- **Match the surrounding style:** two-space indent, a doc comment on every exported item that says what it does and
  why, and comments that carry the reason or the measurement, not a restatement of the code.

## Change the planner or a robot model

A planner change that looks right can lose points. Several did. So a change to `src/auto/` or to the robot model
comes with a measurement:

1. To measure the code before your change, run `npx tsx scripts/eval.ts before`. It plays 24 fixed seeds in about 2
   minutes and appends to `experiments/policy-loop.jsonl`.
2. Make one change.
3. Run `npx tsx scripts/eval.ts your-label`, and then run `python3 scripts/eval-compare.py before your-label`.
4. Add a row to `experiments/policy-loop.md` with the change, the score, and the decision, whether you keep the change
   or not. A reverted experiment is a result too.

One match varies by about 20 points, and the standard error over 24 seeds is 6 to 10 points. Treat a difference under
20 combined points as unproven, and say so in the row.

To compare robot designs, add a row to `scripts/exp-specs.ts`, run `npx tsx scripts/exp-run.ts GROUP 96 10 101 TAG`,
and then run `npx tsx scripts/exp-report.ts`. Its Change column compares each design with the baseline seed by
seed.

## Report a behavior that looks wrong

The fastest bug report is an annotated match:

1. Play a match in the simulator, and press **V** to review it.
2. Scrub to the moment, click the robot, and type what is wrong.
3. Click the gear icon in the control bar, click **Export**, and attach the two files to a GitHub issue.

The notes file records what every robot was doing at each marked moment, which is what a fix needs. The files in
`traces/` are the annotated matches that drove the fixes so far, and the code comments refer to them by name.

## Change the site or the writing

- The home page is `index.html`, the simulator's page is `sim/index.html`, the Match Lab comes from
  `scripts/results-page.template.html`, and the lessons come from `docs/top-ten.md`.
- After a change to the post, the template, or the result files, run `python3 scripts/build-site.py`, and commit the
  pages that it writes under `public/`.
- Every number in the post comes from a file in `experiments/`. If you add a number, add the run that produced it.
- The writing follows the [Google developer documentation style guide](https://developers.google.com/style): second
  person, present tense, and claims that a reader can check.

## Pull requests

- Keep one purpose per pull request.
- Write the commit subject in the imperative, under 72 characters. In the body, say what changed and why, how you
  verified it, and what you left untested.
- `npm test` and `npx tsc --noEmit` must pass. CI runs both, checks that the generated pages are fresh, and builds the
  site. `main` accepts a pull request only when that check is green.
- Cloudflare builds a preview of the site for every pull request, and the preview's URL appears on the pull request.
- By contributing, you agree that your contribution is licensed under the MIT license in `LICENSE`.

## Conduct

The [code of conduct](CODE_OF_CONDUCT.md) applies to every issue, pull request, and discussion.
