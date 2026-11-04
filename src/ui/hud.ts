/**
 * What the page shows about the MATCH: the scoreboard, the score table, the results card, the match card before the
 * MATCH, the driver's HUD, the status bar, and the tournament bracket. `hud` redraws them a few times a second.
 */
import type { Frame } from '../input';
import { clockText } from '../review';
import { RP } from '../sim/config';
import type { AllianceScore, Sim } from '../sim/world';
import { ROUNDS, TIERS, advance, bracketHtml, isChampion, isOver, newBracket, saveBracket, type Bracket } from '../tournament';
import { app, focus, openReview, startMatch, stopMatch } from './app';
import { $, fmt } from './dom';
import { sel } from './settings';
import { paintTransport } from './transport';
import { paintTree } from './tree-ui';

type ScoreKey = Exclude<keyof AllianceScore, 'rp' | 'total'>;
const ROWS: [string, ScoreKey][] = [['LEAVE', 'leave'], ['AUTO PARK', 'autoPark'], ['AUTO TIPS', 'autoTips'], ['TELEOP TIPS', 'teleopTips'], ['In CELL', 'cell'], ['FLOWERS', 'flower'], ['Bottom NECTAR', 'bottomNectar'], ['GARDEN', 'garden'], ['PARK', 'park'], ['Opponent FOULS', 'fouls']];
const RP_ROWS: [string, keyof AllianceScore['rp']][] = [['SWARM RP', 'swarm'], ['POLLINATOR 1 RP', 'pollinator1'], ['POLLINATOR 2 RP', 'pollinator2']];

/** Builds the rows of an FTC-style score table: red at one side, the category in the middle, blue at the other side. A trace without a breakdown shows dashes. */
function scoreRows(r: AllianceScore | null, b: AllianceScore | null, totals: { red: number; blue: number }, final: boolean) {
  const row = (cls: string, n: string, x: string | number, y: string | number) => `<tr class="${cls}"><td class="r">${x}</td><td>${n}</td><td class="b">${y}</td></tr>`;
  let html = row('head', '', 'RED', 'BLUE') + ROWS.map(([n, k]) => row('', n, r?.[k] ?? '–', b?.[k] ?? '–')).join('') + row('total', 'TOTAL', totals.red, totals.blue);
  if (r && b && !app.sim.options.playoff) {
    html += RP_ROWS.map(([n, k], i) => row(i ? 'rprow' : 'rprow sep', n, r.rp[k] ? '+1' : '', b.rp[k] ? '+1' : '')).join('');
    if (final) {
      const result = (mine: number, theirs: number) => (mine > theirs ? RP.win : mine === theirs ? RP.tie : 0), bonus = (q: AllianceScore) => RP_ROWS.filter(([, k]) => q.rp[k]).length;
      const wr = result(r.total, b.total), wb = result(b.total, r.total), label = r.total === b.total ? 'TIE RP' : 'WIN RP';
      html += row('rprow', label, wr ? `+${wr}` : '', wb ? `+${wb}` : '') + row('total', 'RANKING POINTS', wr + bonus(r), wb + bonus(b));
    }
  }
  return html;
}

// ---- Tournament ----
/** Starts a tournament from the first round, or leaves the one in progress. */
export function setBracket(b: Bracket | null) { app.bracket = b; saveBracket(b); paintBracket(); stopMatch(); }
export function paintBracket() {
  const b = app.bracket;
  $('tourstart').textContent = b ? 'Leave tournament' : 'Start tournament';
  $('tourbox').innerHTML = b ? bracketHtml(b) : '';
  // A tournament plays full playoff MATCHES against a full field, so those settings step aside.
  for (const el of [sel.mode, sel.opponents, sel.stage]) el.closest('label')!.classList.toggle('hidden', !!b);
}
/** The bracket and the next step, on the results card of a tournament MATCH. */
function tournamentCard(b: Bracket): string {
  const res = b.results[b.round], round = ROUNDS[b.round];
  const [msg, next] = isChampion(b) ? ['Tournament champions!', 'New tournament']
    : res === 'lost' ? [`Eliminated in the ${round}.`, 'New tournament']
    : res === 'won' ? [`You won the ${round}.`, `Next: ${ROUNDS[b.round + 1]}`]
    : [`A tie replays the ${round}.`, `Replay the ${round}`];
  return `<div class="tourmsg">${msg}</div>${bracketHtml(b)}<div class="btns"><button id="fnext" class="primary">${next}</button></div>`;
}
function nextRound() {
  const b = app.bracket; if (!b) return;
  if (isOver(b)) setBracket(newBracket()); else { advance(b); saveBracket(b); paintBracket(); stopMatch(); }
}

/**
 * The driver's HUD at the bottom edge, in TELEOP: what the robot carries, in launch order, and whether the shot preview
 * enters the CELL. It shows only for a robot with a human driver.
 */
function paintDriverHud() {
  const fi = focus(), me = app.sim.view(fi), hud = $('drivehud');
  const show = !app.review.active && app.bots[fi].driver !== 'planner' && (app.sim.phase === 'teleop' || app.sim.phase === 'transition');
  hud.classList.toggle('hidden', !show); if (!show) return;
  const slots = Array.from({ length: me.cfg.capacity }, (_, k) => me.carried[k]).map(k => `<i class="${k ? (k === 'pollen' ? 'pollen' : k === 'nectar_red' ? 'nred' : 'nblue') : ''}"></i>`).join('');
  const on = app.view.onTarget, aim = on === null ? '' : `<span class="aim${on ? ' on' : ''}">${on ? 'On target' : 'Off target'}</span>`;
  const html = `<span class="slots">${slots}</span>${aim}`;
  if (hud.dataset.html !== html) { hud.dataset.html = html; hud.innerHTML = html; }
}

/** Draws the results card at the end of the MATCH: the final score, the breakdown, the ranking points, and in a tournament the bracket. */
function paintFinal(r: AllianceScore | null, b: AllianceScore | null, totals: { red: number; blue: number }) {
  const final = $('final'), show = !app.review.frame && app.sim.phase === 'post' && !app.finalClosed, t = app.bracket;
  final.classList.toggle('hidden', !show); $('left').classList.toggle('hidden', show || !app.scoreOpen);
  const key = `${r?.total}-${b?.total}-${t ? t.round + t.results.join() : ''}`;
  if (!show || !r || !b || final.dataset.key === key) return;
  const winner = r.total > b.total ? 'red' : b.total > r.total ? 'blue' : 'tie';
  final.dataset.key = key;
  final.innerHTML = `<div class="win ${winner}">${winner === 'tie' ? 'TIE' : `${winner.toUpperCase()} WINS`}</div><div class="big"><div class="red">${r.total}</div><div class="blue">${b.total}</div></div>` +
    `<div class="body">${t ? tournamentCard(t) : ''}<table class="ftc">${scoreRows(r, b, totals, true)}</table><div class="btns"><button id="freview"${t ? '' : ' class="primary"'}>Review and annotate (V)</button><button id="fclose">Close</button></div><div class="hint">Press R to reset the field.</div></div>`;
  $('freview').onclick = openReview; $('fclose').onclick = () => { app.finalClosed = true; };
  $('fnext')?.addEventListener('click', nextRound);
}

/** Draws the status bar: which controller is connected, and who each input drives. */
function paintStatus(pad: Frame['pad']) {
  const { bots } = app, padWho = bots.find(q => q.driver === 'pad1'), kb = bots.find(q => q.driver === 'keyboard') ?? (pad ? undefined : padWho);
  $('pad').textContent = `Controller: ${pad ? pad.id.slice(0, 28) : 'not connected'}${padWho ? `, drives ${padWho.plate}` : ''}`;
  const item = (on: boolean, label: string, who?: string) => `<span class="sb-item${on ? ' on' : ''}"><i></i>${label}${who ? ` <span>drives ${who}</span>` : ''}</span>`;
  const status = item(!!pad, pad ? pad.id.slice(0, 28) : 'No controller', pad ? padWho?.plate : undefined) + item(!!kb, 'Keyboard', kb?.plate);
  const bar = $('statusbar'); if (bar.dataset.html !== status) { bar.dataset.html = status; bar.innerHTML = status; }
}

/** Draws the match card in the middle of the FIELD: loading, the countdown, the start of a MATCH, or the transition. */
function paintBanner() {
  const { sim, bots } = app, t = app.bracket, banner = $('banner');
  const humans = bots.filter(q => q.driver !== 'planner').map(q => q.plate), who = humans.length ? `${humans.join(' and ')}, you have the controls. The planner drives the other robots.` : 'The planner drives every robot.';
  const play = '<button class="primary" data-play>Start the MATCH</button><kbd>Enter</kbd>';
  const text = app.loadMsg ?? (app.startAt ? '<b>3, 2, 1…</b>'
    : sim.phase === 'pre' && t ? `<span class="eyebrow">${ROUNDS[t.round]} · ${TIERS[t.round].name}</span><b>32294 vs ${t.plates[t.round].join(' & ')}</b><small>Blue: ${TIERS[t.round].blurb}.</small><div class="go">${play}</div>`
    : sim.phase === 'pre' ? `<b>Ready</b><small>Right-click a robot or use a gear to set it up.${sel.autopaths.value === 'on' ? ` The dashed orange line is ${bots[focus()].plate}'s AUTO plan.` : ''}</small><div class="go">${play}</div>`
    : sim.phase === 'transition' ? `<b>Pick up your controllers</b><small>${who}</small>`
    : null);
  banner.classList.toggle('hidden', !text || app.editing >= 0 || app.editor.active);
  // The banner is rebuilt only when its text changes: a button replaced between a press and its release gets no click.
  if (text && banner.dataset.text !== text) { banner.dataset.text = text; banner.innerHTML = text; }
}

export function hud(pad: Frame['pad']) {
  const { sim, review } = app;
  paintTree();
  // In the review, the scoreboard, the clock, and the score table show the trace frame at the cursor.
  const f = review.frame, r = f ? f.scores?.red ?? null : sim.score('red'), b = f ? f.scores?.blue ?? null : sim.score('blue');
  const totals = f ? f.score : { red: r!.total, blue: b!.total }, phase = (f ? f.phase : sim.phase) as Sim['phase'], clock = f ? f.clock : sim.timer;
  $('sred').textContent = String(totals.red); $('sblue').textContent = String(totals.blue);
  const clockStr = f ? clockText(clock) : fmt(clock); $('clock').textContent = clockStr;
  app.view.board(totals.red, totals.blue, clockStr, phase === 'pre' ? 'Press A to start' : phase === 'post' ? 'Final · A resets' : phase);
  const flowersOpen = f ? phase === 'teleop' && clock <= 60 : sim.flowersUnlocked;
  $('phase').textContent = { pre: 'Ready', auto: 'AUTO', transition: 'Transition', teleop: sim.mode === 'practice' ? 'Practice' : flowersOpen ? 'TELEOP · FLOWERS open' : 'TELEOP', post: 'Final' }[phase];
  document.body.classList.toggle('playing', !f && (sim.phase === 'auto' || sim.phase === 'transition' || sim.phase === 'teleop' || app.startAt > 0));
  document.body.classList.toggle('paused', app.livePaused);
  $('scoretable').innerHTML = scoreRows(r, b, totals, phase === 'post');
  paintFinal(r, b, totals); paintStatus(pad); paintDriverHud(); paintBanner();
  // The scoreboard moves right when, centered, it would reach the control bar.
  document.body.classList.toggle('narrow', innerWidth / 2 - $('top').offsetWidth / 2 < $('dock').getBoundingClientRect().right + 12);
  paintTransport();
}

export function initHud() {
  $('banner').addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-play]')) startMatch(); });
  $('tourstart').onclick = () => { $('tourstart').blur(); setBracket(app.bracket ? null : newBracket()); };
  paintBracket();
}
