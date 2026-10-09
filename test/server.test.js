import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyPath } from '../src/core/util.js';
import { startServer } from '../src/server/server.js';
import { fakeProvider } from './fixtures.js';

let P;
let local;
let pub;
let home;
const at = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
const post = (s, p, body) =>
  fetch(at(s, p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  home = await mkdtemp(
    join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'hdtilt-'),
  );
  process.env.HDTILT_HOME = join(home, 'config');
  process.env.HDTILT_CACHE = join(home, 'cache');
  P = await fakeProvider();
  local = await startServer({ port: 0, public: false });
  pub = await startServer({ port: 0, public: true });
});
afterAll(async () => {
  P.close();
  local.close();
  pub.close();
  await rm(home, { recursive: true, force: true });
});

describe('API', () => {
  it('reports health and mode', async () => {
    expect(await (await fetch(at(pub, '/api/health'))).json()).toMatchObject({ ok: true, public: true });
  });
  it('loads a playlist and its guide', async () => {
    const r = await (await post(local, '/api/load', { source: { type: 'm3u', url: `${P.base}/list.m3u` } })).json();
    expect(r.channels).toHaveLength(3);
    expect(r.groups[0]).toEqual({ name: 'News', count: 1 });
    const g = await (await post(local, '/api/guide', { url: r.epgUrl, channels: r.channels })).json();
    expect(g.programmes['news.test'].some((p) => p.title === 'The Hour')).toBe(true);
  });
  it('refuses private addresses in public mode', async () => {
    const res = await post(pub, '/api/load', { source: { type: 'm3u', url: `${P.base}/list.m3u` } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('private');
  });
  it('keeps no playlists in public mode', async () => {
    expect((await fetch(at(pub, '/api/playlists'))).status).toBe(404);
  });
  it('serves the app shell for unknown routes', async () => {
    const res = await fetch(at(local, '/some/route'));
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('proxy', () => {
  it('rewrites an HLS playlist back through itself', async () => {
    const res = await fetch(at(local, proxyPath(`${P.base}/hls/film.m3u8`, 'hls')));
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await res.text();
    const lines = text
      .split('\n')
      .filter((l) => l && !l.startsWith('#EXTINF') && l !== '#EXTM3U' && !l.startsWith('#EXT-X-TARGET'));
    expect(lines.every((l) => l.includes('/p/'))).toBe(true);
    expect(text).toContain('URI="/p/');
  });
  it('streams a transport stream through', async () => {
    const res = await fetch(at(local, proxyPath(`${P.base}/live/news.ts`, 'mpegts')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect((await res.arrayBuffer()).byteLength).toBe(188 * 4);
  });
  it('rejects a garbage token', async () => {
    expect((await fetch(at(local, '/p/!!!/x.ts'))).status).toBe(404);
    expect((await fetch(at(local, '/p/bm90IGEgdXJs/x.ts'))).status).toBe(400);
  });
});

describe('MCP over HTTP', () => {
  const rpc = (s, method, params) => post(s, '/mcp', { jsonrpc: '2.0', id: 1, method, params }).then((r) => r.json());
  it('initializes and hides saving tools in public mode', async () => {
    expect((await rpc(pub, 'initialize', {})).result.serverInfo.name).toBe('hdtilt');
    const names = (await rpc(pub, 'tools/list')).result.tools.map((t) => t.name);
    expect(names).toContain('whats_on');
    expect(names).not.toContain('add_playlist');
  });
  it('answers with a source passed inline', async () => {
    const r = await rpc(local, 'tools/call', {
      name: 'whats_on',
      arguments: { source: { type: 'm3u', url: `${P.base}/list.m3u` }, query: 'news' },
    });
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text)[0].now.title).toBe('The Hour');
  });
});

const cli = (args, input) =>
  new Promise((resolve) => {
    const p = spawn('node', ['bin/hdtilt.js', ...args], { env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input) {
      p.stdin.write(input);
      setTimeout(() => p.kill(), 1500);
    }
    p.on('close', (code) => resolve({ code, out, err }));
  });

describe('CLI + stdio MCP', () => {
  it('adds a playlist and answers what is on', async () => {
    const add = await cli(['add', 'test', `${P.base}/list.m3u`]);
    expect(add.out).toContain('3 channels in 2 groups, guide found');
    const now = await cli(['now', 'news']);
    expect(now.out).toContain('The Hour');
    const url = await cli(['url', '101']);
    expect(url.out.trim()).toBe(`${P.base}/live/news.ts`);
    const ch = await cli(['channels', '--json']);
    expect(JSON.parse(ch.out)).toHaveLength(3);
  });
  it('does not keep a playlist that fails to load', async () => {
    const r = await cli(['add', 'broken', `${P.base}/missing.m3u`]);
    expect(r.err).toContain('404');
    const list = await cli(['playlists', '--json']);
    expect(JSON.parse(list.out).map((p) => p.name)).not.toContain('broken');
  });
  it('speaks MCP on stdio against the saved playlist', async () => {
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_channels', arguments: { group: 'News' } } },
    ];
    const r = await cli(['mcp'], `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n`);
    const lines = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1].result.content[0].text).channels[0].name).toBe('News One');
  });
});
