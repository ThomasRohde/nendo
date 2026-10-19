// From a snapshot folder, the paper's export plan (plan.json), its Word exports (paper.docx, as the
// view writes it, and paper-typeset.docx, set as TeX sets it) and its LaTeX reference (tex/paper.tex). `breaks.json`, when present, names the
// headings the reference starts a column with (Compare-ManusPaper.ps1).
import fs from 'node:fs/promises';
import path from 'node:path';
import { Lexer } from '../../../extensions/manuscript/vendor/editor.js';
import * as lib from '../../../extensions/manuscript/vendor/export.js';
import { exportPlan, toDocx, packDocx } from '../../../extensions/manuscript/export.mjs';
import { readManuscript } from '../../../extensions/manuscript/model.mjs';
import { toLatex } from '../latex.mjs';

// `what`: 'tex' writes only the reference, 'docx' only the exports, with the reference's breaks.
const [dir, root = null, what = 'all'] = process.argv.slice(2);
const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8'));
const records = snapshot.records['mn.block'].map(r => ({ recordId: r.recordId, version: r.recordVersion, values: r.values }));
const manuscript = readManuscript(records, root);
const plan = exportPlan(manuscript);
const index = JSON.parse(await fs.readFile(path.join(dir, 'media', 'index.json'), 'utf8'));
// The day the reference and the export both print in the draft line.
const date = new Date();
const dateText = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const breaks = new Set(JSON.parse(await fs.readFile(path.join(dir, 'breaks.json'), 'utf8').catch(() => '[]')));
// The exports start the references on a new page where the reference does.
const referencesOnNewPage = plan.items.some(i => i.type === 'heading' && i.role === 'References' && breaks.has(i.text));
if (what !== 'tex') {
  // A profile for the paper is the person's choice over the layout; the reference has none.
  const profile = (snapshot.records['mn.profile'] ?? []).find(p => p.values['mn.profile.root'] === manuscript.root && p.values['mn.profile.layout'] === 'Paper');
  if (profile) console.log('Note: this manuscript has a Paper profile; the comparison uses the layout without it.');
  const pictures = new Map();
  for (const [address, m] of Object.entries(index)) pictures.set(address, { data: new Uint8Array(await fs.readFile(path.join(dir, 'media', m.file))), mediaType: m.mediaType, width: m.width, height: m.height });
  const built = toDocx(plan, pictures, lib, Lexer, 'paper', { date, referencesOnNewPage });
  await fs.writeFile(path.join(dir, 'paper.docx'), await packDocx(built, lib, 'nodebuffer'));
  const typeset = toDocx(plan, pictures, lib, Lexer, 'paper', { date, typeset: true, referencesOnNewPage });
  await fs.writeFile(path.join(dir, 'paper-typeset.docx'), await packDocx(typeset, lib, 'nodebuffer'));
  await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify({ ...plan, footnoteNumbers: [...plan.footnoteNumbers] }));
}
if (what === 'docx') process.exit(0);
const tex = path.join(dir, 'tex');
await fs.mkdir(tex, { recursive: true });
const pictures = new Map();
for (const [address, m] of Object.entries(index)) { await fs.copyFile(path.join(dir, 'media', m.file), path.join(tex, m.file)); pictures.set(address, m.file); }
await fs.writeFile(path.join(tex, 'paper.tex'), toLatex(plan, pictures, Lexer, { date: dateText, breakBefore: breaks }));
console.log(`"${plan.title}": ${plan.items.length} blocks${breaks.size ? `, columns started at ${[...breaks].join('; ')}` : ''}`);
