package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.math.Pose;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

/**
 * Legal wall start, three individual rear shots into the initially raised CELL, then PARK.
 * The CELL starts with three NECTAR (manual10.3.1); three POLLEN can tip it. Retain the
 * fourth preload rather than fire it at the now-lowered CELL. No automatic reload is claimed.
 * Timed transfer pulses require hardware feed-time tuning; see RearLauncher.FEED_SECONDS.
 */
@Autonomous(name = "Launch Park Auto", group = "BIOBUZZ", preselectTeleOp = "Main TeleOp")
public class LaunchParkAuto extends BiobuzzAuto {
    // Team estimate for a loaded single-ball rear shooter. Match RearLauncher's recovery.
    public static double SHOT_INTERVAL_SECONDS = 0.9;
    public static double HIVE_SETTLE_SECONDS = 1.0;

    @Override protected Pose startPose() { return paths.audienceStart; }

    @Override protected String placement() {
        return "FRONT on the audience wall, REAR outtake toward the raised audience CELL";
    }

    @Override protected void run() {
        switch (step) {
            case 0:
                follower.follow(paths.startToLaunch);
                next();
                break;
            case 1:
                if (pathDone()) {
                    if (!atPose(paths.launch)) {
                        telemetry.addLine("Launch path did not settle: stopping without firing");
                        requestOpModeStop();
                        break;
                    }
                    follower.hold(paths.launch);
                    next();
                }
                break;
            case 2:
                if (robot.launcher.shootOne()) next();
                else if (!robot.launcher.available()) { step = 8; stepTimer.reset(); }
                break;
            case 3:
                if (stepTimer.seconds() >= SHOT_INTERVAL_SECONDS) next();
                break;
            case 4:
                if (robot.launcher.shootOne()) next();
                break;
            case 5:
                if (stepTimer.seconds() >= SHOT_INTERVAL_SECONDS) next();
                break;
            case 6:
                if (robot.launcher.shootOne()) next();
                break;
            case 7:
                if (stepTimer.seconds() >= SHOT_INTERVAL_SECONDS) next();
                break;
            case 8:
                if (stepTimer.seconds() >= HIVE_SETTLE_SECONDS) next();
                break;
            case 9:
                robot.launcher.stop();
                follower.follow(paths.launchToPark);
                next();
                break;
            case 10:
                if (pathDone()) next();
                break;
            default:
                robot.launcher.stop();
                break;
        }
    }
}
