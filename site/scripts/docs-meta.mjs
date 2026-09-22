// Which repository documents the site renders, and how a path under docs/ becomes a
// route. Shared by the content collection, the docs routes and the link rewriter, so
// a document added here is reachable and linkable in one edit.

/** Everything the site renders, as tinyglobby patterns relative to ../docs. */
export const DOCS_PATTERN = [
  '*.md',
  'contracts/*.md',
  'decisions/*.md',
  '!decisions/template.md',
];

/**
 * docs/design/ and docs/reviews/ are the project's own working material — plans it
 * has moved past and review records that are evidence rather than documentation.
 * They stay on GitHub, and every link into them — a document, a data file or an
 * image — is rewritten to point there rather than copied beside the site.
 */
export const EXCLUDED_DIRECTORIES = ['design', 'reviews'];

/** Assets the site serves itself. Anything else stays on GitHub. */
export const COPIED_ASSET_PATTERN = /\.(png|ico|svg|mp4)$/i;

export const REPOSITORY = 'https://github.com/ThomasRohde/nendo';
export const BLOB = `${REPOSITORY}/blob/main`;

/** True when a path relative to docs/ is one of the documents the site renders. */
export function isRendered(relativePath) {
  const clean = relativePath.replace(/\\/g, '/');
  if (!clean.endsWith('.md')) return false;
  if (clean === 'decisions/template.md') return false;
  const segments = clean.split('/');
  if (segments.length === 1) return true;
  if (segments.length === 2) return segments[0] === 'contracts' || segments[0] === 'decisions';
  return false;
}

/**
 * The route for a document. A directory's README is that directory's index, so
 * contracts/README.md is /docs/contracts rather than /docs/contracts/readme.
 */
export function toSlug(id) {
  const clean = id.replace(/\\/g, '/').replace(/\.md$/, '');
  if (clean === 'README') return '';
  return clean.replace(/\/README$/, '');
}

/** The sidebar, in reading order rather than alphabetical order. */
export const GROUPS = [
  {
    title: 'Start here',
    order: ['vision', 'architecture', 'roadmap', 'glossary', 'nendo-station', 'dogfooding', 'custom-view-authoring'],
    match: id => !id.includes('/'),
  },
  {
    title: 'Contracts',
    order: ['contracts'],
    match: id => id.startsWith('contracts/'),
  },
  {
    title: 'Decisions',
    order: ['decisions'],
    match: id => id.startsWith('decisions/'),
  },
];
