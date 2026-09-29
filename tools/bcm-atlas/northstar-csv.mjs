// The Northstar capability model as the spreadsheet a person would have (W-075): one row per
// capability, its parent named by code rather than by a record ID only the file knows.
// northstar-capabilities.csv is this function's output, committed so the Engine's import lane
// reads the same file a person would; northstar-csv.test.mjs fails when the two drift apart.
//
//   node tools/bcm-atlas/northstar-csv.mjs   rewrites northstar-capabilities.csv
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { northstarModel } from './northstar.mjs';

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

export function northstarCsv() {
  const capabilities = northstarModel()['bcm.capability'];
  const byId = new Map(capabilities.map((record) => [record.recordId, record]));
  const lines = ['Code,Name,Parent'];
  for (const record of capabilities) {
    const parent = record.values['cap.parent'] === null ? '' : byId.get(record.values['cap.parent']).values['cap.code'];
    lines.push([record.values['cap.code'], record.values['cap.name'], parent].map(quote).join(','));
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./northstar-capabilities.csv', import.meta.url), northstarCsv(), 'utf8');
}
