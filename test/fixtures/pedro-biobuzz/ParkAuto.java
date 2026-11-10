package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.math.Pose;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

/* LEAVE + PARK: off the alliance wall and into the loading zone. 8 points. */
@Autonomous(name = "Park Auto", group = "BIOBUZZ", preselectTeleOp = "Main TeleOp")
public class ParkAuto extends BiobuzzAuto {

    @Override
    protected Pose startPose() {
        return paths.wallStart;
    }

    @Override
    protected String placement() {
        return "back on the ALLIANCE wall, beside the loading zone on its audience side";
    }

    @Override
    protected void run() {
        switch (step) {
            case 0:
                follower.follow(paths.wallToPark);
                next();
                break;
            case 1:
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
