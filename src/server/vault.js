// The account's key vault (2026-10-28).
//
// A library holds provider logins. It used to be sealed under HDTILT_LIBRARY_KEY
// (or a key derived from the JWT secret), which the server held around the clock,
// so whoever had the box had every login. Now each account sets a passphrase in
// the browser (PBKDF2 600k -> HKDF -> AES-256-GCM, @profullstack/sealed-secrets,
// plus a recovery key shown once); the server keeps only the sealed record.
//
// To sync, the browser (or `hdtilt vault unlock`) sends the derived data key,
// never the passphrase. It lives in this process's memory for the time chosen
// (8h default, 7 days at most) and Lock forgets it. A restart forgets every key:
// sync answers 423 until the owner unlocks again, and every device keeps its own
// copy meanwhile.

import {
  base64ToBytes,
  createSealer,
  isSealRecord,
  parseTtl,
  UNLOCK_DEFAULT_TTL_SECONDS,
  UnlockStore,
  wipe,
} from '@profullstack/sealed-secrets';

export { isSealRecord };
export const sealer = createSealer({ app: 'hdtilt', scope: 'library' });
const FIELD = 'library';
const PREFIX = 'v2:';

const STORE = Symbol.for('hdtilt.vault.unlockStore');
export function unlockStore() {
  globalThis[STORE] ??= new UnlockStore();
  return globalThis[STORE];
}
export function resetUnlockStoreForTests() {
  globalThis[STORE]?.lockAll();
  delete globalThis[STORE];
}
export const dataKeyFor = (userId) => (userId ? unlockStore().get(String(userId)) : null);

const MESSAGES = {
  vault_missing:
    'Set up your key vault first (Account, Key vault): your library is sealed with a passphrase only you know.',
  vault_locked: 'Your key vault is locked. Unlock it (Account, Key vault, or `hdtilt vault unlock`) to sync.',
  legacy_unmigrated: 'Your library was saved before the key vault existed. Unlock your vault once to re-seal it.',
};
export class VaultLockedError extends Error {
  constructor(code = 'vault_locked') {
    super(MESSAGES[code] || MESSAGES.vault_locked);
    this.name = 'VaultLockedError';
    this.code = code;
    this.status = 423;
  }
}

export function ttlSeconds(value) {
  if (value === undefined || value === null || value === '') return UNLOCK_DEFAULT_TTL_SECONDS;
  try {
    return parseTtl(String(value));
  } catch {
    throw Object.assign(new Error('ttl must look like 30m, 8h or 7d (7 days at most)'), { status: 400 });
  }
}

export const isSealedLibrary = (blob) => String(blob ?? '').startsWith(PREFIX);

export async function sealLibrary(userId, data) {
  const dek = dataKeyFor(userId);
  if (!dek) throw new VaultLockedError('vault_locked');
  const blob = await sealer.sealJson(dek, data, String(userId), FIELD);
  return PREFIX + JSON.stringify(blob);
}

export async function openLibrary(userId, stored) {
  const dek = dataKeyFor(userId);
  if (!dek) throw new VaultLockedError('vault_locked');
  return sealer.unsealJson(dek, JSON.parse(String(stored).slice(PREFIX.length)), String(userId), FIELD);
}

export async function unlockWithDataKey(userId, seal, dekBase64, ttl) {
  if (!isSealRecord(seal)) throw new VaultLockedError('vault_missing');
  const dek = base64ToBytes(String(dekBase64 || ''));
  try {
    if (dek.length !== 32 || !(await sealer.verifyDataKey(dek, seal, String(userId)))) {
      throw Object.assign(new Error('That passphrase does not open your vault'), { status: 403 });
    }
    return unlockStore().unlock(String(userId), dek, ttl);
  } finally {
    wipe(dek);
  }
}

export async function verifyRewrap(userId, current, next, dekBase64) {
  const dek = base64ToBytes(String(dekBase64 || ''));
  try {
    return (
      dek.length === 32 &&
      (await sealer.verifyDataKey(dek, current, String(userId))) &&
      (await sealer.verifyDataKey(dek, next, String(userId)))
    );
  } finally {
    wipe(dek);
  }
}
