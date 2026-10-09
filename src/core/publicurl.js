import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Ported from tipoffwatch.com packages/playlists/src/publicurl.js.
 *
 * The guard that makes proxying a THIRD-PARTY url safe.
 *
 * Every other stream this app opens is a url the reader themselves supplied:
 * their own provider line, or one shared with them by its owner. Proxying that
 * grants nobody anything they did not already have, so `openStream` fetches it
 * without asking where it points.
 *
 * A public news channel is different in exactly one way that matters: the url
 * comes from iptv-org, by way of nichedb, and nobody in that chain is us. An
 * attacker who lands a url in that directory would otherwise have our server
 * fetch it from INSIDE the deployment -- and this deployment has a private
 * network with Postgres and Redis on it, reachable at names like
 * `postgres.railway.internal` that resolve to addresses no reader can reach.
 * That is server-side request forgery, and the fix is to refuse before
 * connecting rather than to hope the directory stays clean.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * 1. **Resolve the name, then judge the ADDRESS.** A hostname allowlist is not a
 *    defence: `internal.evil.com` is a perfectly ordinary public name with an A
 *    record pointing at 10.0.0.5.
 * 2. **Never follow a redirect blindly.** A public url may 302 to a private one,
 *    which is the same attack with an extra step, so `fetchPublic` walks the
 *    hops itself and re-checks each.
 */

/** Ranges that are not routable on the public internet, per IANA. */
const V4_BLOCKED = [
  [[0, 0, 0, 0], 8], // this network
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, and the cloud metadata address
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, includes broadcast
];

const v4ToInt = (parts) => ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];

export function isPrivateIpv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable is not provably public
  }
  const value = v4ToInt(parts);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(base) & mask);
  });
}

export function isPrivateIpv6(ip) {
  const raw = String(ip).toLowerCase().split('%')[0];
  if (raw === '::1' || raw === '::') return true;
  // ::ffff:10.0.0.1 is IPv4 wearing a hat, and the hat is not a defence.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // fc00::/7 unique-local, fe80::/10 link-local, plus multicast.
  return /^(f[cd]|fe[89ab]|ff)/.test(raw);
}

export const isPrivateIp = (ip) => (ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip));

/**
 * Resolve a url and refuse it unless every address it answers with is public.
 *
 * `all: true` matters: a name with one public and one private address is not
 * half safe, because which one connect(2) picks is not ours to decide.
 *
 * @param {string} raw
 * @param {{ lookup?: Function }} [opts] injectable so the refusal branches are
 *   testable without a DNS server that answers with 127.0.0.1.
 */
export async function assertPublicUrl(raw, { lookup = dnsLookup, allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('not a url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing ${url.protocol} url`);
  }
  // A local install proxies the owner's own network on purpose: a tuner on the
  // LAN is a source, not an attack.
  if (allowPrivate) return url;
  // A literal address skips DNS but not the check.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/\.(internal|local|localdomain)$/i.test(host) || host === 'localhost') {
    throw new Error('refusing an internal hostname');
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('could not resolve host');
  }
  if (!addresses?.length) throw new Error('host resolved to nothing');
  for (const a of addresses) {
    if (isPrivateIp(a.address)) throw new Error('refusing a private address');
  }
  return url;
}

/**
 * Fetch a third-party url, re-checking the destination at every hop.
 *
 * `redirect: 'manual'` rather than 'follow', because 'follow' would do the last
 * hop's connect without ever showing it to `assertPublicUrl` -- which is the
 * whole point of this function.
 */
/**
 * How long to wait for a channel to answer at all.
 *
 * Bounds reaching the provider, not watching it: it is cleared the moment the
 * headers arrive, because a timeout that survived into playback would cut a
 * live channel off mid-stream. Measured in production before this existed, a
 * dead channel held a request open for the full 30 seconds a client would
 * wait — and these are other people's streams, so some of them are always dead.
 */
const CONNECT_TIMEOUT_MS = 8000;

export async function fetchPublic(
  raw,
  { signal, headers = {}, maxHops = 3, lookup, allowPrivate = false, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {},
) {
  let target = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const url = await assertPublicUrl(target, { lookup, allowPrivate });

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, connectTimeoutMs);

    let res;
    try {
      res = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) throw new Error('closed');
      throw new Error(err?.name === 'AbortError' ? 'timed out' : 'could not connect');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!location) throw new Error('redirect with no location');
      target = new URL(location, url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error('too many redirects');
}
