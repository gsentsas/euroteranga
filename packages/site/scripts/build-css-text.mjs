// Publishes the website stylesheets as one string (`@euroteranga/site/css-text`)
// for the OPS preview, which renders a page inside a sandboxed frame. Same
// order as apps/web/app/layout.tsx: foundation tokens, then the site styles.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sources = [
  fileURLToPath(import.meta.resolve('@euroteranga/ui/tokens.css')),
  fileURLToPath(new URL('../styles/site.css', import.meta.url)),
];
const css = (await Promise.all(sources.map((source) => readFile(source, 'utf8')))).join('\n');
const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await writeFile(
  new URL('site-css.js', dist),
  `/** The website stylesheets (tokens, then site), for the OPS preview frame. */\nexport const SITE_CSS = ${JSON.stringify(css)};\n`,
);
await writeFile(new URL('site-css.d.ts', dist), 'export declare const SITE_CSS: string;\n');
