import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Review R-018: Studio chose agLargeTextCellEditor for long text and Markdown, but main.ts never
// registered its module, so AG Grid logged error #200 and opened no editor at all. AG Grid
// ignores an option whose module is missing, so nothing throws: the registry is read here.
const source = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

// Each built-in editor name and the module AG Grid needs registered for it.
const editorModules = {
  agTextCellEditor: 'TextEditorModule',
  agLargeTextCellEditor: 'LargeTextEditorModule',
  agSelectCellEditor: 'SelectEditorModule',
  agRichSelectCellEditor: 'RichSelectModule',
  agNumberCellEditor: 'NumberEditorModule',
  agDateCellEditor: 'DateEditorModule',
  agDateStringCellEditor: 'DateEditorModule',
  agCheckboxCellEditor: 'CheckboxEditorModule',
};

test('R-018: every cell editor Studio names has its module registered', async () => {
  const main = await source('main.ts');
  const registry = main.match(/ModuleRegistry\.registerModules\(\[([^\]]*)\]\)/);
  assert.ok(registry, 'main.ts no longer registers its grid modules in one list.');
  const registered = new Set(registry[1].split(',').map(name => name.trim()).filter(Boolean));
  const used = new Set();
  for (const name of ['view-data.ts', 'studio-columns.ts', 'grids.ts']) {
    let text;
    try { text = await source(name); } catch { continue; }
    for (const match of text.matchAll(/'(ag[A-Za-z]+CellEditor)'/g)) used.add(match[1]);
  }
  assert.ok(used.has('agLargeTextCellEditor'), 'Studio no longer chooses the large-text editor; update this test with what it chooses.');
  const missing = [...used].filter(editor => !registered.has(editorModules[editor] ?? `an unknown module for ${editor}`))
    .map(editor => `${editor} needs ${editorModules[editor] ?? 'a module this test does not know'}`);
  assert.deepEqual(missing, [], `Studio names editors whose modules are not registered: ${missing.join('; ')}`);
});

test('R-018: the large-text editor is given room, not its default of 200 characters', async () => {
  const text = await source('view-data.ts');
  assert.match(text, /maxLength: largeTextCharacters/);
  const bound = Number(text.match(/const largeTextCharacters = ([\d_]+);/)?.[1].replaceAll('_', ''));
  assert.ok(bound >= 32 * 1024, `A long text past ${bound} characters would be cut by the editor.`);
});
