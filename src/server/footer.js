// The shared Profullstack footer (@profullstack/footer), rendered into the
// <!--pfs-footer--> markers of index.html from the @latest template on jsDelivr
// (cached an hour by the package; the bundled template if the CDN is down), so a
// footer release needs no redeploy and the ring's verifier sees it in the HTML.
import { footerHtml } from '@profullstack/footer';

const OPTIONS = { site: 'https://hdtilt.com/' };
const REGION = /<!--pfs-footer-->[\s\S]*?<!--\/pfs-footer-->/;

/** @param {string} html */
export async function withFooter(html) {
  if (!REGION.test(html)) return html;
  try {
    const footer = await footerHtml(OPTIONS);
    return html.replace(REGION, () => `<!--pfs-footer-->${footer}<!--/pfs-footer-->`);
  } catch {
    return html;
  }
}
