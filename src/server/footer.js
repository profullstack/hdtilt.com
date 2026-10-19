// The pit.world network footer, fetched server side from
// https://pit.world/snippets/footer.html and rendered into the
// <!--pit-footer--> markers of index.html on every page load. It refetches at
// most hourly with a 3-second timeout; on failure it keeps the last good copy,
// or renders nothing, so pit.world being down never breaks the page.
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
  if (!REGION.test(html)) return html;
  await refresh();
  return html.replace(REGION, () => `<!--pit-footer-->${cached}<!--/pit-footer-->`);
}
