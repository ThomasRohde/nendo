// A kit as a design-system bundle for Claude Design: written guidelines (README.md), tokens,
// logos as SVG, and preview pages whose first line names the card group the Design System pane
// files them under. /design-sync in Claude Code uploads the folder into a design-system project.
import { ratio, shown, grade, inkOn } from './contrast.js';

const esc = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const str = value => String(value ?? '');

/** m is the board's model of the kit; tools are {css, tokens, stackOf, weightOf, slug, isLogo}. */
export function designBundle(m, tools) {
  const { stackOf, weightOf, slug } = tools;
  const name = str(m.kit.values.kitName) || 'Brand';
  const root = slug(name) || 'brand';
  const families = m.typefaces.map(t => str(t.values.typeFamily).trim()).filter(f => /^[A-Za-z0-9 ]{2,60}$/.test(f));
  const fontLink = families.length
    ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families.map(f => `family=${f.replace(/ /g, '+')}:wght@400;700`).join('&')}&display=swap">` : '';
  const heading = stackOf(m.fonts.heading, 'Heading'), body = stackOf(m.fonts.body, 'Body');
  const page = (group, title, inner) => `<!-- @dsCard group="${group}" -->
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(name)}: ${esc(title)}</title>
${fontLink}
<link rel="stylesheet" href="../tokens/brand.css">
<style>
  body { margin: 0; padding: 24px; background: ${m.bg}; color: ${m.ink}; font-family: ${body}; }
  h1, h2, h3 { font-family: ${heading}; font-weight: ${weightOf(m.fonts.heading, 700)}; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
  .card { border-radius: 10px; overflow: hidden; border: 1px solid rgba(0,0,0,.12); }
  .muted { opacity: .72; font-size: 13px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
</style>
<body>
<h2>${esc(title)}</h2>
${inner}
</body>
</html>
`;
  const logoPath = l => `assets/logos/${slug(l.values.logoName) || 'logo'}.svg`;
  const logos = m.logos.filter(tools.isLogo);

  const colours = m.colours.filter(c => m.hexOf(c)).map(c => {
    const hex = m.hexOf(c);
    const onBg = c === m.background ? ratio(m.ink, hex) : ratio(hex, m.bg);
    return `<div class="card"><div style="height:96px;background:${hex};color:${inkOn(hex)};padding:10px;font-size:22px">Aa</div>
<div style="padding:10px"><b>${esc(c.values.colourName)}</b><br><code>${hex}</code> · ${esc(c.values.colourRole)}<br>
<span class="muted">${c === m.background ? 'Text on it' : 'On background'} ${shown(onBg)}:1 ${grade(onBg).label}</span>
${c.values.colourUsage ? `<p class="muted">${esc(c.values.colourUsage)}</p>` : ''}</div></div>`;
  }).join('\n');
  const type = m.typefaces.map(t => `<div style="margin-bottom:24px">
<div class="muted">${esc(t.values.typeRole)} · ${esc(t.values.typeFamily)} ${weightOf(t)}${t.values.typeSize ? ` · ${Number(t.values.typeSize)}px` : ''}</div>
<div style="font-family:${stackOf(t, t.values.typeRole)};font-weight:${weightOf(t)};font-size:${Math.min(64, Number(t.values.typeSize) || 18)}px">${esc(str(m.kit.values.kitTagline) || 'The quick brown fox jumps over the lazy dog')}</div>
${t.values.typeUsage ? `<p class="muted">${esc(t.values.typeUsage)}</p>` : ''}</div>`).join('\n');
  const logoCards = logos.map(l => `<div class="card" style="background:#fff0"><div style="display:grid;grid-template-columns:1fr 1fr">
<div style="background:${m.bg};height:120px;display:grid;place-items:center;padding:12px"><img src="../${logoPath(l)}" alt="" style="max-width:100%;max-height:100%"></div>
<div style="background:${m.hexOf(m.colours.find(c => c.values.colourRole === 'Primary')) ?? '#1b1b1b'};height:120px;display:grid;place-items:center;padding:12px"><img src="../${logoPath(l)}" alt="" style="max-width:100%;max-height:100%"></div></div>
<div style="padding:10px"><b>${esc(l.values.logoName)}</b> · ${esc(l.values.logoKind)}${l.values.logoUsage ? `<p class="muted">${esc(l.values.logoUsage)}</p>` : ''}</div></div>`).join('\n');
  const voiceLines = str(m.kit.values.kitVoice).split('\n').map(l => l.trim()).filter(Boolean);
  const samples = m.samples.map(s => {
    const v = s.values;
    const back = m.hexOf(m.colour(v.sampleBackground)) ?? m.bg, ink = m.hexOf(m.colour(v.sampleInk)) ?? m.ink;
    const accent = m.hexOf(m.colour(v.sampleAccent)) ?? ink;
    const label = (ratio(back, accent) ?? 0) >= (ratio(ink, accent) ?? 0) ? back : ink;
    const logo = m.logo(v.sampleLogo);
    return `<div class="card" style="background:${back};color:${ink};padding:20px;display:grid;gap:10px;align-content:start">
${logo && tools.isLogo(logo) ? `<img src="../${logoPath(logo)}" alt="" style="height:32px;justify-self:start">` : ''}
${v.sampleHeadline ? `<h3 style="color:${ink}">${esc(v.sampleHeadline)}</h3>` : ''}
${v.sampleBody ? `<p style="margin:0">${esc(v.sampleBody)}</p>` : ''}
${v.sampleAction ? `<span style="justify-self:start;background:${accent};color:${label};padding:8px 16px;border-radius:6px;font-weight:600">${esc(v.sampleAction)}</span>` : ''}
<small style="opacity:.7">${esc(v.sampleName)} · ${esc(v.sampleKind)}</small></div>`;
  }).join('\n');

  const table = (head, rows) => rows.length ? `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map(r => `| ${r.map(c => str(c).replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ')} |`).join('\n')}\n` : '';
  const v = m.kit.values;
  const readme = `# ${name}

${v.kitTagline ? `> ${v.kitTagline}\n\n` : ''}${v.kitBrief ? `${v.kitBrief}\n\n` : ''}This design system was exported from Brandkits in Nendo. Contrast ratios are WCAG 2.2, worked out by Brandkits: body text needs 4.5:1, large text and UI graphics 3:1.

## Personality

${str(v.kitPersonality).split(/[,;\n]/).map(t => t.trim()).filter(Boolean).map(t => `- ${t}`).join('\n') || '- (none yet)'}

## Voice

${voiceLines.map(l => `- ${l}`).join('\n') || '(none yet)'}

## Colours

${table(['Name', 'Hex', 'Role', 'On background', 'Usage'], m.colours.filter(c => m.hexOf(c)).map(c => {
    const value = c === m.background ? ratio(m.ink, m.hexOf(c)) : ratio(m.hexOf(c), m.bg);
    return [c.values.colourName, m.hexOf(c), c.values.colourRole, `${shown(value)}:1 ${grade(value).label}`, c.values.colourUsage];
  }))}
Tokens: \`tokens/brand.css\` (CSS custom properties) and \`tokens/tokens.json\` (W3C Design Tokens).

## Typography

${table(['Role', 'Family', 'Fallback', 'Weight', 'Size', 'Usage'], m.typefaces.map(t => [t.values.typeRole, t.values.typeFamily, t.values.typeStack, weightOf(t), t.values.typeSize ? `${t.values.typeSize}px` : '', t.values.typeUsage]))}
## Logos

${table(['Name', 'Kind', 'File', 'Usage'], logos.map(l => [l.values.logoName, l.values.logoKind, logoPath(l), l.values.logoUsage]))}
${v.kitImagery ? `## Imagery\n\n${v.kitImagery}\n` : ''}`;

  const files = [
    { path: `${root}/README.md`, text: readme },
    { path: `${root}/tokens/brand.css`, text: tools.css },
    { path: `${root}/tokens/tokens.json`, text: tools.tokens },
    ...logos.map(l => ({ path: `${root}/${logoPath(l)}`, text: str(l.values.logoSvg) })),
  ];
  if (colours) files.push({ path: `${root}/preview/colours.html`, text: page('Colors', 'Colours', `<div class="grid">${colours}</div>`) });
  if (type) files.push({ path: `${root}/preview/type.html`, text: page('Type', 'Type', type) });
  if (logoCards) files.push({ path: `${root}/preview/logos.html`, text: page('Brand', 'Logos', `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${logoCards}</div>`) });
  if (voiceLines.length || v.kitPersonality) files.push({ path: `${root}/preview/voice.html`, text: page('Brand', 'Voice', `<ul>${voiceLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${v.kitImagery ? `<h3>Imagery</h3><p>${esc(v.kitImagery)}</p>` : ''}`) });
  if (samples) files.push({ path: `${root}/preview/samples.html`, text: page('Components', 'Samples', `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${samples}</div>`) });
  return { root, files };
}
