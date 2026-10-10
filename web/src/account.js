// The signed-in account: its session, the screens that make one, and keeping
// the library (playlists, favorites, recents) the same on every device.

import * as store from './store.js';

let session = store.prefs.read('session', null); // { accessToken, refreshToken, user }
const listeners = new Set();

export const current = () => session?.user || null;
export const onChange = (fn) => listeners.add(fn);
const emit = () => {
  for (const fn of listeners) fn(current());
};

function save(next) {
  session = next;
  store.prefs.write('session', next);
  emit();
}

/** Swap an expired access token for a new one; false when the session is over. */
async function refresh() {
  if (!session?.refreshToken) return false;
  const r = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!r.ok) {
    save(null);
    return false;
  }
  const { tokens } = await r.json();
  save({ ...session, ...tokens });
  return true;
}

/** fetch with the session attached, refreshed once if it has expired. */
export async function authedFetch(path, init = {}) {
  const go = () =>
    fetch(path, {
      ...init,
      headers: { ...(init.headers || {}), ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}) },
    });
  let res = await go();
  // Access tokens last an hour; the refresh token keeps a TV signed in.
  if (res.status === 401 && session && (await refresh())) res = await go();
  return res;
}

async function call(path, body, { auth = false, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const init = {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = auth ? await authedFetch(path, init) : await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `server answered ${res.status}`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * The cookie the stream proxy wants: <video> and <img> requests cannot carry
 * the session's bearer token. Renewed at start and after every sign-in.
 */
export async function renewMediaCookie() {
  if (!session) return;
  await call('/api/auth/media', {}, { auth: true }).catch(() => {});
}

export async function signIn(login, password) {
  const r = await call('/api/auth/login', { login, password });
  store.prefs.write('hadAccount', true);
  save({ ...r.tokens, user: r.user });
  await renewMediaCookie();
  return r.user;
}
export const register = (username, email, password) => call('/api/auth/register', { username, email, password });
export const resend = (email) => call('/api/auth/resend', { email });
export const forgot = (email) => call('/api/auth/forgot', { email });
export const reset = (token, password) => call('/api/auth/reset', { token, password });
export async function verify(token) {
  const r = await call('/api/auth/verify', { token });
  store.prefs.write('hadAccount', true);
  save({ ...r.tokens, user: r.user });
  await renewMediaCookie();
  return r.user;
}
export async function signOut() {
  if (session)
    call('/api/auth/logout', { refreshToken: session.refreshToken, accessToken: session.accessToken }).catch(() => {});
  save(null);
}
export const authorize = (query, decision) => call('/api/oauth/authorize', { query, decision }, { auth: true });

/* ------------------------------------------------------------------ sync */

let version = store.prefs.read('libraryVersion', 0);
let pushTimer = 0;
let gather = null; // () => Promise<library>
let apply = null; // (library) => Promise<void>

/**
 * Wire sync to the app: `collect` builds the library from local state, `merge`
 * folds a server copy into it.
 */
export function attachSync(collect, merge) {
  gather = collect;
  apply = merge;
}

/** Pull, merge into what this device has, push the union back. */
export async function syncNow() {
  if (!session || !gather) return;
  const remote = await call('/api/library', undefined, { auth: true });
  if (remote.data) await apply(remote.data);
  version = remote.version;
  await push();
}

async function push() {
  const data = await gather();
  try {
    const r = await call('/api/library', { data, baseVersion: version }, { auth: true, method: 'PUT' });
    version = r.version;
    store.prefs.write('libraryVersion', version);
  } catch (e) {
    // Another device wrote first: take theirs, merge, try once more.
    if (e.status === 409) return syncNow();
    throw e;
  }
}

/** Call after any local change; writes are batched. */
export function changed() {
  if (!session) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch(() => {}), 1500);
}

/** Union two libraries. Playlists by id, favorites per playlist, newest recents first. */
export function mergeLibraries(local, remote) {
  // Deleted on any device stays deleted: a union alone would resurrect it.
  const deleted = [...new Set([...(remote.deleted || []), ...(local.deleted || [])])];
  const gone = new Set(deleted);
  const byId = new Map();
  for (const p of [...(remote.playlists || []), ...(local.playlists || [])]) if (!gone.has(p.id)) byId.set(p.id, p);
  const favorites = { ...(remote.favorites || {}) };
  for (const [id, list] of Object.entries(local.favorites || {})) {
    favorites[id] = [...new Set([...(favorites[id] || []), ...list])];
  }
  const recent = { ...(remote.recent || {}) };
  for (const [id, list] of Object.entries(local.recent || {})) {
    recent[id] = [...new Set([...list, ...(recent[id] || [])])].slice(0, 40);
  }
  return { playlists: [...byId.values()], favorites, recent, deleted };
}
