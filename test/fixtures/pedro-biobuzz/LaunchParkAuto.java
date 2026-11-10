package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.math.Pose;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

/*
 * Drives to the launch spot in front of the up-tilted cell, then parks in the loading zone.
 * A hive tip is 20 points, but the robot has no launcher yet, so for now this scores the
 * same 8 as Park Auto.
 */
@Autonomous(name = "Launch Park Auto", group = "BIOBUZZ", preselectTeleOp = "Main TeleOp")
public class LaunchParkAuto extends BiobuzzAuto {

    // How long to sit at the launch spot. 0 until there is a launcher.
    public static double LAUNCH_SECONDS = 0.0;

    @Override
    protected Pose startPose() {
        return paths.audienceStart;
    }

    @Override
    protected String placement() {
        return "back on the AUDIENCE wall, facing the up-tilted cell";
    }

    @Override
    protected void run() {
        switch (step) {
            case 0:
                follower.follow(paths.startToLaunch);
                next();
                break;
            case 1:
                if (pathDone()) {
                    next();
                }
                break;
            case 2:
                // Fire the four preloads here once there is a launcher, and move on when
                // it is empty instead of on a timer.
                if (stepTimer.seconds() >= LAUNCH_SECONDS) {
                    next();
                }
                break;
            case 3:
                follower.follow(paths.launchToPark);
                next();
                break;
            case 4:
                if (pathDone()) {
                    next();
                }
                break;
            default:
                // Parked. The follower holds the pose until the OpMode stops.
                break;
        }
    }
}
