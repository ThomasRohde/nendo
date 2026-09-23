// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// A GitHub project page, so the site lives under /nendo. Every internal href goes
// through import.meta.env.BASE_URL; a missing prefix works in dev and 404s live.
export default defineConfig({
  site: 'https://thomasrohde.github.io',
  base: '/nendo',
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },
  // The sync step reads the brand assets from ../docs/assets/brand, which is
  // outside the Astro project root.
  vite: {
    server: { fs: { allow: ['..'] } },
  },
});
