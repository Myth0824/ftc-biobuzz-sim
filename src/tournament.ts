/**
 * A single-elimination playoff bracket against the planner. Your alliance is red. Each round's blue alliance is a level
 * harder than the last, by its robots' build, launcher error, intake success, and defense. A win advances, a loss ends
 * the run, and a tie replays the round, as in FTC playoffs. The browser keeps the bracket, as a convenience.
 */
import { REF_ERR, defaultBot, metaBot, type BotSetup } from './setup';

export const ROUNDS = ['Round of 16', 'Quarterfinal', 'Semifinal', 'Final'] as const;

const err = (k: number) => ({ errElevDeg: REF_ERR.errElevDeg * k, errAzimDeg: REF_ERR.errAzimDeg * k, errSpeed: REF_ERR.errSpeed * k });

/** The opponents' level in each round, in `ROUNDS` order. `setup` builds blue robot `i`, 2 or 3. */
export const TIERS: { name: string; blurb: string; setup: (i: number) => BotSetup }[] = [
  { name: 'Rookie', blurb: 'baseline robots on 312 rpm, 4x launcher error, 70% intake, LEAVE and PARK in AUTO',
    setup: i => ({ ...defaultBot(i), driveRpm: 312, ...err(4), intakeP: 0.7, auto: 'leave-and-park' }) },
  { name: 'Regular', blurb: 'baseline robots, 2x launcher error, 85% intake',
    setup: i => ({ ...defaultBot(i), ...err(2), intakeP: 0.85 }) },
  { name: 'Veteran', blurb: 'the meta build with the reference launcher, FLOWERS from 45 s',
    setup: i => ({ ...metaBot(i), flowerStartSec: 45 }) },
  { name: 'World class', blurb: 'the meta build on a turret, half the launcher error, opportunistic defense',
    setup: i => ({ ...metaBot(i), turret: true, ...err(0.5), intakeP: 1, flowerStartSec: 45, defense: 'opportunistic' }) },
];

export type Result = 'won' | 'lost';
export interface Bracket {
  /** The index in `ROUNDS` of the round being played, or of the last one when the run is over. */ round: number;
  results: Result[];
  /** The blue alliance's number plates, by round. */ plates: [string, string][];
}

const KEY = 'biobuzz.tournament.v1';
const plate = () => String(1000 + Math.floor(Math.random() * 29000));

export function newBracket(): Bracket { return { round: 0, results: [], plates: ROUNDS.map(() => [plate(), plate()]) }; }
/** Loads the saved bracket. A round won before the page closed moves on to the next one. */
export function loadBracket(): Bracket | null {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!b || !Array.isArray(b.results) || !Array.isArray(b.plates)) return null;
    advance(b); return b;
  } catch { return null; }
}
export function saveBracket(b: Bracket | null) { try { if (b) localStorage.setItem(KEY, JSON.stringify(b)); else localStorage.removeItem(KEY); } catch { /* Storage is a convenience. */ } }

export const isOver = (b: Bracket) => b.results.includes('lost') || b.results.length === ROUNDS.length;
export const isChampion = (b: Bracket) => b.results.length === ROUNDS.length && b.results.every(r => r === 'won');

/** Gets blue robot `i`'s setup for the bracket's round. */
export function opponent(b: Bracket, i: number): BotSetup { return { ...TIERS[b.round].setup(i), plate: b.plates[b.round][i - 2] }; }

/** Records a finished MATCH. Returns the result, or null for a tie, which replays the round. */
export function record(b: Bracket, red: number, blue: number): Result | null {
  if (red === blue) return null;
  const r: Result = red > blue ? 'won' : 'lost'; b.results[b.round] = r; return r;
}

/** Moves on to the next round after a win. */
export function advance(b: Bracket) { if (b.results[b.round] === 'won' && b.round < ROUNDS.length - 1) b.round++; }

/** Draws the bracket as one row of rounds: each round's level, its opponents, and its result. */
export function bracketHtml(b: Bracket): string {
  return `<div class="bracket">${ROUNDS.map((name, k) => {
    const r = b.results[k], now = !r && k === b.round && !isOver(b);
    return `<div class="rnd ${r ?? (now ? 'now' : '')}"><b>${name}</b><span>${TIERS[k].name}</span><span>${b.plates[k].join(' & ')}</span><span>${r === 'won' ? 'Won' : r === 'lost' ? 'Lost' : now ? 'Up next' : ''}</span></div>`;
  }).join('')}</div>`;
}
