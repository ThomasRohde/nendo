import { getCollection, type CollectionEntry } from 'astro:content';
import { toSlug } from '../scripts/docs-meta.mjs';

export interface DocLink {
  id: string;
  slug: string;
  href: string;
  title: string;
  summary: string;
}

export interface DocGroup {
  title: string;
  blurb: string;
  items: DocLink[];
}

const base = import.meta.env.BASE_URL.replace(/\/$/, '');

/** The document's own first heading. None of these files carry frontmatter. */
function titleOf(entry: CollectionEntry<'docs'>): string {
  const heading = entry.body?.match(/^#\s+(.+?)\s*$/m);
  if (heading) return heading[1].replace(/`/g, '');
  return entry.id;
}

/** The first real sentence after the heading, for the index cards. */
function summaryOf(entry: CollectionEntry<'docs'>): string {
  const body = entry.body ?? '';
  const afterHeading = body.replace(/^[\s\S]*?^#\s+.+?$/m, '');
  for (const block of afterHeading.split(/\n{2,}/)) {
    const line = block.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('|') || line.startsWith('```')) continue;
    if (line.startsWith('- ') || line.startsWith('> ') || line.startsWith('*')) continue;
    const flat = line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (flat.length < 30) continue;
    return flat.length > 190 ? `${flat.slice(0, 187).replace(/[\s,;:]+\S*$/, '')}…` : flat;
  }
  return '';
}

function toLink(entry: CollectionEntry<'docs'>): DocLink {
  const slug = toSlug(entry.id);
  return {
    id: entry.id,
    slug,
    href: `${base}/docs${slug === '' ? '' : `/${slug}`}`,
    title: titleOf(entry),
    summary: summaryOf(entry),
  };
}

// Reading order, not alphabetical order: somebody arriving cold should meet the
// vision before the contracts, and the contracts before the decisions.
const START_ORDER = [
  'vision',
  'architecture',
  'roadmap',
  'glossary',
  'nendo-station',
  'dogfooding',
  'custom-view-authoring',
];

export async function docGroups(): Promise<DocGroup[]> {
  const entries = await getCollection('docs');
  const links = entries.map(toLink);

  const start = links
    .filter(link => !link.id.includes('/'))
    .sort((a, b) => {
      const left = START_ORDER.indexOf(a.id);
      const right = START_ORDER.indexOf(b.id);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    });

  const inDirectory = (directory: string) =>
    links
      .filter(link => link.id.startsWith(`${directory}/`))
      .sort((a, b) => {
        // A directory's README is its index and leads.
        if (a.id.endsWith('/README')) return -1;
        if (b.id.endsWith('/README')) return 1;
        return a.id.localeCompare(b.id);
      });

  return [
    {
      title: 'Start here',
      blurb: 'What Nendo is for, how it is built, and what is honestly not yet true.',
      items: start,
    },
    {
      title: 'Contracts',
      blurb: 'Behaviour in detail: what each surface, read and refusal actually does.',
      items: inDirectory('contracts'),
    },
    {
      title: 'Decisions',
      blurb: 'The accepted ADRs, which are the architecture authority.',
      items: inDirectory('decisions'),
    },
  ];
}

export { toSlug, titleOf };
