import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { DOCS_PATTERN } from '../scripts/docs-meta.mjs';

// The repository's own documents, rendered from ../docs rather than copied. The
// documents stay the single source; the site is another way to read them.
const docs = defineCollection({
  // The loader lower-cases generated IDs, which turned contracts/README.md into
  // contracts/readme — a route that is not the directory index and a GitHub link
  // to a file that does not exist. Keep the path as it is written on disk.
  loader: glob({
    pattern: DOCS_PATTERN,
    base: '../docs',
    generateId: ({ entry }) => entry.split('\\').join('/').replace(/\.md$/, ''),
  }),
});

export const collections = { docs };
