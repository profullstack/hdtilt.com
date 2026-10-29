import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MemoryAdapter } from '@profullstack/auth-system';
import { createAccounts } from '../src/server/accounts.js';
import { openPending, safeNext, sealPending } from '../src/server/coinpay.js';
import { startServer } from '../src/server/server.js';

// A stand-in for coinpayportal.com: codes it "issued" map to who signed in and
// the nonce to put in the id_token.
const CLIENT_ID = 'cp_test_client';
const ISSUER = 'https://coinpay.test';
const grants = new Map(); // code -> { sub, email, nonce }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeCoinpay = async (url, init = {}) => {
  const u = new URL(String(url));
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/api/oauth/token') {
    const p = new URLSearchParams(String(init.body));
    const g = grants.get(p.get('code'));
    if (!g || p.get('client_secret') !== 'test-client-secret' || !p.get('code_verifier'))
      return json(400, { error: 'invalid_grant' });
    grants.delete(p.get('code'));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const idToken = `${b64({ alg: 'RS256' })}.${b64({ iss: ISSUER, aud: CLIENT_ID, sub: g.sub, exp, nonce: g.nonce, email: g.email })}.sig`;
    return json(200, {
      access_token: `at:${g.sub}:${g.email}`,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    });
  }
  if (u.pathname === '/api/oauth/userinfo') {
    const [, sub, email] = String(init.headers.authorization).replace('Bearer ', '').split(':');
    return json(200, { sub, email, email_verified: false });
  }
  return json(404, {});
};

let srv;
let base;
let accounts;
const at = (p) => `${base}${p}`;
const cookieFrom = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const post = (p, body, token) =>
  fetch(at(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** Start a login, "consent" at the fake CoinPay as `who`, come back. Returns the callback's redirect. */
async function signInAs(who, { next = '/home', tamper = {} } = {}) {
  const start = await fetch(at(`/api/v1/coinpay/oauth/start?next=${encodeURIComponent(next)}`), { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  const code = `code-${Math.random()}`;
  grants.set(code, { ...who, nonce: tamper.nonce ?? to.searchParams.get('nonce') });
  const cb = await fetch(
    at(
      `/api/v1/coinpay/oauth/callback?code=${code}&state=${encodeURIComponent(tamper.state ?? to.searchParams.get('state'))}`,
    ),
    { redirect: 'manual', headers: { cookie: tamper.cookie ?? cookieFrom(start) } },
  );
  return cb.headers.get('location');
}

async function sessionFor(who) {
  const loc = await signInAs(who);
  const code = new URL(loc, 'http://x').searchParams.get('code');
  const r = await post('/api/auth/coinpay', { code });
  return { status: r.status, ...(await r.json()) };
}

beforeAll(async () => {
  accounts = createAccounts({
    adapter: new MemoryAdapter(),
    sendEmail: async () => {},
    coinpayFetch: fakeCoinpay,
    env: {
      SITE_URL: 'https://hdtilt.test',
      HDTILT_JWT_SECRET: 'test-secret-test-secret-test-secret',
      COINPAY_OAUTH_CLIENT_ID: CLIENT_ID,
      COINPAY_OAUTH_CLIENT_SECRET: 'test-client-secret',
      COINPAY_BASE_URL: ISSUER,
    },
  });
  srv = await startServer({ port: 0, public: true, accounts, authPerMinute: 1000, crawlGate: null, remux: false });
  base = `http://127.0.0.1:${srv.address().port}`;
  // An existing password account whose address an attacker will use at CoinPay.
  await accounts.auth.register({
    email: 'victim@example.org',
    password: 'couch-potato',
    profile: { username: 'victim' },
    autoVerify: true,
  });
});
afterAll(() => srv.close());

describe('Sign in with CoinPay', () => {
  it('says it is on, and starts with PKCE S256, state, nonce and the exact redirect', async () => {
    expect((await (await fetch(at('/api/health'))).json()).coinpay).toBe(true);
    const r = await fetch(at('/api/v1/coinpay/oauth/start'), { redirect: 'manual' });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get('location'));
    expect(to.origin + to.pathname).toBe(`${ISSUER}/api/oauth/authorize`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('code_challenge')).toBeTruthy();
    expect(to.searchParams.get('state')).toBeTruthy();
    expect(to.searchParams.get('nonce')).toBeTruthy();
    expect(to.searchParams.get('scope')).toBe('openid profile email');
    expect(to.searchParams.get('redirect_uri')).toBe('https://hdtilt.test/api/v1/coinpay/oauth/callback');
    expect(r.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('a new CoinPay user gets a new account, and the handoff code works once', async () => {
    const loc = await signInAs({ sub: 'sub-new', email: 'new@example.org' });
    expect(loc).toStartWith('/oauth/coinpay?code=');
    const code = new URL(loc, 'http://x').searchParams.get('code');
    const r = await post('/api/auth/coinpay', { code });
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.tokens.accessToken).toBeTruthy();
    expect(s.user.email).toBeNull(); // the placeholder is nobody's address
    expect(s.user.emailVerified).toBe(false);
    expect(s.user.coinpayOnly).toBe(true);
    expect(s.next).toBe('/home');
    const me = await (
      await fetch(at('/api/me'), { headers: { authorization: `Bearer ${s.tokens.accessToken}` } })
    ).json();
    expect(me.id).toBe(s.user.id);
    expect((await post('/api/auth/coinpay', { code })).status).toBe(400);
    // The same sub next time: the same account.
    expect((await sessionFor({ sub: 'sub-new', email: 'new@example.org' })).user.id).toBe(s.user.id);
  });

  it('an email that matches an existing account does NOT sign into it', async () => {
    const victim = await accounts.login({ login: 'victim', password: 'couch-potato' });
    const s = await sessionFor({ sub: 'sub-attacker', email: 'victim@example.org' });
    expect(s.status).toBe(200);
    expect(s.user.id).not.toBe(victim.user.id);
    expect(s.user.email).toBeNull();
    // The real owner still signs in with their password, to their own account.
    expect((await accounts.login({ login: 'victim@example.org', password: 'couch-potato' })).user.id).toBe(
      victim.user.id,
    );
  });

  it('rejects a bad state, a missing or forged cookie, and a bad nonce', async () => {
    expect(await signInAs({ sub: 's1', email: 'a@b.co' }, { tamper: { state: 'nope' } })).toBe(
      '/oauth/coinpay?error=state',
    );
    expect(await signInAs({ sub: 's1', email: 'a@b.co' }, { tamper: { cookie: '' } })).toBe(
      '/oauth/coinpay?error=state',
    );
    const forged = sealPending(
      { state: 'x', verifier: 'v', nonce: 'n', mode: 'link', userId: 'someone', exp: Date.now() + 60_000 },
      'not-the-secret',
    );
    const r = await fetch(at('/api/v1/coinpay/oauth/callback?code=c&state=x'), {
      redirect: 'manual',
      headers: { cookie: `hdtilt_coinpay=${encodeURIComponent(forged)}` },
    });
    expect(r.headers.get('location')).toBe('/oauth/coinpay?error=state');
    expect(await signInAs({ sub: 's1', email: 'a@b.co' }, { tamper: { nonce: 'wrong' } })).toBe(
      '/oauth/coinpay?error=failed',
    );
  });

  it('a CoinPay-only account cannot be signed into with a password', async () => {
    const r = await post('/api/auth/login', { login: 'cp-anything@coinpay.hdtilt.invalid', password: 'x' });
    expect(r.status).toBe(401);
  });

  it('linking needs a signed-in session; then the CoinPay login lands on that account', async () => {
    expect((await fetch(at('/api/v1/coinpay/link'), { method: 'POST' })).status).toBe(401);
    expect((await fetch(at('/api/v1/coinpay/link'))).status).toBe(401);
    const victim = await accounts.login({ login: 'victim', password: 'couch-potato' });
    const token = victim.tokens.accessToken;
    const status = await (
      await fetch(at('/api/v1/coinpay/link'), { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(status.linked).toBe(false);
    const start = await post('/api/v1/coinpay/link', {}, token);
    expect(start.status).toBe(200);
    const to = new URL((await start.json()).url);
    const code = 'link-code';
    grants.set(code, { sub: 'sub-victim', email: 'whatever@example.org', nonce: to.searchParams.get('nonce') });
    const cb = await fetch(at(`/api/v1/coinpay/oauth/callback?code=${code}&state=${to.searchParams.get('state')}`), {
      redirect: 'manual',
      headers: { cookie: cookieFrom(start) },
    });
    expect(cb.headers.get('location')).toBe('/account?coinpay=linked');
    expect((await sessionFor({ sub: 'sub-victim', email: 'x@y.co' })).user.id).toBe(victim.user.id);

    // A sub already bound to another account cannot be linked here.
    const again = await post('/api/v1/coinpay/link', {}, token);
    const to2 = new URL((await again.json()).url);
    grants.set('link-2', { sub: 'sub-new', email: 'new@example.org', nonce: to2.searchParams.get('nonce') });
    const cb2 = await fetch(at(`/api/v1/coinpay/oauth/callback?code=link-2&state=${to2.searchParams.get('state')}`), {
      redirect: 'manual',
      headers: { cookie: cookieFrom(again) },
    });
    expect(cb2.headers.get('location')).toBe('/account?coinpay=taken');

    // Disconnect works for a password account...
    const off = await fetch(at('/api/v1/coinpay/link'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await off.json()).linked).toBe(false);
    // ...and is refused when CoinPay is the only way in.
    const only = await sessionFor({ sub: 'sub-new', email: 'new@example.org' });
    const refused = await fetch(at('/api/v1/coinpay/link'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${only.tokens.accessToken}` },
    });
    expect(refused.status).toBe(409);
  });

  it('only same-site paths are followed after sign-in', () => {
    expect(safeNext('/oauth/authorize?client_id=hdtilt-cli')).toBe('/oauth/authorize?client_id=hdtilt-cli');
    expect(safeNext('//evil.example')).toBe('/home');
    expect(safeNext('https://evil.example')).toBe('/home');
    expect(safeNext('/\\evil.example')).toBe('/home');
    expect(openPending('garbage', 'k')).toBeNull();
  });
});
