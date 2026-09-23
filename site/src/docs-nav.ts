import { getCollection } from 'astro:content';

export interface DocLink {
  id: string;
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

// Reading order: start, then everyday use, then where the project is going.
const GROUPS = [
  { key: 'Start', title: 'Start', blurb: 'What Nendo is and how to open your first file.' },
  { key: 'Use', title: 'Use', blurb: 'Screens, calculations, agents, custom views and your data.' },
  { key: 'Project', title: 'Project', blurb: 'Where Nendo is now and where it could go.' },
] as const;

export async function docGroups(): Promise<DocGroup[]> {
  const entries = await getCollection('docs');
  return GROUPS.map(group => ({
    title: group.title,
    blurb: group.blurb,
    items: entries
      .filter(entry => entry.data.group === group.key)
      .sort((a, b) => a.data.order - b.data.order)
      .map(entry => ({
        id: entry.id,
        href: `${base}/docs/${entry.id}`,
        title: entry.data.title,
        summary: entry.data.description,
      })),
  })).filter(group => group.items.length > 0);
}
