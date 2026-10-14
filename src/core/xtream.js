// Xtream Codes ("player_api.php") client. Runs anywhere fetch does.
//
// A provider line is three things: a server, a username and a password. Every
// URL below carries the last two in the clear, because that is how the protocol
// works, so none of them may be logged or put in a page address.

/** @typedef {{ server: string, username: string, password: string }} XtreamLogin */

/** Normalise what people paste: no trailing slash, no player_api.php, a scheme. */
export function serverOf(raw) {
  let s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}`;
}

/**
 * Pull a login out of an M3U URL that is really an Xtream line in disguise:
 * `http://host/get.php?username=U&password=P&type=m3u_plus`.
 * Returns null for anything else.
 */
export function loginFromM3uUrl(raw) {
  try {
    const u = new URL(raw);
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (/\/get\.php$/i.test(u.pathname) && username && password) {
      return { server: `${u.protocol}//${u.host}`, username, password };
    }
  } catch {}
  return null;
}

export function apiUrl(login, action, params = {}) {
  const u = new URL(`${serverOf(login.server)}/player_api.php`);
  u.searchParams.set('username', login.username);
  u.searchParams.set('password', login.password);
  if (action) u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

export const xmltvUrl = (login) =>
  `${serverOf(login.server)}/xmltv.php?username=${encodeURIComponent(login.username)}&password=${encodeURIComponent(login.password)}`;

const path = (login) => `${encodeURIComponent(login.username)}/${encodeURIComponent(login.password)}`;

export const liveUrl = (login, streamId, ext = 'ts') =>
  `${serverOf(login.server)}/live/${path(login)}/${streamId}.${ext}`;

export const movieUrl = (login, streamId, ext = 'mp4') =>
  `${serverOf(login.server)}/movie/${path(login)}/${streamId}.${ext}`;

export const episodeUrl = (login, episodeId, ext = 'mp4') =>
  `${serverOf(login.server)}/series/${path(login)}/${episodeId}.${ext}`;

/**
 * Archive playback. Xtream wants the start in the SERVER's local time, which
 * the panel reports as `server_info.timezone`; UTC is right for most panels and
 * is what we fall back to.
 */
export function timeshiftUrl(login, streamId, startMs, minutes, timeZone = 'UTC') {
  const d = new Date(startMs);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const at = `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
  return `${serverOf(login.server)}/timeshift/${path(login)}/${Math.ceil(minutes)}/${at}/${streamId}.ts`;
}

export async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'hdtilt' } });
  if (!res.ok) throw new Error(`provider answered ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('provider did not answer with JSON; check the server address');
  }
}

/** Account status. Throws when the login is refused. */
export async function account(login, fetchImpl = fetch) {
  const data = await getJson(apiUrl(login), fetchImpl);
  if (!data?.user_info || Number(data.user_info.auth) === 0) {
    throw new Error('the provider refused that username and password');
  }
  const u = data.user_info;
  return {
    status: u.status,
    expiresAt: u.exp_date ? Number(u.exp_date) * 1000 : null,
    maxConnections: Number(u.max_connections) || null,
    activeConnections: Number(u.active_cons) || 0,
    formats: u.allowed_output_formats || [],
    timeZone: data.server_info?.timezone || 'UTC',
  };
}

/**
 * Live channels in the same shape an M3U produces, so nothing downstream needs
 * to know which kind of source it came from.
 */
export async function liveChannels(login, { fetchImpl = fetch, ext } = {}) {
  const [cats, streams] = await Promise.all([
    getJson(apiUrl(login, 'get_live_categories'), fetchImpl),
    getJson(apiUrl(login, 'get_live_streams'), fetchImpl),
  ]);
  const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
  return (streams || []).map((s) => {
    const ch = {
      id: `x${s.stream_id}`,
      name: String(s.name || '').trim() || `Channel ${s.stream_id}`,
      url: liveUrl(login, s.stream_id, ext || 'ts'),
      group: catName.get(String(s.category_id)) || 'Uncategorized',
      kind: 'live',
      streamId: Number(s.stream_id),
    };
    if (s.stream_icon) ch.logo = s.stream_icon;
    if (s.epg_channel_id) ch.tvgId = s.epg_channel_id;
    if (s.num) ch.chno = Number(s.num);
    if (Number(s.tv_archive) === 1) {
      ch.catchup = { type: 'xc', days: Number(s.tv_archive_duration) || undefined };
    }
    return ch;
  });
}

/** Movie or series categories: [{ id, name }]. kind is 'movie' or 'series'. */
export async function vodCategories(login, kind, fetchImpl = fetch) {
  const action = kind === 'series' ? 'get_series_categories' : 'get_vod_categories';
  const cats = await getJson(apiUrl(login, action), fetchImpl);
  return (Array.isArray(cats) ? cats : []).map((c) => ({
    id: String(c.category_id),
    name: String(c.category_name || ''),
  }));
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const yearOf = (...vs) => {
  for (const v of vs) {
    const y = /\b(19|20)\d{2}\b/.exec(String(v || ''))?.[0];
    if (y) return Number(y);
  }
  return undefined;
};

/** A TMDB id, for subtitles: panels send it as a number, a string, or "0" for none. */
const tmdbOf = (...vs) => {
  for (const v of vs) {
    const n = Number(String(v ?? '').trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
};

/** One movie as get_vod_streams lists it, in the shape the app shows. */
export function movieOf(login, m, catName = new Map()) {
  return {
    id: `m${m.stream_id}`,
    name: String(m.name || '').trim() || `Movie ${m.stream_id}`,
    group: catName.get(String(m.category_id)) || 'Movies',
    category: String(m.category_id ?? ''),
    logo: m.stream_icon || undefined,
    rating: num(m.rating) || undefined,
    year: yearOf(m.year, m.releasedate, m.name),
    added: num(m.added),
    tmdbId: tmdbOf(m.tmdb, m.tmdb_id),
    url: movieUrl(login, m.stream_id, m.container_extension || 'mp4'),
    kind: 'vod',
  };
}

/** One show as get_series lists it. */
export function showOf(s, catName = new Map()) {
  return {
    id: `s${s.series_id}`,
    seriesId: Number(s.series_id),
    name: String(s.name || '').trim() || `Series ${s.series_id}`,
    group: catName.get(String(s.category_id)) || 'Series',
    category: String(s.category_id ?? ''),
    logo: s.cover || undefined,
    plot: s.plot || undefined,
    rating: num(s.rating) || undefined,
    year: yearOf(s.releaseDate, s.release_date, s.name),
    added: num(s.last_modified),
    kind: 'series',
  };
}

/** Movies, all of them or one category's. All of them can be 100+ MB of JSON. */
export async function movies(login, { category, fetchImpl = fetch } = {}) {
  const [cats, items] = await Promise.all([
    category ? [] : getJson(apiUrl(login, 'get_vod_categories'), fetchImpl),
    getJson(apiUrl(login, 'get_vod_streams', category ? { category_id: category } : {}), fetchImpl),
  ]);
  const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
  return (Array.isArray(items) ? items : []).map((m) => movieOf(login, m, catName));
}

/** Shows, all of them or one category's. */
export async function series(login, { category, fetchImpl = fetch } = {}) {
  const [cats, items] = await Promise.all([
    category ? [] : getJson(apiUrl(login, 'get_series_categories'), fetchImpl),
    getJson(apiUrl(login, 'get_series', category ? { category_id: category } : {}), fetchImpl),
  ]);
  const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
  return (Array.isArray(items) ? items : []).map((s) => showOf(s, catName));
}

/**
 * "EN - Lost In Space (2018) - S01E01 - Impact" is how panels title an
 * episode; beside its show and its S01 E01 it is "Impact". A title that is
 * nothing but the code keeps the whole thing.
 */
export function episodeTitle(raw, n) {
  const t = String(raw || '').trim();
  const m = /(?:^|[\s\-–|:])S\d{1,3}\s*E\d{1,4}\b\s*(?:[-–|:]\s*)?(.*)$/i.exec(t);
  const rest = m?.[1]?.trim();
  return rest || t || `Episode ${n}`;
}

/**
 * A show's details and episodes. Panels send `episodes` as an object keyed by
 * season, or as a list of lists; both come out as one flat list in order.
 */
export async function seriesInfo(login, seriesId, fetchImpl = fetch) {
  const data = await getJson(apiUrl(login, 'get_series_info', { series_id: seriesId }), fetchImpl);
  if (!data || typeof data !== 'object') throw new Error('the provider has nothing for that show');
  const raw = data.episodes || {};
  const groups = Array.isArray(raw) ? raw.map((list, i) => [list?.[0]?.season ?? i + 1, list]) : Object.entries(raw);
  const episodes = [];
  for (const [season, list] of groups) {
    for (const e of Array.isArray(list) ? list : []) {
      const info = e.info && typeof e.info === 'object' ? e.info : {};
      episodes.push({
        id: `e${e.id}`,
        season: Number(e.season ?? season) || 0,
        episode: Number(e.episode_num) || 0,
        name: episodeTitle(e.title, e.episode_num),
        plot: info.plot || undefined,
        duration: num(info.duration_secs),
        logo: info.movie_image || undefined,
        url: episodeUrl(login, e.id, e.container_extension || 'mp4'),
        kind: 'vod',
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = data.info || {};
  return {
    seriesId: Number(seriesId),
    name: String(i.name || '').trim(),
    plot: i.plot || undefined,
    logo: i.cover || undefined,
    genre: i.genre || undefined,
    rating: num(i.rating) || undefined,
    year: yearOf(i.releaseDate, i.release_date),
    tmdbId: tmdbOf(i.tmdb, i.tmdb_id),
    episodes,
  };
}

/** Back-compat: a show's episodes only. */
export async function episodes(login, seriesId, fetchImpl = fetch) {
  return (await seriesInfo(login, seriesId, fetchImpl)).episodes;
}

const b64 = (s) => {
  try {
    const bin = atob(String(s || ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return String(s || '');
  }
};

/** A channel's next few programmes, for a provider with no XMLTV. */
export async function shortEpg(login, streamId, limit = 4, fetchImpl = fetch) {
  const data = await getJson(apiUrl(login, 'get_short_epg', { stream_id: streamId, limit }), fetchImpl);
  return (data?.epg_listings || []).map((p) => ({
    start: Number(p.start_timestamp) * 1000,
    stop: Number(p.stop_timestamp) * 1000,
    title: b64(p.title),
    desc: b64(p.description) || undefined,
  }));
}
