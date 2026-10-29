import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { MemoryAdapter } from '@profullstack/auth-system';
import { bytesToBase64 } from '@profullstack/sealed-secrets';
import { createAccounts, sealer as legacySealer, memoryStore } from '../src/server/accounts.js';
import {
  isSealedLibrary,
  openLibrary,
  resetUnlockStoreForTests,
  sealer,
  sealLibrary,
  ttlSeconds,
  unlockStore,
  VaultLockedError,
} from '../src/server/vault.js';

/* The library is sealed under each account's own key vault; nothing at rest opens it. */

describe('sealing the library', () => {
  it('locked: no seal, no open', async () => {
    resetUnlockStoreForTests();
    await expect(sealLibrary('u1', { a: 1 })).rejects.toBeInstanceOf(VaultLockedError);
  });
  it('unlocked: round trip, bound to the account, no plaintext', async () => {
    resetUnlockStoreForTests();
    const key = randomBytes(32);
    unlockStore().unlock('u1', key, 3600);
    const blob = await sealLibrary('u1', { pass: 'hunter2' });
    expect(isSealedLibrary(blob)).toBe(true);
    expect(blob).not.toContain('hunter2');
    expect(await openLibrary('u1', blob)).toEqual({ pass: 'hunter2' });
    unlockStore().unlock('u2', key, 3600);
    await expect(openLibrary('u2', blob)).rejects.toThrow();
  });
  it('lock, expiry and restart forget the key; ttl 8h default, 7d max', () => {
    resetUnlockStoreForTests();
    unlockStore().unlock('u3', randomBytes(32), 3600);
    unlockStore().lock('u3');
    expect(unlockStore().get('u3')).toBeNull();
    unlockStore().unlock('u3', randomBytes(32), 3600);
    resetUnlockStoreForTests();
    expect(unlockStore().get('u3')).toBeNull();
    expect(ttlSeconds()).toBe(8 * 3600);
    expect(ttlSeconds('30d')).toBe(7 * 86400);
  });
});

describe('the old server key', () => {
  const env = { SITE_URL: 'https://hdtilt.test', HDTILT_JWT_SECRET: 'x'.repeat(32), HDTILT_LIBRARY_KEY: 'old-key' };
  const legacy = legacySealer('old-key').seal({ playlists: [{ id: 'p', source: { password: 'pw' } }] });

  async function setup(extraEnv = {}) {
    resetUnlockStoreForTests();
    const adapter = new MemoryAdapter();
    const store = memoryStore(adapter);
    await store.putLibrary('u9', legacy, null);
    const accounts = createAccounts({ adapter, store, env: { ...env, ...extraEnv }, sendEmail: async () => {} });
    const made = await sealer.createSeal('a long passphrase', 'u9');
    await accounts.createVault({ userId: 'u9' }, { seal: made.seal });
    return { accounts, store, made };
  }

  async function noVault(extraEnv = {}) {
    resetUnlockStoreForTests();
    const adapter = new MemoryAdapter();
    const store = memoryStore(adapter);
    await store.putLibrary('u8', legacy, null);
    const accounts = createAccounts({ adapter, store, env: { ...env, ...extraEnv }, sendEmail: async () => {} });
    return { accounts, store };
  }

  it('with no vault yet, the library reads and syncs as before v0.5.0', async () => {
    const { accounts, store } = await noVault();
    const got = await accounts.getLibrary({ userId: 'u8' });
    expect(got.data.playlists[0].source.password).toBe('pw');
    await accounts.putLibrary({ userId: 'u8' }, { data: { playlists: [] }, baseVersion: got.version });
    const row = await store.getLibrary('u8');
    expect(isSealedLibrary(row.blob)).toBe(false);
    expect((await accounts.getLibrary({ userId: 'u8' })).data.playlists).toEqual([]);
  });

  it('with no vault and the cutoff on, it is a 423, not the old key', async () => {
    const { accounts } = await noVault({ LEGACY_KEY_MIGRATION: 'off' });
    await expect(accounts.getLibrary({ userId: 'u8' })).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('once the vault exists it is never read at runtime, even with the env key present', async () => {
    const { accounts } = await setup();
    await expect(accounts.getLibrary({ userId: 'u9' })).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('is re-sealed in place by the first unlock, and then reads normally', async () => {
    const { accounts, store, made } = await setup();
    const r = await accounts.unlockVault({ userId: 'u9' }, { dek: bytesToBase64(made.dek), ttl: '1h' });
    expect(r.migration.migrated).toBe(1);
    const row = await store.getLibrary('u9');
    expect(isSealedLibrary(row.blob)).toBe(true);
    expect(row.version).toBe(1);
    expect((await accounts.getLibrary({ userId: 'u9' })).data.playlists[0].source.password).toBe('pw');
  });

  it('stays as it is after the cutoff (LEGACY_KEY_MIGRATION=off), never deleted', async () => {
    const { accounts, store, made } = await setup({ LEGACY_KEY_MIGRATION: 'off' });
    const r = await accounts.unlockVault({ userId: 'u9' }, { dek: bytesToBase64(made.dek) });
    expect(r.migration.migrated).toBe(0);
    expect((await store.getLibrary('u9')).blob).toBe(legacy);
  });
});
