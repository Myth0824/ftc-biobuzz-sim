/**
 * The AUTO editor: shows a red robot's AUTO plan on the FIELD before a MATCH, and edits the poses of a plan that you
 * created, by dragging handles. System plans, the tree files in `src/auto/trees/auto/`, are read-only: **Create new**
 * copies one under a name and a description, and the copy becomes the robot's plan. Trees are written in red's frame,
 * and a blue robot runs them rotated 180° about the FIELD center, so the editor works on the two red robots. The
 * browser keeps your plans (`user-trees.ts`). See `auto/auto-edit.ts` for how a drag changes a tree.
 */
import { exprContext, type ExprContext, type TreeDef } from './bt';
import { addReference, defUsers, deleteDef, changedDefs, changedSteps, clonePlan, editHandles, isEdited, makeAbsolute, moveHandle, moveReference, planId, poseText, referencePoints, referTo, resetHandle, sharedWith, sourceOf, stepReference, toAlliance, turnHandle, turnReference, rootSequence, addDriveToStep, removeStep, moveStep, type Handle, type RefPoint } from './auto/auto-edit';
import { AUTO_FIELD, AUTO_PROBLEMS, AUTO_REGISTRY, AUTO_SOURCES, AUTO_TREES, BUILT_IN_AUTO, SOLO_AUTO, addAutoTree, autoFor, autoStart, defValues } from './auto/onboard';
import { addDef, defRows, paramFields, readField, setDef, setParam, sortProblems, type DefRow, type ParamField, type Problems } from './auto/draft';
import type { View, CameraMode } from './render/view';
import type { TreeEdit } from './render/tree-view';
import { startSide, type BotSetup } from './setup';
import type { Sim } from './sim/world';
import { deleteUserTree, saveUserTree } from './user-trees';
import { FIELD } from './sim/config';

type Json = Record<string, unknown>;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** The snap grid, 1 in, and the heading snap, 5°. */
const GRID_M = 0.0254, HEADING_SNAP_DEG = 5;
/** How close the pointer must come to a reference point to snap to it, in pixels, and how long a hold there takes to refer the pose to it. */
const REF_SNAP_PX = 12, REF_HOLD_MS = 500;
/** The red robots: the editor edits in red's frame. */
export const RED_ROBOTS = [0, 1] as const;

export interface EditorHost {
  view: View; canvas: HTMLCanvasElement; bots: BotSetup[];
  sim(): Sim;
  /** Called when a robot's AUTO setting changes, so that the page saves the setups and updates the robot's coach. */
  setAuto(robot: number, id: string): void;
  /** Called when the editor opens, closes, or changes, so that the page redraws. */
  changed(): void;
}

/** Writes a definition's value for the definitions panel: a number to 3 decimals, a pose as x, y, and heading. */
function valueText(v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  const p = v as { x?: unknown; y?: unknown; headingDeg?: unknown } | null;
  if (p && typeof p === 'object' && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.headingDeg === 'number') return `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.headingDeg.toFixed(1)}°)`;
  return JSON.stringify(v);
}

export class FieldEditor {
  /** The red robot whose plan the editor shows, or -1 when the editor is closed. */
  robot = -1;
  /** True while you edit the plan: the handles take drags. Only a plan that you created can be edited. */
  editing = false;
  /** Counts the edits, for the key of the AUTO preview. */
  rev = 0;
  selected: string | null = null;
  /** The index in `handles` of the point that the ghost robot shows: the handle clicked, or the selected step's first. */
  point = -1;
  handles: Handle[] = [];
  /** The steps that differ from the plan that this one was copied from. */
  changed: ReadonlySet<string> = new Set();
  /** The reference points: the plan's definitions that are poses. */
  refs: RefPoint[] = [];
  /** The definitions that differ from the source plan, including reference points and deleted definitions. */
  changedRefs: ReadonlySet<string> = new Set();
  /** The selected reference point, and the selected offset line, by the path of the step that it belongs to. */
  selectedRef: string | null = null; selectedLink: string | null = null;
  /** The loader's problems with the plan shown, sorted onto its steps and definitions. A plan with problems doesn't run. */
  problems: Problems = sortProblems(null, []);
  /** A problem with the last action, such as a reference point that can't be deleted. The status line shows it until the selection or the plan changes. */
  notice: string | null = null;
  /** If true, a drag snaps to the 1 in grid, and a turn to 5°. Holding Alt, or Option on a Mac, inverts it for one drag. */
  snapGrid = false;
  /** The reference point that a dragged pose rests on, and since when. After `REF_HOLD_MS`, a release refers the pose to it. */
  private dwell: { name: string; since: number; ready: boolean } | null = null;
  /** Undo and redo: the plan before each edit, and the plans that an undo took back. A drag is one edit. */
  private past: Json[] = []; private future: Json[] = []; private dragFrom: Json | null = null;
  private tree: Json = {}; private original: Json = {};
  private drag: { what: 'handle' | 'ref'; index: number; part: 'pose' | 'heading'; moved: boolean; dx: number; dy: number } | null = null;
  private camera: CameraMode = 'driver'; private swallowClick = false;

  constructor(private readonly host: EditorHost) {
    const c = host.canvas;
    c.addEventListener('pointerdown', e => {
      if (this.robot < 0 || e.button !== 0) return;
      // What's selected wins: a selected step's handle or the selected reference point under the pointer takes the press,
      // so that a step that names a reference point, and sits on it, can be dragged. Otherwise a reference point, small
      // and drawn over the steps that name it, wins within its own few pixels. Then an offset line wins where it shows
      // outside the discs at its ends, because a step's disc takes presses out to 16 px and a short line is under that.
      // Then the step handles. A click on any of them is the editor's: the click that follows mustn't also pick the
      // robot under it.
      this.hoverRef?.(null, 0, 0);
      const handle = this.handleAt(e), refHit = this.host.view.refAt(e.clientX, e.clientY, this.refDrawList());
      const handleSelected = !!handle && this.handles[handle.index].path === this.selected, refSelected = !!refHit && this.refs[refHit.index].name === this.selectedRef;
      const ref = refSelected || (refHit && !handleSelected) ? refHit : null, knob = !ref && handle?.part === 'heading';
      const k = ref || knob ? null : this.host.view.linkAt(e.clientX, e.clientY, this.links());
      if (k !== null) { this.selectLink(this.links()[k].path); this.swallowClick = true; return; }
      const hit = ref ? null : handle; if (!ref && !hit) return;
      this.swallowClick = true;
      if (ref) this.selectRef(this.refs[ref.index].name); else { const h = this.handles[hit!.index]; this.select(h.path, hit!.index); }
      if (!this.editing) return;
      e.preventDefault(); c.setPointerCapture(e.pointerId);
      // The drag keeps the offset between the pointer and the handle, so that the handle doesn't jump to the pointer.
      const q = this.pointer(e), at = ref ? this.refs[ref.index].pose : this.handles[hit!.index].pose;
      this.drag = { what: ref ? 'ref' : 'handle', index: ref ? ref.index : hit!.index, part: (ref ?? hit)!.part, moved: false, dx: q ? at.x - q.x : 0, dy: q ? at.y - q.y : 0 };
      this.dragFrom = this.tree; this.dwell = null;
    });
    c.addEventListener('pointermove', e => {
      if (this.robot < 0) return;
      if (!this.drag) {
        const ref = this.host.view.refAt(e.clientX, e.clientY, this.refDrawList());
        this.hoverRef?.(ref ? this.refs[ref.index] : null, e.clientX, e.clientY);
        c.style.cursor = ref || this.handleAt(e) ? (this.editing ? 'grab' : 'pointer') : this.host.view.linkAt(e.clientX, e.clientY, this.links()) !== null ? 'pointer' : ''; return;
      }
      c.style.cursor = 'grabbing'; this.dragTo(e);
    });
    const end = (e: PointerEvent) => {
      if (!this.drag) return;
      // A release can come without a move to its own position, so the release position counts as a move.
      if (e.type === 'pointerup') this.dragTo(e);
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      // The click that follows the release would report the FIELD position in the log.
      // A pose that rested on a reference point long enough refers to it now.
      const d = this.drag, lit = this.dwell?.ready ? this.refs.find(r => r.name === this.dwell!.name) : undefined;
      if (lit && d.what === 'handle' && d.part === 'pose' && this.handles[d.index]?.kind === 'drive') { d.moved = true; this.apply(referTo(this.tree, this.handles[d.index], lit), false); }
      this.swallowClick = true; if (d.moved && this.dragFrom) { this.remember(this.dragFrom); this.save(); }
      this.drag = null; this.dragFrom = null; this.dwell = null; c.style.cursor = ''; this.host.view.showGrid(null); this.paint(); this.host.changed();
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }

  /**
   * Gets the handle under the pointer. Two steps can put handles on one spot, as two sweeps with the same waypoints do,
   * so the selected step's handles come first and win a tie.
   */
  private handleAt(e: { clientX: number; clientY: number }): { index: number; part: 'pose' | 'heading' } | null {
    const order = this.handles.map((_, i) => i).sort((a, b) => Number(this.handles[b].path === this.selected) - Number(this.handles[a].path === this.selected));
    const hit = this.host.view.handleAt(e.clientX, e.clientY, order.map(i => this.handles[i].sim));
    return hit && { index: order[hit.index], part: hit.part };
  }

  /** Gets the FIELD point under the pointer in the edited robot's alliance frame, or null off the FIELD. */
  private pointer(e: PointerEvent) {
    const q = this.host.view.pickFloor(e.clientX, e.clientY);
    return q ? toAlliance(q, this.host.sim().view(this.robot).alliance) : null;
  }

  /** Hover callback for the page: the reference point under the pointer, or null, to show its name. */
  hoverRef: ((ref: RefPoint | null, clientX: number, clientY: number) => void) | null = null;

  /**
   * Moves the dragged handle or reference point, or turns its heading, to the pointer's position on the FIELD floor.
   * A step's pose snaps to a reference point near the pointer, and otherwise, with snapping on, to the 1 in grid. A turn
   * snaps to its reference point's heading within 5°, and otherwise, with snapping on, to 5° steps.
   */
  private dragTo(e: PointerEvent) {
    const q = this.drag && this.pointer(e); if (!this.drag || !q) return;
    const d = this.drag, snap = this.snapGrid !== e.altKey, clamp = (v: number) => Math.max(-FIELD.half, Math.min(FIELD.half, v));
    const grid = (v: number) => (snap ? Math.round(v / GRID_M) * GRID_M : v);
    let to = { x: clamp(q.x + d.dx), y: clamp(q.y + d.dy) }, next: Json;
    if (d.what === 'ref') {
      const r = this.refs[d.index]; if (!r) return;
      next = d.part === 'pose' ? moveReference(this.tree, r, { x: grid(to.x), y: grid(to.y) }) : turnReference(this.tree, r, this.snapHeading((Math.atan2(q.y - r.pose.y, q.x - r.pose.x) * 180) / Math.PI, null, snap));
    } else {
      const h = this.handles[d.index]; if (!h) return;
      if (d.part === 'pose') {
        const near = this.refs.find(r => this.host.view.nearPoint(e.clientX, e.clientY, r.sim, REF_SNAP_PX));
        if (near) {
          to = { x: near.pose.x, y: near.pose.y };
          // A hold sends no pointer events, so a timer lights the point after `REF_HOLD_MS` if the pose is still there.
          if (this.dwell?.name !== near.name && h.kind === 'drive') {
            const mark = { name: near.name, since: performance.now(), ready: false }; this.dwell = mark;
            setTimeout(() => { if (this.dwell === mark && this.drag) { mark.ready = true; this.paint(); this.host.changed(); } }, REF_HOLD_MS);
          }
        } else { this.dwell = null; to = { x: grid(to.x), y: grid(to.y) }; }
        next = moveHandle(this.tree, h, to);
      } else {
        const ref = this.refs.find(r => r.name === stepReference(this.tree, h)) ?? null;
        next = turnHandle(this.tree, h, this.snapHeading((Math.atan2(q.y - h.pose.y, q.x - h.pose.x) * 180) / Math.PI, ref, snap));
      }
    }
    const at = d.what === 'ref' ? this.refs[d.index]?.sim : this.handles[d.index]?.sim;
    this.host.view.showGrid(snap && d.part === 'pose' && at ? at : null);
    if (JSON.stringify(next) !== JSON.stringify(this.tree)) { d.moved = true; this.apply(next, false); } else this.paint();
  }

  /** Snaps a heading in degrees: to the reference point's heading within 5°, and otherwise, if `snap`, to 5° steps. */
  private snapHeading(deg: number, ref: RefPoint | null, snap: boolean) {
    if (ref && Math.abs(wrap(deg - ref.pose.headingDeg)) < HEADING_SNAP_DEG) return ref.pose.headingDeg;
    return snap ? Math.round(deg / HEADING_SNAP_DEG) * HEADING_SNAP_DEG : deg;
  }

  get active() { return this.robot >= 0; }

  /** Checks whether the canvas click that just happened was on a handle, or ended a drag, and forgets it. The page ignores such a click. */
  takeClick() { const s = this.swallowClick; this.swallowClick = false; return s; }

  /** Gets the id of the AUTO tree that robot `i` runs, or null for none. */
  treeOf(i: number): string | null {
    const b = this.host.bots[i]; if (b.auto === 'none') return null;
    const id = b.auto === 'default' ? autoFor(this.host.sim().view(i), SOLO_AUTO) : b.auto;
    return AUTO_TREES[id] ? id : null;
  }

  /** Opens the editor on red robot `i`, with the overhead camera. Returns false for a blue robot. */
  open(i: number = 0): boolean {
    if (!RED_ROBOTS.includes(i as 0 | 1)) return false;
    if (this.robot < 0) { this.camera = this.host.view.mode; this.host.view.mode = 'overhead'; }
    this.showRobot(i); return true;
  }

  /** Shows the plan of red robot `i`. Editing stops: each plan is edited on purpose, with **Edit**. */
  showRobot(i: number) {
    const id = this.treeOf(i);
    this.robot = i; this.editing = false; this.selected = null; this.point = -1; this.drag = null; this.past = []; this.future = [];
    this.selectedRef = null; this.selectedLink = null; this.dwell = null; this.addingDef = false;
    this.tree = id ? (AUTO_SOURCES[id] as Json) : {}; this.original = this.originalOf(this.tree);
    this.rev++; this.refresh(); this.host.changed();
  }

  close() {
    if (this.robot < 0) return;
    this.robot = -1; this.editing = false; this.drag = null; this.handles = []; this.refs = []; this.host.view.showHandles([]); this.host.view.showRefs([]); this.host.view.showLinks([]); this.host.view.showGrid(null);
    this.hoverRef?.(null, 0, 0); this.host.view.mode = this.camera; this.host.canvas.style.cursor = '';
    this.host.changed();
  }

  /** The plan shown, as the robot runs it, or null for a robot with no AUTO plan. */
  get def(): TreeDef | null { const id = this.tree.id; return typeof id === 'string' ? AUTO_TREES[id] ?? null : null; }

  /** True if the plan shown is one that you created; false for a system plan. */
  get isUserPlan() { const id = this.tree.id; return typeof id === 'string' && !BUILT_IN_AUTO.has(id); }

  /** The start position that the plan shown is for, if it isn't the robot's own: a warning. */
  get wrongStart(): 'right' | 'left' | null {
    const def = this.def; if (!def || this.robot < 0) return null;
    const s = autoStart(def); return s !== 'any' && s !== startSide(this.robot) ? s : null;
  }

  /** Starts editing the plan shown. A system plan can't be edited. */
  edit() { if (!this.isUserPlan) return; this.editing = true; this.paint(); this.host.changed(); }

  /** Gets the plans that **Create new** can copy for the robot shown: every plan for its start position, and every plan for any start. */
  sources(): { id: string; name: string }[] {
    const side = this.robot >= 0 ? startSide(this.robot) : 'right';
    return Object.values(AUTO_TREES).filter(d => { const s = autoStart(d); return s === 'any' || s === side; }).map(d => ({ id: d.id, name: d.name }));
  }

  /**
   * Makes a plan from a copy of `from`, with `name` and `description`, makes it the robot's plan, and starts editing it.
   * Returns a problem to show, or null when it's made.
   */
  create(from: string, name: string, description: string): string | null {
    const n = name.trim(), d = description.trim(), src = AUTO_SOURCES[from] as Json | undefined;
    if (!n) return 'Give the plan a name.'; if (n.length > 80) return 'A name can have at most 80 characters.';
    if (!d) return 'Say what the plan does, in a sentence or two.'; if (!src) return 'Pick a plan to copy.';
    if (Object.values(AUTO_TREES).some(t => t.name.toLowerCase() === n.toLowerCase())) return `A plan is already named "${n}".`;
    const tree = clonePlan(src, { id: planId(n, id => id in AUTO_TREES), name: n, description: d });
    addAutoTree(tree, true); saveUserTree(tree);
    this.host.setAuto(this.robot, String(tree.id));
    this.showRobot(this.robot); this.edit();
    return null;
  }

  /**
   * Creates a brand-new empty plan with `name` and `description`, for the robot's start position (blank template).
   * Returns a problem to show, or null.
   */
  createBlank(name: string, description: string): string | null {
    const n = name.trim(), d = description.trim();
    if (!n) return 'Give the plan a name.'; if (n.length > 80) return 'A name can have at most 80 characters.';
    if (!d) return 'Say what the plan does, in a sentence or two.';
    if (Object.values(AUTO_TREES).some(t => t.name.toLowerCase() === n.toLowerCase())) return `A plan is already named "${n}".`;
    const side = this.robot >= 0 ? startSide(this.robot) : 'right';
    const blankId = side === 'left' ? 'blank-left' : 'blank-right';
    const src = AUTO_SOURCES[blankId] as Json | undefined;
    if (!src) return 'Blank template not found.';
    const tree = clonePlan(src, { id: planId(n, id => id in AUTO_TREES), name: n, description: d });
    addAutoTree(tree, true); saveUserTree(tree);
    this.host.setAuto(this.robot, String(tree.id));
    this.showRobot(this.robot); this.edit();
    return null;
  }

  /**
   * Adds a `drive.driveTo` step to the root sequence that drives to the reference point named `refName`.
   * Returns a problem to show, or null.
   */
  addDriveToRef(refName: string): string | null {
    if (!this.editing) return 'Edit a plan that you made to add steps.';
    const ref = this.refs.find(r => r.name === refName); if (!ref) return `No reference point named ${refName}.`;
    const r = addDriveToStep(this.tree, refName, ref.pose);
    if ('error' in r) return r.error;
    try { this.remember(this.tree); this.apply(r.tree, true); } catch (e) { this.past.pop(); return e instanceof Error ? e.message.replace(/^.*?: /, '') : String(e); }
    // Select the newly added step
    const seq = rootSequence(r.tree); if (seq?.length) { const last = seq[seq.length - 1] as Json; if (typeof last.id === 'string') this.select(`root/${last.id}`); }
    return null;
  }

  /** Removes the step at root-sequence `index`. Returns a problem or null. */
  removeStepAt(index: number): string | null {
    if (!this.editing) return 'Edit a plan that you made to remove steps.';
    const r = removeStep(this.tree, index);
    if ('error' in r) return r.error;
    this.remember(this.tree); this.selected = null; this.point = -1; this.apply(r.tree, true); return null;
  }

  /** Moves the step at root-sequence `index` up (-1) or down (+1). Returns a problem or null. */
  moveStepAt(index: number, dir: -1 | 1): string | null {
    if (!this.editing) return 'Edit a plan that you made to reorder steps.';
    const r = moveStep(this.tree, index, dir);
    if ('error' in r) return r.error;
    this.remember(this.tree); this.apply(r.tree, true); return null;
  }

  /** Gets the root-sequence step list for the step-order panel: each step's id, label/ref, and index. */
  rootSteps(): { index: number; id: string; label: string; path: string }[] {
    const seq = rootSequence(this.tree); if (!seq) return [];
    return seq.map((s, i) => {
      const id = typeof s.id === 'string' ? s.id : String(i);
      const ref = typeof s.ref === 'string' ? s.ref : (typeof (s as Json).parallel !== 'undefined' ? '{ parallel }' : typeof (s as Json).sequence !== 'undefined' ? '{ sequence }' : '?');
      return { index: i, id, label: ref, path: `root/${id}` };
    });
  }

  /**
   * Deletes the plan shown, which must be one that you created. Every robot that ran it goes back to the plan that it
   * was copied from, or to **Default** when that's the robot's default.
   */
  deletePlan() {
    if (!this.isUserPlan) return; const id = String(this.tree.id), from = sourceOf(this.tree);
    this.host.bots.forEach((b, k) => {
      if (b.auto !== id) return;
      const back = from && AUTO_TREES[from] && autoFor(this.host.sim().view(k), SOLO_AUTO) !== from ? from : 'default';
      this.host.setAuto(k, back);
    });
    deleteUserTree(id); this.showRobot(this.robot);
  }

  /** The tree view's options: the selection, and the nodes with handles. */
  treeEdit(): TreeEdit {
    const defs = this.defs().map(d => ({ name: d.name, pose: d.pose, value: d.value, bad: this.problems.defs.has(d.name), changed: this.isUserPlan && this.changedRefs.has(d.name) }));
    const constants = Object.entries(AUTO_FIELD).map(([k, v]) => ({ name: `field.${k}`, value: String(v) })); // A constant shows its CAD value in full.
    return { selected: this.selected, editable: new Set(this.handles.map(h => h.path)), changed: this.changed, problems: new Set(this.problems.nodes.keys()), defs, selectedDef: this.selectedRef, constants, canAdd: this.editing };
  }

  /** Selects a step, and the point of it that the ghost robot shows: `point`, or the step's first handle. */
  select(path: string | null, point?: number) {
    this.selected = path; this.point = point ?? this.handles.findIndex(h => h.path === path); this.selectedRef = null; this.selectedLink = null; this.notice = null; this.addingDef = false;
    this.paint(); this.host.changed();
  }

  /** Selects a reference point. The steps that name it show their offset lines to it. */
  selectRef(name: string) { this.notice = null; this.addingDef = false; this.selected = null; this.point = -1; this.selectedRef = name; this.selectedLink = null; this.paint(); this.host.changed(); }

  /** Selects the offset line of a step, and the step. **Delete** then makes the step absolute. */
  selectLink(path: string) { this.select(path); this.selectedLink = path; this.paint(); this.host.changed(); }

  /** Makes the step of the selected offset line absolute: it keeps its place, and stops following its reference point. */
  deleteLink() { if (this.selectedLink) this.makeStepAbsolute(this.selectedLink); }

  /** Makes a drive step absolute: it keeps its place, and stops following its reference point. */
  makeStepAbsolute(path: string) {
    const h = this.handles.find(q => q.path === path && q.kind === 'drive'); if (!h || !this.editing) return;
    this.remember(this.tree); this.selectedLink = null; this.apply(makeAbsolute(this.tree, h), true);
  }

  /**
   * Gets what a right-click at a screen point can act on: the reference point there, or the drive step whose disc or
   * offset line is there, with the reference point that the step is built on. Null if neither is there.
   */
  menuAt(clientX: number, clientY: number): { ref: string } | { step: string; id: string; ref: string | null } | null {
    const r = this.host.view.refAt(clientX, clientY, this.refDrawList()); if (r) return { ref: this.refs[r.index].name };
    const k = this.host.view.linkAt(clientX, clientY, this.links()), hit = this.handleAt({ clientX, clientY });
    const h = k !== null ? this.handles.find(q => q.path === this.links()[k].path) : hit ? this.handles[hit.index] : undefined;
    if (!h || h.kind !== 'drive') return null;
    const name = stepReference(this.tree, h);
    return { step: h.path, id: h.path.split('/').pop()!, ref: name && this.refs.some(q => q.name === name) ? name : null };
  }

  /**
   * Deletes the selected reference point, or `name`. The steps that name it become absolute and keep their places.
   * Returns a problem to show, such as another definition that uses the point, or null.
   */
  deleteRef(name = this.selectedRef): string | null {
    if (!this.editing || !name) return null;
    const r = deleteDef(this.tree, this.handles, name); if ('error' in r) { this.notice = r.error; this.host.changed(); return r.error; }
    try { this.remember(this.tree); this.selectedRef = null; this.apply(r.tree, true); } catch (e) { this.past.pop(); return e instanceof Error ? e.message.replace(/^.*?: /, '') : String(e); }
    return null;
  }

  /** Adds a reference point at a FIELD point, in the robot's alliance frame. Returns a problem to show, or null. */
  addReferenceAt(name: string, field: { x: number; y: number }): string | null {
    if (!this.editing) return 'Edit a plan that you made to add reference points.';
    const r = addReference(this.tree, name, toAlliance(field, this.host.sim().view(this.robot).alliance)); if ('error' in r) return r.error;
    try { this.remember(this.tree); this.apply(r.tree, true); } catch (e) { this.past.pop(); return e instanceof Error ? e.message.replace(/^.*?: /, '') : String(e); }
    this.selectRef(name.trim()); return null;
  }

  /**
   * The offset lines to draw: from each step that is built on a reference point to that point, for the selected step,
   * the selected line's step, the dragged step, and every step that names the selected reference point.
   */
  links(): { path: string; from: { x: number; z: number }; to: { x: number; z: number } }[] {
    const out: { path: string; from: { x: number; z: number }; to: { x: number; z: number } }[] = [];
    const dragged = this.drag?.what === 'handle' ? this.handles[this.drag.index]?.path : null;
    for (const h of this.handles) {
      if (h.kind !== 'drive') continue;
      const name = stepReference(this.tree, h), r = name ? this.refs.find(q => q.name === name) : undefined; if (!r) continue;
      if (h.path !== this.selected && h.path !== dragged && name !== this.selectedRef) continue;
      if (Math.hypot(h.sim.x - r.sim.x, h.sim.z - r.sim.z) < 0.01) continue; // No offset: nothing to draw.
      out.push({ path: h.path, from: h.sim, to: r.sim });
    }
    return out;
  }

  /** Gets the form fields of the selected step, or null if the selection isn't a leaf. */
  fields(): ParamField[] | null { return this.selected ? paramFields(this.tree, this.selected, AUTO_REGISTRY) : null; }

  /** Gets the selected node: its type, such as `drive.driveTo` or `sequence`, its id, and the leaf type's doc. */
  selectedNode(): { label: string; id: string; doc: string | null; leaf: boolean; detail?: string } | null {
    const find = (n: TreeDef['root']): TreeDef['root'] | null => (n.path === this.selected ? n : n.children.map(find).find(Boolean) ?? null);
    const n = this.def && this.selected ? find(this.def.root) : null; if (!n) return null;
    return { label: n.label, id: n.path.split('/').pop()!, doc: n.leaf ? AUTO_REGISTRY.leaves[n.label]?.doc ?? null : null, leaf: !!n.leaf, detail: n.detail };
  }

  /** Sets a parameter of a step from a form field's text. An empty field removes the parameter. See `readField`. */
  setParamText(path: string, key: string, text: string) {
    const f = paramFields(this.tree, path, AUTO_REGISTRY)?.find(q => q.key === key); if (!f || !this.editing || f.control === 'list') return;
    const next = setParam(this.tree, path, key, readField(f, text)); if (next === this.tree) return;
    this.remember(this.tree); this.apply(next, true);
  }

  /**
   * Applies a new tree JSON directly. Used by the step-settings panel to add/remove/modify
   * sibling nodes (intake, turret, shoot) alongside a drive.driveTo step.
   */
  applyTree(next: Record<string, unknown>) {
    if (!this.editing) return;
    this.remember(this.tree); this.apply(next as Json, true);
  }

  /** Returns a deep clone of the current tree JSON, for reading and mutating before calling applyTree(). */
  cloneTree(): Record<string, unknown> { return structuredClone(this.tree) as Record<string, unknown>; }

  /**
   * Gets the plan's definitions, each with its value before the match for the robot shown, as text. The list is kept
   * until the plan or the robot changes, because the page redraws the tree view often.
   */
  defs(): (DefRow & { value: string | null })[] {
    const key = `${this.rev}:${this.robot}`; if (this.defsCache?.key === key) return this.defsCache.rows;
    const def = this.def, values = def ? defValues(def, this.host.sim().view(this.robot)) : [];
    const rows = defRows(this.tree, def).map(r => {
      const i = def?.defNames.indexOf(r.name) ?? -1;
      return { ...r, value: i >= 0 ? valueText(values[i]) : null };
    });
    this.defsCache = { key, rows }; return rows;
  }
  private defsCache: { key: string; rows: (DefRow & { value: string | null })[] } | null = null;

  /**
   * Gets the names that an expression in the plan can use, for the panel's expression fields. In a definition, `before`
   * is the definition's name, because a definition can use only the ones before it.
   */
  exprContext(before?: string): ExprContext { return exprContext(AUTO_REGISTRY, 'onboard', this.def, before); }

  /** Gets the value before the MATCH of a definition or a FIELD constant, as text, such as `-0.3237` for `field.hiveX`, or undefined for another name. */
  valueOf(path: string): string | null | undefined {
    const c = /^field\.(\w+)$/.exec(path);
    if (c && c[1] in AUTO_FIELD) return String(AUTO_FIELD[c[1] as keyof typeof AUTO_FIELD]);
    return this.defs().find(d => d.name === path)?.value;
  }

  /** Gets the selected definition, with the steps and definitions that use it, or null. */
  selectedDef(): (DefRow & { value: string | null; users: string[] }) | null {
    const d = this.selectedRef ? this.defs().find(r => r.name === this.selectedRef) : undefined;
    return d ? { ...d, users: defUsers(this.tree, d.name) } : null;
  }

  /** True while the settings panel shows the form that adds a definition. */
  addingDef = false;
  /** Shows the form that adds a definition, in place of the selection. */
  startAddDef() { if (!this.editing) return; this.selected = null; this.point = -1; this.selectedRef = null; this.selectedLink = null; this.addingDef = true; this.paint(); this.host.changed(); }
  cancelAddDef() { this.addingDef = false; this.host.changed(); }

  /** Sets a definition's expression. */
  setDefText(name: string, text: string) {
    if (!this.editing) return;
    const next = setDef(this.tree, name, text); if (next === this.tree || JSON.stringify(next) === JSON.stringify(this.tree)) return;
    this.remember(this.tree); this.apply(next, true);
  }

  /** Adds a definition. Returns a problem to show, or null. */
  addDefinition(name: string, text: string): string | null {
    if (!this.editing) return 'Edit a plan that you made to add definitions.';
    const r = addDef(this.tree, name, text); if ('error' in r) return r.error;
    this.remember(this.tree); this.apply(r.tree, true); this.selectRef(name.trim()); return null;
  }

  private refDrawList() { return this.refs.map(r => ({ ...r.sim, selected: r.name === this.selectedRef })); }

  get canUndo() { return this.editing && this.past.length > 0; }
  get canRedo() { return this.editing && this.future.length > 0; }

  /** Takes back the last edit of the plan being edited, and saves the plan as it was. */
  undo() { const t = this.past.pop(); if (!t || !this.editing) return; this.future.push(this.tree); this.commit(t); }
  /** Makes again the last edit that `undo` took back. */
  redo() { const t = this.future.pop(); if (!t || !this.editing) return; this.past.push(this.tree); this.commit(t); }

  /** Keeps a plan in the undo history, and clears the redo history, because a new edit starts a new branch. At most 200 are kept. */
  private remember(before: Json) { this.past.push(before); if (this.past.length > 200) this.past.shift(); this.future = []; }

  /** Makes `t` the plan, saves it, and redraws: for undo and redo. */
  private commit(t: Json) { addAutoTree(t, true); this.tree = t; this.save(); this.rev++; this.refresh(); this.host.changed(); }

  /** Checks whether any handle of the selected node differs from the plan that this one was copied from. */
  selectedEdited() {
    if (!this.editing) return false;
    if (this.selectedRef) return this.changedRefs.has(this.selectedRef) && typeof (this.original.defs as Json | undefined)?.[this.selectedRef] === 'string';
    return this.handles.some(h => h.path === this.selected && isEdited(this.tree, h, this.original));
  }

  /** Moves the selected step's handles, or the selected reference point, back to where the plan that this one was copied from has them. */
  resetSelected() {
    const was = this.selectedRef ? (this.original.defs as Json | undefined)?.[this.selectedRef] : undefined;
    if (this.selectedRef && this.editing && typeof was === 'string') {
      const t = structuredClone(this.tree); (t.defs as Json)[this.selectedRef] = was; this.remember(this.tree); this.apply(t, true); return;
    }
    if (!this.selected || !this.editing) return; let t = this.tree;
    for (const h of this.handles.filter(q => q.path === this.selected)) t = resetHandle(t, h, this.original);
    if (t !== this.tree) { this.remember(this.tree); this.apply(t, true); }
  }

  /** Describes the selection: a step's pose in red's FIELD coordinates and as written, a reference point, or an offset line. */
  describe(fmtPos: (x: number, y: number) => string): string {
    const hs = this.handles.filter(h => h.path === this.selected);
    if (!this.def) return 'This robot runs no AUTO plan. Pick one in its robot config.';
    if (this.notice) return this.notice;
    const ref = this.refs.find(r => r.name === this.selectedRef);
    if (ref) {
      const users = this.handles.filter(h => h.kind === 'drive' && stepReference(this.tree, h) === ref.name).map(h => h.path.split('/').pop());
      return `Reference point ${ref.name}: ${fmtPos(ref.pose.x, ref.pose.y)}, heading ${wrap(ref.pose.headingDeg).toFixed(1)}° · ${(this.tree.defs as Json)[ref.name]}`
        + (users.length ? ` · used by ${users.join(', ')}${this.editing ? ': a drag moves them all' : ''}` : '')
        + (this.editing ? ` · press Delete, or right-click, to delete it${users.length ? ', and its steps keep their places' : ''}` : '');
    }
    if (this.selectedLink) {
      const h = this.handles.find(q => q.path === this.selectedLink);
      if (h) return `${h.path.split('/').pop()} is ${poseText(this.tree, h)}${this.editing ? ' · press Delete, or right-click, to make it absolute' : ''}`;
    }
    if (!hs.length) return this.selected ? (this.problems.count && this.selectedNode()?.label.startsWith('drive.') ? 'This step\'s pose has a problem, or uses a definition that has one, so it isn\'t on the FIELD.' : 'This step has no pose on the FIELD.') : this.editing ? 'Drag a pose or its heading knob, or click a step in the tree.' : 'Click a pose or a step in the tree.';
    if (hs[0].kind === 'waypoint') return `${hs.length} waypoints${this.editing ? ' · drag one to move it' : ''}`;
    const h = hs[0], deg = wrap(h.pose.headingDeg), def = this.def, shared = sharedWith(this.tree, def, h);
    return `${fmtPos(h.pose.x, h.pose.y)}, heading ${deg.toFixed(1)}° · pose ${poseText(this.tree, h)}`
      + (shared.length && this.editing ? ` · also used by ${shared.join(', ')}: a drag moves this step only` : '')
      + (this.editing && stepReference(this.tree, h) ? ' · right-click it to make it absolute' : '');
  }

  /** The tree that a plan was copied from, or the tree itself. */
  private originalOf(tree: Json): Json { const from = sourceOf(tree); return from && AUTO_SOURCES[from] ? (AUTO_SOURCES[from] as Json) : tree; }

  /** Makes `next` the plan being edited. A drag saves to storage when it ends; other edits save at once. */
  private apply(next: Json, save: boolean) {
    if (!this.editing) return;
    this.notice = null;
    addAutoTree(next, true); this.tree = next;
    this.rev++; this.refresh(); if (save) this.save(); this.host.changed();
  }

  private save() { if (this.isUserPlan) saveUserTree(this.tree); }

  private refresh() {
    const def = this.def; this.handles = def ? editHandles(def, this.host.sim().view(this.robot)) : [];
    this.changed = def && this.isUserPlan ? changedSteps(def, this.tree, this.original) : new Set();
    this.refs = def ? referencePoints(def, this.host.sim().view(this.robot)) : [];
    this.changedRefs = def && this.isUserPlan ? changedDefs(this.tree, this.original) : new Set();
    this.problems = sortProblems(def, typeof this.tree.id === 'string' ? AUTO_PROBLEMS[this.tree.id] ?? [] : []);
    if (this.point >= this.handles.length) this.point = -1;
    this.paint();
  }

  private paint() {
    this.host.view.showHandles(this.handles.map(h => ({ ...h.sim, kind: h.kind, selected: h.path === this.selected, edited: this.isUserPlan && isEdited(this.tree, h, this.original) })), this.editing);
    this.host.view.showRefs(this.refs.map(r => ({ ...r.sim, selected: r.name === this.selectedRef, edited: this.changedRefs.has(r.name), lit: !!this.dwell?.ready && this.dwell.name === r.name })), this.editing);
    this.host.view.showLinks(this.links().map(l => ({ ...l, selected: l.path === this.selectedLink })));
  }
}
