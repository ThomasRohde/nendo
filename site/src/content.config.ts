import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// The public guides. They are written for somebody who has never seen Nendo and
// describe the product as it is now. The repository's own documents under ../docs
// record how it was made; they stay on GitHub and are not rendered here.
const docs = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(['Start', 'Use', 'Project']),
    order: z.number(),
  }),
});

export const collections = { docs };
