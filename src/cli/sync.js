// The CLI and TUI side of an hdtilt account: OAuth 2.1 sign-in (code + PKCE,
// loopback, from @profullstack/auth-system/cli) and syncing the saved
// playlists and favorites with the account's library.
//
// The CLI keys playlists by name, the web app by id, so the config remembers
// which id each local name came from (`libraryIds`).

import { createTokenStore, getAccessToken, login, logout } from '@profullstack/auth-system/cli';
import { readConfig, writeConfig } from '../core/config.js';

export const CLIENT_ID = 'hdtilt-cli';
export const issuer = () => (process.env.HDTILT_ISSUER || 'https://hdtilt.com').replace(/\/$/, '');
export const tokenStore = () =>
  createTokenStore('hdtilt', process.env.HDTILT_HOME ? { dir: process.env.HDTILT_HOME } : {});

export async function signIn({ manual } = {}) {
  const store = tokenStore();
  await login({ issuer: issuer(), clientId: CLIENT_ID, store, ...(manual ? { manual: true } : {}) });
  return whoami();
}

export async function signOut() {
  await logout({ store: tokenStore() }).catch(() => {});
}

async function api(path, init = {}) {
  const store = tokenStore();
  const token = await getAccessToken({ store }).catch(() => null);
  if (!token) throw new Error('not signed in; run `hdtilt login`');
  const res = await fetch(`${issuer()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${issuer()} answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const whoami = () => api('/api/me');

/** Are we signed in at all (without a network call)? */
export async function signedIn() {
  try {
    return Boolean(await tokenStore().load());
  } catch {
    return false;
  }
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'playlist';

function toLibrary(cfg) {
  const ids = cfg.libraryIds || {};
  const playlists = [];
  const favorites = {};
  const recent = {};
  for (const [name, source] of Object.entries(cfg.playlists)) {
    if (source.type === 'text') continue;
    const id = ids[name] || `cli-${slug(name)}`;
    ids[name] = id;
    playlists.push({ id, name, source });
    favorites[id] = cfg.favorites[name] || [];
  }
  cfg.libraryIds = ids;
  return { playlists, favorites, recent };
}

/**
 * Pull the account's library into the config (union: nothing local is lost),
 * then push the result back. Returns what changed locally.
 */
export async function sync() {
  const remote = await api('/api/library');
  const cfg = await readConfig();
  cfg.libraryIds ||= {};
  let added = 0;
  const nameFor = Object.fromEntries(Object.entries(cfg.libraryIds).map(([n, id]) => [id, n]));
  const deleted = new Set([...(remote.data?.deleted || []), ...(cfg.deletedIds || [])]);
  for (const p of remote.data?.playlists || []) {
    if (deleted.has(p.id)) continue;
    let name = nameFor[p.id] || p.name;
    if (!nameFor[p.id] && cfg.playlists[name] && JSON.stringify(cfg.playlists[name]) !== JSON.stringify(p.source)) {
      name = `${p.name} (${p.id.slice(-4)})`; // same name, different playlist: keep both
    }
    if (!cfg.playlists[name]) added++;
    cfg.playlists[name] = p.source;
    cfg.libraryIds[name] = p.id;
    const favs = remote.data.favorites?.[p.id] || [];
    cfg.favorites[name] = [...new Set([...(cfg.favorites[name] || []), ...favs])];
  }
  cfg.current ??= Object.keys(cfg.playlists)[0];
  const lib = toLibrary(cfg);
  await writeConfig(cfg);
  const put = async (baseVersion) =>
    api('/api/library', {
      method: 'PUT',
      body: JSON.stringify({
        data: { ...remote.data, ...lib, recent: remote.data?.recent || {}, deleted: [...deleted] },
        baseVersion,
      }),
    });
  try {
    await put(remote.version);
  } catch (e) {
    if (e.status !== 409) throw e;
    return sync(); // another device wrote between our read and write
  }
  return { added, playlists: lib.playlists.length };
}

/** Fire-and-forget push after a local change, when signed in. */
export async function pushQuietly() {
  if (!(await signedIn())) return;
  try {
    await sync();
  } catch {}
}
