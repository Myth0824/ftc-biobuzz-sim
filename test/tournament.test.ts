import { describe, expect, it } from 'vitest';
import { ROUNDS, TIERS, advance, isChampion, isOver, newBracket, opponent, record } from '../src/tournament';
import { robotConfig } from '../src/setup';

describe('tournament bracket', () => {
  it('advances on a win, replays a tie, and ends on a loss', () => {
    const b = newBracket();
    expect(record(b, 10, 10)).toBeNull(); advance(b); expect(b.round).toBe(0);
    expect(record(b, 20, 10)).toBe('won'); advance(b); expect(b.round).toBe(1);
    expect(record(b, 5, 30)).toBe('lost'); expect(isOver(b)).toBe(true); expect(isChampion(b)).toBe(false);
  });

  it('crowns a champion after every round is won', () => {
    const b = newBracket();
    for (let k = 0; k < ROUNDS.length; k++) { record(b, 2, 1); advance(b); }
    expect(isChampion(b)).toBe(true); expect(b.round).toBe(ROUNDS.length - 1);
  });

  it('gets harder each round: the launcher error never grows and the last round is the tightest', () => {
    const b = newBracket(), spread = TIERS.map((_, k) => { b.round = k; return robotConfig(opponent(b, 2)).shooter.pollen.yawStdDeg; });
    expect(spread).toEqual([...spread].sort((x, y) => y - x));
    expect(spread[0]).toBeGreaterThan(spread[spread.length - 1]);
  });
});
