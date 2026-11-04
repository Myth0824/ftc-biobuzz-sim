/**
 * The tree view: one robot's behavior tree, live during a MATCH and at the cursor in the review. In the AUTO editor it
 * shows the plan being edited, and the camera keeps the FIELD clear of it.
 */
import { TELEOP_TREES } from '../auto/driver';
import { AUTO_TREES } from '../auto/onboard';
import { LiveTreeState, TreePanel, treeStateAt } from '../render/tree-view';
import { app, focus } from './app';
import { $ } from './dom';
import { sel } from './settings';

export const treePanel = new TreePanel($('treebody'), $('treehead'));
const liveTrees = [0, 1, 2, 3].map(() => new LiveTreeState());
// The robot buttons are rebuilt only when the robots or the choice change: a button that is replaced between the press
// and the release of a click never receives the click.
let botsKey = '';

/** Draws the tree view for the chosen robot: live during a MATCH, and at the cursor in the review. */
export function paintTree() {
  const { editor, bots } = app, el = $('tree'), on = sel.treeview.value === 'on' || editor.active; el.classList.toggle('hidden', !on);
  // The camera keeps the FIELD centered in the strip between the side panels. Outside the editor only the score table
  // shows, and the match view keeps its framing, so the insets are zero there.
  if (!editor.active) { app.view.insetLeft = 0; app.view.insetRight = 0; }
  if (!on) return;
  const i = app.treeRobot >= 0 ? app.treeRobot : focus(), plate = bots[i].plate;
  // In the editor the buttons are the two red robots, in the order that the drivers see them on the FIELD: R1 starts on
  // the left, and R0 on the right.
  const order = editor.active ? [1, 0] : [0, 1, 2, 3], picked = editor.active ? editor.robot : i;
  const key = `${editor.active ? 'edit' : 'view'}:${picked}:${bots.map(b => b.plate).join(',')}`;
  if (key !== botsKey) { botsKey = key; $('treebots').innerHTML = order.map(k => `<button data-k="${k}" class="${k < 2 ? 'red' : 'blue'}${k === picked ? ' on' : ''}">${bots[k].plate}</button>`).join(''); }
  // The panel fills the space under the control bar and the score, down to the editor bar or the bottom edge.
  el.style.top = `${$('dock').getBoundingClientRect().bottom + 8}px`; el.style.bottom = editor.active ? `${innerHeight - $('autoedit').getBoundingClientRect().top + 8}px` : '12px';
  if (editor.active) {
    // Every camera view keeps the FIELD clear of these panels: the tree view and the score on the left, and the
    // inspector on the right when it shows.
    app.view.insetLeft = Math.max(el.getBoundingClientRect().right, $('left').getBoundingClientRect().right) + 8;
    const insp = $('aeinsp'); app.view.insetRight = insp.classList.contains('hidden') ? 0 : innerWidth - insp.getBoundingClientRect().left + 8;
    treePanel.paint(`${bots[editor.robot].plate} · AUTO plan`, editor.def, { running: new Set(), last: new Map() }, 'This robot runs no AUTO plan.', editor.treeEdit());
    return;
  }
  const cur = app.review.cursor;
  if (cur) {
    const at = treeStateAt(cur.trace, cur.index, i), def = at ? AUTO_TREES[at.tree] ?? TELEOP_TREES[at.tree] ?? null : null;
    treePanel.paint(`${plate} · ${def?.name ?? 'Tree'} · at the cursor`, def, at?.state ?? null, at ? `This trace names the tree ${at.tree}, which this version doesn't have.` : 'No tree ran at this moment, or the trace predates tree recording.');
    return;
  }
  if (bots[i].driver !== 'planner' && (app.sim.phase === 'teleop' || app.sim.phase === 'post')) { treePanel.paint(`${plate} · Tree`, null, null, 'A person drives this robot in TELEOP.'); return; }
  const t = app.coaches[i]?.currentTree();
  if (!t) { treePanel.paint(`${plate} · Tree`, null, null, 'The tree starts with the MATCH.'); return; }
  treePanel.paint(`${plate} · ${t.period === 'auto' ? 'AUTO' : 'TELEOP'} · ${t.def.name}`, t.def, liveTrees[i].read(t.recorder));
}

export function initTreeView() {
  // In the AUTO editor, the buttons pick which red robot's plan the editor shows.
  $('treebots').onclick = e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-k]'); if (!btn) return;
    if (app.editor.active) app.editor.showRobot(Number(btn.dataset.k)); else { app.treeRobot = Number(btn.dataset.k); paintTree(); }
  };
  // The tree view sits under the dock, so it moves when the dock changes size: when the score table fills on the first
  // frame, or when the score opens or closes.
  new ResizeObserver(() => paintTree()).observe($('dock'));
}
