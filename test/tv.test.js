import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MemoryAdapter } from '@profullstack/auth-system';
import { createAccounts } from '../src/server/accounts.js';
import { startServer } from '../src/server/server.js';
import { createDeviceFlow, normaliseUserCode, rokuPlay } from '../src/server/tv.js';
import { fakeProvider } from './fixtures.js';

let P;
let srv;
let base;
let session;
const mail = [];
const at = (p) => `${base}${p}`;
const post = (p, body, token) =>
  fetch(at(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const form = (p, fields) =>
  fetch(at(p), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

beforeAll(async () => {
  P = await fakeProvider();
  const accounts = createAccounts({
    adapter: new MemoryAdapter(),
    sendEmail: async (m) => mail.push(m),
    env: { SITE_URL: 'https://hdtilt.test', HDTILT_JWT_SECRET: 'test-secret-test-secret-test-secret' },
  });
  srv = await startServer({ port: 0, public: true, accounts, authPerMinute: 1000, allowPrivate: true, remux: false });
  base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await post('/api/auth/register', {
    username: 'tvfan',
    email: 'tv@example.org',
    password: 'couch-potato',
    first_name: 'Tee',
    last_name: 'Vee',
  });
  if (!mail.length) throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const token = new URL(mail[0].text.match(/https?:\/\/\S+\/verify\?token=\S+/)[0]).searchParams.get('token');
  await post('/api/auth/verify', { token });
  session = (await (await post('/api/auth/login', { login: 'tvfan', password: 'couch-potato' })).json()).tokens;
});
afterAll(() => {
  srv.close();
  P.close();
});

describe('user codes', () => {
  it('reads what people type', () => {
    expect(normaliseUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
    expect(normaliseUserCode(' bcdfghjk ')).toBe('BCDF-GHJK');
    expect(normaliseUserCode('bcd')).toBeNull();
  });
});

describe('device sign-in', () => {
  let dev;
  it('hands the TV a code and a place to enter it', async () => {
    dev = await (await form('/oauth/device_authorization', { client_id: 'hdtilt-tv' })).json();
    expect(dev.user_code).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
    expect(dev.verification_uri).toBe('https://hdtilt.test/link');
    expect(dev.interval).toBe(5);
  });

  it('refuses other clients', async () => {
    const r = await form('/oauth/device_authorization', { client_id: 'nope' });
    expect(r.status).toBe(401);
  });

  it('says pending until someone approves', async () => {
    const r = await form('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dev.device_code,
      client_id: 'hdtilt-tv',
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('authorization_pending');
  });

  it('needs a website session to approve, not a guess', async () => {
    expect((await post('/api/oauth/device', { code: dev.user_code })).status).toBe(401);
    const bad = await post('/api/oauth/device', { code: 'BBBB-BBBB', decision: 'approve' }, session.accessToken);
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('turns an approval into tokens for the TV, once', async () => {
    const info = await (
      await post('/api/oauth/device', { code: dev.user_code.toLowerCase() }, session.accessToken)
    ).json();
    expect(info.clientName).toBe('hdtilt on your TV');
    const ok = await post('/api/oauth/device', { code: dev.user_code, decision: 'approve' }, session.accessToken);
    expect(ok.status).toBe(200);
    const fields = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dev.device_code,
      client_id: 'hdtilt-tv',
    };
    const t = await (await form('/oauth/token', fields)).json();
    expect(t.access_token.startsWith('ht_at_')).toBe(true);
    expect(t.refresh_token).toBeTruthy();
    const again = await form('/oauth/token', fields);
    expect((await again.json()).error).toBe('expired_token');
    // The TV token is an ordinary one: it reads the account and refreshes.
    const me = await (await fetch(at('/api/me'), { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    expect(me.user?.username ?? me.username).toBe('tvfan');
    const r = await (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: 'hdtilt-tv',
      })
    ).json();
    expect(r.access_token.startsWith('ht_at_')).toBe(true);
    // ...but it cannot approve other TVs.
    const d2 = await (await form('/oauth/device_authorization', { client_id: 'hdtilt-tv' })).json();
    expect((await post('/api/oauth/device', { code: d2.user_code, decision: 'approve' }, t.access_token)).status).toBe(
      403,
    );
  });

  it('tells the TV when the person said no', async () => {
    const d = await (await form('/oauth/device_authorization', { client_id: 'hdtilt-tv' })).json();
    await post('/api/oauth/device', { code: d.user_code, decision: 'deny' }, session.accessToken);
    const r = await form('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: d.device_code,
      client_id: 'hdtilt-tv',
    });
    expect((await r.json()).error).toBe('access_denied');
  });

  it('expires codes', async () => {
    let t = 0;
    const flow = createDeviceFlow({ oauth: {}, site: 'https://x', now: () => t });
    const d = flow.start({ client_id: 'hdtilt-tv' });
    t += 11 * 60_000;
    await expect(flow.poll({ device_code: d.device_code, client_id: 'hdtilt-tv' })).rejects.toThrow('expired');
    expect(() => flow.lookup(d.user_code)).toThrow();
  });
});

describe('TV data', () => {
  const source = () => ({ type: 'm3u', url: `${P.base}/list.m3u` });

  it('needs a sign-in on hdtilt.com', async () => {
    expect((await post('/api/tv/load', { source: source() })).status).toBe(401);
  });

  it('loads groups and a media cookie', async () => {
    const r = await (await post('/api/tv/load', { source: source() }, session.accessToken)).json();
    expect(r.total).toBe(3);
    expect(r.groups.map((g) => g.name)).toEqual(['News', 'Movies, Classics']);
    expect(r.media).toMatch(/^hdtilt_media=/);
    // The cookie lets a Roku through the stream proxy.
    const hls = await fetch(at('/hls/abc/index.m3u8'), { headers: { cookie: r.media } });
    expect(hls.status).not.toBe(401);
  });

  it('pages a group, filters, and picks channels by id', async () => {
    const g = await (
      await post('/api/tv/channels', { source: source(), group: 'Movies, Classics', limit: 1 }, session.accessToken)
    ).json();
    expect(g.total).toBe(2);
    expect(g.items).toHaveLength(1);
    expect(g.items[0].play).toEqual({ url: `${P.base}/hls/film.m3u8`, format: 'hls' });
    const q = await (await post('/api/tv/channels', { source: source(), q: 'one news' }, session.accessToken)).json();
    expect(q.items.map((c) => c.name)).toEqual(['News One']);
    expect(q.items[0].chno).toBe(101);
    const ids = await (
      await post('/api/tv/channels', { source: source(), ids: ['news.test', 'missing'] }, session.accessToken)
    ).json();
    expect(ids.items.map((c) => c.id)).toEqual(['news.test']);
  });

  it('reports a provider that fails', async () => {
    const r = await post(
      '/api/tv/load',
      { source: { type: 'm3u', url: `${P.base}/missing.m3u` } },
      session.accessToken,
    );
    expect(r.status).toBe(502);
  });
});

describe('Roku play URLs', () => {
  it('plays what a Roku decodes direct, and remuxes transport streams', () => {
    expect(rokuPlay('http://p/x.m3u8')).toEqual({ url: 'http://p/x.m3u8', format: 'hls' });
    const sw = rokuPlay('http://p/live/u/p/1.ts', { m3u8: true });
    expect(sw).toMatchObject({ url: 'http://p/live/u/p/1.m3u8', format: 'hls' });
    expect(sw.fallback).toMatch(/^\/hls\/[A-Za-z0-9_-]+\/index\.m3u8$/);
    const ts = rokuPlay('http://p/live/u/p/1.ts');
    expect(ts.format).toBe('hls');
    expect(ts.url).toMatch(/^\/hls\/[A-Za-z0-9_-]+\/index\.m3u8$/);
    expect(ts.media).toBe(true);
    expect(rokuPlay('http://p/live/u/p/1.ts', { remux: false })).toEqual({
      url: 'http://p/live/u/p/1.ts',
      format: 'ts',
    });
    const mkv = rokuPlay('http://p/movie/u/p/1.mkv', { kind: 'vod' });
    expect(mkv).toMatchObject({ url: 'http://p/movie/u/p/1.mkv', format: 'mkv' });
    expect(mkv.fallback).toMatch(/\?vod=1$/);
    expect(rokuPlay('http://p/movie/u/p/1.mkv', { kind: 'vod', remux: false })).toEqual({
      url: 'http://p/movie/u/p/1.mkv',
      format: 'mkv',
    });
    expect(rokuPlay('http://p/movie/u/p/1.mov', { kind: 'vod' }).format).toBe('mp4');
    expect(rokuPlay('http://p/movie/u/p/1.avi', { kind: 'vod' }).url).toMatch(/\?vod=1$/);
  });
});
