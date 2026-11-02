import { describe, expect, it } from 'vitest';
import { AUTO_REGISTRY, AUTO_TREES } from '../src/auto/onboard';
import { checkExpr, completeAt, exprContext, t } from '../src/bt';

const def = AUTO_TREES['wall-sweep-pair-right'];
const labels = (src: string, pos = src.length, ctx = exprContext(AUTO_REGISTRY, 'onboard', def)) => completeAt(src, pos, ctx)?.options.map(o => o.label) ?? null;

describe('checking one expression', () => {
  it('checks an expression as the loader does, with its type and the position of a problem', () => {
    const ctx = exprContext(AUTO_REGISTRY, 'onboard', def);
    expect(checkExpr('len * 10 + bots.me.dimensions.length', ctx, t.number())).toEqual({ type: expect.objectContaining({ kind: 'number' }) });
    expect(checkExpr('offset(ownFlower, 0.2, 0)', ctx)).toEqual({ type: expect.objectContaining({ kind: 'object' }) });
    expect(checkExpr('wallStand * nope', ctx)).toEqual({ message: "unknown name 'nope'", pos: 12 });
    expect(checkExpr('bots.me.transfer.full', ctx, t.number())).toEqual({ message: expect.stringMatching(/number/), pos: expect.any(Number) });
  });
  it('gives a definition only the definitions before it, and says so for a later one', () => {
    const ctx = exprContext(AUTO_REGISTRY, 'onboard', def, 'stand');
    expect(ctx.defs.map(d => d.name)).toEqual(['full', 'len', 'flip']);
    expect(checkExpr('len / 2', ctx)).toEqual({ type: expect.objectContaining({ kind: 'number' }) });
    expect(checkExpr('park.x', ctx)).toEqual({ message: "'park' is defined later, and a definition can use only the ones before it", pos: 0 });
  });
});

describe('completion', () => {
  it('offers the top-level names, the definitions, the functions, and the words', () => {
    const top = labels('len + ')!;
    expect(top).toEqual(expect.arrayContaining(['bots', 'clock', 'field', 'launchAudience', 'pose', 'offset', 'min', 'and', 'not']));
    expect(completeAt('len + fl', 8, exprContext(AUTO_REGISTRY, 'onboard', def))!.from).toBe(6);
  });
  it('offers the fields of a path after a dot, including a pose definition and the FIELD constants', () => {
    expect(labels('bots.me.')).toEqual(['dimensions', 'slot', 'drive', 'transfer', 'shooter', 'turret', 'vision']);
    expect(labels('bots.me.dimensions.le')).toEqual(['length', 'width']);
    expect(labels('park.')).toEqual(['x', 'y', 'headingDeg']);
    expect(labels('field.')).toEqual(expect.arrayContaining(['half', 'flowerHalfSize', 'hiveX', 'flowerNear', 'flowerFar']));
  });
  it('offers nothing inside a string, inside a number, or after a value that has no fields', () => {
    expect(labels("bots.me.vision.seesRaised('re")).toBeNull();
    expect(labels('1.5')).toBeNull();
    expect(labels('len.')).toBeNull();
  });
});
