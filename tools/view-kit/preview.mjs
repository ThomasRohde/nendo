// Preview a custom-view package from its folder against Nendo's real view API.
//
//   node tools/view-kit/preview.mjs <package folder>
//
// It serves the folder the way the host serves a package from a file, with /_nendo/api.js from
// the Workbench build, beside the fixture broker the gate lanes use: the Workbench's broker
// rules, its toolbar and menu rules, and fixture records. It says what kind of evidence it gives,
// because a view that passes here has passed a source test, not run in Nendo: what a view did in
// the embedded host is at nendo://application/extension-events once Nendo shows it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const evidence =
  'Source test: this runs the package against Nendo\'s real api.js and a fixture broker with fixture records. ' +
  'It is not the embedded host. What the view does in Nendo is at nendo://application/extension-events once a screen shows it.';

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (folder === '--describe') {
    console.log(evidence);
  } else if (folder === undefined) {
    console.error('Name the package folder: node tools/view-kit/preview.mjs extensions/<package>');
    process.exitCode = 2;
  } else {
    // The fixture server reads the package folder relative to tools/, where it lives.
    const relative = path.relative(path.join(here, '..'), path.resolve(folder));
    const server = spawn(process.execPath, [path.join(here, '..', 'Graph-FixtureServer.mjs'), '', relative], { stdio: ['ignore', 'pipe', 'inherit'] });
    server.stdout.setEncoding('utf8');
    server.stdout.once('data', (line) => {
      const info = JSON.parse(line);
      console.log(evidence);
      console.log(`Open ${info.brokerUrl} to see ${info.packageId}. The fixture stops after ten minutes, or press Ctrl+C.`);
    });
    server.on('exit', (code) => { process.exitCode = code ?? 0; });
  }
}
