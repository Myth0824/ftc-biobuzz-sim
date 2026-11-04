import { describe, expect, it } from 'vitest';
import { addAutoTree, removeAutoTree } from '../src/auto/onboard';
import { importPedro } from '../src/auto/pedro';

// The team's template, with the 2.x API.
const V2 = `
import static com.pedropathing.api.Paths.line;
@Autonomous(name = "Auto Template", group = "BIOBUZZ")
public class AutoTemplate extends OpMode {
    private final Pose startPose = new Pose(56, 8, Math.toRadians(90));
    private final Pose parkPose = new Pose(56, 36, Math.toRadians(90));
    private Path park;
    public void init() {
        follower.setPose(startPose);
        park = line(startPose, parkPose).linear(startPose, parkPose);
    }
    public void loop() {
        switch (step) { case 0: follower.follow(park); step++; break; }
    }
}`;

// The 1.x builder, with a curve, a chain, and a heading set after the build.
const V1 = `
public class BlueSide extends OpMode {
    private final Pose startPose = new Pose(9, 111, Math.toRadians(270));
    private final Pose scorePose = new Pose(14, 129, Math.toRadians(315)); // the basket
    private final Pose pickup1Pose = new Pose(37, 121, Math.toRadians(0));
    private Path scorePreload;
    private PathChain grabPickup1;
    public void buildPaths() {
        scorePreload = new Path(new BezierLine(new Point(startPose), new Point(scorePose)));
        scorePreload.setLinearHeadingInterpolation(startPose.getHeading(), scorePose.getHeading());
        grabPickup1 = follower.pathBuilder()
                .addPath(new BezierCurve(new Point(scorePose), new Point(30, 140, Point.CARTESIAN), new Point(pickup1Pose)))
                .setTangentHeadingInterpolation()
                .addParametricCallback(0.5, () -> { intake.run(); })
                .build();
    }
    public void autonomousPathUpdate() {
        switch (pathState) {
            case 0: follower.followPath(scorePreload); setPathState(1); break;
            case 1: if (!follower.isBusy()) { follower.followPath(grabPickup1, true); } break;
        }
    }
    public void init() { follower.setStartingPose(startPose); buildPaths(); }
}`;

const children = (t: Record<string, unknown>) => ((t.root as { sequence: { children: { ref: string; params: Record<string, unknown> }[] } }).sequence.children);

describe('Pedro Pathing import', () => {
  it('reads the 2.x template: start pose, a line, and linear heading', async () => {
    const { tree, warnings } = await importPedro(V2, 'AutoTemplate.java');
    expect(warnings).toEqual([]);
    expect(tree.id).toBe('pedro-auto-template');
    expect(tree.name).toBe('Pedro: Auto Template');
    expect((tree.defs as Record<string, string>).start).toBe('pose(-0.406, -1.626, 90)');
    const c = children(tree);
    expect(c.map(s => s.ref)).toEqual(['drive.driveTo', 'drive.followPath']);
    expect(c[1].params.waypoints).toEqual([{ x: -0.406, y: -0.914, headingDeg: 90 }]);
    expect(() => { addAutoTree(tree); removeAutoTree(String(tree.id)); }).not.toThrow();
  });

  it('reads the 1.x builder: curves are sampled, headings follow the interpolation, paths run in follow order', async () => {
    const { tree } = await importPedro(V1, 'BlueSide.java');
    const c = children(tree), score = c[1].params.waypoints as { headingDeg: number | null }[];
    // The path's callback runs the intake, so the path runs beside intake.run.
    const [drive, intake] = (c[2] as unknown as { parallel: { children: { ref: string; params: Record<string, unknown> }[] } }).parallel.children;
    const grab = drive.params.waypoints as { headingDeg: number | null }[];
    expect([c[1].params.tag, drive.params.tag, intake.ref]).toEqual(['pedro-scorePreload', 'pedro-grabPickup1', 'intake.run']);
    expect(score).toHaveLength(1); expect(score[0].headingDeg).toBe(-45);
    expect(grab).toHaveLength(6); expect(grab.every(w => w.headingDeg === null)).toBe(true);
    expect(() => { addAutoTree(tree); removeAutoTree(String(tree.id)); }).not.toThrow();
  });

  it('rotates a source that starts on the far half into the red frame', async () => {
    const { tree, warnings } = await importPedro(V2.replace(/new Pose\(56,/g, 'new Pose(88,'));
    expect(warnings[0]).toMatch(/rotated 180/);
    expect((tree.defs as Record<string, string>).start).toBe('pose(-0.406, 1.626, -90)');
  });

  it('reads the mechanism calls of a state machine: intake, launches, and timers', async () => {
    const src = `
public class Mech extends OpMode {
    private final Pose a = new Pose(56, 8, 0), b = new Pose(56, 40, 0), c = new Pose(20, 40, 0);
    private PathChain toScore, toPickup, back;
    public void buildPaths() {
        toScore = follower.pathBuilder().addPath(new BezierLine(a, b)).build();
        toPickup = follower.pathBuilder().addPath(new BezierLine(b, c)).build();
        back = follower.pathBuilder().addPath(new BezierLine(c, b)).build();
    }
    private void runIntake() { robot.intake.setPower(INTAKE_POWER); }
    public static double INTAKE_POWER = 1;
    public void update() {
        switch (state) {
            case 0: follower.followPath(toScore); state = 1; break;
            case 1: if (!follower.isBusy()) { shooter.fire(); timer.resetTimer(); state = 2; } break;
            case 2: if (timer.getElapsedTimeSeconds() > 1) { follower.followPath(toPickup); runIntake(); state = 3; } break;
            case 3: if (!follower.isBusy()) { sleep(500); intake.stop(); follower.followPath(back); state = 4; } break;
            case 4: if (!follower.isBusy() || timer.getElapsedTimeSeconds() > 6) { launch(); state = 5; } break;
        }
    }
    public void init() { follower.setStartingPose(a); buildPaths(); }
}`;
    const { tree, warnings } = await importPedro(src, 'Mech.java'), c = children(tree) as unknown as Record<string, unknown>[];
    expect(c.map(s => s.id)).toEqual(['s1', 's2', 's2-shoot', 's4', 's5', 's6', 's6-shoot']);
    expect(c.map(s => s.ref ?? 'parallel')).toEqual(['drive.driveTo', 'drive.followPath', 'shooter.shoot', 'parallel', 'parallel', 'drive.followPath', 'shooter.shoot']);
    // The sleep was held with the intake running, so the wait runs beside the intake too.
    expect((c[4] as { parallel: { children: { ref: string; params: { timeoutSec: number } }[] } }).parallel.children[0]).toMatchObject({ ref: 'wait', params: { timeoutSec: 0.5 } });
    expect(warnings.join(' ')).toMatch(/2 intake calls and 2 launches/);
    expect(() => { addAutoTree(tree); removeAutoTree(String(tree.id)); }).not.toThrow();
  });

  it('reads a command-based auto', async () => {
    const src = `
public class Cmd extends CommandOpMode {
    private final Pose a = new Pose(56, 8, 0), b = new Pose(56, 40, 0);
    private PathChain go;
    public void initialize() {
        go = follower.pathBuilder().addPath(new BezierLine(a, b)).build();
        follower.setStartingPose(a);
        schedule(new SequentialCommandGroup(
            new InstantCommand(() -> intake.start()),
            new FollowPathCommand(follower, go),
            new InstantCommand(() -> { intake.stop(); }),
            new WaitCommand(250),
            new InstantCommand(shooter::shoot)));
    }
}`;
    const c = children((await importPedro(src)).tree) as unknown as Record<string, unknown>[];
    expect(c.map(s => s.ref ?? 'parallel')).toEqual(['drive.driveTo', 'parallel', 'wait', 'shooter.shoot']);
  });

  it('reads structure that text matching got wrong: comments, strings, generics, and nested blocks', async () => {
    const src = `
// followPath(fake) in a comment doesn't count, and neither does a string.
public class Tricky extends LinearOpMode {
    /* intake.setPower(1); */
    private final Map<String, Pose> named = new HashMap<>();
    private final Pose a = new Pose(56, 8, 0), b = new Pose(56, 40, 0);
    private PathChain go;
    @Override
    public void runOpMode() {
        this.go = follower.pathBuilder().addPath(new BezierLine(a, b)).build();
        follower.setStartingPose(a);
        telemetry.addData("note", "follower.followPath(fake); intake.setPower(1)");
        waitForStart();
        if (opModeIsActive()) {
            for (int i = 0; i < 1; i++) { intake.setPower(1); }
            follower.followPath(go);
            while (opModeIsActive() && follower.isBusy()) { follower.update(); }
            intake.setPower(0);
            sleep(250);
        }
    }
}`;
    const { tree, warnings } = await importPedro(src, 'Tricky.java'), c = children(tree) as unknown as Record<string, unknown>[];
    expect(c.map(s => s.ref ?? 'parallel')).toEqual(['drive.driveTo', 'parallel', 'wait']);
    expect(warnings.join(' ')).toMatch(/2 intake calls and 0 launches/);
  });

  it('names the line where a file stops being Java', async () => {
    await expect(importPedro('public class Broken {\n  void f() { x = ; }\n}')).rejects.toThrow(/line 2/);
  });

  it('rejects a file with no path', async () => {
    await expect(importPedro('public class Empty { }')).rejects.toThrow(/no Pedro path/);
  });
});
