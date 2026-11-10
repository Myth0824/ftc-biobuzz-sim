package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.follower.Follower;
import com.pedropathing.math.Pose;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.util.ElapsedTime;

import org.firstinspires.ftc.teamcode.Field.Alliance;
import org.firstinspires.ftc.teamcode.Robot;

/*
 * Shared by the match autos (ParkAuto, LaunchParkAuto). Each of those is one routine:
 * where the robot starts, and a switch that runs one step per loop.
 *
 * After INIT, on gamepad1:
 *   X / B            blue / red alliance
 *   dpad up / down   start delay, for staying out of a partner's way
 * The telemetry says where to put the robot.
 *
 * Blue is red turned half way round the field, so the robot makes the same moves on
 * either alliance. The alliance sets the pose on the field, which TeleOp carries on from.
 */
public abstract class BiobuzzAuto extends OpMode {

    // Give up on a path that hasn't settled by now, so a bad tune can't eat the whole auto.
    public static double PATH_TIMEOUT_SECONDS = 6.0;
    public static double MAX_DELAY_SECONDS = 20.0;

    protected final ElapsedTime stepTimer = new ElapsedTime();
    protected Robot robot;
    protected Follower follower;
    protected AutoPaths paths;
    protected int step;

    private Alliance alliance = Robot.alliance;
    private double delaySeconds = 0.0;
    private boolean delayDone;

    /** Where the robot is placed, from the paths built for the chosen alliance. */
    protected abstract Pose startPose();

    /** The same thing in words, for the drive team. */
    protected abstract String placement();

    /** Runs the current step. Called once per loop after the start delay. */
    protected abstract void run();

    @Override
    public void init() {
        robot = new Robot(hardwareMap);
        follower = robot.drivetrain.follower;
        paths = new AutoPaths(alliance);
    }

    @Override
    public void init_loop() {
        if (gamepad1.xWasPressed() || gamepad1.bWasPressed()) {
            alliance = gamepad1.x ? Alliance.BLUE : Alliance.RED;
            paths = new AutoPaths(alliance);
        }
        if (gamepad1.dpadUpWasPressed()) {
            delaySeconds = Math.min(MAX_DELAY_SECONDS, delaySeconds + 1.0);
        }
        if (gamepad1.dpadDownWasPressed()) {
            delaySeconds = Math.max(0.0, delaySeconds - 1.0);
        }

        Pose start = startPose();
        telemetry.addData("Alliance (X blue, B red)", alliance);
        telemetry.addData("Delay (dpad up/down)", "%.0f s", delaySeconds);
        telemetry.addData("Place", placement());
        telemetry.addData("Start", "x %.1f  y %.1f  h %.0f°",
                start.x(), start.y(), Math.toDegrees(start.heading()));
        telemetry.update();
    }

    @Override
    public void start() {
        Robot.alliance = alliance;
        follower.setPose(startPose());
        step = 0;
        delayDone = false;
        stepTimer.reset();
    }

    @Override
    public void loop() {
        robot.update();

        if (!delayDone) {
            if (stepTimer.seconds() >= delaySeconds) {
                delayDone = true;
                stepTimer.reset();
            }
        } else {
            run();
        }

        telemetry.addData("Step", delayDone ? String.valueOf(step) : "delay");
        robot.addTelemetry(telemetry);
        telemetry.update();
    }

    @Override
    public void stop() {
        if (robot != null) {
            robot.stop();
        }
    }

    /** Moves on to the next step. */
    protected void next() {
        step++;
        stepTimer.reset();
    }

    /** True once the path started in the step before has finished, or has taken too long. */
    protected boolean pathDone() {
        return !follower.following() || stepTimer.seconds() >= PATH_TIMEOUT_SECONDS;
    }
}
