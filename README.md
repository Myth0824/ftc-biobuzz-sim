# BIOBUZZ simulator

A browser physics simulator for BIOBUZZ, the 2026-2027 *FIRST* Tech Challenge game, with the results of about 12,000
simulated matches. It is a project of the students and mentors of NCSSM FTC teams 5064, 8569, and 22377.

[![CI](https://github.com/caryden/ftc-biobuzz-sim/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/caryden/ftc-biobuzz-sim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live site: <https://biobuzz.ncssmftc.org/>**

| Page | What it is |
| --- | --- |
| [Ten lessons](https://biobuzz.ncssmftc.org/lessons/) | What to build, what to practice, and how to plan a match, with the numbers behind each lesson |
| [Match Lab](https://biobuzz.ncssmftc.org/lab/) | Configure an alliance, and see its estimated score distribution and its chance of beating an opponent |
| [Simulator](https://biobuzz.ncssmftc.org/sim/) | Four robots play a full match on the official field. Configure each robot, drive with a controller, and review and annotate the match. |

This project isn't affiliated with or endorsed by *FIRST*. See [NOTICE.md](NOTICE.md).

## What the simulator models

- **The field.** The official field CAD supplies every field element. The HIVE is a rigid body on a pivot, calibrated to
  the six tipping cases of the Event Field Setup Guide, section 12.3. See [docs/hive-calibration.md](docs/hive-calibration.md).
- **The robots.** A mecanum drivetrain with a DC motor model, a battery with internal resistance, and a traction limit.
  The intake, the launcher, and FLOWER placement are bulk models with sampled errors, not mechanism physics.
- **The match.** A full 2:30 MATCH with AUTO, the transition, TELEOP, scoring, ranking points, and a PIN referee (G421).
- **The drivers.** Every robot runs an AUTO behavior tree. In TELEOP, a TELEOP tree or a person with a controller drives.

[docs/simulator.md](docs/simulator.md) describes the planner, the AUTO trees, partner coordination, the robot
config, and the review mode.

## Run it

You need Node.js 20 or later.

1. To install the dependencies, run `npm install`.
2. To start the dev server, run `npm run dev`.
3. Open the URL that Vite prints, go to **Simulator**, and then click **Play** in the control bar at the upper left.

To run the simulator as a desktop app instead, run `npm run app`: it starts the dev server on port 5888 and opens the
simulator page in an Electron window.

The deployed simulator also installs as an app and works offline, as at an event with no Wi-Fi: in Chrome or Edge on a
computer, or the Meta Quest browser, use **Install** in the address bar or the browser menu. One visit online caches
it. On a Quest, the headset button in the control bar drives from the alliance area in VR. See
[docs/simulator.md](docs/simulator.md#platforms).

| Input | Action |
| --- | --- |
| Left stick | Drive and strafe |
| Right stick X | Turn |
| LB and RB | Shoot NECTAR and shoot POLLEN |
| LT and RT | Place POLLEN and place NECTAR in a FLOWER |
| Gear icon, or a right-click on a robot | Open the robot config |
| Enter, R, C, M, V | Start, reset, change the camera, mark a moment, and review the match |
| Space, left arrow, right arrow | Play or pause, and go to the previous or the next mark |

To run the tests, run `npm test`. They cover the HIVE calibration, the drivetrain, the behavior-tree runtime, the AUTO trees, the referee, and
full scripted matches, without a browser.

## Run matches without a browser

| Command | What it does |
| --- | --- |
| `npx tsx scripts/match.ts` | Plays one four-robot match and prints a timeline and the final score |
| `npx tsx scripts/eval.ts LABEL` | Plays 24 fixed seeds and reports the combined score and where TELEOP time goes |
| `python3 scripts/eval-compare.py BASE NEW` | Compares two evaluation runs |
| `npx tsx scripts/exp-run.ts GROUP 96 10 101 TAG` | Runs a group of robot designs from `scripts/exp-specs.ts` against the baseline |
| `npx tsx scripts/exp-report.ts` | Pools the design runs into tables |
| `npx tsx scripts/auto-timeline.ts 1001` | Prints the AUTO timeline of the red robots |

The results are in [experiments/](experiments/README.md). Every number on the site comes from a file there.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/sim/` | The match simulation. It has no DOM and no three.js dependency, so it runs in Node.js. |
| `src/auto/` | The planner: the tree files in `trees/auto/` and `trees/teleop/`, their leaves, tactics, path planning, the path follower, and the defense bookkeeping |
| `src/bt/` | The behavior-tree runtime: coroutines that advance once per physics step. It knows nothing about BIOBUZZ. See [docs/behavior-trees.md](docs/behavior-trees.md). |
| `src/ref/`, `src/render/` | The PIN referee, and the three.js view |
| `src/main.ts`, `src/review.ts`, `src/setup.ts` | The simulator page, the review mode, and the robot setups |
| `src/field-editor.ts`, `src/user-trees.ts` | The field editor for AUTO poses, and the edited trees that the browser keeps |
| `index.html`, `sim/index.html` | The home page and the simulator page. Both are Vite entries. |
| `public/` | The field and ball models, and the built Match Lab and lessons pages |
| `scripts/` | Headless runners, the experiment tools, the model converters, and the site builder |
| `experiments/` | Results and logs of every measured change |
| `traces/` | Annotated matches that drove the planner fixes |
| `functions/`, `server/`, `migrations/`, `wrangler.toml` | The match counter and the tree catalog, on Cloudflare Pages and D1 |
| `.github/workflows/ci.yml` | The checks that every pull request must pass |
| `docs/` | The lessons, the simulator description, the HIVE calibration, the behavior-tree design, and the backlog |

## The site

`npm run build` produces the whole static site in `dist/`. The Match Lab and the lessons page are generated by
`python3 scripts/build-site.py` and committed under `public/`, so the build needs no Python. Run that script after you
change `docs/top-ten.md`, the template, or the result files.

The home page shows a live count of simulated matches and of the countries that they came from.
`functions/api/matches.js` is a Cloudflare Pages Function that keeps the counts in a D1 database, because D1 increments
atomically. It stores a visitor's address only as a salted hash, for one day, and a country only as a count per
two-letter code.

The same database holds the tree catalog: every AUTO and TELEOP tree, with its id, name, and description.
`functions/api/trees.js` answers `GET /api/trees` and `GET /api/trees/ID`. The system trees are the files in
`src/auto/trees/auto/` and `src/auto/trees/teleop/`. The build writes them to `trees/catalog.json`, and the first request after a deployment goes live
copies them into D1, so the catalog always matches the live code, including after a rollback. A preview reads the
deployment's own files, because it has no database.

### Deployment

Cloudflare Pages deploys the site by its Git integration: a merge to `main` deploys to production, and every pull
request gets a preview URL. Branch protection requires the **Build and test** check, so a change that fails its tests
can't reach `main`. The Pages project uses the build command `npm run build` and the output directory `dist`.
`.node-version` pins Node.js 22, and `wrangler.toml` supplies the D1 binding. A preview gets no database binding, so a
preview can't change the real count.

The database schema is in `migrations/`. The last step of `npm run build`, `scripts/migrate-d1.mjs`, applies new
migrations to the production database, but only in a Pages build of `main`, and only when the production environment
has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A failed migration fails the build, so the new code doesn't go
live. A migration must be additive, because the old deployment runs against the new schema until the new one is live.

To deploy your own copy, follow these steps:

1. To create the database, run `wrangler d1 create DB_NAME`, and put the ID that it prints in `wrangler.toml`.
2. To create the tables, run `wrangler d1 migrations apply DB --remote`.
3. In the Cloudflare dashboard, go to **Workers & Pages**, create a Pages project from your fork, and set the build
   command and the output directory as described earlier.
4. Optional: to have production builds apply later migrations, create a Cloudflare API token with **D1 Edit**
   permission. In the Pages project's settings, add it as `CLOUDFLARE_API_TOKEN`, with your account ID as
   `CLOUDFLARE_ACCOUNT_ID`, in the production environment variables only.

## Sources

- **Field geometry.** The official field CAD from the *FIRST* Playing Field Resources page. `scripts/convert-step.mjs`
  converts the STEP file to `public/field.glb` and writes `cad/field-manifest.json`, and `scripts/convert-balls.mjs`
  extracts the ball models. The STEP file isn't in the repository.
- **Rules and point values.** The BIOBUZZ Competition Manual, sections 9 and 10.
- **HIVE tipping point.** The Event Field Setup Guide, section 12.3.
- **Starting positions of the CELL NECTAR and the GARDEN POLLEN.** The CAD staging spots, which match the Event Field
  Setup Guide, section 11, and the Competition Manual, section 10.3.1.
- **Ball masses.** AndyMark's product page: 0.055 lb for POLLEN (am-5851) and 0.091 lb for NECTAR (am-5852). The
  manual's section 9.8 names the material, polyethylene, and gives no weight. `node scripts/ball-mass.mjs` checks the
  weights against the plastic volume of the CAD models.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md). The fastest bug report is an annotated match: review a match in the
simulator, click the robot that did something wrong, type a note, click **Export** in the game setup, and attach the
files to an issue.

## License

[MIT](LICENSE) for the code, the documents, and the experiment data. The field and ball models and the trademarks
belong to others: see [NOTICE.md](NOTICE.md).
