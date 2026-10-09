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

async function getJson(url, fetchImpl) {
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

export async function movies(login, fetchImpl = fetch) {
  const [cats, items] = await Promise.all([
    getJson(apiUrl(login, 'get_vod_categories'), fetchImpl),
    getJson(apiUrl(login, 'get_vod_streams'), fetchImpl),
  ]);
  const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
  return (items || []).map((m) => ({
    id: `m${m.stream_id}`,
    name: m.name,
    group: catName.get(String(m.category_id)) || 'Movies',
    logo: m.stream_icon || undefined,
    rating: m.rating ? Number(m.rating) : undefined,
    url: movieUrl(login, m.stream_id, m.container_extension || 'mp4'),
    kind: 'vod',
  }));
}

export async function series(login, fetchImpl = fetch) {
  const [cats, items] = await Promise.all([
    getJson(apiUrl(login, 'get_series_categories'), fetchImpl),
    getJson(apiUrl(login, 'get_series'), fetchImpl),
  ]);
  const catName = new Map((cats || []).map((c) => [String(c.category_id), c.category_name]));
  return (items || []).map((s) => ({
    id: `s${s.series_id}`,
    seriesId: Number(s.series_id),
    name: s.name,
    group: catName.get(String(s.category_id)) || 'Series',
    logo: s.cover || undefined,
    plot: s.plot || undefined,
    kind: 'series',
  }));
}

export async function episodes(login, seriesId, fetchImpl = fetch) {
  const data = await getJson(apiUrl(login, 'get_series_info', { series_id: seriesId }), fetchImpl);
  const out = [];
  for (const [season, list] of Object.entries(data?.episodes || {})) {
    for (const e of list) {
      out.push({
        id: `e${e.id}`,
        season: Number(season),
        episode: Number(e.episode_num),
        name: e.title,
        url: episodeUrl(login, e.id, e.container_extension || 'mp4'),
        kind: 'vod',
      });
    }
  }
  return out;
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
