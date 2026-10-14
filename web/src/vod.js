// Movies & Shows: films and series, beside Live TV.
//
// A rail of categories (Continue watching, Search, then the provider's own),
// and a list of titles; a show opens into its episodes. An Xtream line is
// browsed a category at a time through /api/vod, because a big line has
// hundreds of thousands of titles; a plain M3U's films are already in the
// channel list (its /movie/ and /series/ entries), so those are browsed here.

import { filterByWords, fold } from '../../src/core/match.js';
import * as store from './store.js';

const CONTINUE = 'continue';
const SEARCH = 'search';
const KINDS = { movie: 'Movies', series: 'Shows' };
const RESUME_MIN = 60; // seconds in before a position is worth keeping
const DONE_LEFT = 0.05; // the last 5% counts as watched

export const V = {
  kind: 'movie', // movie | series
  cats: [], // [{ id, name }] of the kind, as listed by the provider
  cat: CONTINUE, // open category id
  items: [], // titles in the open category (or search results)
  view: [], // items after the filter
  q: '', // filter (or search words in Search)
  show: null, // an open show: { seriesId, name, episodes, ... }
  season: null, // season shown in an open show
  focus: 0,
  railFocus: 0,
  pane: 'items', // items | rail
  loading: '',
  error: '',
  total: 0, // search matches, of which `items` is the first page
  local: null, // { movie: [], series: [] } for an M3U playlist
  seq: 0, // drops answers to questions no longer asked
  history: [], // what was watched: [{ item, pos, dur, at, show }]
};

/** The rail: two pseudo-categories, then the provider's. */
export const railOf = () => [{ id: CONTINUE, name: '↺ Continue watching' }, { id: SEARCH, name: 'Search…' }, ...V.cats];

const hKey = (plId) => `vodhist:${plId}`;

export async function loadHistory(plId) {
  V.history = plId ? await store.get(hKey(plId), []) : [];
}

/** How far into a title someone got, 0..1, or 0. */
export function progressOf(id) {
  const h = V.history.find((x) => x.item.id === id);
  return h?.dur ? Math.min(1, h.pos / h.dur) : 0;
}

/** Where to start a title: where it was left, unless it was finished. */
export function resumeAt(id) {
  const h = V.history.find((x) => x.item.id === id);
  if (!h || h.pos < RESUME_MIN) return 0;
  if (h.dur && h.pos > h.dur * (1 - DONE_LEFT)) return 0;
  return Math.floor(h.pos);
}

/** Remember a position. `show` is the series an episode belongs to. */
export async function remember(plId, item, pos, dur, show = null) {
  if (!plId || !item) return;
  const slim = { id: item.id, name: item.name, url: item.url, kind: item.kind, logo: item.logo, group: item.group };
  if (item.season != null) Object.assign(slim, { season: item.season, episode: item.episode });
  const entry = { item: slim, pos: Math.floor(pos || 0), dur: Math.floor(dur || 0), at: Date.now() };
  if (show) entry.show = { seriesId: show.seriesId, name: show.name, logo: show.logo };
  V.history = [entry, ...V.history.filter((x) => x.item.id !== item.id)].slice(0, 60);
  await store.set(hKey(plId), V.history);
}

/** Continue watching: started, not finished, newest first. */
export function continueList() {
  return V.history
    .filter((h) => h.pos >= RESUME_MIN && !(h.dur && h.pos > h.dur * (1 - DONE_LEFT)))
    .map((h) => ({ ...h.item, show: h.show, resume: h.pos, dur: h.dur }));
}

/** An M3U's films and episodes, from the channel list it already loaded. */
export function setLocal(channels) {
  if (!channels) {
    V.local = null;
    return;
  }
  const movie = [];
  const series = [];
  for (const c of channels) {
    if (c.kind === 'vod') movie.push(c);
    else if (c.kind === 'series') series.push(c);
  }
  V.local = { movie, series };
}

/** Categories of an M3U's films: its group-titles. */
function localCats(kind) {
  const seen = new Map();
  for (const c of V.local?.[kind] || []) seen.set(c.group, (seen.get(c.group) || 0) + 1);
  return [...seen].map(([name, n]) => ({ id: `g:${name}`, name, n }));
}

// A title is found by its name, and an episode in Continue watching by its show's too.
const titleText = (x) => [x.name, x.show?.name];

/** Every word, anywhere in the title, any order (core/match.js). */
export function filterTitles(list, q) {
  return filterByWords(list, q, titleText);
}

/**
 * Talk to the server (`ask`: a function that POSTs to /api/vod for the current
 * playlist) or to the M3U's own entries. Returns what changed.
 */
export async function loadCategories(ask) {
  if (V.local) {
    V.cats = localCats(V.kind);
    return;
  }
  const r = await ask({ kind: V.kind });
  if (r.local) {
    V.local = { movie: [], series: [] };
    V.cats = [];
    return;
  }
  V.cats = r.categories || [];
}

export async function loadCategory(ask) {
  V.show = null;
  V.total = 0;
  if (V.cat === CONTINUE) {
    V.items = continueList().filter((x) => (V.kind === 'series' ? x.show || x.kind === 'series' : !x.show));
    return;
  }
  if (V.cat === SEARCH) {
    if (fold(V.q).trim().length < 2) {
      V.items = [];
      return;
    }
    if (V.local) {
      V.items = filterTitles(V.local[V.kind], V.q);
      V.total = V.items.length;
      return;
    }
    const r = await ask({ kind: V.kind, q: V.q });
    V.items = r.items || [];
    V.total = r.total || V.items.length;
    return;
  }
  if (V.local) {
    const g = V.cat.replace(/^g:/, '');
    V.items = V.local[V.kind].filter((c) => c.group === g);
    return;
  }
  const r = await ask({ kind: V.kind, category: V.cat });
  const name = V.cats.find((c) => c.id === V.cat)?.name;
  V.items = (r.items || []).map((x) => (name ? { ...x, group: name } : x));
}

export async function loadShow(ask, seriesId) {
  const r = await ask({ seriesId });
  V.show = r.show;
  const seasons = seasonsOf(V.show);
  // The season of the episode last watched, else the first.
  const last = V.history.find((h) => h.show?.seriesId === V.show.seriesId);
  V.season = last?.item.season ?? seasons[0] ?? null;
}

export const seasonsOf = (show) => [...new Set((show?.episodes || []).map((e) => e.season))];

/** What the list shows now, filter applied. */
export function setItemsView() {
  if (V.show) {
    const eps = V.show.episodes.filter((e) => V.season == null || e.season === V.season);
    V.view = V.cat === SEARCH ? eps : filterTitles(eps, V.q);
  } else V.view = V.cat === SEARCH ? V.items : filterTitles(V.items, V.q);
  V.focus = Math.min(V.focus, Math.max(0, V.view.length - 1));
}

/** The episode after this one in its show, for "next episode". */
export function nextEpisode(show, ep) {
  if (!show || !ep) return null;
  const i = show.episodes.findIndex((e) => e.id === ep.id);
  return i >= 0 ? show.episodes[i + 1] || null : null;
}

/** /vod/movies/<cat>?q=  /vod/shows/<cat>  /vod/show/<id> */
export function vodPath() {
  if (V.show) return `/vod/show/${V.show.seriesId}`;
  const kind = V.kind === 'series' ? 'shows' : 'movies';
  const q = V.q ? `?q=${encodeURIComponent(V.q)}` : '';
  return `/vod/${kind}/${encodeURIComponent(V.cat)}${q}`;
}

export const kindName = (k) => KINDS[k];
export { CONTINUE, SEARCH };

const two = (n) => String(n).padStart(2, '0');
export const epLabel = (e) => `S${two(e.season)} E${two(e.episode)}`;

/** "1h 48m" */
export function runtime(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
