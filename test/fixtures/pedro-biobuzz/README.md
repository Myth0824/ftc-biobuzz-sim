These Java fixtures were copied on 2026-11-10 from team 32294's working robot source in
`ishsharm0/FTC_Biobuzz_32294`, under `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/`.
`Field.java` is at that package root; the other files are in `opmodes/`.
They exercise the actual multi-file routes, constructor-local arithmetic, enum alliance pose helper,
inherited start pose, follow order, and timer checks. They are parser inputs, not Java build targets.
Update them together when the team's route source changes. Tests also cover the minimal three-file import
without `BiobuzzAuto.java` and feed the result to the simulator's AUTO editor preview.

The2026-11-10 realism update changes the source to a rear-facing shooter, three individual preload shots with 0.9 s
recovery, one-second hive settling, and physical-wall/tape offsets from the official CAD. The real transfer feed pulse
is an unmeasured0.25 s initial value. Fixtures remain exact copies of the robot repo files listed above.

Matching robot implementation: [b89504e](https://github.com/ishsharm0/FTC_Biobuzz_32294/commit/b89504e).
