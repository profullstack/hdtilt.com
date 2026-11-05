// Build the PWA into web/dist: bundle the app (engines split out so a channel
// only loads the demuxer it needs), copy the static shell, rasterise the icon.

import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// esbuild rather than Bun.build, for `target` alone. Bun's bundler has no browser
// version knob: `target: 'browser'` emits whatever the source uses AND `??=` inside
// its own generated helpers, so the bundle fails to parse below Chromium 85 and the
// page renders blank. That is invisible on a phone, which updates its WebView through
// the Play Store, and fatal on a Fire TV, which does not. chrome70 is the floor the
// Fire TV app targets (Fire OS 5), and esbuild lowers its own helpers to it too.
const res = await esbuild.build({
  entryPoints: [join(here, 'src/app.js')],
  outdir: out,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: ['chrome70'],
  metafile: true,
  // Every file a page loads is named by its content, so a deploy can never
  // pair a new page with an hour-old cached script.
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  // The browser uses one function from @profullstack/profile, renderProfileFields,
  // which is a pure template helper. Importing it from the package root also pulls
  // the server half (handlers, store) and through it node:dns, node:net, node:https.
  // Bun tree-shook those away; esbuild resolves before it shakes and refuses. The
  // package's exports map has no subpath for the html half, so point at the file.
  alias: {
    '@profullstack/profile': join(here, '../node_modules/@profullstack/profile/src/html.js'),
  },
});
await cp(join(here, 'public'), out, { recursive: true });

const outputs = Object.entries(res.metafile.outputs);
const appJs = outputs
  .find(([path, o]) => o.entryPoint && path.endsWith('.js'))[0]
  .split('/')
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
const js = outputs.filter(([path]) => path.endsWith('.js'));
const kb = js.reduce((n, [, o]) => n + o.bytes, 0) / 1024;
console.log(`web/dist: ${js.length} files, ${kb.toFixed(0)} KB of JS`);
