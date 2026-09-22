// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { rehypeRepoLinks } from './scripts/rehype-repo-links.mjs';

// A GitHub project page, so the site lives under /nendo. Every internal href goes
// through import.meta.env.BASE_URL; a missing prefix works in dev and 404s live.
export default defineConfig({
  site: 'https://thomasrohde.github.io',
  base: '/nendo',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  markdown: {
    // Astro 7 renders Markdown with Satteri by default. The repository documents need
    // a hast pass to rewrite the file-to-file links they were written with, so this
    // stays on the unified() pipeline, which takes rehype plugins as they are.
    processor: unified({
      rehypePlugins: [rehypeRepoLinks],
    }),
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },
  // The repository documentation is rendered from ../docs, which is outside the
  // Astro project root.
  vite: {
    server: { fs: { allow: ['..'] } },
  },
});
