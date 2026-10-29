// Sign in with CoinPay: CoinPay is the master account across the Profullstack
// fleet, and hdtilt is one of its relying parties.
//
// Authorization code + PKCE (S256) + state + nonce, confidential client (the
// secret goes with the code exchange). The id_token's issuer, audience, expiry
// and nonce are checked and userinfo's sub must match (all in
// @profullstack/coinpay-onboard/oauth).
//
// STANDING rule: an hdtilt account is bound to the CoinPay `sub` and nothing
// else. A CoinPay email that matches an existing account never signs into it
// (CoinPay does not verify addresses); linking CoinPay to an existing account
// happens only from that account, signed in ("Connect CoinPay"). A first
// CoinPay sign-in with no link makes a new account with a placeholder
// `.invalid` address that is never reported as verified.
//
// The browser holds the session in localStorage, so the callback cannot hand
// it over in a cookie: it leaves a single-use handoff code (two minutes, in
// this process) that the page swaps for tokens with POST /api/auth/coinpay.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  authorizeUrl,
  finishSignIn,
  pkce,
  randomToken,
  SIGN_IN_SCOPES,
  sameState,
} from '@profullstack/coinpay-onboard/oauth';

export const COINPAY_COOKIE = 'hdtilt_coinpay';
export const PLACEHOLDER_DOMAIN = 'coinpay.hdtilt.invalid';
const PENDING_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 2 * 60_000;

/** True for the made-up address a CoinPay-only account carries. */
export const isPlaceholderEmail = (email) =>
  String(email || '')
    .toLowerCase()
    .endsWith(`@${PLACEHOLDER_DOMAIN}`);

/** A same-site path to land on after sign-in; anything else becomes /home. */
export function safeNext(next) {
  const s = String(next || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\r\n]/.test(s) || s.length > 2000)
    return '/home';
  return s;
}

/** The pending request rides in an HttpOnly cookie, HMAC-signed with the client secret. */
export function sealPending(pending, key) {
  const body = Buffer.from(JSON.stringify(pending)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function openPending(value, key, now = Date.now()) {
  const [body, mac, extra] = String(value || '').split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p === 'object' && Number(p.exp) > now ? p : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ env: Record<string,string|undefined>, site: string, adapter: object, store: object,
 *   auth: object, publicUser: (u: object) => object, fetch?: typeof fetch, base?: string }} deps
 * @returns {null | object} null when no CoinPay client is configured
 */
export function createCoinpaySignIn({ env, site, adapter, store, auth, publicUser, fetch: doFetch, base }) {
  const clientId = env.COINPAY_OAUTH_CLIENT_ID;
  const clientSecret = env.COINPAY_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = `${site}/api/v1/coinpay/oauth/callback`;
  const handoffs = new Map(); // code -> { userId, next, exp }

  /** Begin: the authorize URL and the cookie value that proves this browser started it. */
  function start({ mode = 'login', userId = null, next } = {}) {
    if (mode === 'link' && !userId) throw Object.assign(new Error('Sign in first'), { status: 401 });
    const { verifier, challenge } = pkce();
    const state = randomToken();
    const nonce = randomToken();
    const cookie = sealPending(
      { state, verifier, nonce, mode, userId, next: safeNext(next), exp: Date.now() + PENDING_TTL_MS },
      clientSecret,
    );
    const url = authorizeUrl({ clientId, redirectUri, state, challenge, nonce, scopes: SIGN_IN_SCOPES, base });
    return { url, cookie, maxAge: PENDING_TTL_MS / 1000 };
  }

  /** A first CoinPay sign-in: a new account bound to the sub, never an existing one by email. */
  async function accountForSub(who) {
    const linked = await store.coinpayUser(who.sub);
    if (linked) return linked;
    const tag = createHash('sha256').update(who.sub).digest('hex').slice(0, 16);
    const user = await adapter.createUser({
      email: `cp-${tag}@${PLACEHOLDER_DOMAIN}`,
      password: null,
      emailVerified: false,
      profile: {
        username: `coinpay-${tag.slice(0, 10)}`,
        coinpayOnly: true,
        // Contact information only: CoinPay does not verify it.
        ...(who.email ? { contactEmail: who.email } : {}),
        ...(who.name ? { displayName: who.name } : {}),
      },
    });
    const bound = await store.linkCoinpay(who.sub, user.id, who.email);
    if (bound !== 'linked') {
      // Two first sign-ins raced: the other one won, use its account.
      await adapter.deleteUser(user.id).catch(() => {});
      return store.coinpayUser(who.sub);
    }
    return user.id;
  }

  /** The callback: query + the cookie in, where to send the browser out. */
  async function callback(query, cookieValue) {
    const pending = openPending(cookieValue, clientSecret);
    if (!pending || !sameState(pending.state, query.state)) return { redirect: '/oauth/coinpay?error=state' };
    const failed = pending.mode === 'link' ? '/account?coinpay=' : '/oauth/coinpay?error=';
    if (query.error) return { redirect: `${failed}denied` };
    if (!query.code) return { redirect: `${failed}failed` };
    let who;
    try {
      const r = await finishSignIn({
        code: String(query.code),
        verifier: pending.verifier,
        nonce: pending.nonce,
        clientId,
        clientSecret,
        redirectUri,
        base,
        fetch: doFetch,
      });
      who = { sub: r.sub, email: r.email, name: r.name };
    } catch (e) {
      console.error(`hdtilt: CoinPay sign-in failed: ${e.message}`);
      return { redirect: `${failed}failed` };
    }
    if (pending.mode === 'link') {
      if (!(await adapter.getUserById(pending.userId))) return { redirect: '/account?coinpay=failed' };
      const outcome = await store.linkCoinpay(who.sub, pending.userId, who.email);
      return { redirect: `/account?coinpay=${outcome}` };
    }
    const userId = await accountForSub(who);
    if (!userId) return { redirect: '/oauth/coinpay?error=failed' };
    const code = randomToken();
    const now = Date.now();
    for (const [k, v] of handoffs) if (v.exp < now) handoffs.delete(k);
    handoffs.set(code, { userId, next: pending.next, exp: now + HANDOFF_TTL_MS });
    return { redirect: `/oauth/coinpay?code=${encodeURIComponent(code)}` };
  }

  /** POST /api/auth/coinpay { code }: the session, once. */
  async function exchange(code) {
    const h = handoffs.get(String(code || ''));
    handoffs.delete(String(code || ''));
    if (!h || h.exp < Date.now()) throw new Error('That sign-in link has expired; try Sign in with CoinPay again');
    const u = await adapter.getUserById(h.userId);
    if (!u) throw new Error('No such account');
    const tokens = await auth.tokenUtils.generateTokens(u.id);
    return { user: publicUser(u), tokens, next: h.next };
  }

  async function status(userId) {
    const link = await store.coinpayForUser(userId);
    const u = await adapter.getUserById(userId);
    return { linked: Boolean(link), coinpayOnly: Boolean(u && isCoinpayOnly(u)), since: link?.createdAt || null };
  }

  /** Disconnect, unless CoinPay is the only way into this account. */
  async function unlink(userId) {
    const u = await adapter.getUserById(userId);
    if (!u) throw Object.assign(new Error('No such account'), { status: 400 });
    if (isCoinpayOnly(u))
      throw Object.assign(new Error('CoinPay is the only way into this account, so it stays connected'), {
        status: 409,
      });
    await store.unlinkCoinpay(userId);
    return { linked: false };
  }

  return { start, callback, exchange, status, unlink, redirectUri, clientId };
}

/** An account with no password and no real address: CoinPay is its only way in. */
export const isCoinpayOnly = (u) => isPlaceholderEmail(u.email) || Boolean(u.profile?.coinpayOnly);
