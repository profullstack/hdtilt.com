// Two footers render into index.html's markers on every page load:
//
// - <!--pfs-footer-->: the shared Profullstack footer (@profullstack/footer,
//   copyright + webring) from the @latest template on jsDelivr (cached an hour
//   by the package; the bundled template if the CDN is down).
// - <!--pit-footer-->: the pit.world network footer, fetched server side from
//   https://pit.world/snippets/footer.html, last in the page. It refetches at
//   most hourly with a 3-second timeout; on failure it keeps the last good
//   copy, or renders nothing, so pit.world being down never breaks the page.
import { footerHtml } from '@profullstack/footer';

const RING_OPTIONS = { site: 'https://hdtilt.com/' };
const RING_REGION = /<!--pfs-footer-->[\s\S]*?<!--\/pfs-footer-->/;
const URL_ = 'https://pit.world/snippets/footer.html?site=hdtilt.com';
const TTL = 60 * 60 * 1000;
const REGION = /<!--pit-footer-->[\s\S]*?<!--\/pit-footer-->/;

let cached = '';
let fetchedAt = 0;
/** @type {Promise<void> | null} */
let inflight = null;

function refresh() {
  if (Date.now() - fetchedAt < TTL) return Promise.resolve();
  inflight ??= (async () => {
    try {
      const res = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const html = await res.text();
        if (html.includes('data-pit-footer')) cached = html;
      }
    } catch {
      // Keep the last good footer.
    } finally {
      fetchedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** @param {string} html */
export async function withFooter(html) {
  if (RING_REGION.test(html)) {
    try {
      const ring = await footerHtml(RING_OPTIONS);
      html = html.replace(RING_REGION, () => `<!--pfs-footer-->${ring}<!--/pfs-footer-->`);
    } catch {
      // Leave the markers empty.
    }
  }
  if (!REGION.test(html)) return html;
  await refresh();
  return html.replace(REGION, () => `<!--pit-footer-->${cached}<!--/pit-footer-->`);
}
