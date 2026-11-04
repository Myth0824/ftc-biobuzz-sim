/**
 * The AUTO editor's panels around the FIELD: the editor bar, the settings inspector, the step settings and step order
 * panels, the new-plan dialog, the reference-point menu, and the see-through robot at the selected pose. The editing
 * itself is in `FieldEditor`. Clicks on the canvas go here too, because the editor takes them first.
 */
import { findNode } from '../auto/auto-edit';
import type { previewAuto } from '../auto/onboard';
import { Inspector } from '../render/inspector';
import type { Sim } from '../sim/world';
import { fmtPos } from '../units';
import { app, openEditor } from './app';
import { $, closeModals, ownKeys, store, stored, toast, toggleModal } from './dom';
import { openConfig } from './robot-config';
import { paintTree, treePanel } from './tree-ui';

type JsonObj = Record<string, unknown>;
let inspector: Inspector;

// ---- Step settings ----
// When a drive step is selected, this panel adds an intake and a turret angle beside it, in a `parallel` that wraps the
// drive, and a shoot step right after it. The shooter can't share the parallel: the drive and the shooter are separate
// subsystems, and a shot from a moving robot misses.
let stepSettingsKey = '';
const DRIVES = ['drive.driveTo', 'drive.followPath'];

/** Finds the children array that holds the node with this id, at any depth. */
function findChildrenContaining(obj: unknown, id: string): JsonObj[] | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const [key, v] of Object.entries(obj as JsonObj)) {
    if (key === 'children' && Array.isArray(v) && v.some((c: JsonObj) => c.id === id)) return v as JsonObj[];
    const r = findChildrenContaining(v, id); if (r) return r;
  }
  return null;
}

/**
 * Finds the selected drive step in `tree`: the array that holds it and its index there, and, when a parallel already
 * wraps it, the parallel's children. Returns null when the selection isn't a drive step.
 */
function resolveStepContext(tree: JsonObj, path: string, node: ReturnType<typeof app.editor.selectedNode>) {
  const id = path.split('/').pop()!, parentChildren = findChildrenContaining(tree, id);
  if (!path || !parentChildren) return null;
  const stepIdx = parentChildren.findIndex(c => c.id === id);
  if (node && DRIVES.includes(node.label)) return { siblings: null, parentChildren, stepIdx };
  const kids = ((findNode(tree, path) as JsonObj | null)?.parallel as JsonObj | undefined)?.children;
  if (node?.label !== 'parallel' || !Array.isArray(kids) || !kids.some((c: JsonObj) => DRIVES.includes(String(c.ref)))) return null;
  return { siblings: kids as JsonObj[], parentChildren, stepIdx };
}

/** Wraps a bare drive step in a `parallel` of policy `any`, which keeps the step's id, and returns its children. */
function wrapInParallel(parentChildren: JsonObj[], stepIdx: number): JsonObj[] {
  const step = parentChildren[stepIdx], children = [{ ...step, id: `${step.id}-drive` }];
  parentChildren[stepIdx] = { id: step.id, parallel: { policy: 'any', children } };
  return children;
}

function paintStepSettings() {
  const { editor } = app, panel = $('stepSettings'), node = editor.selectedNode(), path = editor.selected;
  if (!editor.active || !path) { panel.classList.add('hidden'); stepSettingsKey = ''; return; }
  const key = `${editor.def?.id ?? ''}|${path}|${editor.rev}|${editor.editing}`;
  if (key === stepSettingsKey) return;
  stepSettingsKey = key;
  const ctx = resolveStepContext(editor.cloneTree(), path, node);
  panel.classList.toggle('hidden', !ctx); if (!ctx) return;

  const stepId = path.split('/').pop()!, sibs = ctx.siblings ?? [], next = ctx.parentChildren[ctx.stepIdx + 1];
  const param = (n: JsonObj | null | undefined, k: string) => (n?.params as JsonObj | undefined)?.[k];
  const intake = sibs.find(c => c.ref === 'intake.run'), turret = sibs.find(c => c.ref === 'turret.angle');
  const shoot = next?.id === `${stepId}-shoot` && next.ref === 'shooter.shoot' ? next : null;
  const filter = (param(intake, 'filter') as string) ?? 'pollen', ro = !editor.editing;
  const off = (on: boolean) => (!on || ro ? 'disabled' : '');
  const filters: [string, string][] = [['pollen', 'POLLEN only'], ['own_nectar', 'Own NECTAR only'], ['all', 'All elements'], ['none', 'Off']];

  panel.innerHTML = `<h2>Step ${stepId}</h2>
    ${ro ? '<p class="ss-note">Click <b>Edit</b> in the editor bar to change this step.</p>' : ''}
    <div class="ss-row"><input type="checkbox" id="ss-intake-on" ${intake ? 'checked' : ''} ${ro ? 'disabled' : ''}><label for="ss-intake-on">Intake</label>
      <select id="ss-intake-filter" ${off(!!intake)}>${filters.map(([v, l]) => `<option value="${v}" ${v === filter ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="ss-row"><input type="checkbox" id="ss-turret-on" ${turret ? 'checked' : ''} ${ro ? 'disabled' : ''}><label for="ss-turret-on">Turret</label>
      <input id="ss-turret-deg" type="number" min="-180" max="180" step="5" value="${param(turret, 'degrees') ?? 0}" ${off(!!turret)}><span>°, 90 is left</span></div>
    <div class="ss-row"><input type="checkbox" id="ss-shoot-on" ${shoot ? 'checked' : ''} ${ro ? 'disabled' : ''}><label for="ss-shoot-on">Shoot</label>
      <input id="ss-shoot-count" type="number" min="1" max="4" step="1" value="${param(shoot, 'count') ?? 3}" ${off(!!shoot)}><span>elements,</span>
      <input id="ss-shoot-timeout" type="number" min="0.5" max="10" step="0.5" value="${param(shoot, 'timeoutSec') ?? 3}" ${off(!!shoot)}><span>s at most</span></div>`;
  if (ro) return;

  const checked = (id: string) => $<HTMLInputElement>(id).checked, value = (id: string) => $<HTMLInputElement>(id).value;
  const apply = () => {
    const t = editor.cloneTree(), c = resolveStepContext(t, path, node); if (!c) return;
    const add: JsonObj[] = [
      ...(checked('ss-intake-on') ? [{ ref: 'intake.run', params: { filter: value('ss-intake-filter') } }] : []),
      ...(checked('ss-turret-on') ? [{ ref: 'turret.angle', params: { degrees: Number(value('ss-turret-deg')), timeoutSec: 2 } }] : []),
    ];
    if (c.siblings || add.length) {
      const kids = c.siblings ?? wrapInParallel(c.parentChildren, c.stepIdx);
      for (let k = kids.length - 1; k >= 0; k--) if (['intake.run', 'turret.angle', 'shooter.shoot'].includes(String(kids[k].ref))) kids.splice(k, 1);
      kids.push(...add);
      // A parallel with only the drive left goes back to a bare drive step.
      if (kids.length === 1 && DRIVES.includes(String(kids[0].ref))) c.parentChildren[c.stepIdx] = { ...kids[0], id: stepId };
    }
    if (c.parentChildren[c.stepIdx + 1]?.id === `${stepId}-shoot`) c.parentChildren.splice(c.stepIdx + 1, 1);
    if (checked('ss-shoot-on')) c.parentChildren.splice(c.stepIdx + 1, 0, { id: `${stepId}-shoot`, note: 'Shoots after the drive step above. Added by step settings.', ref: 'shooter.shoot', params: { count: Number(value('ss-shoot-count')), timeoutSec: Number(value('ss-shoot-timeout')) } });
    editor.applyTree(t); stepSettingsKey = '';
  };
  panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(el => { el.onchange = apply; ownKeys(el); });
}

// ---- Step order ----
let stepOrderKey = '';
const SHORT: [string, string][] = [['drive.driveTo', '→ drive to'], ['drive.followPath', '→ follow path'], ['shooter.shoot', '⬤ shoot'], ['intake.run', '◎ intake'], ['wait', '⏱ wait']];
/** Lists the plan's top-level steps, with buttons that move or remove each one. It shows while you edit your own plan. */
function paintStepOrder() {
  const { editor } = app, panel = $('stepOrder');
  if (!editor.active || !editor.editing || !editor.isUserPlan) { panel.classList.add('hidden'); stepOrderKey = ''; return; }
  const key = `${editor.def?.id ?? ''}|${editor.rev}|${editor.selected}`;
  if (key === stepOrderKey) return;
  stepOrderKey = key; panel.classList.remove('hidden');
  const steps = editor.rootSteps();
  if (!steps.length) { panel.innerHTML = '<h3>Steps</h3><p>No steps yet. Right-click a reference point to add a drive step.</p>'; return; }
  panel.innerHTML = `<h3>Steps (${steps.length})</h3>` + steps.map(s => {
    const short = SHORT.reduce((l, [from, to]) => l.replace(from, to), s.label);
    return `<div class="step-row${editor.selected === s.path ? ' sel' : ''}" data-path="${s.path}">
      <span title="${s.id}: ${s.label}">${s.id} <span>${short}</span></span>
      <button data-move="-1" data-idx="${s.index}" title="Move up">↑</button><button data-move="1" data-idx="${s.index}" title="Move down">↓</button><button data-del="${s.index}" class="del" title="Remove step">✕</button>
    </div>`;
  }).join('');
  panel.querySelectorAll<HTMLElement>('.step-row').forEach(row => row.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('button') && row.dataset.path) editor.select(row.dataset.path); }));
  panel.querySelectorAll<HTMLButtonElement>('button[data-move]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const err = editor.moveStepAt(Number(btn.dataset.idx), Number(btn.dataset.move) as -1 | 1); if (err) toast(err); }));
  panel.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const err = editor.removeStepAt(Number(btn.dataset.del)); if (err) toast(err); }));
}

/** Draws the editor bar: the plan's name and status, the selected step's pose, the buttons, and the panels beside the FIELD. */
export function paintEditor() {
  const { editor } = app;
  document.body.classList.toggle('editing', editor.active); $('autoedit').classList.toggle('hidden', !editor.active);
  // The side panels close with the editor. They open again below, when there is a plan to show.
  if (!editor.active) { for (const id of ['aeinsp', 'stepSettings', 'stepOrder']) $(id).classList.add('hidden'); stepSettingsKey = ''; stepOrderKey = ''; return; }
  const def = editor.def, wrong = editor.wrongStart;
  $('aehead').textContent = `${app.bots[editor.robot].plate} · ${def?.name ?? 'No AUTO plan'}`;
  const n = editor.changed.size, r = editor.changedRefs.size, parts = [n ? `${n} step${n === 1 ? '' : 's'}` : '', r ? `${r} definition${r === 1 ? '' : 's'}` : ''].filter(Boolean);
  const changes = parts.length ? ` · ${parts.join(' and ')} changed` : '';
  const bad = editor.problems.count, problems = bad ? ` · ${bad} problem${bad === 1 ? '' : 's'}: it doesn't run` : '';
  const status = $('aestatus'); status.classList.toggle('warn', !!wrong || bad > 0);
  status.textContent = !def ? '' : wrong ? `This plan is for the ${wrong} start position.` : editor.isUserPlan ? `${editor.editing ? 'Your plan · editing' : 'Your plan'}${changes}${problems}` : 'System plan · read-only';
  $('aeinsp').classList.toggle('hidden', !def);
  if (def) inspector.paint({ editing: editor.editing, problems: editor.problems, path: editor.selected, node: editor.selectedNode(), fields: editor.fields(), def: editor.selectedDef(), adding: editor.addingDef, ctx: before => editor.exprContext(before), valueOf: path => editor.valueOf(path) },
    `${def.id}:${editor.robot}|${editor.rev}|${editor.selected}|${editor.editing}|${editor.selectedRef}|${editor.addingDef}`);
  paintStepSettings();
  $<HTMLButtonElement>('aeundo').disabled = !editor.canUndo; $<HTMLButtonElement>('aeredo').disabled = !editor.canRedo;
  // The bar cuts long lines short, so each line's tooltip holds the whole text.
  for (const [id, text] of [['aeframe', 'Red alliance frame: +x toward the blue wall, +y toward the rear wall. Blue robots run this tree rotated 180°.'], ['aesel', editor.describe((x, y) => fmtPos(x, y, app.units))]] as const) { $(id).textContent = text; $(id).title = text; }
  $<HTMLButtonElement>('aereset').disabled = !editor.selectedEdited();
  const edit = $<HTMLButtonElement>('aeedit'); edit.disabled = !editor.isUserPlan || editor.editing;
  edit.title = editor.isUserPlan ? 'Lets you drag the poses of this plan.' : 'System plans are read-only. Create a copy to change it.';
  $<HTMLButtonElement>('aedelete').disabled = !editor.isUserPlan;
  paintStepOrder();
}

/**
 * In the editor, shows a see-through robot at the selected point, and runs another one along the path into the point and
 * out of it. The preview has a pose for each handle, in the same order, and `ends` marks where the path reaches each.
 */
export function paintGhost(me: Sim, plan: ReturnType<typeof previewAuto> | null) {
  const { editor, view } = app, i = editor.point;
  if (!editor.active || !plan || i < 0 || plan.poses.length !== editor.handles.length) { view.showGhost(null, null); return; }
  // Headings turn evenly by distance between two poses, the short way.
  const ramp = (pts: { x: number; z: number }[], h0: number, h1: number) => {
    const d = pts.map((_, k) => (k ? Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z) : 0)), total = d.reduce((a, b) => a + b, 0) || 1, dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    let run = 0; return pts.map((q, k) => { run += d[k]; return { x: q.x, z: q.z, heading: h0 + (dh * run) / total }; });
  };
  const at = plan.poses[i], from = i ? plan.ends[i - 1] : 0, to = plan.ends[i], next = plan.ends[i + 1];
  const into = ramp(plan.path.slice(from, to + 1), i ? plan.poses[i - 1].heading : me.heading, at.heading);
  const out = next === undefined ? [] : ramp(plan.path.slice(to, next + 1), at.heading, plan.poses[i + 1].heading);
  view.showGhost({ x: at.x, z: at.z, heading: at.heading }, me.cfg, into, out);
}

// ---- Canvas clicks and the reference-point menu ----
let refAt: { x: number; y: number } | null = null, menuFor: ReturnType<typeof app.editor.menuAt> = null;

/** In the editor, a right-click on the FIELD floor offers a reference point there; on a reference point it also offers to delete it, and on a step built on one, to make the step absolute. */
function openRefMenu(e: MouseEvent) {
  const { editor, view } = app, q = view.pickFloor(e.clientX, e.clientY); if (!q) return;
  refAt = q; menuFor = editor.menuAt(e.clientX, e.clientY);
  const menu = $('aemenu'); menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`; menu.classList.remove('hidden');
  const add = $<HTMLButtonElement>('aeaddref'), drive = $<HTMLButtonElement>('aedrivetoref'), abs = $<HTMLButtonElement>('aeabs'), del = $<HTMLButtonElement>('aedelref');
  const onStep = !!menuFor && 'step' in menuFor, onRef = !!menuFor && !('step' in menuFor) && 'ref' in menuFor;
  add.disabled = !editor.editing; abs.classList.toggle('hidden', !onStep); del.classList.toggle('hidden', !onRef);
  drive.classList.toggle('hidden', !onRef || !editor.editing);
  if (onRef) { drive.textContent = `Go to reference point ${(menuFor as { ref: string }).ref}`; drive.disabled = !editor.editing; }
  if (menuFor && 'step' in menuFor) { abs.textContent = menuFor.ref ? `Make ${menuFor.id} absolute (stop following ${menuFor.ref})` : `${menuFor.id} is already absolute`; abs.disabled = !editor.editing || !menuFor.ref; }
  if (menuFor && !('step' in menuFor)) { del.textContent = `Delete reference point ${menuFor.ref}`; del.disabled = !editor.editing; }
  for (const b of [add, drive, abs, del]) b.title = editor.editing ? '' : 'Edit a plan that you made to change it.';
  // Keep the menu in the window: near the right or bottom edge it opens to the left of or above the pointer. The bottom
  // edge is the editor bar, so that the menu never hides behind it or the status bar.
  const floor = $('autoedit').getBoundingClientRect().top, box = menu.getBoundingClientRect();
  if (box.right > innerWidth - 4) menu.style.left = `${Math.max(4, e.clientX - box.width)}px`;
  if (box.bottom > floor - 4) menu.style.top = `${Math.max(4, e.clientY - box.height)}px`;
}

function initCanvas() {
  const { canvas, editor, view, review } = app;
  // A click on the FIELD floor shows the position in a toast, in the coordinate system that the floor labels show. In
  // the review, a click on a robot adds a note instead.
  canvas.addEventListener('click', e => {
    if (editor.takeClick() || view.dragged) return;
    // In the editor, a click on the other red robot shows that robot's plan. Only a click on the robot itself counts: in
    // the overhead view a robot is a large target, and its path passes near it.
    if (editor.active) { const other = 1 - editor.robot; if (view.pickRobot(e.clientX, e.clientY, 0) === other) { editor.showRobot(other); return; } }
    if (review.active && view.pickRobot(e.clientX, e.clientY) !== null) return;
    const q = view.pickFloor(e.clientX, e.clientY); if (q) toast(`Field position: ${fmtPos(q.x, q.y, app.units)}`);
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (editor.active) { openRefMenu(e); return; }
    const i = view.pickRobot(e.clientX, e.clientY); if (i !== null) openConfig(i);
  });
  const hideMenu = () => $('aemenu').classList.add('hidden');
  addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest?.('#aemenu')) hideMenu(); }, true);
  $('aeaddref').onclick = () => { hideMenu(); $<HTMLInputElement>('aerefinput').value = ''; $('aereferr').textContent = ''; $('aerefname').classList.remove('hidden'); $('aerefinput').focus(); };
  $('aeabs').onclick = () => { hideMenu(); if (menuFor && 'step' in menuFor) editor.makeStepAbsolute(menuFor.step); };
  $('aedelref').onclick = () => { hideMenu(); if (menuFor && !('step' in menuFor)) editor.deleteRef(menuFor.ref); };
  $('aedrivetoref').onclick = () => { hideMenu(); if (menuFor && !('step' in menuFor)) { const err = editor.addDriveToRef(menuFor.ref); if (err) toast(err); } };
  $('aerefcancel').onclick = () => $('aerefname').classList.add('hidden');
  $('aerefadd').onclick = () => { if (!refAt) return; const err = editor.addReferenceAt($<HTMLInputElement>('aerefinput').value, refAt); $('aereferr').textContent = err ?? ''; if (!err) $('aerefname').classList.add('hidden'); };
  ownKeys($('aerefinput'), () => $('aerefadd').click());
}

// ---- The new-plan dialog ----
function initNewPlan() {
  const { editor } = app, d = { mode: $<HTMLSelectElement>('aemode'), fromRow: $('aefromrow'), from: $<HTMLSelectElement>('aefrom'), name: $<HTMLInputElement>('aename'), desc: $<HTMLTextAreaElement>('aedesc') };
  for (const el of [d.from, d.name, d.desc]) ownKeys(el);
  const close = () => $('aenew').classList.add('hidden');
  d.mode.onchange = () => { d.fromRow.classList.toggle('hidden', d.mode.value === 'blank'); };
  // It asks for the plan to copy, or a blank plan, a name, and a description, and the editor checks them.
  $('aecreate').onclick = () => {
    const current = editor.def?.id ?? '', esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    d.from.innerHTML = editor.sources().map(s => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    d.mode.value = 'copy'; d.fromRow.classList.remove('hidden'); d.name.value = ''; d.desc.value = ''; $('aeerr').textContent = ''; $('aenew').classList.remove('hidden'); d.name.focus();
  };
  $('aecancel').onclick = close;
  $('aemake').onclick = () => {
    const err = d.mode.value === 'blank' ? editor.createBlank(d.name.value, d.desc.value) : editor.create(d.from.value, d.name.value, d.desc.value);
    $('aeerr').textContent = err ?? ''; if (!err) close();
  };
  $('aedone').onclick = () => { close(); editor.close(); };
}

export function initEditorUi() {
  const { editor } = app;
  initCanvas(); initNewPlan();
  $('editauto').onclick = () => { $('editauto').blur(); closeModals(); if (editor.active) editor.close(); else openEditor(app.treeRobot === 1 ? 1 : 0); };
  $('aeundo').onclick = () => editor.undo(); $('aeredo').onclick = () => editor.redo();
  $('aereset').onclick = () => editor.resetSelected(); $('aeedit').onclick = () => editor.edit();
  $('aedelete').onclick = () => { const d = editor.def; if (d && confirm(`Delete the plan "${d.name}"? This browser keeps no other copy of it.`)) editor.deletePlan(); };
  // The help opens over the editor, at the editor's section.
  $('aehelp').onclick = () => { toggleModal('helpbox'); setTimeout(() => $('helpbox').querySelector('#help-autoedit')?.scrollIntoView({ behavior: 'smooth' }), 80); };
  // The snap checkbox is a convenience that this browser keeps. The reference point under the pointer shows its name.
  const snap = $<HTMLInputElement>('aesnap'); snap.checked = stored('biobuzz.snap') === 'on'; editor.snapGrid = snap.checked;
  snap.onchange = () => { editor.snapGrid = snap.checked; store('biobuzz.snap', snap.checked ? 'on' : 'off'); snap.blur(); };
  editor.hoverRef = (ref, x, y) => { const tip = $('aehover'); tip.classList.toggle('hidden', !ref); if (ref) { tip.textContent = ref.name; tip.style.left = `${x + 12}px`; tip.style.top = `${y + 10}px`; } };
  // Undo and redo keys, and Delete for a selected offset line or reference point, while you edit a plan. They leave text
  // fields to the browser, and CodeMirror's expression fields, which are contenteditable, to CodeMirror.
  addEventListener('keydown', e => {
    if (!editor.active || !editor.editing || (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedLink) { e.preventDefault(); editor.deleteLink(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedRef) { e.preventDefault(); editor.deleteRef(); return; }
    const z = e.key === 'z' || e.key === 'Z';
    if ((e.metaKey || e.ctrlKey) && z) { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
    else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); editor.redo(); }
  }, true);
  // A click on a step in the tree view selects it, and its handles on the FIELD light up. The definitions and constants
  // at the root are groups that open and close. A click on a definition selects it.
  $('treebody').addEventListener('click', e => {
    if (!editor.active) return; const t = e.target as HTMLElement;
    const grp = t.closest<HTMLElement>('.tv[data-grp]'); if (grp) { const k = grp.dataset.grp as 'defs' | 'constants'; treePanel.open[k] = !treePanel.open[k]; paintTree(); return; }
    const d = t.closest<HTMLElement>('.tv[data-def]'); if (d) { editor.selectRef(d.dataset.def!); return; }
    if (t.closest('.tv[data-adddef]')) { editor.startAddDef(); return; }
    const row = t.closest<HTMLElement>('.tv[data-path]'); if (row) editor.select(row.dataset.path!);
  });
  // The settings panel: the plan's problems, the selected step's parameters, and the definitions.
  inspector = new Inspector($('aeinsp'), {
    setParam: (path, key, text) => editor.setParamText(path, key, text),
    setDef: (name, text) => editor.setDefText(name, text),
    addDef: (name, text) => editor.addDefinition(name, text),
    cancelAdd: () => editor.cancelAddDef(),
    deleteDef: name => editor.deleteRef(name),
    selectNode: path => editor.select(path),
    selectDef: name => editor.selectRef(name),
  });
}
