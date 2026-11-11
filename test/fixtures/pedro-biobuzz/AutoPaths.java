package org.firstinspires.ftc.teamcode.opmodes;

import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

import org.firstinspires.ftc.teamcode.Field;
import org.firstinspires.ftc.teamcode.Field.Alliance;

import static com.pedropathing.api.Paths.curve;
import static com.pedropathing.api.Paths.line;

/*
 * Poses and paths for the BIOBUZZ autos, built for one alliance.
 *
 * Auto points: LEAVE 3 (off the wall), PARK 5 (partly in the loading zone), HIVE TIP 20.
 * Two robots that both leave and park make 16, which is the SWARM ranking point.
 *
 *   Park Auto          start on the alliance wall beside the loading zone, slide into it.
 *   Launch Park Auto   start on the audience wall facing the up-tilted cell, drive to the
 *                      launch spot, then swing wide of the hive frame into the loading zone.
 *
 * The robot never turns during either driving route, so heading error can't push a corner into
 * the wall or the frame.
 */
public class AutoPaths {

    // Distance from the audience wall to the robot's center when launching.
    public static double LAUNCH_Y = 20.0;
    // Rear outtake points toward the audience CELL when the robot front faces -Y.
    public static double LAUNCH_HEADING_DEGREES = -90.0;

    public final Pose wallStart, wallPark;
    public final Pose audienceStart, launch, audiencePark;

    public final Path wallToPark;
    public final Path startToLaunch;
    public final Path launchToPark;

    public AutoPaths(Alliance alliance) {
        double halfLength = Field.ROBOT_LENGTH / 2.0;
        double halfWidth = Field.ROBOT_WIDTH / 2.0;
        double parkY = (Field.LOADING_ZONE_Y_MIN + Field.LOADING_ZONE_Y_MAX) / 2.0;

        // Back on the alliance wall, facing the hive, just clear of the loading zone tape
        // (starting inside the zone is not allowed).
        wallStart = alliance.pose(Field.WALL_INSET + halfLength, Field.LOADING_ZONE_Y_MIN - halfWidth - 3.0, 0);
        wallPark = alliance.pose(Field.WALL_INSET + halfLength + Field.PARK_WALL_GAP, parkY, 0);

        // FRONT touches the audience wall. The REAR outtake faces the raised audience CELL.
        audienceStart = alliance.pose(Field.UP_CELL_X, Field.WALL_INSET + halfLength, LAUNCH_HEADING_DEGREES);
        launch = alliance.pose(Field.UP_CELL_X, LAUNCH_Y, LAUNCH_HEADING_DEGREES);
        audiencePark = alliance.pose(Field.WALL_INSET + halfWidth + Field.PARK_WALL_GAP, parkY, LAUNCH_HEADING_DEGREES);

        wallToPark = line(wallStart, wallPark).linear(wallStart, wallPark);
        startToLaunch = line(audienceStart, launch).linear(audienceStart, launch);

        // The control points pull the path toward the alliance wall first, so the robot
        // passes about a foot clear of the hive frame's corner.
        launchToPark = curve(launch, alliance.pose(20, 24, LAUNCH_HEADING_DEGREES), alliance.pose(15, 50, LAUNCH_HEADING_DEGREES), audiencePark)
                .linear(launch, audiencePark);
    }
}
