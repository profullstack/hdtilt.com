// Movies & Shows: an Xtream line's films and series, browsed a category at a
// time. A big line has hundreds of thousands of films (one measured 213,348,
// 108 MB of JSON), so nothing ever sends the whole catalogue to a screen:
// categories first, then one category's titles, then one show's episodes.
//
// Search is the exception, and it needs every title. The server fetches the
// full list once, keeps only what a match needs (no posters, no plots), and
// remembers it for an hour.
//
// A plain M3U playlist has its films in the channel list already (entries
// under /movie/ and /series/), so the app browses those itself: `local`.

import { fold, wordsOf } from './match.js';
import { normaliseSource } from './sources.js';
import { hash } from './util.js';
import * as xtream from './xtream.js';

const INDEX_TTL = 3600_000;
const MAX_INDEXES = 4;
const MAX_RESULTS = 300;
const indexes = new Map(); // key -> { at, p }

export { fold };

/** Every word of the query, anywhere in the title, in any order (core/match.js rules). */
export function matches(foldedName, words) {
  for (const w of words) if (!foldedName.includes(w) && !foldedName.replace(/ /g, '').includes(w)) return false;
  return true;
}

const yearIn = (...vs) => {
  for (const v of vs) {
    const y = /\b(19|20)\d{2}\b/.exec(String(v || ''))?.[0];
    if (y) return Number(y);
  }
  return 0;
};

/**
 * A search index from a raw get_vod_streams / get_series list: two strings per
 * title (as listed, and folded) and the rest in typed arrays. JSON.parse gives
 * every title its own copy of "10660" and "mkv"; 213k of those add up.
 */
export function buildIndex(kind, rawList, cats = [], login = null) {
  const list = Array.isArray(rawList) ? rawList : [];
  const n = list.length;
  const catIds = [];
  const catAt = new Map();
  const exts = [];
  const extAt = new Map();
  const intern = (v, arr, at) => {
    const k = String(v ?? '');
    let i = at.get(k);
    if (i === undefined) {
      i = arr.push(k) - 1;
      at.set(k, i);
    }
    return i;
  };
  const ix = {
    kind,
    login,
    names: new Array(n),
    folded: new Array(n),
    ids: new Float64Array(n),
    cat: new Uint32Array(n),
    ext: new Uint16Array(n),
    year: new Uint16Array(n),
    rating: new Float32Array(n),
    catIds,
    exts,
    catName: new Map(cats.map((c) => [String(c.id), c.name])),
  };
  for (let i = 0; i < n; i++) {
    const x = list[i] || {};
    const name = String(x.name || '').trim();
    ix.names[i] = name;
    ix.folded[i] = fold(name);
    ix.ids[i] = Number(kind === 'series' ? x.series_id : x.stream_id) || 0;
    ix.cat[i] = intern(x.category_id, catIds, catAt);
    ix.ext[i] = kind === 'series' ? 0 : intern(x.container_extension || 'mp4', exts, extAt);
    ix.year[i] = yearIn(x.year, x.releaseDate, x.release_date, x.releasedate, name);
    ix.rating[i] = Number(x.rating) || 0;
  }
  return ix;
}

// Building one holds a 100+ MB response and its parse at once: one at a time.
let building = Promise.resolve();

/** The whole catalogue of one kind, cut down to what a search needs. */
function indexFor(login, kind, fetchImpl) {
  const key = indexKey(login, kind);
  const have = indexes.get(key);
  if (have && Date.now() - have.at < INDEX_TTL) return have.p;
  const p = building
    .catch(() => {})
    .then(async () => {
      const action = kind === 'series' ? 'get_series' : 'get_vod_streams';
      const [cats, raw] = await Promise.all([
        xtream.vodCategories(login, kind, fetchImpl),
        xtream.getJson(xtream.apiUrl(login, action), fetchImpl),
      ]);
      return buildIndex(kind, raw, cats, login);
    });
  building = p;
  indexes.set(key, { at: Date.now(), p });
  p.catch(() => indexes.delete(key));
  while (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value);
  return p;
}

function indexKey(login, kind) {
  return `${kind}:${hash(`${xtream.serverOf(login.server)}|${login.username}|${login.password}`)}`;
}

/** Titles whose name has every word of `q`. Starts-with ranks first. */
export function searchIndex(ix, q, limit = MAX_RESULTS) {
  const words = wordsOf(q);
  if (!words.length) return { items: [], total: 0 };
  const first = [];
  const rest = [];
  for (let i = 0; i < ix.folded.length; i++) {
    if (!matches(ix.folded[i], words)) continue;
    // "LAT - Matrix" starts with a language tag, so "starts with" means any word does.
    const f = ix.folded[i];
    (f.startsWith(words[0]) || f.includes(` ${words[0]}`) ? first : rest).push(i);
  }
  const hits = first.concat(rest);
  const items = hits.slice(0, limit).map((i) => {
    const id = ix.ids[i];
    const category = ix.catIds[ix.cat[i]];
    const base = {
      name: ix.names[i],
      group: ix.catName.get(category) || (ix.kind === 'series' ? 'Series' : 'Movies'),
      category,
      year: ix.year[i] || undefined,
      rating: ix.rating[i] ? Math.round(ix.rating[i] * 10) / 10 : undefined,
    };
    return ix.kind === 'series'
      ? { id: `s${id}`, seriesId: id, ...base, kind: 'series' }
      : { id: `m${id}`, ...base, url: xtream.movieUrl(ix.login, id, ix.exts[ix.ext[i]]), kind: 'vod' };
  });
  return { items, total: hits.length };
}

/**
 * One request from the Movies & Shows screen.
 * @param {object} source  the playlist's source
 * @param {{ kind?: 'movie'|'series', category?: string, q?: string, seriesId?: number }} ask
 * @returns {Promise<object>} one of { local }, { categories }, { items }, { items, total }, { show }
 */
export async function browseVod(source, ask = {}, { fetch: fetchImpl = fetch } = {}) {
  const src = normaliseSource(source);
  if (src.type !== 'xtream') return { local: true };
  const kind = ask.kind === 'series' ? 'series' : 'movie';
  if (ask.seriesId != null) return { show: await xtream.seriesInfo(src, Number(ask.seriesId), fetchImpl) };
  if (ask.q && String(ask.q).trim()) {
    const ix = await indexFor(src, kind, fetchImpl);
    return searchIndex(ix, String(ask.q));
  }
  if (ask.category != null && ask.category !== '') {
    const category = String(ask.category);
    const items =
      kind === 'series'
        ? await xtream.series(src, { category, fetchImpl })
        : await xtream.movies(src, { category, fetchImpl });
    // Newest first: a category is usually a service or a genre, and what was
    // added last week is what someone opened it for.
    items.sort((a, b) => (b.added || 0) - (a.added || 0) || (b.year || 0) - (a.year || 0));
    return { items };
  }
  return { categories: await xtream.vodCategories(src, kind, fetchImpl) };
}

/** For tests. */
export const _indexes = indexes;
