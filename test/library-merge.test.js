import { describe, expect, it } from 'bun:test';

// web/src/store.js reads prefs from localStorage when it is imported.
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
const { mergeLibraries } = await import('../web/src/account.js');

describe('library merge: favorites moved to the top', () => {
  it("puts the account's order first, and only a favorite can be on top", () => {
    const merged = mergeLibraries(
      { favorites: { p: ['a', 'b', 'c'] }, pins: { p: ['c', 'gone'] } },
      { favorites: { p: ['b', 'd'] }, pins: { p: ['d', 'b'] } },
    );
    expect(merged.favorites.p).toEqual(['b', 'd', 'a', 'c']);
    expect(merged.pins.p).toEqual(['d', 'b', 'c']);
  });
  it('merges a library saved before there was a top of the list', () => {
    expect(mergeLibraries({ favorites: { p: ['a'] } }, { favorites: {} }).pins).toEqual({});
    expect(mergeLibraries({ favorites: { p: ['a'] }, pins: { p: ['a'] } }, {}).pins).toEqual({ p: ['a'] });
  });
});
