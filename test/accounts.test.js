import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { MemoryAdapter } from '@profullstack/auth-system';
import { createAccounts } from '../src/server/accounts.js';
import { startServer } from '../src/server/server.js';

const mail = [];
let srv;
let base;
const at = (p) => `${base}${p}`;
const post = (p, body, token) =>
  fetch(at(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const linkIn = (m, path) => new URL(m.text.match(new RegExp(`https?://\\S+${path}\\?token=\\S+`))[0]);

beforeAll(async () => {
  const accounts = createAccounts({
    adapter: new MemoryAdapter(),
    sendEmail: async (m) => mail.push(m),
    env: { SITE_URL: 'https://hdtilt.test', HDTILT_JWT_SECRET: 'test-secret-test-secret-test-secret' },
  });
  srv = await startServer({ port: 0, public: true, accounts, authPerMinute: 1000 });
  base = `http://127.0.0.1:${srv.address().port}`;
});
afterAll(() => srv.close());

let session;

describe('sign up', () => {
  it('needs a proper username, email and password', async () => {
    const r = await post('/api/auth/register', { username: 'x', email: 'a@b.co', password: 'longenough' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('username');
    const r2 = await post('/api/auth/register', { username: 'okname', email: 'a@b.co', password: 'short' });
    expect((await r2.json()).error).toContain('8 characters');
  });

  it('emails a link, and refuses sign-in until it is used', async () => {
    const r = await post('/api/auth/register', {
      username: 'Viewer_1',
      email: 'Viewer@Example.org',
      password: 'couch-potato',
    });
    expect(r.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('viewer@example.org');
    expect(mail[0].subject).toContain('Confirm');
    const login = await post('/api/auth/login', { login: 'viewer_1', password: 'couch-potato' });
    expect(login.status).toBe(401);
    expect((await login.json()).code).toBe('unverified');
  });

  it('can send the link again', async () => {
    await post('/api/auth/resend', { email: 'viewer@example.org' });
    expect(mail).toHaveLength(2);
  });

  it('verifies, and the link signs you in', async () => {
    const link = linkIn(mail.at(-1), '/verify');
    expect(link.origin).toBe('https://hdtilt.test');
    const r = await post('/api/auth/verify', { token: link.searchParams.get('token') });
    const body = await r.json();
    expect(body.user).toMatchObject({ username: 'Viewer_1', emailVerified: true });
    expect(body.tokens.accessToken).toBeTruthy();
  });

  it('says "already confirmed" when the link is used again', async () => {
    const link = linkIn(mail.at(-1), '/verify');
    const r = await post('/api/auth/verify', { token: link.searchParams.get('token') });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('already_verified');
    expect(body.tokens).toBeUndefined();
  });

  it('calls a forged link broken, not confirmed', async () => {
    const r = await post('/api/auth/verify', {
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4IiwidHlwZSI6ImVtYWlsX3ZlcmlmaWNhdGlvbiJ9.bad',
    });
    expect((await r.json()).code).toBeUndefined();
  });

  it('refuses a taken username, in any case', async () => {
    const r = await post('/api/auth/register', {
      username: 'viewer_1',
      email: 'other@example.org',
      password: 'couch-potato',
    });
    expect((await r.json()).error).toContain('taken');
  });

  it('does not reveal that an email already has an account', async () => {
    const r = await post('/api/auth/register', {
      username: 'someone',
      email: 'viewer@example.org',
      password: 'couch-potato',
    });
    expect(r.status).toBe(200);
  });
});

describe('sign in', () => {
  it('takes a username or an email', async () => {
    const byName = await post('/api/auth/login', { login: 'VIEWER_1', password: 'couch-potato' });
    expect(byName.status).toBe(200);
    const byMail = await (
      await post('/api/auth/login', { login: 'viewer@example.org', password: 'couch-potato' })
    ).json();
    session = byMail.tokens;
    expect(byMail.user.username).toBe('Viewer_1');
  });
  it('says the same thing for a wrong password and an unknown user', async () => {
    const a = await (await post('/api/auth/login', { login: 'viewer_1', password: 'nope-nope' })).json();
    const b = await (await post('/api/auth/login', { login: 'ghost', password: 'nope-nope' })).json();
    expect(a.error).toBe(b.error);
  });
});

describe('library', () => {
  const get = (token) => fetch(at('/api/library'), { headers: { authorization: `Bearer ${token}` } });
  const put = (token, body) =>
    fetch(at('/api/library'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  it('needs a session', async () => {
    expect((await fetch(at('/api/library'))).status).toBe(401);
  });
  it('round-trips, and refuses a write based on an old version', async () => {
    expect(await (await get(session.accessToken)).json()).toEqual({ data: null, version: 0 });
    const data = {
      playlists: [
        { id: 'p1', name: 'Home', source: { type: 'xtream', server: 'http://h', username: 'u', password: 'secret' } },
      ],
      favorites: { p1: ['a', 'b'] },
    };
    const w = await (await put(session.accessToken, { data, baseVersion: 0 })).json();
    expect(w.version).toBe(1);
    expect((await (await get(session.accessToken)).json()).data).toEqual(data);
    const stale = await put(session.accessToken, { data: {}, baseVersion: 0 });
    expect(stale.status).toBe(409);
  });
});

describe('password reset', () => {
  it('emails a link that sets a new password', async () => {
    await post('/api/auth/forgot', { email: 'viewer@example.org' });
    const link = linkIn(mail.at(-1), '/reset');
    const r = await post('/api/auth/reset', { token: link.searchParams.get('token'), password: 'new-couch-potato' });
    expect(r.status).toBe(200);
    expect((await post('/api/auth/login', { login: 'viewer_1', password: 'new-couch-potato' })).status).toBe(200);
  });
  it('answers the same for an unknown address', async () => {
    const before = mail.length;
    expect((await post('/api/auth/forgot', { email: 'nobody@example.org' })).status).toBe(200);
    expect(mail.length).toBe(before);
  });
});

describe('OAuth 2.1 for the CLI and TUI', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = {
    response_type: 'code',
    client_id: 'hdtilt-cli',
    redirect_uri: 'http://127.0.0.1:43210/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st8',
  };
  let tokens;

  it('publishes its metadata', async () => {
    const m = await (await fetch(at('/.well-known/oauth-authorization-server'))).json();
    expect(m).toMatchObject({
      issuer: 'https://hdtilt.test',
      token_endpoint: 'https://hdtilt.test/oauth/token',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('shows consent, then issues a code a PKCE verifier can redeem', async () => {
    const s = (await (await post('/api/auth/login', { login: 'viewer_1', password: 'new-couch-potato' })).json())
      .tokens;
    const info = await (await post('/api/oauth/authorize', { query }, s.accessToken)).json();
    expect(info.clientName).toBe('hdtilt CLI and TUI');
    const { redirect } = await (
      await post('/api/oauth/authorize', { query, decision: 'approve' }, s.accessToken)
    ).json();
    const u = new URL(redirect);
    expect(u.searchParams.get('state')).toBe('st8');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: u.searchParams.get('code'),
      redirect_uri: query.redirect_uri,
      client_id: 'hdtilt-cli',
      code_verifier: verifier,
    });
    tokens = await (
      await fetch(at('/oauth/token'), {
        method: 'POST',
        body: form,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).json();
    expect(tokens.access_token.startsWith('ht_at_')).toBe(true);
  });

  it('lets that token read the same library', async () => {
    const r = await fetch(at('/api/library'), { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect((await r.json()).data.favorites.p1).toEqual(['a', 'b']);
  });

  it('cannot approve more sign-ins with an OAuth token', async () => {
    expect((await post('/api/oauth/authorize', { query, decision: 'approve' }, tokens.access_token)).status).toBe(403);
  });

  it('rotates on refresh and revokes the family', async () => {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: 'hdtilt-cli',
    });
    const next = await (await fetch(at('/oauth/token'), { method: 'POST', body: form })).json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    await fetch(at('/oauth/revoke'), { method: 'POST', body: new URLSearchParams({ token: next.refresh_token }) });
    expect(
      (await fetch(at('/api/library'), { headers: { authorization: `Bearer ${next.access_token}` } })).status,
    ).toBe(401);
  });

  it('refuses a missing PKCE challenge', async () => {
    const s = (await (await post('/api/auth/login', { login: 'viewer_1', password: 'new-couch-potato' })).json())
      .tokens;
    const r = await post('/api/oauth/authorize', { query: { ...query, code_challenge: '' } }, s.accessToken);
    expect(r.status).toBe(400);
  });
});

describe('rate limit', () => {
  it('turns away the 21st sign-in attempt in a minute', async () => {
    const accounts = createAccounts({
      adapter: new MemoryAdapter(),
      sendEmail: async () => {},
      env: { HDTILT_JWT_SECRET: 'x'.repeat(40) },
    });
    const s2 = await startServer({ port: 0, public: true, accounts });
    const url = `http://127.0.0.1:${s2.address().port}/api/auth/login`;
    const codes = [];
    for (let i = 0; i < 21; i++) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"login":"a","password":"b"}',
      });
      codes.push(r.status);
    }
    s2.close();
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});
