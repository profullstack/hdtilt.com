import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createCrawlGate } from '../src/server/crawl.js';
import { startServer } from '../src/server/server.js';

const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CHROME = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-dest': 'document',
};
let s;
const at = (p) => `http://127.0.0.1:${s.address().port}${p}`;

beforeAll(async () => {
  const gate = createCrawlGate({
    COINPAY_X402_KEY: 'cp_live_test',
    CRAWL_PAY_TO: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
  });
  s = await startServer({ port: 0, public: true, crawlGate: gate });
});
afterAll(() => s.close());

describe('crawl gateway', () => {
  it('is off without a key', () => {
    expect(createCrawlGate({})).toBeNull();
  });
  it('charges GPTBot with a PAYMENT-REQUIRED offer', async () => {
    const r = await fetch(at('/'), { headers: { 'user-agent': GPT } });
    expect(r.status).toBe(402);
    expect(r.headers.get('payment-required')).toBeTruthy();
  });
  it('sells a day pass on /crawl', async () => {
    const r = await fetch(at('/crawl'), { headers: { accept: 'application/json' } });
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.accepts[0].amount).toBe('1000000');
  });
  it('lets a browser and the health check through', async () => {
    expect((await fetch(at('/api/health'), { headers: { 'user-agent': GPT } })).status).toBe(200);
    expect((await fetch(at('/'), { headers: CHROME })).status).not.toBe(402);
  });
});
