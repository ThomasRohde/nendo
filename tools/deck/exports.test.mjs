import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPptx } from '../../extensions/deck/pptx.mjs';
import { buildHtml } from '../../extensions/deck/export-html.mjs';
import { layoutSlide, approxMeasure } from '../../extensions/deck/layout.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { zip, unzip, crc32 } from '../../extensions/deck/zip.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';
import { EXAMPLE_SLIDES } from './example.mjs';

const text = async entry => new TextDecoder().decode(await entry.bytes());
// A one-pixel PNG, as a picture the exporter embeds.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

function deckOf(template, aspect = '16:9') {
  const theme = resolveTheme(template, null, { aspect, footer: 'Footer' });
  const slides = EXAMPLE_SLIDES.map((s, i) => ({
    laid: layoutSlide({ layout: s.layout, title: s.title ?? '', kicker: s.kicker ?? '', body: s.body ?? '', body2: s.body2 ?? '', chart: s.chart ?? 'Column', image: s.layout.startsWith('Image') || s.layout === 'Full image' ? 'media:photo' : null, imageAlt: '' },
      theme, { measure: approxMeasure, number: i + 1 }),
    hidden: i === 3, notes: s.notes,
  }));
  return { theme, slides };
}

test('zip and unzip agree, and the checksum is the standard one', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const entries = unzip(zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]));
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/b.bin']);
  assert.equal(await text(entries[0]), 'hello');
  assert.deepEqual([...await entries[1].bytes()], [1, 2, 3]);
});

test('the PowerPoint package: every slide, its notes, the theme, pictures, and hidden slides kept hidden', async () => {
  for (const template of TEMPLATES) for (const aspect of ['16:9', '4:3']) {
    const { theme, slides } = deckOf(template, aspect);
    const bytes = buildPptx({ deck: { title: 'T & <T>', author: 'A' }, theme, slides, images: new Map([['media:photo', { bytes: PNG, ext: 'png', width: 1, height: 1 }]]), now: new Date('2026-10-23T12:00:00Z') });
    const entries = unzip(bytes);
    const names = entries.map(e => e.name);
    const where = `${template.id} ${aspect}`;
    assert.equal(names[0], '[Content_Types].xml', where);
    assert.equal(names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, slides.length, where);
    assert.equal(names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length, slides.length, where);
    assert.ok(names.includes('ppt/theme/theme1.xml') && names.some(n => /^ppt\/media\/.+\.png$/.test(n)), where);
    const types = await text(entries[0]);
    for (const n of names.filter(n => n.endsWith('.xml') && !n.startsWith('[') && !n.includes('_rels'))) assert.ok(types.includes(`PartName="/${n}"`), `${where}: ${n} has no content type`);
    const presentation = await text(entries.find(e => e.name === 'ppt/presentation.xml'));
    assert.match(presentation, aspect === '16:9' ? /<p:sldSz cx="12192000" cy="6858000"/ : /<p:sldSz cx="9144000" cy="6858000"/, where);
    const fourth = await text(entries.find(e => e.name === 'ppt/slides/slide4.xml'));
    assert.match(fourth, /<p:sld [^>]*show="0"/, `${where}: a hidden slide stays hidden`);
    const core = await text(entries.find(e => e.name === 'docProps/core.xml'));
    assert.ok(core.includes('T &amp; &lt;T&gt;'), `${where}: the title is escaped`);
    for (const e of entries.filter(e => e.name.endsWith('.xml') || e.name.endsWith('.rels'))) {
      const xml = await text(e);
      assert.ok(xml.startsWith('<?xml'), `${where}: ${e.name}`);
      assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), `${where}: ${e.name} carries a control character`);
      // Every element that opens closes: a cheap well-formedness check.
      const opened = (xml.match(/<[A-Za-z][\w:.-]*(\s[^<>]*)?(?<!\/)>/g) ?? []).length, closed = (xml.match(/<\/[A-Za-z][\w:.-]*>/g) ?? []).length;
      assert.equal(opened, closed, `${where}: ${e.name} opens ${opened} elements and closes ${closed}`);
    }
  }
});

test('the PowerPoint package keeps a link\'s address', async () => {
  const theme = resolveTheme(TEMPLATES[0], null, { aspect: '16:9', footer: '' });
  const laid = layoutSlide({ layout: 'Bullets', title: 'Links', body: '- Read [the report](https://example.com/report?a=1&b=2)\n- And [the report](https://example.com/report?a=1&b=2) again', body2: '', chart: 'Column', image: null }, theme, { measure: approxMeasure, number: 1 });
  const entries = unzip(buildPptx({ deck: { title: 'Links', author: 'A' }, theme, slides: [{ laid, hidden: false, notes: '' }], images: new Map(), now: new Date('2026-10-23T12:00:00Z') }));
  const slide = await text(entries.find(e => e.name === 'ppt/slides/slide1.xml'));
  const rels = await text(entries.find(e => e.name === 'ppt/slides/_rels/slide1.xml.rels'));
  const ids = [...slide.matchAll(/<a:hlinkClick r:id="(rId\d+)"\/>/g)].map(m => m[1]);
  assert.equal(ids.length, 2, `two linked runs: ${ids}`);
  assert.equal(new Set(ids).size, 1, 'one relationship for one address');
  assert.ok(rels.includes(`<Relationship Id="${ids[0]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report?a=1&amp;b=2" TargetMode="External"/>`), rels);
});

test('the HTML file: every slide, starting where asked, with its notes, and script text kept inert', () => {
  const { theme, slides } = deckOf(TEMPLATES[0]);
  const html = buildHtml({ title: 'Deck </script><b>', author: 'A', W: 1280, H: 720, theme, start: 2,
    slides: slides.map((s, i) => ({ html: slideHtml(s.laid, { urlFor: () => 'data:image/png;base64,AA==' }), notes: i === 0 ? 'Line separator </script>' : s.notes, title: `S${i}` })) });
  assert.equal((html.match(/class="dk-slide/g) ?? []).length, slides.length);
  assert.equal((html.match(/class="dk-slide (?!off)/g) ?? []).length, 1, 'only the start slide shows at first');
  assert.ok(html.indexOf('class="dk-slide  ') > html.indexOf('aria-label="3 of'), 'the start slide is the third');
  const data = /<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)[1];
  assert.ok(!data.includes('</script') && !data.includes(' '), 'the notes cannot close the script or break a line');
  assert.equal(JSON.parse(data).start, 2);
  assert.ok(!html.includes('<title>Deck </script>'), 'the title is escaped');
  assert.ok(!/<script[^>]+src=/.test(html), 'the file loads no script from elsewhere');
});
