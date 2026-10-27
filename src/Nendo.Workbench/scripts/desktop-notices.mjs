import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSection } from './browser-host-notices.mjs';
import { section } from './third-party-notices.mjs';

// The licence notices the installed Nendo owes whoever receives it. The payload is self-contained:
// it carries the .NET and ASP.NET Core runtimes, the Windows App SDK and every NuGet package the
// Engine, the MCP adapter and the Desktop host run on, and MIT, BSD-3-Clause and Apache-2.0 each
// require their notice in every copy. Nendo.Desktop's publish lists every file it wrote in
// notices/published-files.txt; tools/Publish-NendoPayload.ps1 runs this script on the payload,
// which writes THIRD-PARTY-NOTICES.txt beside the host and refuses a file nothing covers. The
// Workbench and the web page carry their own notices: Workbench/THIRD-PARTY-NOTICES.txt and the
// page's nendo-notices template. Usage: node scripts/desktop-notices.mjs <payload>

/** Files of Nendo's own build, which Nendo's licence covers, and the folders with notices of their own. */
const own = [/^Nendo\.[^/]+$/, /^[^/]+\.xbf$/, /^Assets\//, /^Workbench\//, /^WebPage\//];

const folder = (path) => resolve(path).toLowerCase() + sep;
const nuspecTag = (nuspec, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(nuspec)?.[1].trim();

/** The package in a folder, named as its .nuspec names it. */
function packageIn(path) {
  const nuspec = readdirSync(path).find((name) => name.endsWith('.nuspec'));
  if (nuspec === undefined) throw new Error(`${path} has no .nuspec.`);
  const text = readFileSync(join(path, nuspec), 'utf8');
  return { id: nuspecTag(text, 'id'), version: nuspecTag(text, 'version'), path };
}

/**
 * The publish's list, with each file's package: the one MSBuild names, the package folder it was
 * read from, or the Windows App SDK runtime package for what was unpacked from its MSIX. The list
 * is the NuGet package root, then `MsixContent|package folder`, then
 * `path|package|version|written from|source` per file, the source being where a file was read
 * before ReadyToRun compiled it. A file of none of these has package null.
 */
export function publishedFiles(listPath) {
  const [root, msix, ...lines] = readFileSync(listPath, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((line) => line !== '');
  const [msixContent, msixPackage] = msix.split('|');
  const packages = new Map();
  const at = (path) => {
    const key = folder(path);
    if (!packages.has(key)) packages.set(key, packageIn(path));
    return packages.get(key);
  };
  const files = lines.map((line) => {
    const [path, id, version, written, source] = line.split('|');
    const file = { path: path.replace(/\\/g, '/'), package: null };
    const from = resolve(source || written).toLowerCase();
    if (id) file.package = at(join(root, id.toLowerCase(), version.toLowerCase()));
    else if (from.startsWith(folder(msixContent))) file.package = at(msixPackage);
    else if (from.startsWith(folder(root))) {
      const [name, release] = from.slice(folder(root).length).split(sep);
      file.package = at(join(root, name, release));
    }
    return file;
  });
  return { files, packages: [...new Set(files.map((file) => file.package).filter((pkg) => pkg !== null))].sort((a, b) => a.id.localeCompare(b.id)) };
}

/** The whole notices file the payload carries beside Nendo.Desktop.exe. */
export function desktopNotices(repository, list, licences) {
  return [
    'Nendo: licences of the software in this folder.\n\nNendo carries the .NET runtimes, the Windows App SDK and the packages listed below. Each licence requires its notice to travel with every copy. The Workbench folder and the web pages Export writes carry their own: Workbench\\THIRD-PARTY-NOTICES.txt and the page\'s notices.\n',
    section('Nendo', readFileSync(join(repository, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim()),
    ...list.packages.map((pkg) => packageSection(pkg, licences)),
  ].join('\n');
}

/** What the notices leave uncovered, as sentences; empty when every published file is covered. */
export function uncoveredFiles(list, text) {
  const uncovered = [];
  for (const file of list.files) {
    if (file.package === null) {
      if (!own.some((pattern) => pattern.test(file.path))) uncovered.push(`${file.path} comes from no package and is not Nendo's own`);
    } else if (!text.includes(`\n${file.package.id} ${file.package.version} (`)) uncovered.push(`${file.path} comes from ${file.package.id} ${file.package.version}, which the notices do not name`);
  }
  return uncovered;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const payload = process.argv[2];
  if (payload === undefined) throw new Error('Usage: node scripts/desktop-notices.mjs <payload>');
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  const list = publishedFiles(join(payload, 'notices', 'published-files.txt'));
  const text = desktopNotices(repository, list, join(repository, 'src', 'Nendo.Browser', 'licences'));
  const uncovered = uncoveredFiles(list, text);
  if (uncovered.length > 0) throw new Error(`The payload's notices leave ${uncovered.length} file(s) uncovered:\n${uncovered.join('\n')}`);
  writeFileSync(join(payload, 'THIRD-PARTY-NOTICES.txt'), text);
  console.log(`THIRD-PARTY-NOTICES.txt: ${list.packages.length} packages, ${list.files.length} files covered.`);
}
