/**
 * Editing an AUTO tree's poses on the FIELD. Everything here works on the tree file's JSON and has no DOM, so tests can
 * run it.
 *
 * A tree is written in the alliance frame, which is red's FIELD coordinates: x and y in meters, and headings in degrees
 * counterclockwise from +x. A blue robot runs the same tree rotated 180° about the FIELD center, so the editor edits
 * in red's frame only.
 *
 * A drive step's pose is an expression. A drag changes the expression by one rule: it edits the number literals of a
 * `pose(x, y, heading)` or `offset(p, dx, dy, dHeading)` call, and if the values that move aren't literals, it wraps
 * the expression in `offset()`. So `launchAudience` becomes `offset(launchAudience, 0.2, -0.1)`: the step still
 * follows the robot's size, and the steps that share the definition don't move. A path's waypoints are numbers, so a
 * drag changes a waypoint itself.
 */
import { literalNumber, splitCall, type TreeDef } from '../bt';
import type { Sim } from '../sim/world';
import { definedPoses, isPose, leafParams, simHeading, simPoint, type Pose } from './onboard';

type Json = Record<string, unknown>;
type Waypoint = { x: number; y: number; headingDeg: number | null };

/** One draggable point: a drive step's pose, or one waypoint of a path. */
export interface Handle {
  /** The node's path in the tree, for example `root/steps/1.sequence/s3`. */
  path: string;
  kind: 'drive' | 'waypoint';
  /** The waypoint's index, for a waypoint. */
  index?: number;
  /** Where the tree puts the point, in the alliance frame. A waypoint without a heading has heading 0 here: the robot faces along the path. */
  pose: Pose;
  /** The same point on the simulator's floor axes, for drawing: three.js x and z, and the heading in radians. */
  sim: { x: number; z: number; heading?: number };
}

const mm = (v: number) => Math.round(v * 1000) / 1000;
const halfDeg = (v: number) => Math.round(v * 2) / 2;
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Writes a number for an expression: at most three decimals, and no `-0`. */
const num = (v: number) => String(Object.is(v, -0) ? 0 : v);

/** Gets the editable points of a tree for the robot that `sim` views, in step order. */
export function editHandles(def: TreeDef, sim: Sim): Handle[] {
  const rotate = sim.alliance === 'blue', out: Handle[] = [];
  for (const { node, params: p } of leafParams(def, sim)) {
    if (node.label === 'drive.driveTo' && isPose(p.pose)) {
      const pose = p.pose;
      out.push({ path: node.path, kind: 'drive', pose, sim: { ...simPoint(pose, rotate), heading: simHeading(pose.headingDeg, rotate) } });
    }
    if (node.label === 'drive.followPath' && Array.isArray(p.waypoints)) (p.waypoints as Waypoint[]).forEach((w, i) => w && Number.isFinite(w.x) && Number.isFinite(w.y) && out.push({ path: node.path, kind: 'waypoint', index: i, pose: { x: w.x, y: w.y, headingDeg: w.headingDeg ?? 0 }, sim: simPoint(w, rotate) }));
  }
  return out;
}

/** Converts a FIELD point to the alliance frame of an alliance. Blue's frame is the FIELD rotated 180°. */
export const toAlliance = (p: { x: number; y: number }, alliance: 'red' | 'blue') => (alliance === 'blue' ? { x: -p.x, y: -p.y } : { x: p.x, y: p.y });

/**
 * Finds the JSON of the node at `path` in a tree file. A path segment is a child's id, `INDEX.LABEL` for a child
 * without an id, or the key of a single child, such as `child`. Returns null if no node has that path.
 */
export function findNode(tree: Json, path: string): Json | null {
  const segs = path.split('/'); if (segs[0] !== 'root') return null;
  let node = tree.root as Json | undefined;
  for (const seg of segs.slice(1)) {
    if (!node || typeof node !== 'object') return null;
    const kind = Object.keys(node).find(k => k !== 'id' && k !== 'note'), spec = kind ? node[kind] : undefined;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
    const sp = spec as Json, single = sp[seg];
    if (seg !== 'children' && single && typeof single === 'object' && !Array.isArray(single)) { node = single as Json; continue; }
    const kids = sp.children; if (!Array.isArray(kids)) return null;
    const m = /^(\d+)\.(.+)$/.exec(seg);
    node = (kids as Json[]).find(k => k.id === seg) ?? (m && !(kids[Number(m[1])] as Json)?.id ? kids[Number(m[1])] as Json : undefined);
  }
  return node ?? null;
}

/** Copies a tree, applies `edit` to the params of the node at `path`, and returns the copy, or the tree itself if no leaf has that path. */
function editParams(tree: Json, path: string, edit: (params: Json) => void): Json {
  const out = structuredClone(tree), node = findNode(out, path); if (!node || node.ref === undefined) return tree;
  edit((node.params ??= {}) as Json); return out;
}

/** Writes a pose parameter as an expression. A tree file can also give a pose as an object of three values. */
function poseSource(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as { x: unknown; y: unknown; headingDeg: unknown };
  return `pose(${o.x}, ${o.y}, ${o.headingDeg})`;
}

/**
 * Moves and turns a pose expression by `dx` and `dy` meters and `dh` degrees, in the alliance frame. It edits the
 * number literals of a `pose()` or `offset()` call when every value that moves is a literal, and otherwise wraps the
 * expression in `offset()`. An offset that comes back to zero is removed, so a drag back to the start restores the
 * expression as it was.
 */
export function shiftPose(source: string, dx: number, dy: number, dh: number): string {
  const call = splitCall(source);
  if (call?.name === 'pose' && call.args.length === 3) {
    const [x, y, h] = call.args.map(literalNumber), d = [dx, dy, dh];
    if ([x, y, h].every((v, i) => d[i] === 0 || v !== null)) {
      const out = call.args.map((a, i) => (d[i] === 0 ? a : num((i === 2 ? halfDeg : mm)([x, y, h][i]! + d[i]))));
      return `pose(${out.join(', ')})`;
    }
  }
  if (call?.name === 'offset' && (call.args.length === 3 || call.args.length === 4)) {
    const [ox, oy] = [call.args[1], call.args[2]].map(literalNumber), oh = call.args.length === 4 ? literalNumber(call.args[3]) : 0;
    if (ox !== null && oy !== null && oh !== null) return offsetOf(call.args[0], mm(ox + dx), mm(oy + dy), halfDeg(wrapDeg(oh + dh)));
  }
  return offsetOf(source, mm(dx), mm(dy), halfDeg(wrapDeg(dh)));
}

const offsetOf = (base: string, dx: number, dy: number, dh: number) =>
  dx === 0 && dy === 0 && dh === 0 ? base : `offset(${base}, ${num(dx)}, ${num(dy)}${dh ? `, ${num(dh)}` : ''})`;

/** Moves a handle to a point in the alliance frame, and returns the edited tree. Values round to 1 mm. */
export function moveHandle(tree: Json, h: Handle, to: { x: number; y: number }): Json {
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive') p.pose = shiftPose(poseSource(p.pose), to.x - h.pose.x, to.y - h.pose.y, 0);
    if (h.kind === 'waypoint' && h.index !== undefined && Array.isArray(p.waypoints)) { const w = p.waypoints[h.index] as Waypoint; p.waypoints[h.index] = { ...w, x: mm(to.x), y: mm(to.y) }; }
  });
}

/** Turns a drive step to a heading in degrees in the alliance frame, and returns the edited tree. The heading rounds to 0.5°. */
export function turnHandle(tree: Json, h: Handle, headingDeg: number): Json {
  if (h.kind !== 'drive') return tree;
  return editParams(tree, h.path, p => { p.pose = shiftPose(poseSource(p.pose), 0, 0, wrapDeg(headingDeg - h.pose.headingDeg)); });
}

/** The value that a handle edits: a drive step's `pose`, or one waypoint. */
function edited(tree: Json, h: Handle): unknown {
  const p = findNode(tree, h.path)?.params as Json | undefined;
  return h.kind === 'drive' ? p?.pose : (p?.waypoints as unknown[] | undefined)?.[h.index ?? -1];
}

/** Undoes the edits of one handle: its value goes back to what `original` has. */
export function resetHandle(tree: Json, h: Handle, original: Json): Json {
  const was = edited(original, h); if (was === undefined) return tree;
  return editParams(tree, h.path, p => {
    if (h.kind === 'drive') p.pose = structuredClone(was);
    if (h.kind === 'waypoint' && h.index !== undefined && Array.isArray(p.waypoints)) p.waypoints[h.index] = structuredClone(was);
  });
}

/** Checks whether a handle differs from the same handle in the original tree. */
export function isEdited(tree: Json, h: Handle, original: Json): boolean {
  return JSON.stringify(edited(tree, h)) !== JSON.stringify(edited(original, h));
}

/** Gets a drive step's pose parameter as it is written, such as `offset(launchAudience, 0.2, -0.1)`. */
export function poseText(tree: Json, h: Handle): string | null {
  const v = h.kind === 'drive' ? edited(tree, h) : undefined; return v === undefined ? null : poseSource(v);
}

/** Gets the ids of the other drive steps whose pose is the same bare definition as this step's, such as `launchAudience`. */
export function sharedWith(tree: Json, def: TreeDef, h: Handle): string[] {
  const mine = poseText(tree, h); if (!mine || !/^[A-Za-z_]\w*$/.test(mine)) return [];
  const out: string[] = [];
  const walk = (n: TreeDef['root']) => {
    if (n.label === 'drive.driveTo' && n.path !== h.path && poseText(tree, { ...h, path: n.path }) === mine) out.push(n.path.split('/').pop()!);
    n.children.forEach(walk);
  };
  walk(def.root);
  return out;
}

/**
 * Makes a tree id from a plan's name: lowercase letters, digits, and hyphens, at most 64 characters, and unique among
 * `taken`. A name with no letter or digit gets the id `plan`. A taken id gets `-2`, `-3`, and so on.
 */
export function planId(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58).replace(/-+$/, '') || 'plan';
  let id = base; for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Makes a plan from a copy of a tree file, with its own id, name, and description. `meta.clonedFrom` names the
 * source, so that the editor can reset a step to the source's value.
 */
export function clonePlan(tree: Json, plan: { id: string; name: string; description: string }): Json {
  const { editedFrom: _, clonedFrom: __, ...meta } = (tree.meta ?? {}) as Json;
  return { ...structuredClone(tree), id: plan.id, name: plan.name, description: plan.description, meta: { ...meta, clonedFrom: tree.id } };
}

/** Gets the id of the tree that a plan was copied from, or null for a tree that isn't a copy. */
export const sourceOf = (tree: Json): string | null => {
  const m = (tree.meta ?? {}) as Json, from = m.clonedFrom ?? m.editedFrom; return typeof from === 'string' ? from : null;
};

/**
 * Gets the leaves of `def` whose JSON in `tree` differs from the node at the same path in `original`, the plan that
 * `tree` was copied from. A leaf that `original` doesn't have counts as changed. Returns their paths.
 */
export function changedSteps(def: TreeDef, tree: Json, original: Json): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeDef['root']) => {
    if (n.leaf) { const a = findNode(tree, n.path), b = findNode(original, n.path); if (JSON.stringify(a) !== JSON.stringify(b)) out.add(n.path); }
    n.children.forEach(walk);
  };
  walk(def.root);
  return out;
}

// ---- Reference points: the definitions whose value is a pose, such as `launchAudience`. ----

/** A definition whose value is a pose. Steps can name it, or be an offset from it. */
export interface RefPoint {
  name: string;
  /** The value for the robot shown, in the alliance frame. */
  pose: Pose;
  /** The same point on the simulator's floor axes, for drawing. */
  sim: { x: number; z: number; heading: number };
}

/** Gets a tree's reference points for the robot that `sim` views. */
export function referencePoints(def: TreeDef, sim: Sim): RefPoint[] {
  const rotate = sim.alliance === 'blue';
  return definedPoses(def, sim).map(({ name, pose }) => ({ name, pose, sim: { ...simPoint(pose, rotate), heading: simHeading(pose.headingDeg, rotate) } }));
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Gets the reference point that a pose expression is built on: `launchAudience`, or the first value of `offset(launchAudience, ...)`. Returns null for any other expression. */
export function referenceOf(source: string): string | null {
  const t = source.trim(); if (NAME.test(t)) return t;
  const c = splitCall(t); return c?.name === 'offset' && NAME.test(c.args[0]) ? c.args[0] : null;
}

/** Gets the reference point that a drive step's pose is built on, or null. */
export const stepReference = (tree: Json, h: Handle): string | null => { const t = poseText(tree, h); return t ? referenceOf(t) : null; };

/** Copies a tree and applies `edit` to its `defs`, or returns the tree itself if it has no definition `name`. */
function editDef(tree: Json, name: string, edit: (src: string) => string): Json {
  const src = (tree.defs as Json | undefined)?.[name]; if (typeof src !== 'string') return tree;
  const out = structuredClone(tree); (out.defs as Json)[name] = edit(src); return out;
}

/** Moves a reference point to a point in the alliance frame. Its definition changes by the rule of `shiftPose`, so every step that names it moves too. */
export function moveReference(tree: Json, ref: RefPoint, to: { x: number; y: number }): Json {
  return editDef(tree, ref.name, src => shiftPose(src, to.x - ref.pose.x, to.y - ref.pose.y, 0));
}

/** Turns a reference point to a heading in degrees in the alliance frame. */
export function turnReference(tree: Json, ref: RefPoint, headingDeg: number): Json {
  return editDef(tree, ref.name, src => shiftPose(src, 0, 0, wrapDeg(headingDeg - ref.pose.headingDeg)));
}

/**
 * Makes a drive step's pose refer to a reference point: the pose becomes the point's name, or an offset from it that
 * keeps the step where it is now. Values round to 1 mm and 0.5°.
 */
export function referTo(tree: Json, h: Handle, ref: RefPoint): Json {
  if (h.kind !== 'drive') return tree;
  return editParams(tree, h.path, p => { p.pose = offsetOf(ref.name, mm(h.pose.x - ref.pose.x), mm(h.pose.y - ref.pose.y), halfDeg(wrapDeg(h.pose.headingDeg - ref.pose.headingDeg))); });
}

/** Makes a drive step's pose absolute: `pose(x, y, heading)` with the numbers where it is now. It no longer follows its reference point or the robot's size. */
export function makeAbsolute(tree: Json, h: Handle): Json {
  if (h.kind !== 'drive') return tree;
  return editParams(tree, h.path, p => { p.pose = `pose(${num(mm(h.pose.x))}, ${num(mm(h.pose.y))}, ${num(halfDeg(wrapDeg(h.pose.headingDeg)))})`; });
}

/**
 * Adds a reference point: a definition `name = pose(x, y, 0)` at a point in the alliance frame. Returns the tree, or
 * the problem with the name. The loader also rejects a name that the environment or a function already has.
 */
export function addReference(tree: Json, name: string, at: { x: number; y: number }): { tree: Json } | { error: string } {
  const n = name.trim();
  if (!NAME.test(n)) return { error: 'A name is letters, digits, and underscores, and starts with a letter.' };
  if ((tree.defs as Json | undefined)?.[n] !== undefined) return { error: `The plan already has a definition named ${n}.` };
  const out = structuredClone(tree); out.defs = { ...((out.defs as Json | undefined) ?? {}), [n]: `pose(${num(mm(at.x))}, ${num(mm(at.y))}, 0)` };
  return { tree: out };
}

/** Gets the names of the definitions whose source in `tree` differs from `original`'s, including new ones. */
/**
 * Deletes a definition, such as a reference point. Every drive step whose pose is the definition or an offset from it
 * becomes absolute first, so those steps keep their places. Returns the tree and the ids of the steps made absolute, or
 * the problem if another definition or step still uses the name, for example `parkRight`, which is `pose(park.x, …)`.
 */
export function deleteDef(tree: Json, handles: readonly Handle[], name: string): { tree: Json; madeAbsolute: string[] } | { error: string } {
  if (typeof (tree.defs as Json | undefined)?.[name] !== 'string') return { error: `The plan has no definition named ${name}.` };
  let out = tree; const madeAbsolute: string[] = [];
  for (const h of handles) if (h.kind === 'drive' && stepReference(out, h) === name) { out = makeAbsolute(out, h); madeAbsolute.push(h.path.split('/').pop()!); }
  out = structuredClone(out); delete (out.defs as Json)[name];
  const users = defUsers(out, name);
  return users.length ? { error: `${users.join(', ')} still ${users.length === 1 ? 'uses' : 'use'} ${name}. Change ${users.length === 1 ? 'it' : 'them'} first.` } : { tree: out, madeAbsolute };
}

/** Gets the definitions and step ids whose expressions name `name`. A quoted string, such as `'rear'`, or a field, such as `park.x`'s `x`, doesn't count. */
export function defUsers(tree: Json, name: string): string[] {
  const word = new RegExp(`(?<![\\w.'"])${name}(?![\\w'"])`), out: string[] = [];
  for (const [k, v] of Object.entries((tree.defs ?? {}) as Json)) if (typeof v === 'string' && word.test(v)) out.push(k);
  const names = (v: unknown): boolean => typeof v === 'string' ? word.test(v) : !!v && typeof v === 'object' && Object.values(v).some(names);
  const walk = (n: unknown, id: string | null) => {
    if (Array.isArray(n)) { n.forEach(c => walk(c, id)); return; }
    if (!n || typeof n !== 'object') return;
    const o = n as Json, mine = typeof o.id === 'string' ? o.id : id;
    if (o.params && names(o.params)) out.push(mine ?? String(o.ref));
    for (const [k, v] of Object.entries(o)) if (k !== 'params' && k !== 'meta') walk(v, mine);
  };
  walk(tree.root, null);
  return [...new Set(out)];
}

export function changedDefs(tree: Json, original: Json): Set<string> {
  const a = (tree.defs ?? {}) as Json, b = (original.defs ?? {}) as Json;
  return new Set([...Object.keys(a), ...Object.keys(b)].filter(k => a[k] !== b[k]));
}

// ---- Step insertion, reordering, and deletion ----

/**
 * Generates a step id that is unique within a children array. Tries `base`, then `base-2`, `base-3`, etc.
 */
function uniqueId(children: unknown[], base: string): string {
  const used = new Set((children as Json[]).map(c => (c as Json).id).filter(Boolean));
  let id = base; for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Walks the tree JSON looking for the top-level `sequence.children` array — the outermost sequence that holds all
 * the steps. Returns the array or null if the tree has no such root sequence.
 */
export function rootSequence(tree: Json): Json[] | null {
  const root = tree.root; if (!root || typeof root !== 'object') return null;
  const seq = (root as Json).sequence; if (!seq || typeof seq !== 'object') return null;
  const kids = (seq as Json).children; return Array.isArray(kids) ? kids as Json[] : null;
}

/**
 * Adds a `drive.driveTo` step to the end of the root sequence that goes to the reference point named `ref`.
 * Returns the new tree, or `{ error }` when the tree has no root sequence or the ref name is invalid.
 */
export function addDriveToStep(tree: Json, ref: string, pose: Pose, timeoutSec = 5): { tree: Json } | { error: string } {
  const seq = rootSequence(tree); if (!seq) return { error: 'This plan has no root sequence to add steps to.' };
  const out = structuredClone(tree), outSeq = rootSequence(out)!;
  const id = uniqueId(outSeq, ref ? `go-${ref}` : 'step');
  outSeq.push({ id, ref: 'drive.driveTo', params: { pose: ref || `pose(${num(mm(pose.x))}, ${num(mm(pose.y))}, ${num(halfDeg(wrapDeg(pose.headingDeg)))})`, timeoutSec } });
  return { tree: out };
}

/**
 * Adds a step at the end of the root sequence. `step` is a partial node object; an `id` is generated if absent.
 * Returns the new tree, or `{ error }` when the tree has no root sequence.
 */
export function appendStep(tree: Json, step: Json): { tree: Json } | { error: string } {
  const seq = rootSequence(tree); if (!seq) return { error: 'This plan has no root sequence to add steps to.' };
  const out = structuredClone(tree), outSeq = rootSequence(out)!;
  const id = uniqueId(outSeq, typeof step.id === 'string' ? step.id : 'step');
  outSeq.push({ ...structuredClone(step), id });
  return { tree: out };
}

/**
 * Removes the step at `index` from the root sequence. Steps added by the step-settings panel (shoot tags) that
 * immediately follow the removed step are also removed. Returns the new tree, or `{ error }`.
 */
export function removeStep(tree: Json, index: number): { tree: Json } | { error: string } {
  const seq = rootSequence(tree); if (!seq) return { error: 'This plan has no root sequence.' };
  if (index < 0 || index >= seq.length) return { error: 'Step index out of range.' };
  const out = structuredClone(tree), outSeq = rootSequence(out)!;
  const removedId = (outSeq[index] as Json).id;
  outSeq.splice(index, 1);
  // Also remove an immediately following shoot step that was tagged by the step-settings panel
  if (typeof removedId === 'string' && index < outSeq.length) {
    const next = outSeq[index] as Json;
    if (next.id === `${removedId}-shoot`) outSeq.splice(index, 1);
  }
  return { tree: out };
}

/**
 * Moves the step at `index` up (dir = -1) or down (dir = +1) in the root sequence, keeping any trailing shoot step
 * that belongs to it together with it. Returns the new tree, or `{ error }`.
 */
export function moveStep(tree: Json, index: number, dir: -1 | 1): { tree: Json } | { error: string } {
  const seq = rootSequence(tree); if (!seq) return { error: 'This plan has no root sequence.' };
  const dest = index + dir;
  if (dest < 0 || dest >= seq.length) return { error: 'Cannot move step further.' };
  const out = structuredClone(tree), outSeq = rootSequence(out)!;
  // Determine the block: step + its attached shoot step (if any)
  const stepId = (outSeq[index] as Json).id;
  const hasShoot = typeof stepId === 'string' && index + 1 < outSeq.length && (outSeq[index + 1] as Json).id === `${stepId}-shoot`;
  const block = hasShoot ? outSeq.splice(index, 2) : [outSeq.splice(index, 1)[0]];
  const insertAt = dir < 0 ? dest : dest - (block.length - 1);
  outSeq.splice(insertAt, 0, ...block);
  return { tree: out };
}
