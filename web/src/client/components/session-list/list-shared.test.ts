import { describe, expect, it } from 'vitest';
import { ownColumnCount } from './list-shared';

describe('ownColumnCount', () => {
  // 2026-11-11: the group spans were counted for the auto-fill grid in styles that lay the
  // list out on one column of their own (Cosmos), adding columns the grid does not have.
  it('counts the columns a style sets itself', () => {
    expect(ownColumnCount('minmax(0, 1fr)')).toBe(1);
    expect(ownColumnCount('1fr 1fr')).toBe(2);
    expect(ownColumnCount('minmax(0, 1fr) minmax(0, 2fr) 200px')).toBe(3);
    expect(ownColumnCount('repeat(3, minmax(0, 1fr))')).toBe(3);
    expect(ownColumnCount('repeat(2, 100px 1fr)')).toBe(4);
  });

  it('does not guess what depends on the width', () => {
    expect(ownColumnCount('repeat(auto-fill, minmax(min(100%, 336px), 1fr))')).toBeNull();
    expect(ownColumnCount('repeat(auto-fit, minmax(140px, 1fr))')).toBeNull();
    expect(ownColumnCount('')).toBeNull();
  });
});
