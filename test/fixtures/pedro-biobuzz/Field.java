package org.firstinspires.ftc.teamcode;

import com.pedropathing.math.Pose;

/*
 * BIOBUZZ field positions, in inches.
 *
 *   x  0 at the nominal red corner, 144 at the nominal blue corner
 *   y  0 at the nominal audience edge, 144 at the nominal far edge
 *   heading 0 faces the blue wall, 90 faces away from the audience
 *
 * Everything is written for red. The field is the same after a half turn about its
 * center, so Alliance.pose() turns a red pose into the matching blue one.
 *
 * Nominal Pedro frame is 144 in. Physical wall/tape/hive offsets below are converted from
 * the official CAD in ftc-biobuzz-sim/cad/field-manifest.json and src/sim/config.ts.
 * The CAD inner wall is 1.7929 m from center, not 72 inches: preserve that inset so
 * the Java start pose actually touches the same wall as the simulator (G304).
 * Official rules: https://ftc-resources.firstinspires.org/ftc/archive/2027/game/manual-11
 * Measure the assembled field and the real robot before relying on these targets.
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
    public static final double INCH_METERS = 0.0254;
    public static final double WALL_INSET = SIZE / 2.0 - 1.7929 / INCH_METERS;

    // Measure the real robot, bumper to bumper. LENGTH runs front to back.
    public static double ROBOT_LENGTH = 18.0;
    public static double ROBOT_WIDTH = 18.0;

    // Loading zone: against the alliance wall, in the fifth tile from the audience.
    public static final double LOADING_ZONE_DEPTH = 0.2917 / INCH_METERS;
    public static final double LOADING_ZONE_Y_MIN = SIZE / 2.0 + 0.6072 / INCH_METERS;
    public static final double LOADING_ZONE_Y_MAX = SIZE / 2.0 + 1.1836 / INCH_METERS;

    // Hive frame footprint, centered on the field.
    public static final double FRAME_X_MIN = SIZE / 2.0 - 0.628 / INCH_METERS;
    public static final double FRAME_X_MAX = SIZE - FRAME_X_MIN;
    public static final double FRAME_Y_MIN = SIZE / 2.0 - 0.495 / INCH_METERS;
    public static final double FRAME_Y_MAX = SIZE - FRAME_Y_MIN;

    // The red cell that starts the match tilted up is the one on the audience side.
    public static final double UP_CELL_X = SIZE / 2.0 - 0.3237 / INCH_METERS;

    // Gap left between the robot and the wall when parked. LEAVE needs the robot off the
    // wall and PARK needs it partly inside the 11 in. deep zone, so 4 leaves about the
    // same room for error both ways.
    public static double PARK_WALL_GAP = 4.0;

    private Field() {}
}
