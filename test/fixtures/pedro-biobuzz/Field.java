package org.firstinspires.ftc.teamcode;

import com.pedropathing.math.Pose;

/*
 * BIOBUZZ field positions, in inches.
 *
 *   x  0 at the red alliance wall, 144 at the blue alliance wall
 *   y  0 at the audience wall, 144 at the far wall
 *   heading 0 faces the blue wall, 90 faces away from the audience
 *
 * Everything is written for red. The field is the same after a half turn about its
 * center, so Alliance.pose() turns a red pose into the matching blue one.
 *
 * Zone sizes are from the Competition Manual (section 9.3). The hive numbers are read off
 * the manual's figures, good to an inch or two: measure them on a real field before
 * relying on them.
 */
public final class Field {

    public enum Alliance {
        RED, BLUE;

        /** A pose given for red, in degrees, placed for this alliance. */
        public Pose pose(double x, double y, double headingDegrees) {
            if (this == RED) {
                return new Pose(x, y, Math.toRadians(headingDegrees));
            }
            return new Pose(SIZE - x, SIZE - y, Math.toRadians(headingDegrees - 180));
        }

        /** Field heading the drivers face from their alliance area. */
        public double driverHeading() {
            return this == RED ? 0.0 : Math.PI;
        }
    }

    public static final double SIZE = 144.0;

    // Measure the real robot, bumper to bumper. LENGTH runs front to back.
    public static double ROBOT_LENGTH = 18.0;
    public static double ROBOT_WIDTH = 18.0;

    // Loading zone: against the alliance wall, in the fifth tile from the audience.
    public static final double LOADING_ZONE_DEPTH = 11.0;
    public static final double LOADING_ZONE_Y_MIN = 96.5;
    public static final double LOADING_ZONE_Y_MAX = 119.5;

    // Hive frame footprint, centered on the field.
    public static final double FRAME_X_MIN = 47.3, FRAME_X_MAX = 96.7;
    public static final double FRAME_Y_MIN = 52.5, FRAME_Y_MAX = 91.5;

    // The red cell that starts the match tilted up is the one on the audience side.
    public static final double UP_CELL_X = 60.0;
    public static final double UP_CELL_Y = 61.0;

    // Gap left between the robot and the wall when parked. LEAVE needs the robot off the
    // wall and PARK needs it partly inside the 11 in. deep zone, so 4 leaves about the
    // same room for error both ways.
    public static double PARK_WALL_GAP = 4.0;

    private Field() {}
}
