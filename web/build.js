// Build the PWA into web/dist: bundle the app (engines split out so a channel
// only loads the demuxer it needs), copy the static shell, rasterise the icon.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const res = await Bun.build({
  entrypoints: [join(here, 'src/app.js')],
  outdir: out,
  splitting: true,
  format: 'esm',
  minify: true,
  target: 'browser',
  // Every file a page loads is named by its content, so a deploy can never
  // pair a new page with an hour-old cached script.
  naming: { entry: '[name]-[hash].js', chunk: 'chunk-[hash].js' },
});
if (!res.success) {
  for (const l of res.logs) console.error(l);
  process.exit(1);
}
await cp(join(here, 'public'), out, { recursive: true });

const appJs = res.outputs
  .find((o) => o.kind === 'entry-point')
  .path.split('/')
  .pop();
const css = await readFile(join(out, 'app.css'));
const appCss = `app-${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`;
await writeFile(join(out, appCss), css);
await rm(join(out, 'app.css'));
const indexFile = join(out, 'index.html');
const html = (await readFile(indexFile, 'utf8')).replace('/app.css', `/${appCss}`).replace('/app.js', `/${appJs}`);
if (!html.includes(appCss) || !html.includes(appJs)) throw new Error('index.html no longer names app.css/app.js');
await writeFile(indexFile, html);

// Stamp the service worker so every build replaces the cached shell.
const sw = join(out, 'sw.js');
await writeFile(
  sw,
  (await readFile(sw, 'utf8'))
    .replace("'hdtilt-v1'", `'hdtilt-${Date.now().toString(36)}'`)
    .replace("'/app.css', '/app.js'", `'/${appCss}', '/${appJs}'`),
);

try {
  const { Resvg } = await import('@resvg/resvg-js');
  const svg = await readFile(join(here, 'public/icon.svg'));
  for (const size of [192, 512]) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
    await writeFile(join(out, `icon-${size}.png`), png);
  }
} catch (e) {
  console.warn(`icons not rasterised: ${e.message}`);
}
const kb = res.outputs.reduce((n, o) => n + o.size, 0) / 1024;
console.log(`web/dist: ${res.outputs.length} files, ${kb.toFixed(0)} KB of JS`);
