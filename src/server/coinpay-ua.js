// Every server-side call to CoinPay (x402 verify/settle, hosted checkout, OAuth
// token + userinfo) names this app, so CoinPay's logs and throttle can tell the
// fleet's apps apart instead of seeing a bare `Bun/x.y.z` from one shared IP.

import { VERSION } from '../version.js';

export const COINPAY_UA = `hdtilt.com/${VERSION} (+https://hdtilt.com)`;

/** fetch with our User-Agent added (kept if the caller already set one). */
export function coinpayFetch(input, init = {}) {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('user-agent')) headers.set('user-agent', COINPAY_UA);
  return fetch(input, { ...init, headers });
}
