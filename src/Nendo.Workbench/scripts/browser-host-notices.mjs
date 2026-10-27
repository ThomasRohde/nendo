import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { section, workbenchNoticeSections } from './third-party-notices.mjs';

// The licence notices the browser host page owes whoever receives it (ADR-0035, ADR-0036). The page
// carries the Workbench bundle, the .NET runtime and the NuGet packages the Engine runs on, with
// SQLite linked into the runtime, and an exported page is a copy that is sent on. The MIT,
// BSD-3-Clause and Apache-2.0 licences each require their notice in every copy, so
// pack-browser-host.mjs carries this text in the page. Nendo.Browser's publish leaves what it
// knows in notices/: the runtime pack's LICENSE.TXT and THIRD-PARTY-NOTICES.TXT, and the restore's
// project.assets.json, which names every package the runtime holds.

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
const tag = (nuspec, name) => new RegExp(`<${name}(?:\\s+type="([^"]*)")?>([^<]*)</${name}>`).exec(nuspec);
const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The packages whose code or native library the browser runtime publishes, from the restore. */
export function runtimePackages(assetsPath) {
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const target = Object.entries(assets.targets).find(([name]) => name.endsWith('/browser-wasm'));
  if (target === undefined) throw new Error(`${assetsPath} has no browser-wasm target.`);
  const folder = Object.keys(assets.packageFolders)[0];
  return Object.entries(target[1])
    .filter(([, entry]) => entry.type === 'package')
    .filter(([, entry]) => Object.keys(entry.runtime ?? {}).some((file) => !file.endsWith('/_._')) || Object.keys(entry.native ?? {}).length > 0)
    .map(([key]) => {
      const [id, version] = key.split('/');
      return { id, version, path: join(folder, assets.libraries[key].path) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One package's licence: the file it ships, or its SPDX expression's text with its copyright. */
function packageLicence(pkg, licences) {
  const nuspecFile = readdirSync(pkg.path).find((name) => name.endsWith('.nuspec'));
  if (nuspecFile === undefined) throw new Error(`${pkg.path} has no .nuspec.`);
  const nuspec = readFileSync(join(pkg.path, nuspecFile), 'utf8');
  const licence = tag(nuspec, 'license');
  if (licence === null) throw new Error(`${pkg.id} ${pkg.version} declares no licence.`);
  const [, kind, value] = licence;
  if (kind === 'file') return { name: 'see below', text: read(join(pkg.path, unescape(value))) };
  const template = join(licences, `${value}.txt`);
  if (!existsSync(template)) throw new Error(`${pkg.id} ${pkg.version} is licensed ${value}, and no text for it is in ${licences}.`);
  const copyright = unescape(tag(nuspec, 'copyright')?.[2] ?? `${tag(nuspec, 'authors')?.[2] ?? pkg.id}`).trim();
  return { name: value, text: read(template).replace('{copyright}', copyright.startsWith('Copyright') || copyright.startsWith('©') ? copyright : `Copyright (c) ${copyright}`) };
}

/** The whole notices text the page carries. */
export function browserHostNotices(workbenchRoot, noticesFolder, licences) {
  const parts = [
    'Nendo web page: licences of the software in this page.\n\nThis page carries the Nendo Workbench, the .NET runtime and the packages listed below, with SQLite linked into the runtime. Each licence requires its notice to travel with every copy of the page.\n',
    ...workbenchNoticeSections(workbenchRoot),
    section('.NET runtime (MIT)', read(join(noticesFolder, 'dotnet-LICENSE.TXT'))),
    section('.NET runtime: third-party notices', read(join(noticesFolder, 'dotnet-THIRD-PARTY-NOTICES.TXT'))),
  ];
  for (const pkg of runtimePackages(join(noticesFolder, 'project.assets.json'))) {
    const licence = packageLicence(pkg, licences);
    let text = licence.text;
    const notices = readdirSync(pkg.path).find((name) => /^third-party-notices(\.(txt|md))?$/i.test(name));
    if (notices !== undefined) text += `\n\n${read(join(pkg.path, notices))}`;
    if (pkg.id === 'SQLitePCLRaw.lib.e_sqlite3') text += '\n\nThis package\'s library is SQLite, which is in the public domain: https://sqlite.org/copyright.html';
    parts.push(section(`${pkg.id} ${pkg.version} (${licence.name})`, text));
  }
  return parts.join('\n');
}
