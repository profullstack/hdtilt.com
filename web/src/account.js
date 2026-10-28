// The signed-in account: its session, the screens that make one, and keeping
// the library (playlists, favorites, recents) the same on every device.

import { bytesToBase64, createSealer, wipe } from '@profullstack/sealed-secrets';
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
    // Only a refusal ends the session. A 5xx is the server restarting, and
    // signing a TV out over that would be worse than one failed request.
    if (r.status < 500) save(null);
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
export const register = (username, email, password, profile = {}) =>
  call('/api/auth/register', { ...profile, username, email, password });
/** The shared profile (name, company, title, LinkedIn) for the signed-in account. */
export const getProfile = () => call('/api/v1/me/profile', undefined, { auth: true });
export const saveProfile = (fields) => call('/api/v1/me/profile', fields, { auth: true, method: 'PATCH' });
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

/* ------------------------------------------------------------------ key vault */
// The library is sealed with a passphrase only the account holder knows. All
// the crypto happens here; the server gets the sealed record and, on unlock,
// only the derived data key (never the passphrase), held in its memory.

const sealer = createSealer({ app: 'hdtilt', scope: 'library' });
export const LOST_PASSPHRASE =
  'If you lose both your passphrase and your recovery key, the library stored on our server is gone for good: nobody here can open it. Your devices keep their own copies.';

export const vaultStatus = () => call('/api/vault', undefined, { auth: true });

async function sendUnlock(dek, ttl) {
  try {
    return await call('/api/vault/unlock', { dek: bytesToBase64(dek), ttl }, { auth: true });
  } finally {
    wipe(dek);
  }
}

/** First time: returns the recovery key, to show once. */
export async function createVault(passphrase, ttl = '8h') {
  const { userId } = await vaultStatus();
  const made = await sealer.createSeal(passphrase, userId);
  try {
    await call('/api/vault', { seal: made.seal }, { auth: true });
  } catch (e) {
    wipe(made.dek);
    throw e;
  }
  await sendUnlock(made.dek, ttl);
  return made.recoveryKey;
}

export async function unlockVault(secret, { recovery = false, ttl = '8h' } = {}) {
  const { userId, seal } = await vaultStatus();
  const dek = recovery
    ? await sealer.unlockSealWithRecovery(seal, secret.trim(), userId)
    : await sealer.unlockSeal(seal, secret, userId);
  return sendUnlock(dek, ttl);
}

export const lockVault = () => call('/api/vault/lock', {}, { auth: true });
