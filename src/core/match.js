// One way to filter, everywhere: Live TV, the guide, Movies & Shows, the CLI,
// the TUI and MCP. Every word typed must be somewhere in the text, in any
// order, ignoring case, accents and punctuation. "espn us" finds "US| ESPN HD".
//
// On a TV the filter is often the only way to a channel (Silk on a Fire TV
// cannot scroll the lists with its pointer), so a near miss is not good enough:
// a word also matches across a missing space ("sports1" finds "Sports 1",
// "bbc one" finds "BBCOne"), and a lone number is the channel number.

/** Lower case, no accents, punctuation as spaces, single spaces. */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of a query, folded. */
export const wordsOf = (q) => fold(q).split(' ').filter(Boolean);

/** A searchable form of some text: folded, plus the same without spaces. */
export function haystack(...parts) {
  const f = fold(parts.filter(Boolean).join(' '));
  return { f, c: f.replace(/ /g, '') };
}

/** Every word in it, anywhere, in any order. */
export function hasWords(hay, words) {
  for (const w of words) if (!hay.f.includes(w) && !hay.c.includes(w)) return false;
  return true;
}

// Folding 50,000 names on every key press is slow on a TV stick, so each item
// keeps its haystack. Items are plain objects, never mutated in place.
const caches = new Map(); // textOf -> WeakMap(item -> haystack)
const hayOf = (x, textOf) => {
  let cache = caches.get(textOf);
  if (!cache) caches.set(textOf, (cache = new WeakMap()));
  let h = cache.get(x);
  if (!h) {
    h = haystack(...textOf(x));
    cache.set(x, h);
  }
  return h;
};

const channelText = (c) => [c.name, c.group];

/**
 * Filter a list by a query. `textOf` gives the strings an item is found by
 * (default: its name and group). A query of only digits also matches `chno`.
 */
export function filterByWords(list, query, textOf = channelText) {
  const words = wordsOf(query);
  if (!words.length) return list;
  const n = /^\d+$/.test(String(query).trim()) ? Number(String(query).trim()) : null;
  return list.filter((x) => (n != null && x.chno === n) || hasWords(hayOf(x, textOf), words));
}
