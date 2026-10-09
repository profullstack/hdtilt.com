// Everything the browser keeps: playlists (with their provider logins), the
// channel lists they produced, favorites, recents and the last channel.
// IndexedDB, because a 300,000-entry list does not fit in localStorage.

const DB = 'hdtilt';
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

export async function get(key, fallback = null) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result ?? fallback);
      r.onerror = () => resolve(fallback);
    });
  } catch {
    return fallback;
  }
}

export async function set(key, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const t = d.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, key);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } catch {}
}

export async function del(key) {
  try {
    const d = await db();
    d.transaction('kv', 'readwrite').objectStore('kv').delete(key);
  } catch {}
}

/** Small per-device preferences, where losing them costs nothing. */
export const prefs = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem(`hdtilt.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`hdtilt.${key}`, JSON.stringify(value));
    } catch {}
  },
};
