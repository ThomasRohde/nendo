// @ts-check
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';

const BASE = '/nendo';

// The facts a guide states about a version are read from the files that decide them,
// so a version cut cannot leave a guide on the old number. A guide writes the token
// and the build writes the value: {{version}} from Directory.Build.props, the product
// version the installer ships, and {{dotnetSdk}} from global.json.
const repoFile = (/** @type {string} */ name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const productVersion = repoFile('Directory.Build.props').match(/<Version>([^<]+)<\/Version>/)?.[1];
if (!productVersion) throw new Error('Directory.Build.props has no <Version>.');
const dotnetSdk = JSON.parse(repoFile('global.json')).sdk?.version;
if (!dotnetSdk) throw new Error('global.json pins no sdk.version.');
const facts = { version: productVersion, dotnetSdk };

// Astro's default Markdown processor is Satteri, and these are its HTML-tree (hast)
// plugins. site/package.json pins @astrojs/markdown-satteri to the version astro
// itself pins; move the two together.
//
// The content layer caches a rendered guide and its key leaves out functions, so a
// changed fact does not invalidate it: after a version change, clear site/.astro and
// site/node_modules/.astro (scripts/check-dist.mjs says so when it sees a stale one).

// A table wider than its column scrolls inside its own box instead of running under
// the On-this-page list or widening a phone page. The .table-scroll rule in
// global.css does the work; this gives every rendered markdown table the wrapper.
const tableScroll = {
  name: 'nendo-table-scroll',
  element: {
    filter: ['table'],
    visit(/** @type {any} */ node, /** @type {any} */ ctx) {
      ctx.wrapNode(node, { type: 'element', tagName: 'div', properties: { className: ['table-scroll'] }, children: [] });
    },
  },
};

// GitHub Pages serves a page at its directory URL, so /nendo/use answers with a 301 to
// /nendo/use/. The guides link the short way; this writes the slash on every internal
// link to a page, before the fragment.
const trailingSlash = {
  name: 'nendo-trailing-slash',
  element: {
    filter: ['a'],
    visit(/** @type {any} */ node, /** @type {any} */ ctx) {
      const href = node.properties?.href;
      if (typeof href !== 'string' || !href.startsWith(`${BASE}/`)) return;
      const [, pathPart = '', rest = ''] = href.match(/^([^?#]*)(.*)$/) ?? [];
      if (pathPart.endsWith('/') || /[.][a-z0-9]+$/i.test(pathPart)) return;
      ctx.setProperty(node, 'href', `${pathPart}/${rest}`);
    },
  },
};

const versionFacts = {
  name: 'nendo-version-facts',
  text(/** @type {any} */ node, /** @type {any} */ ctx) {
    if (!node.value.includes('{{')) return;
    const parent = ctx.parent(node);
    if (parent?.tagName === 'code' || parent?.tagName === 'pre') return;
    const value = node.value.replace(/[{][{](\w+)[}][}]/g, (/** @type {string} */ whole, /** @type {string} */ name) => {
      if (!(name in facts)) throw new Error(`A guide uses the unknown fact ${whole}.`);
      return facts[/** @type {keyof typeof facts} */ (name)];
    });
    ctx.replaceNode(node, { type: 'text', value });
  },
};

// A GitHub project page, so the site lives under /nendo. Every internal href goes
// through import.meta.env.BASE_URL; a missing prefix works in dev and 404s live.
// Internal links carry the trailing slash (scripts/check-links.mjs refuses one that
// does not); 'ignore' keeps the dev server and the preview answering both forms.
export default defineConfig({
  site: 'https://thomasrohde.github.io',
  base: BASE,
  trailingSlash: 'ignore',
  // Astro's default compression drops the newline between a word and an inline
  // element that starts the next source line, printing "arenot" and "avgand". The
  // pages are small, so the whitespace stays.
  compressHTML: false,
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
    processor: satteri({ hastPlugins: [tableScroll, trailingSlash, versionFacts] }),
  },
  // The sync step reads the brand assets from ../docs/assets/brand, which is
  // outside the Astro project root.
  vite: {
    server: { fs: { allow: ['..'] } },
  },
});
