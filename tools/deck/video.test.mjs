import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSlide, approxMeasure } from '../../extensions/deck/layout.mjs';
import { videoOf, slideFrom, F } from '../../extensions/deck/model.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { buildPptx } from '../../extensions/deck/pptx.mjs';
import { buildHtml } from '../../extensions/deck/export-html.mjs';
import { unzip } from '../../extensions/deck/zip.mjs';
import { checkDeck } from '../../extensions/deck/check.mjs';

// A slide's YouTube video: a link the slide keeps, played from YouTube and never copied.

const LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s';
const blank = { title: '', kicker: '', body: '', body2: '', image: null, image2: null, image3: null, image4: null, imageAlt: '', chart: 'Column', video: '' };
const lay = (slide, theme = resolveTheme(TEMPLATES[0]), ctx = {}) => layoutSlide({ ...blank, ...slide }, theme, { measure: approxMeasure, ...ctx });
const words = p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '';
const text = async (entries, name) => new TextDecoder().decode(await entries.find(e => e.name === name).bytes());

test('a YouTube link in any of its shapes is the same video, with its start; anything else is no video', () => {
  for (const link of [LINK, 'youtu.be/dQw4w9WgXcQ?t=90', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ#t=90s', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90', 'https://www.youtube.com/shorts/dQw4w9WgXcQ?t=90', ' https://www.youtube.com/live/dQw4w9WgXcQ?t=1m30s ']) {
    const v = videoOf(link);
    assert.deepEqual([v?.id, v?.start], ['dQw4w9WgXcQ', 90], link);
  }
  const v = videoOf(LINK);
  assert.equal(v.embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1&start=90');
  assert.equal(v.watch, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
  assert.equal(v.link, 'https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed&start=90');
  assert.equal(videoOf('https://youtu.be/dQw4w9WgXcQ').start, 0);
  for (const link of ['', 'dQw4w9WgXcQ', 'https://vimeo.com/76979871', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/channel/UC123',
    'javascript:alert(1)//youtu.be/dQw4w9WgXcQ', 'ftp://youtu.be/dQw4w9WgXcQ', 'https://evil.example/youtu.be/dQw4w9WgXcQ', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ'])
    assert.equal(videoOf(link), null, link);
  assert.equal(slideFrom({ values: { [F.slide.video]: ` ${LINK} ` } }).video, LINK);
  assert.equal(slideFrom({ values: {} }).video, '');
});

test('a Video slide draws its video at 16:9, alone or beside its words, in every template and both shapes', () => {
  const brand = { name: 'Kit', colors: { primary: '#0B6E4F' }, logo: 'media:logo', logoDark: null };
  for (const template of TEMPLATES) for (const aspect of ['16:9', '4:3']) for (const kit of [null, brand]) for (const body of ['', '- Watch the first minute\n- Then we talk\n- Questions after']) {
    const theme = resolveTheme(template, kit, { aspect, footer: 'A footer', slideNumbers: true });
    const l = lay({ layout: 'Video', title: 'How the pilot went', kicker: 'Demo', body, video: LINK }, theme, { number: 3 });
    const where = `${template.id} ${aspect}${kit ? ' with a logo' : ''}${body ? ' with words' : ''}`;
    const [v] = l.items.filter(p => p.type === 'video');
    assert.ok(v, `${where}: no video`);
    assert.ok(Math.abs(v.w / v.h - 16 / 9) < 0.01, `${where}: the video is ${v.w}×${v.h}`);
    assert.ok(v.x >= 0 && v.y >= 0 && v.x + v.w <= l.W && v.y + v.h <= l.H - 60, `${where}: the video leaves the slide or meets the footer at ${[v.x, v.y, v.w, v.h].map(Math.round)}`);
    const title = l.items.find(p => p.role === 'title');
    assert.ok(v.y >= title.y + 40, `${where}: the video lies over the title`);
    assert.equal(l.items.filter(p => p.type === 'text' && p.overflow).length, 0, `${where}: words run over`);
    for (const p of l.items.filter(p => p.type === 'text' && p.role === 'body')) {
      const across = Math.min(p.x + p.w, v.x + v.w) - Math.max(p.x, v.x), down = Math.min(p.y + p.h, v.y + v.h) - Math.max(p.y, v.y);
      assert.ok(across <= 0.5 || down <= 0.5, `${where}: "${words(p)}" lies over the video`);
    }
    if (!body) assert.ok(Math.abs(v.x + v.w / 2 - l.W / 2) < 1, `${where}: a video on its own stands in the middle`);
  }
});

test('a video\'s poster is the slide\'s picture, else YouTube\'s; no link is a place for one, and a bad link says so while editing', () => {
  const [own] = lay({ layout: 'Video', title: 'T', video: LINK, image: 'media:poster', imageAlt: 'The pilot room' }).items.filter(p => p.type === 'video');
  assert.deepEqual([own.poster, own.alt, own.slot], ['media:poster', 'The pilot room', 0]);
  const [youtube] = lay({ layout: 'Video', title: 'The pilot', video: LINK }).items.filter(p => p.type === 'video');
  assert.deepEqual([youtube.poster, youtube.alt], ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', 'The pilot']);
  const empty = lay({ layout: 'Video', title: 'T' }, undefined, { editing: true });
  assert.ok(!empty.items.some(p => p.type === 'video') && empty.items.some(p => p.role === 'video' && p.type === 'rect'));
  assert.ok(empty.items.some(p => words(p) === 'Paste a YouTube link in Video'));
  assert.ok(lay({ layout: 'Video', title: 'T', video: 'https://vimeo.com/1' }, undefined, { editing: true }).items.some(p => /not a YouTube link/.test(words(p))));
  assert.ok(!lay({ layout: 'Video', title: 'T' }).items.some(p => p.type === 'text' && p.role === 'video'), 'no hint outside editing');
  // Only the Video layout plays a video: another layout leaves the link alone.
  assert.ok(!lay({ layout: 'Image right', title: 'T', video: LINK }).items.some(p => p.type === 'video'));
});

test('the slide draws the video as its poster and a play button, and nothing streams until a click', () => {
  const l = lay({ layout: 'Video', title: 'T', video: LINK, imageAlt: 'The pilot' });
  const html = slideHtml(l, { urlFor: src => src.startsWith('https://') ? src : null });
  assert.ok(!/<iframe/i.test(html), 'a slide holds no player until a click asks for one');
  assert.match(html, /class="dk-v" data-role="video"[^>]* data-slot="0" data-embed="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1&amp;rel=0&amp;playsinline=1&amp;start=90" data-watch="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&amp;t=90s"/);
  assert.match(html, /<img src="https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg"/);
  assert.match(html, /aria-label="Video: The pilot"/);
  // A poster that cannot be shown leaves the dark box and its button.
  assert.ok(!slideHtml(l, { urlFor: () => null }).includes('<img'));
});

test('the HTML file plays a video only where YouTube\'s player can play: in Nendo and from a web address', () => {
  const l = lay({ layout: 'Video', title: 'T', video: LINK });
  const html = buildHtml({ title: 'Deck', W: l.W, H: l.H, theme: resolveTheme(TEMPLATES[0]), slides: [{ html: slideHtml(l), notes: '', title: 'T', steps: 0 }] });
  assert.ok(html.includes("const canFrame = data.embedded || /^https?:$/.test(location.protocol);"), 'a file opened from a folder opens the video on YouTube');
  assert.ok(html.includes("player.referrerPolicy = 'strict-origin-when-cross-origin';") && html.includes("player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';"));
  assert.ok(html.includes('stopVideos(from);'), 'leaving a slide stops its video');
});

test('PowerPoint gets an online video: the poster as its picture and a link to YouTube\'s player, nothing downloaded', async () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const laid = lay({ layout: 'Video', title: 'The pilot', video: LINK, imageAlt: 'The pilot room' }, theme);
  const poster = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
  const images = new Map([[poster, { bytes: new Uint8Array([137, 80, 78, 71]), ext: 'jpeg', width: 480, height: 360 }]]);
  const entries = unzip(buildPptx({ deck: { title: 'D' }, theme, slides: [{ laid, hidden: false }], images }));
  const slide = await text(entries, 'ppt/slides/slide1.xml'), rels = await text(entries, 'ppt/slides/_rels/slide1.xml.rels');
  const pic = /<p:pic>(?:(?!<\/p:pic>).)*<a:videoFile r:link="(rId\d+)"\/>(?:(?!<\/p:pic>).)*<\/p:pic>/.exec(slide);
  assert.ok(pic, 'the video is a picture that links a video');
  assert.match(pic[0], /<a:hlinkClick r:id="" action="ppaction:\/\/media"\/>/);
  assert.match(pic[0], /descr="The pilot room"/);
  // hqdefault is 4:3 with the 16:9 frame in its middle: the crop takes the bars off.
  assert.match(pic[0], /<a:srcRect t="12500" b="12500"\/>/);
  assert.ok(rels.includes(`<Relationship Id="${pic[1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed&amp;start=90" TargetMode="External"/>`), rels);
  const blip = /<a:blip r:embed="(rId\d+)"\/>/.exec(pic[0])[1];
  assert.match(rels, new RegExp(`Id="${blip}" Type="[^"]+/image" Target="\\.\\./media/image1\\.jpeg"`));
  assert.deepEqual(entries.filter(e => e.name.startsWith('ppt/media/')).map(e => e.name), ['ppt/media/image1.jpeg'], 'only the poster is in the file');
  // Without a poster to show, a dark box opens the video's page.
  const bare = unzip(buildPptx({ deck: { title: 'D' }, theme, slides: [{ laid, hidden: false }] }));
  const bareSlide = await text(bare, 'ppt/slides/slide1.xml'), bareRels = await text(bare, 'ppt/slides/_rels/slide1.xml.rels');
  const link = /<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Online Media \d+" descr="The pilot room"><a:hlinkClick r:id="(rId\d+)"\/>/.exec(bareSlide);
  assert.ok(link && bareSlide.includes('▶ Watch on YouTube'), bareSlide);
  assert.ok(bareRels.includes(`Id="${link[1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s" TargetMode="External"`));
});

test('the Check tab names a Video slide with no link or a link that plays nothing, and says the room needs the internet', () => {
  const check = slide => checkDeck([{ id: 's', layout: 'Video', title: 'T', kicker: '', body: '', body2: '', notes: 'Notes.', image: null, imageAlt: '', video: '', hidden: false, build: 'None', ...slide }],
    { laid: s => lay(s) }).issues.map(i => `${i.level}: ${i.text}`);
  assert.deepEqual(check({}), ['warn: No video yet: paste a YouTube link in Video.']);
  assert.deepEqual(check({ video: 'https://vimeo.com/1' }), ['warn: The video link is not a YouTube video, so nothing plays.']);
  assert.deepEqual(check({ video: LINK }), ['info: The video plays from YouTube: the room needs the internet when you show it.']);
});
