// The CLI's account sign-in, for real: auth-system's loopback OAuth client
// against this server, then `hdtilt sync` in a subprocess.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAdapter } from '@profullstack/auth-system';
import { createTokenStore, login } from '@profullstack/auth-system/cli';
import { createAccounts } from '../src/server/accounts.js';
import { startServer } from '../src/server/server.js';

let srv;
let base;
let home;
let jwt;
const mail = [];
// Async on purpose: the server under test lives in this process, so a
// synchronous spawn would block it from answering the CLI.
const run = (args, env) =>
  new Promise((resolve) => {
    const p = spawn('node', ['bin/hdtilt.js', ...args], { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', () => resolve({ stdout, stderr }));
  });
const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
const post = (p, body, token) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

beforeAll(async () => {
  home = await mkdtemp(
    join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'hdtilt-cli-'),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const accounts = createAccounts({
    adapter: new MemoryAdapter(),
    sendEmail: async (m) => mail.push(m),
    env: { SITE_URL: base, HDTILT_JWT_SECRET: 'cli-secret-cli-secret-cli-secret' },
  });
  srv = await startServer({ port, public: true, accounts, authPerMinute: 1000 });
  await post('/api/auth/register', { username: 'tvroom', email: 'tv@example.org', password: 'remote-control' });
  const token = new URL(mail[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  jwt = (await post('/api/auth/verify', { token })).tokens.accessToken;
  // What the web app would have synced from another device.
  await fetch(`${base}/api/library`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      baseVersion: 0,
      data: {
        playlists: [
          { id: 'p1', name: 'Living room', source: { type: 'm3u', url: 'http://h/list.m3u' } },
          { id: 'p2', name: 'Old one', source: { type: 'm3u', url: 'http://h/old.m3u' } },
        ],
        favorites: { p1: ['cnn', 'bbc'] },
        deleted: ['p2'],
      },
    }),
  });
});
afterAll(async () => {
  srv.close();
  await rm(home, { recursive: true, force: true });
});

it('signs in through the browser hop and syncs the account into the config', async () => {
  const store = createTokenStore('hdtilt', { dir: join(home, 'config') });
  await login({
    issuer: base,
    clientId: 'hdtilt-cli',
    store,
    manual: false,
    log: () => {},
    // Stand-in for the browser: the user presses Allow on the consent page.
    open: async (url) => {
      const query = Object.fromEntries(new URL(url).searchParams);
      const { redirect } = await post('/api/oauth/authorize', { query, decision: 'approve' }, jwt);
      await fetch(redirect);
    },
  });
  expect((await store.load()).access_token.startsWith('ht_at_')).toBe(true);

  const env = {
    ...process.env,
    HDTILT_ISSUER: base,
    HDTILT_HOME: join(home, 'config'),
    HDTILT_CACHE: join(home, 'cache'),
  };
  const who = await run(['whoami'], env);
  expect(who.stdout).toContain('tvroom <tv@example.org>');
  const r = await run(['sync'], env);
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('Synced 1 playlist(s), 1 new on this machine');
  const cfg = JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8'));
  expect(cfg.playlists['Living room']).toEqual({ type: 'm3u', url: 'http://h/list.m3u' });
  expect(cfg.playlists['Old one']).toBeUndefined();
  expect(cfg.favorites['Living room']).toEqual(['cnn', 'bbc']);

  const out = await run(['logout'], env);
  expect(out.stdout).toContain('Signed out');
  const again = await run(['whoami'], env);
  expect(again.stderr).toContain('not signed in');
});
