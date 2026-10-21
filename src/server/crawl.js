// The crawl door on hdtilt.com: AI training crawlers, headless browsers and SEO
// scrapers buy a day pass ($1 a day over x402, or any coin / PayPal through
// CoinPay's hosted checkout) on /crawl, and get a 402 everywhere else. People,
// verified search crawlers and AI chat/search fetchers are never charged, nor is
// a signed-in viewer. Built only with a scoped key and a payee, so a self-hosted
// or desktop server never sells anything.

import { createGateway } from '@profullstack/x402-gateway';

/** @param {NodeJS.ProcessEnv} env */
export function createCrawlGate(env = process.env) {
  const apiKey = env.COINPAY_X402_KEY || '';
  const payTo = env.CRAWL_PAY_TO || '';
  if (!apiKey || !payTo) return null;
  return createGateway({
    siteUrl: (env.SITE_URL || 'https://hdtilt.com').replace(/\/+$/, ''),
    siteName: 'hdtilt',
    coinpay: { apiKey },
    payTo,
    contact: 'mailto:anthony@profullstack.com',
    openPaths: ['/api/health', '/llms.txt', '/install.sh', '/.well-known/'],
    exempt: (request) => /(?:^|;\s*)hdtilt_media=/.test(request.headers.get('cookie') ?? ''),
  });
}

/** A fetch Request built from a Node one; the body only for the gateway's own POSTs. */
async function requestFor(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  if (!headers.has('x-forwarded-for') && req.socket?.remoteAddress)
    headers.set('x-forwarded-for', req.socket.remoteAddress);
  const method = req.method || 'GET';
  const url = `http://localhost${req.url || '/'}`;
  let body;
  if (method === 'POST' && /^\/crawl(?:\/|$)/.test(new URL(url).pathname)) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) break;
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method, headers, body });
}

/** Answer the request from the gateway if it has something to say. True when it did. */
export async function crawlAnswer(gate, req, res) {
  const answer = await gate.handle(await requestFor(req));
  if (!answer) return false;
  const headers = {};
  answer.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const cookies = answer.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(answer.status, headers);
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await answer.arrayBuffer()));
  return true;
}
