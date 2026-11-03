# How the simulator works

This page describes the simulator for someone who wants to read or change the code. For what the simulations found, see
[the ten lessons](top-ten.md). To set up and contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Robot model

`src/sim/config.ts` holds every robot parameter. The drivetrain model in
`src/sim/drivetrain.ts` computes wheel forces from four goBILDA 5203 Yellow
Jacket motors, a battery with internal resistance, and a traction
limit. Intake, launching, and FLOWER placement use bulk parameters with
sampled distributions, not mechanism physics.

The reference robot, `DEFAULT_ROBOT`, is 16.9 in. square with a 435 rpm drive. `src/setup.ts` turns a robot setup
from the config popup into a `RobotConfig` relative to it. Ball masses are AndyMark's listed weights. Restitution,
friction, and damping are estimates.

## Program drivers

Code drives the robot and presses the buttons. A behavior tree picks what to work on: an AUTO tree in AUTO, and the
default TELEOP tree in TELEOP. For how the trees work, see [Behavior-tree policies](behavior-trees.md). In TELEOP,
`src/auto/executor.ts` runs the tactic that the tree picks: `tip_hive`, `collect_pollen`, `collect_own_nectar`,
`launch_into_hive`, `work_flower`, or `park`.

- **`tip_hive`** collects only the POLLEN that the next TIP needs. It counts
  balls in flight, and when a TIP is certain it collects for the opposite CELL.
  An exhaustive search over the nearest floor balls and FLOWER bottoms picks
  the fastest pickup order that ends at the launch spot.
- **Path following.** `src/auto/planner.ts` plans with a visibility graph around
  the HIVE frame foot bars, the frame legs, and the FLOWERS, with an 8 cm buffer
  beyond the robot's diagonal radius. The executor follows the path by pure
  pursuit and turns to the goal heading while it travels. The page draws the
  path in blue.
- **Own NECTAR in a TIP.** Own NECTAR weighs 1.65 POLLEN toward a TIP, which is the ratio of the listed ball masses, so `tip_hive` collects it with a small
  preference. `nectarReserve` keeps one NECTAR in hand for a FLOWER cap. The policy sets it when 75
  seconds remain.
- **Stalls.** If the robot makes no progress toward a target, the executor backs away, avoids that target for 7
  to 12 seconds, and reports `blocked` with a reason, for example "another robot is in the way". The TELEOP tree then
  picks something else. Inside 0.56 m, robots also push straight away from each other, so they don't wedge.
- **Shooter.** The shooter has a fixed azimuth, with no turret. The default
  shooter faces the rear of the robot, opposite the intake.
- **Endgame by value.** When the drive time to the LOADING ZONE says that it is time to PARK, the TELEOP tree's endgame
  branch compares values, on every step: a launch that finishes a TIP is worth 20 points, a launch that doesn't is worth
  2 per element, and PARK is worth 5. In a qualification MATCH, a robot whose PARK the alliance still needs for the
  SWARM ranking point always parks. **Stage** in the game setup selects a qualification or a playoff MATCH.
- **Reading a TIP.** A TIP counts as under way only when the HIVE is past level or turning away from its stop. A partly
  loaded CELL sags off its stop, and a driver can see that it hasn't tipped.
- **Defense.** The TELEOP tree's `defend` subtree is a full-time defender, with its bookkeeping in `src/auto/defend.ts`,
  and its `bump` branch is an opportunistic shove. Both limit a contact burst, so that no PIN count reaches 3 s.
  **Defense** in the robot config selects one.

| Period | Decision maker | Setting |
| --- | --- | --- |
| AUTO | A behavior tree in `src/auto/trees/auto/`, for every robot | **AUTO plan** in the robot config |
| TELEOP | The default TELEOP tree, `src/auto/trees/teleop/teleop-default.json`: TIPS, and FLOWERS from the time that **TELEOP plan** sets | **Driver**: Planner |
| TELEOP | A person with controller 1 or controller 2. Only the red robots can have a human driver. | **Driver**: Controller 1 or Controller 2 |

### Robot config

Every MATCH has four robots: R0, R1, B0, and B1. To configure a robot before a MATCH, click the gear icon next to
its number in the scoreboard, click its card in the game setup, or right-click the robot. The popup sets the following:

- The number plate, the driver, and the stick frame for a human driver, which is field-centric by default.
- The shooter's release, where it launches from, and the intake layout: front, or front and rear. A shooter
  launches from the rear end, from both ends, or from a turret. The turret aims at the raised CELL whatever the
  robot's heading, with full range of motion and an instant slew, so it's an upper bound on what a real turret does.
  On all four robots it adds 39.4 ± 13.6 combined points over 24 seeds (`e79-turret-all`). The popup also sets a
  turret's range of motion and turn rate: a turret with 180° of range at 180°/s adds 33.9 ± 13.3. A person driving
  steers the turret with the arrow keys (or the D-pad), and it keeps its angle between presses; the turret aims
  itself only when a plan or the planner is driving.
- The launcher's shot-to-shot error as one standard deviation each: elevation, azimuth, and launch speed. Chips fill
  in 1, 3, or 5 times the reference launcher.
- The intake success probability, the AUTO plan, the TELEOP plan, and the defense policy.
- The drive motor's free speed in rpm, the side of the square chassis, and the mass.

**Units** in the options switches the popup, the robot cards, and the field position readout between metric, which is
the default, and US units. A controller drives
one robot: if you give a robot the controller that another robot has, that other robot goes back to the planner.
The simulator opens with the meta build on all four robots: a four-element catapult, 12 in., 15.4 lb, 500 rpm, and
intakes at both ends. Two such robots beat two baseline robots by 96 points over 24 seeds. The popup's **Meta build** and
**Baseline** buttons apply either robot, and they keep the number plate and the driver. The baseline (15 in., 22 lb,
600 rpm, two at a time, a front intake) is the reference of every experiment, so the headless scripts still use it.
On a first visit, the robots carry the team numbers 5064, 8569, 22377, and 772 as number plates, in a random order on
every visit, until you configure a robot. R0, R1, B0, and B1 stay the robot ids in traces. The browser stores the
setups. `src/setup.ts` turns a setup into a `RobotConfig`: the rpm changes the gear ratio of
the same motor, so the stall torque scales inversely, and the size scales the wheelbase, the track, and the intake.

### AUTO trees

Each AUTO plan is a behavior tree in `src/auto/trees/auto/`. It runs in the onboard environment of
`src/auto/onboard.ts`, which has what an OpMode can know: the robot's own pose, its carried count, its size, the clock,
and the camera. It has no ball, FLOWER, or robot positions. For how trees work, see [Behavior-tree
policies](behavior-trees.md).

A tree is a list of steps. Each step is a leaf that commands one of the robot's subsystems:

- **`drive.driveTo`** drives to a pose on a path that the path planner picks. **`drive.followPath`** follows a path
  through the tree's own waypoints, with no planner. **`drive.push`** pushes straight ahead.
- **`intake.run`** runs the intake for as long as it runs. When no leaf runs the intake, it's stopped.
- **`shooter.shoot`** launches a count open loop.
- **`vision.waitTip`** waits until the camera sees a CELL tip.
- **`wait`** waits a time, and **`waitUntil`** waits until a condition holds, for example `bots.me.transfer.full`,
  `bots.me.vision.seesRaised('rear')`, or `clock.remaining <= 2.5`.

A step that collects runs the intake beside a drive, as in FTC's command-based code. For example, a sweep is a
`parallel` node that ends when its first child does: `waitUntil` on a full transfer, `intake.run`, and
`drive.followPath`. For the subsystems and their state, see [Subsystems](behavior-trees.md#subsystems).

Each step ends on its condition or its timeout. The robot then does nothing for one physics step, as a state machine
that advances on its next loop does. `waitUntil` ends without that idle step, and `intake.run` ends only when its
parent does. A tree that ends with a PARK races its steps against the clock, so that the PARK
starts in time whatever step is running. Poses are expressions over the robot's size and shooter direction, so one
tree fits every robot. Each step's note in the tree file says why the step is there.

Paths avoid the fixed FIELD elements and a virtual wall on the FIELD center line, so each robot stays on its own side
(G402). A tree is written for red, in FIELD x and y, and a blue robot runs it rotated 180° about the FIELD center. For
the coordinate system, see [Coordinates and alliances](behavior-trees.md#coordinates-and-alliances). One sensor is modeled: a Limelight 3A that reads
the AprilTag cluster under each CELL, so a `waitCell` step or a `shoot` step with a `cell` holds until the camera
reads that CELL as raised. `src/sim/camera.ts` applies the camera's 54.5° by 42° field of view, a range limit, and
a grazing-angle limit. The camera sits on the shooter side, 0.30 m up and pitched 50°, which frames the raised
CELL's tags from both launch spots. The camera reads the HIVE, not the balls, and only AUTO uses it.

The sweeps are blind but planned from data: `scripts/plan-sweeps.ts` records where spilled balls come to rest over
many simulated AUTO periods, prints a heatmap, searches for the lanes that collect the most, and writes them as the
waypoints of the paths tagged `sweep-solo`, `sweep-right`, and `sweep-left`. Lanes lead with the intake, except along
a wall, where the robot faces the wall and strafes.

To change an AUTO plan, follow these steps:

1. Before the MATCH, click the gear icon in the control bar, and then click **Edit AUTO paths**. The camera changes to
   **Overhead**, and the tree view shows R0's AUTO plan. The buttons above the tree, or a click on the other red robot,
   switch to its plan. Plans are written in red's frame, and blue robots run them rotated 180°.
2. Click **Create new**, pick the plan to copy, and give the new plan a name and a description. The new plan becomes the
   robot's plan, and editing starts. System plans are read-only. To edit a plan that you made earlier, click **Edit**.
3. Drag an orange disc to move a drive step's pose, or drag the knob at the end of its line to turn its heading. A cyan
   disc is a waypoint of a path, such as a sweep. Click a step in the tree view to find its handles: they turn white.
   A see-through robot shows the selected pose, and a second one drives the path through it.
4. To take back an edit, click **Undo**, or press Cmd+Z (Ctrl+Z on other systems).
5. Click **Done**.

The purple dots are reference points, such as `launchAudience`, which steps name. Drag one to move every step that
names it. Right-click the floor to add one, and right-click a point to delete it. Turn on **Snap** to snap to a 1 in
grid. For all the tools, see
[Reference points and snapping](behavior-trees.md#reference-points-and-snapping).

The tree view lists the plan's definitions above its steps, and the panel on the right shows what you select: a step's
settings, such as `timeoutSec`, or a definition. To change one, type in its field and press Enter. An expression field
completes names as you type, such as `bots.me.` or `field.`, and marks a problem before you save. A plan with problems lists them in red at the top of the panel, and its robot
stays still in AUTO until you fix them. For more information, see
[Settings, definitions, and problems](behavior-trees.md#settings-definitions-and-problems).

This browser keeps your plans, and the **AUTO plan** list in the robot config shows them. An edited step has a green
ring on the FIELD and a green dot in the tree view. **Reset this step** moves the selected step back to where the source plan has it, and **Delete plan** deletes the
plan. The bar shows the selected step's pose in FIELD x and y, and the pose as the plan writes it, for example
`offset(launchAudience, 0.2, -0.1)`: a drag keeps the expression and adds an offset to it, so the plan still fits a
robot of another size. For the rule, see [Editing AUTO poses](behavior-trees.md#editing-auto-poses).

The page projects the tree onto the FIELD as a dashed orange line, with a wedge at each pose and a dashed orange circle
where the robot shoots. The circle marks a launch pose only: its 0.21 m radius isn't a range.

### Alliance partners

Every alliance has two robots, which makes four on the FIELD. Partners coordinate through a shared `intent` and a
shared `plan`, the way drive teams talk:

- **Left and right.** The robot that starts on the left of its drivers is the left robot for the whole MATCH: the
  rear side for red and the audience side for blue. At PARK, the robot with the smaller z takes the end of the LOADING ZONE with the smaller z, so partners
  never pass each other along the wall.
- **Routes.** Both robots feed the raised CELL, because the score follows TIPS almost exactly (19.7 points per TIP,
  correlation 0.996 over 1,277 matches). After a TIP both head for the other end at once, so the right robot goes
  under the HIVE and the left robot goes around it on the alliance's own side. `Executor.convention` also offers
  `sides`, where each robot owns one CELL. It removes all contact but leaves a loaded robot waiting, and it scored
  293 against 359 for `routes`.
- **Own side.** A pickup on the opponent's half of the FIELD costs an extra 1.5 m in the route search.
- **Launch spots.** The first robot launches from straight in front of the raised CELL. Its partner launches from
  0.62 m to the side, angled at the opening, because the shooter has a fixed azimuth.
- **TIP load.** A robot counts its partner's carried load toward the TIP only if the partner delivers it first: the
  partner is in its launch phase and nearer to its launch spot. If that covers the TIP, the robot collects for the
  opposite CELL.
- **Yield and swap.** When both partners head for the same CELL, the one with the smaller load waits until the other is
  lined up. If each arrives on the other's launch spot, they swap spots.
- **FLOWERS.** A FLOWER that the partner works on is taken.
- **AUTO.** The wall-sweep pair is the default: `wall-sweep-pair-right` and `wall-sweep-pair-left`, one half per
  start position as the drivers see it. They sweep walls at 30° toward the wall, wait for a spill to land, and take the
  pocket behind the launch spot. The lane-sweep pair is the earlier pair, with lane sweeps. Each half waits for its
  partner's TIP, so a half runs well only with its own partner.
  The right robot (R0 or B0) starts on the alliance wall and takes the first TIP. The left robot (R1 or B1) starts on
  the rear wall for red, which is the audience wall for blue, and fills the CELL that the first TIP raises. Both robots
  score LEAVE and AUTO PARK, which earns the SWARM ranking point.
- **PARK.** Partners take opposite ends of the LOADING ZONE, and both are partly inside.

### Opponent robots

The blue robots run the same AUTO trees and the same TELEOP policy as the red robots, with their own robot
configs. Robots collide with each other, and each planner treats the other robots as obstacles. To compare
scripted strategies against the blue alliance, run `npx tsx scripts/sweep.ts`.

### Referee

`src/ref/referee.ts` calls PINS under G421. Code keeps the facts and the clock: contact, each robot's speed and
commanded direction, how far it moved in the last 2 seconds, and whether a wall or a FIELD element boxes it in.
Code also runs the 3-count, the pause and end conditions A, B, and C, and a MAJOR FOUL of 20 points every 3
seconds. A fixed rule, `ruleJudge`, answers the fuzzy part for each direction: is this robot PINNING that one?
The **Referee** list also has an off setting.

### Sounds

`src/audio.ts` plays the cues of Table 9-1 of the Competition Manual. The cues
are synthesized, and speech uses the browser's voice. FIRST's sound files
aren't bundled. To use your own files, put them in `public/sounds/` with these
names and a `.wav` or `.mp3` extension: `start_countdown`, `match_start`,
`auto_end`, `pick_up_controllers`, `countdown`, `teleop_start`,
`flowers_unlock`, `endgame`, and `match_end`.

### FLOWER doctrine

The middle ring passes POLLEN and retains NECTAR (G418), so NECTAR seats at the
ring and plugs the FLOWER. A finished FLOWER is a plug, four POLLEN, and a cap:
`[RN,P,P,P,P,RN]`. It scores 17 points and it is full, so the opponent can't
cap it. `flowerAction` fills a FLOWER only while a cap NECTAR is still
obtainable, and `flowerStep` fetches the cap for a filled FLOWER before any
other FLOWER work.

### Headless matches

To run a full four-robot match with the planner on every robot, run `npx tsx scripts/match.ts`. The script
prints a timeline for red robot 0, the stalls per robot, and the final score of each alliance. The arguments
are the match mode, the AUTO routine, the seed, and the time at which each group of robots starts FLOWER work.
The comment at the start of `scripts/match.ts` lists them.

## Review and annotate a match

The page records every match at 10 Hz, with each frame's full score breakdown, so that the scoreboard scrubs too.
The control bar at the upper left plays the MATCH the way a media player plays a recording. Its timeline covers the
whole MATCH, and the recorded part fills in as the MATCH runs. Gray ticks mark the MATCH start, the TELEOP start,
FLOWERS open (1:00), the endgame (0:20), and the MATCH end, and dots mark notes.

1. During a match, press **M** to mark a moment that looks wrong. When the referee calls a FOUL, the page adds a note
   on the robot that the FOUL is called on.
2. Drag the thumb back, press **V**, or click the previous-mark button to open the review. A live MATCH waits while
   the review is open. **Go live**, or playback that reaches the newest frame, returns to the MATCH.
3. Drag the thumb, click **Play**, or step between marks with the previous-mark and next-mark buttons. The speed list
   applies to the recording. A live MATCH always runs at 1x.
4. Click a robot, type what went wrong, and press Enter. The note attaches to that robot at the cursor time, and a dot
   marks it on the timeline.

To see why a robot did something, set **Tree view** to **On** in the options. The panel shows a robot's behavior tree,
with the running nodes highlighted and every other node's last result, live during a match and at the cursor in
review. The buttons at the top of the panel pick the robot.

With the dev server, the trace saves to `traces/<name>.json` and the notes to `traces/<name>.annotations.md` and
`.json`. On the deployed site there is no server, so notes stay in the browser's storage, and **Export** in the game
setup downloads the notes and the trace as files. The Markdown file repeats every robot's position, tactic, goal,
stall, and running tree leaf at each note, in field coordinates, so it can be read without the trace. To summarize a
trace, run `npx tsx scripts/trace-report.ts`.

Field coordinates: the origin is the FIELD center, +x is the blue wall, +y is the rear wall, and the unit is the meter.
Field y is the negative of the z axis in the code. A click on the FIELD floor shows the position in a toast at the
bottom edge. Referee calls and rule messages, such as G410, show there too.

**AUTO paths** in the options draws the AUTO plan of the robot that the view follows, as a dashed orange line, and the
path that the planner drives, in blue. Turn it off to see the FIELD clearly. The AUTO editor draws the paths whatever
the setting.

## Watching a match without a screen

`npx tsx scripts/watch-match.ts 6` plays scripted four-robot matches and reports driving quality for the red
alliance: goals abandoned before they were achieved, course reversals, seconds against the partner, idle seconds,
meters per element, and balls left under the HIVE. `npx tsx scripts/auto-check.ts 8` reports AUTO points, TIPS,
and hopper fill.
