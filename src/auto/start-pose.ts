import type { TreeDef } from '../bt';
import type { Sim } from '../sim/world';
import { definedPoses, isPose, leafParams, simHeading, simPoint, type Pose } from './onboard';

/** Source plans describe their initial odometry pose; benchmark trees keep their FIELD spawn. */
export function autoStartPose(def: TreeDef, sim: Sim): Pose | null {
  const enabled = def.meta.startAtFirstPose === true || (def.meta.startAtFirstPose === undefined && def.id.startsWith('pedro-'));
  if (!enabled) return null;
  const first = leafParams(def, sim).find(l => l.node.label === 'drive.driveTo');
  // Dragging/turning a handle can rewrite the first leaf without rewriting the original start definition.
  if (first && isPose(first.params.pose)) return first.params.pose;
  return definedPoses(def, sim).find(d => d.name === 'start')?.pose ?? null;
}

/** Apply only during setup, before coaches, previews, and the first trace frame are created. */
export function placeAutoStart(def: TreeDef, sim: Sim): boolean {
  if (sim.phase !== 'pre') return false;
  const pose = autoStartPose(def, sim);
  if (!pose) return false;
  const rotate = sim.alliance === 'blue', point = simPoint(pose, rotate), heading = simHeading(pose.headingDeg, rotate);
  const body = sim.robot;
  body.setTranslation({ ...point, y: body.translation().y }, true);
  body.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  return true;
}
