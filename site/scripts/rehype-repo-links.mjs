// The repository documents link to each other the way files do — ../contracts/studio.md,
// ../../README.md, assets/brand/nendo.png. Rendered as a website those hrefs are dead, so
// each one is resolved against the document it appears in and sent somewhere real: a route
// for a document the site renders, GitHub for one it does not, and the copied asset for an
// image. A link that leaves docs/ entirely goes to the repository root on GitHub.
import path from 'node:path';
import { visit } from 'unist-util-visit';
import { BLOB, COPIED_ASSET_PATTERN, EXCLUDED_DIRECTORIES, isRendered, toSlug } from './docs-meta.mjs';

const BASE = '/nendo';
const DOCS_ROOT = path.resolve(process.cwd(), '..', 'docs');
const REPO_ROOT = path.resolve(process.cwd(), '..');

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function splitAnchor(href) {
  const hash = href.indexOf('#');
  return hash === -1 ? [href, ''] : [href.slice(0, hash), href.slice(hash)];
}

function rewrite(href, documentDirectory) {
  if (href === '' || EXTERNAL.test(href)) return href;
  const [target, anchor] = splitAnchor(href);
  if (target === '') return href;
  const absolute = path.resolve(documentDirectory, target);
  const fromDocs = path.relative(DOCS_ROOT, absolute).replace(/\\/g, '/');
  const escapesDocs = fromDocs.startsWith('..');

  if (escapesDocs) {
    const fromRepo = path.relative(REPO_ROOT, absolute).replace(/\\/g, '/');
    if (fromRepo.startsWith('..')) return href;
    return `${BLOB}/${fromRepo}${anchor}`;
  }
  if (target.endsWith('.md')) {
    if (!isRendered(fromDocs)) return `${BLOB}/docs/${fromDocs}${anchor}`;
    const slug = toSlug(fromDocs);
    return `${BASE}/docs${slug === '' ? '' : `/${slug}`}${anchor}`;
  }
  // An asset, a data file or a directory. Only an image the sync step copies is
  // served beside the site, and only from a directory the site renders: a link into
  // docs/design/ or docs/reviews/ goes to GitHub whatever it points at.
  const inExcluded = EXCLUDED_DIRECTORIES.includes(fromDocs.split('/')[0]);
  if (!inExcluded && COPIED_ASSET_PATTERN.test(target)) return `${BASE}/repo-docs/${fromDocs}${anchor}`;
  return `${BLOB}/docs/${fromDocs}${anchor}`;
}

export function rehypeRepoLinks() {
  return (tree, file) => {
    const source = file.history?.[0] ?? file.path;
    if (typeof source !== 'string') return;
    const documentDirectory = path.dirname(path.resolve(source));
    // Only the repository documents are rewritten. Pages authored for the site
    // already write their own hrefs.
    if (path.relative(DOCS_ROOT, documentDirectory).startsWith('..')) return;

    visit(tree, 'element', node => {
      if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
        node.properties.href = rewrite(node.properties.href, documentDirectory);
      }
      if (node.tagName === 'img' && typeof node.properties?.src === 'string') {
        node.properties.src = rewrite(node.properties.src, documentDirectory);
        node.properties.loading ??= 'lazy';
        node.properties.decoding ??= 'async';
      }
    });
  };
}
