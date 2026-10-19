// Where TeX breaks a paragraph into lines, for the paper's preview: Knuth and Plass's
// total-fit algorithm over boxes, glue and penalties, with the parameters the AASTeX reference
// sets. Pure: the view measures the words and draws the lines (tools/manus/typeset.test.mjs).

/** What the reference's TeX sets: AASTeX's tolerance and the plain penalties and demerits. */
export const TEX = { pretolerance: 100, tolerance: 9999, hyphenpenalty: 50, exhyphenpenalty: 50, linepenalty: 10,
  adjdemerits: 10000, doublehyphendemerits: 10000, finalhyphendemerits: 5000, emergencystretch: 10 * 72 / 72.27 };

const INFINITE = 10000;

// TeX's badness of stretching or shrinking `t` with `s` to spare (tex.web §108), in its integer
// scaled points, so it truncates as TeX does: 4.9 is 4, which can decide between two sets of lines.
const SP = 65536 * 72.27 / 72;
function texBadness(t, s) {
  t = Math.round(t * SP); s = Math.round(s * SP);
  if (t <= 0) return 0;
  if (s <= 0) return INFINITE;
  const r = t <= 7230584 ? Math.floor(t * 297 / s) : s >= 1663497 ? Math.floor(t / Math.floor(s / 297)) : t;
  return r > 1290 ? INFINITE : Math.floor((r * r * r + 0x20000) / 0x40000);
}

/**
 * The glue TeX puts after a character, from its space factor with plain TeX's sfcodes (LaTeX's
 * \nonfrenchspacing): wider and more stretchable after a sentence's end or a colon, less
 * shrinkable after a comma or semicolon; a capital before the stop makes it an abbreviation.
 * `space` is {width, stretch, shrink, extra} for the type.
 */
export function spaceAfter(text, space) {
  // A character's sfcode sets the factor; a closing bracket or quote (sfcode 0) leaves it as it
  // was, and after a capital (999) no stop, colon or comma raises it past 1000.
  const sfcode = c => /[)\]’'”"]/.test(c) ? 0 : /[.?!]/.test(c) ? 3000 : c === ':' ? 2000 : c === ';' ? 1500 : c === ',' ? 1250 : /[A-Z]/.test(c) ? 999 : 1000;
  let factor = 1000;
  for (const c of text) {
    const s = sfcode(c);
    if (s) factor = s > 1000 && factor < 1000 ? 1000 : s;
  }
  return { type: 'glue', width: space.width + (factor >= 2000 ? space.extra : 0), stretch: space.stretch * factor / 1000, shrink: space.shrink * 1000 / factor };
}

/**
 * Breaks a list of items into lines: boxes {type:'box', width}, glue {type:'glue', width,
 * stretch, shrink} and penalties {type:'penalty', width, penalty, flagged}, ending with TeX's
 * \parfillskip and a forced break; a penalty marked `soft` is a hyphenation point, which TeX's
 * first pass (`hyphenate` false) does not use. `widths(n)` is the width of line n (0 first).
 * Returns the indices of the breaks, or null when no sequence of breaks fits.
 */
export function breakLines(items, widths, { tolerance, linepenalty, adjdemerits, doublehyphendemerits, finalhyphendemerits, ragged = false, background = 0 } = TEX, hyphenate = true) {
  // Running sums of width, stretch and shrink up to each item, so a line's sums are differences.
  const sum = [{ width: 0, stretch: 0, shrink: 0, fil: 0 }];
  for (const item of items) {
    const last = sum.at(-1);
    sum.push(item.type === 'box' ? { ...last, width: last.width + item.width }
      : item.type === 'glue' ? { width: last.width + item.width, stretch: last.stretch + (item.fil ? 0 : item.stretch), shrink: last.shrink + item.shrink, fil: last.fil + (item.fil ? 1 : 0) }
      : last);
  }
  // Where a line after a break at b starts: past the glue and penalties that vanish at a break.
  const startAfter = b => { let i = b + 1; while (i < items.length && items[i].type !== 'box' && !(items[i].type === 'penalty' && items[i].penalty <= -INFINITE)) i++; return i; };
  // The paragraph starts as if after a decent line, as TeX's first active node does.
  let active = [{ position: -1, start: 0, line: 0, fitness: 2, demerits: 0, flagged: false, previous: null }];
  const legal = (i) => {
    const item = items[i];
    if (item.type === 'penalty') return item.penalty < INFINITE && (hyphenate || !item.soft);
    return item.type === 'glue' && i > 0 && items[i - 1].type === 'box';
  };
  for (let i = 0; i < items.length; i++) {
    if (!legal(i)) continue;
    const item = items[i], penalty = item.type === 'penalty' ? item.penalty : 0, flagged = item.type === 'penalty' && !!item.flagged;
    const best = [null, null, null, null];
    const keep = [];
    for (const a of active) {
      const width = sum[i].width - sum[a.start].width + (item.type === 'penalty' ? item.width : 0);
      const target = widths(a.line);
      let ratio, badness;
      if (width < target) {
        // `background` is TeX's \emergencystretch, in its third pass: room to judge by, never drawn.
        const fil = sum[i].fil - sum[a.start].fil, stretch = sum[i].stretch - sum[a.start].stretch + background;
        // \raggedright's \rightskip stretches without end, so a short line is as good as any.
        ratio = fil > 0 || ragged ? 0 : stretch > 0 ? (target - width) / stretch : Infinity;
        badness = fil > 0 || ragged ? 0 : texBadness(target - width, stretch);
      } else if (width > target) {
        const shrink = sum[i].shrink - sum[a.start].shrink;
        ratio = shrink > 0 ? (target - width) / shrink : -Infinity;
        badness = texBadness(width - target, shrink);
      } else ratio = badness = 0;
      if (ratio >= -1) {
        if (badness <= tolerance) {
          let demerits = (linepenalty + badness) ** 2;
          if (penalty >= 0) demerits += penalty ** 2; else if (penalty > -INFINITE) demerits -= penalty ** 2;
          if (flagged && a.flagged) demerits += doublehyphendemerits;
          if (penalty <= -INFINITE && a.flagged) demerits += finalhyphendemerits;
          // TeX's fitness classes (tex.web §852-853): tight, decent, loose and very loose.
          const fitness = width > target ? (badness > 12 ? 3 : 2) : badness > 99 ? 0 : badness > 12 ? 1 : 2;
          if (Math.abs(fitness - a.fitness) > 1) demerits += adjdemerits;
          const total = a.demerits + demerits;
          // Of equal breaks TeX keeps the one after the latest line (tex.web §855 tests <=).
          if (!best[fitness] || total <= best[fitness].demerits)
            best[fitness] = { position: i, start: startAfter(i), line: a.line + 1, fitness, demerits: total, flagged, previous: a };
        }
      }
      // A node stays active while a line from it can still shrink to fit, until a forced
      // break; an overfull line ends it, as no later break could start a line from it.
      if (ratio >= -1 && penalty > -INFINITE) keep.push(a);
    }
    active = keep;
    // TeX keeps a break only if it is within \adjdemerits of the best one here (tex.web §836).
    const least = Math.min(...best.map(node => node?.demerits ?? Infinity));
    for (const node of best) if (node && node.demerits <= least + Math.abs(adjdemerits)) active.push(node);
    if (!active.length) return null;
  }
  const end = active.filter(a => a.position === items.length - 1).sort((x, y) => x.demerits - y.demerits)[0];
  if (!end) return null;
  const breaks = [];
  for (let node = end; node && node.position >= 0; node = node.previous) breaks.unshift(node.position);
  return breaks;
}

/**
 * Text with a soft hyphen wherever TeX's English sets one: at the breaks `hyphenate` (TeX's US
 * patterns) finds, at least two letters into a word and three before its end, in words of
 * letters that follow a space or an opening bracket or quote, as TeX hyphenates only those; a
 * compound's parts after its hyphen are left whole. Chromium on Windows hyphenates nothing.
 */
export function softHyphens(text, hyphenate) {
  return text.replace(/(^|[\s(\[“‘"'])([A-Za-z]{5,})(?![A-Za-z-])/g, (all, before, word) => {
    const parts = hyphenate(word, { hyphenChar: '­' }).split('­');
    let out = '', at = 0;
    parts.forEach((part, i) => { out += part; at += part.length; if (i < parts.length - 1 && at >= 2 && word.length - at >= 3) out += '­'; });
    return before + out;
  });
}

// ---------- Measuring and setting a paragraph ----------
// Times New Roman's advance widths, in thousandths of an em, for the characters of TIMES_CHARS.
// Word sets the paper's text with them, unkerned and without ligatures, and so does the preview,
// so a line set here is a line in both.
const TIMES_CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u2019\u2018\u201c\u201d\u2013\u2014\u2026\u00e9\u00e8\u00f6\u00fc\u00e4\u00e5\u00f8\u00e6\u00c5\u00c9\u00d6\u00dc\u00c4\u00e7\u00f1\u00d7\u00b7\u2022\u00a0\u00ad";
const TIMES_WIDTHS = {
  regular: [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,333,333,444,444,500,1000,1000,444,444,500,500,444,444,500,667,722,611,722,722,722,444,500,564,333,350,250,333],
  italic: [250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,333,333,556,556,500,889,889,444,444,500,500,500,500,500,667,611,611,722,722,611,444,500,675,250,350,250,333],
  bold: [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,333,333,500,500,500,1000,1000,444,444,500,556,500,500,500,722,722,667,778,722,722,444,556,570,333,350,250,333],
  boldItalic: [250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,333,333,500,500,500,1000,1000,444,444,500,556,500,500,500,722,667,667,722,722,667,444,556,570,250,350,250,333],
};
const TIMES_AT = new Map([...TIMES_CHARS].map((c, i) => [c, i]));

/**
 * The width in points of `text` at `style.size` points, in Times New Roman, bold and italic as
 * the style says, or in Consolas (0.55 em a character) for code; unkerned, as Word measures it.
 */
export function timesWidth(text, style = {}) {
  const size = style.size ?? 10;
  if (style.code) return [...text].length * 0.55 * size;
  const table = TIMES_WIDTHS[style.bold ? (style.italic ? 'boldItalic' : 'bold') : style.italic ? 'italic' : 'regular'];
  let width = 0;
  for (const c of text) width += table[TIMES_AT.get(c)] ?? 500;
  return width * size / 1000;
}

// TeX Gyre Termes as XeTeX sets the reference: advance widths for TIMES_CHARS but the
// soft hyphen, the kerns between them and the f-ligatures, in thousandths of an em, read from the
// fonts' hmtx, GPOS and GSUB tables. Breaking a paragraph with these finds TeX's own lines, which
// the preview and the typeset Word export then draw in Times New Roman.
const TERMES = {
  regular: { widths: [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541,333,333,444,444,500,1000,1000,444,444,500,500,444,444,500,667,722,611,722,722,722,444,500,564,250,350,333],
    ligatures: {"ffl": 827, "ff": 600, "fl": 556, "fi": 556},
    kern: {"Ab":-20,"AC":-55,"Ac":-30,"Ad":-30,"Ae":-25,"AG":-55,"Ag":-20,"A-":-25,"AO":-60,"Ao":-40,"AQ":-60,"Aq":-20,"AT":-55,"At":-20,"AU":-60,"Au":-30,"AV":-130,"Av":-80,"AW":-115,"Aw":-75,"AY":-80,"Ay":-85,"Aç":-30,"AÖ":-60,"Aö":-40,"Aø":-40,"A”":-90,"A’":-115,"AÜ":-60,"Aü":-30,"aj":-25,"av":-30,"aw":-30,"ay":-30,"a’":-40,"BA":-50,"BO":-25,"BV":-65,"BW":-60,"BY":-70,"BÄ":-50,"BÅ":-50,"BÖ":-25,"bv":-25,"bw":-30,"by":-30,"CA":-25,"CO":-10,"CÄ":-25,"CÅ":-25,"CÖ":-10,"ch":-15,"ck":-20,",”":-30,",’":-55,"DA":-65,"DJ":-40,"DV":-70,"DW":-55,"DX":-65,"DY":-75,"DÄ":-65,"DÅ":-65,"eV":-85,"ev":-25,"ew":-30,"ex":-35,"ey":-30,"e’":-30,"FA":-70,"Fa":-35,"F,":-50,"Fe":-20,"Fi":-15,"FJ":-15,"Fj":-20,"Fo":-20,"F.":-60,"Fu":-10,"FÄ":-70,"Fä":-20,"Fæ":-35,"FÅ":-70,"Få":-20,"Fé":-15,"Fè":-10,"Fö":-10,"Fø":-20,"Fü":-5,"fa":-25,"fe":-35,"fi":15,"fl":45,"fo":-40,"fs":-20,"fä":-15,"fæ":-25,"få":-15,"fé":-25,"fè":-20,"fö":-20,"fø":-40,"f’":15,"GA":-25,"GT":-20,"GV":-25,"GW":-20,"GY":-25,"GÄ":-25,"GÅ":-25,"ga":-20,"ge":-25,"gr":10,"gä":-20,"gæ":-20,"gå":-20,"gè":-25,"hy":-30,"h’":-40,"-A":-25,"-T":-75,"-V":-80,"-W":-60,"-Y":-110,"-Ä":-25,"-Å":-25,"ij":-35,"iT":-30,"JA":-55,"JÄ":-55,"JÅ":-55,"KC":-45,"Ke":-20,"KG":-50,"K-":-65,"KO":-50,"Ko":-30,"Ku":-20,"Ky":-85,"Ké":-20,"Kè":-20,"KÖ":-50,"Kö":-30,"Kø":-30,"Kü":-20,"ke":-20,"kg":-10,"k-":-65,"ko":-30,"ku":15,"kV":-45,"kW":-35,"ké":-20,"kè":-20,"kö":-30,"kø":-30,"kü":15,"L-":25,"LT":-75,"LU":-25,"LV":-115,"LW":-90,"LY":-100,"Ly":-55,"L”":-100,"L’":-125,"LÜ":-25,"lv":-30,"ly":-25,"mv":-30,"mw":-30,"my":-30,"NA":-30,"Na":-25,"NC":-15,"N,":-15,"Ne":-15,"NG":-20,"NO":-20,"No":-20,"N.":-20,"Nu":-25,"NÄ":-30,"Nä":-25,"Næ":-25,"NÅ":-30,"Nå":-25,"Né":-15,"Nè":-15,"NÖ":-20,"Nö":-20,"Nø":-20,"Nü":-25,"np":-15,"nT":-55,"nv":-30,"nw":-30,"ny":-30,"n’":-40,"OA":-60,"OV":-70,"OW":-55,"OX":-55,"OY":-70,"OÄ":-60,"OÅ":-60,"oT":-90,"ov":-35,"ow":-35,"ox":-35,"oy":-40,"o’":-35,"PA":-90,"Pa":-20,"P,":-95,"Pe":-25,"P-":-40,"PJ":-50,"Po":-25,"P.":-100,"PÄ":-90,"Pä":-20,"Pæ":-20,"PÅ":-90,"På":-20,"Pè":-25,"Pö":-25,"Pø":-25,"py":-30,".”":-35,".’":-60,"qu":-10,"qü":-10,"RC":-40,"Re":-25,"RG":-45,"R-":-50,"RO":-45,"Ro":-35,"RT":-35,"RU":-55,"Ru":-25,"RV":-75,"RW":-70,"RY":-75,"Ry":-35,"Ré":-25,"Rè":-25,"RÖ":-45,"Rö":-35,"Rø":-35,"RÜ":-55,"Rü":-25,"r,":-40,"rf":20,"rg":-15,"r-":-45,"ri":20,"rj":15,"rl":-20,"rm":20,"rn":20,"rp":25,"r.":-50,"rr":25,"rt":25,"ru":20,"rv":20,"rw":20,"rx":15,"ry":20,"rñ":20,"r’":-20,"rü":20,"SA":-35,"ST":-20,"St":-20,"SV":-25,"SW":-20,"SY":-30,"SÄ":-35,"SÅ":-35,"st":-15,"s’":-40,"TA":-55,"Ta":-75,"Tc":-85,"T:":-90,"T,":-75,"Te":-85,"Tg":-90,"T-":-75,"Ti":-20,"TJ":-20,"Tj":-25,"To":-90,"T.":-80,"Tr":-50,"Ts":-75,"T;":-85,"Tu":-95,"TV":15,"Tv":-105,"TW":20,"Tw":-105,"TY":10,"Ty":-100,"TÄ":-55,"Tä":-40,"Tæ":-80,"TÅ":-55,"Tå":-40,"Tç":-85,"Té":-65,"Tè":-45,"Tö":-45,"Tø":-90,"Tü":-50,"t’":-30,"UA":-65,"U,":-30,"Um":-35,"Un":-30,"Up":-30,"U.":-35,"Ur":-25,"UÄ":-65,"UÅ":-65,"Uñ":-15,"u’":-35,"VA":-125,"Va":-90,"VC":-65,"V:":-90,"V,":-105,"Ve":-85,"VG":-65,"Vg":-100,"V-":-70,"Vi":-20,"VO":-65,"Vo":-90,"V.":-110,"Vr":-55,"VS":-45,"V;":-90,"Vu":-50,"Vy":-55,"VÄ":-125,"Vä":-45,"Væ":-80,"VÅ":-125,"Vå":-45,"Vé":-65,"Vè":-45,"VÖ":-65,"Vö":-45,"Vø":-90,"Vü":-25,"va":-25,"vc":-35,"v:":-20,"v,":-70,"ve":-35,"vg":-40,"v-":-30,"vl":-30,"vo":-35,"v.":-75,"vs":-20,"v;":-20,"vä":-25,"væ":-25,"vå":-25,"vç":-35,"vé":-35,"vè":-35,"vö":-35,"vø":-35,"WA":-115,"Wa":-80,"WC":-55,"W:":-80,"W,":-90,"We":-70,"WG":-55,"Wg":-90,"W-":-55,"Wi":-15,"WO":-55,"Wo":-75,"W.":-95,"Wr":-45,"WS":-40,"W;":-80,"WT":15,"Wu":-45,"Wy":-45,"WÄ":-115,"Wä":-40,"Wæ":-80,"WÅ":-115,"Wå":-40,"Wé":-55,"Wè":-35,"WÖ":-55,"Wö":-40,"Wø":-75,"Wü":-25,"wa":-25,"wc":-35,"w:":-25,"w,":-65,"we":-30,"wg":-45,"w-":-25,"wl":-35,"wo":-35,"w.":-70,"ws":-25,"w;":-25,"wä":-25,"wæ":-25,"wå":-25,"wç":-35,"wö":-35,"wø":-35,"XC":-55,"Xe":-30,"X-":-55,"XO":-60,"Xo":-40,"XQ":-60,"Xu":-30,"Xy":-95,"Xé":-30,"Xè":-30,"XÖ":-60,"Xö":-40,"Xø":-40,"Xü":-30,"xa":-10,"xc":-35,"xe":-30,"xo":-45,"xq":-25,"xä":-10,"xå":-10,"xç":-35,"xé":-30,"xè":-30,"xö":-45,"xø":-45,"YA":-75,"Ya":-100,"YC":-70,"Y:":-110,"Y,":-95,"Ye":-105,"YG":-70,"Yg":-110,"Y-":-100,"Yi":-15,"YJ":-30,"YO":-70,"Yo":-105,"Yp":-90,"Y.":-105,"YS":-45,"Y;":-110,"YT":15,"Yu":-80,"Yv":-85,"YÄ":-75,"Yä":-50,"Yæ":-80,"YÅ":-75,"Yå":-50,"Yé":-80,"Yè":-55,"YÖ":-70,"Yö":-55,"Yø":-105,"Yü":-40,"ya":-30,"yc":-35,"y:":-25,"y,":-65,"ye":-35,"yg":-50,"y-":-25,"yl":-30,"yo":-40,"y.":-75,"ys":-25,"y;":-25,"yä":-30,"yæ":-25,"yå":-30,"yç":-35,"yö":-40,"yø":-40,"Zv":-50,"Zy":-50,"Äb":-20,"ÄC":-55,"Äc":-30,"Äd":-30,"Äe":-25,"ÄG":-55,"Äg":-20,"Ä-":-25,"ÄO":-60,"Äo":-40,"ÄQ":-60,"Äq":-20,"ÄT":-55,"Ät":-20,"ÄU":-60,"Äu":-30,"ÄV":-130,"Äv":-80,"ÄW":-115,"Äw":-75,"ÄY":-80,"Äy":-85,"Äç":-30,"ÄÖ":-60,"Äö":-40,"Äø":-40,"Ä”":-90,"Ä’":-115,"ÄÜ":-60,"Äü":-30,"äj":-25,"äv":-30,"äw":-30,"äy":-30,"ä’":-40,"æv":-25,"æw":-30,"æy":-30,"Åb":-20,"ÅC":-55,"Åc":-30,"Åd":-30,"Åe":-25,"ÅG":-55,"Åg":-20,"Å-":-25,"ÅO":-60,"Åo":-40,"ÅQ":-60,"Åq":-20,"ÅT":-55,"Åt":-20,"ÅU":-60,"Åu":-30,"ÅV":-130,"Åv":-80,"ÅW":-115,"Åw":-75,"ÅY":-80,"Åy":-85,"Åç":-30,"ÅÖ":-60,"Åö":-40,"Åø":-40,"Å”":-90,"Å’":-115,"ÅÜ":-60,"Åü":-30,"åj":-25,"åv":-30,"åw":-30,"åy":-30,"å’":-40,"çh":-15,"çk":-20,"ñp":-15,"ñT":-55,"ñv":-30,"ñw":-30,"ñy":-30,"ñ’":-40,"ÖA":-60,"ÖV":-70,"ÖW":-55,"ÖX":-55,"ÖY":-70,"ÖÄ":-60,"ÖÅ":-60,"öT":-90,"öv":-35,"öw":-35,"öx":-35,"öy":-40,"ö’":-35,"øT":-90,"øv":-35,"øw":-35,"øx":-35,"øy":-40,"ø’":-35,"“A":-85,"“T":15,"“Ä":-85,"“Å":-85,"”A":-95,"”T":10,"”Ä":-95,"”Å":-95,"‘A":-110,"‘V":-25,"‘W":-15,"‘Y":-25,"‘Ä":-110,"‘Å":-110,"’A":-130,"’,":-70,"’d":-55,"’o":-55,"’.":-80,"’r":-45,"’s":-45,"’t":-45,"’v":-45,"’w":-45,"’y":-45,"’Ä":-130,"’Å":-130,"’ö":-55,"’ø":-55,"ÜA":-65,"Ü,":-30,"Üm":-35,"Ün":-30,"Üp":-30,"Ü.":-35,"Ür":-25,"ÜÄ":-65,"ÜÅ":-65,"Üñ":-15,"ü’":-35} },
  italic: { widths: [250,333,420,500,500,833,778,214,333,333,500,675,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,675,675,675,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,500,389,389,278,500,444,667,444,444,389,400,275,400,541,333,333,556,556,500,889,889,444,444,500,500,500,500,500,667,611,611,722,722,611,444,500,675,250,350,333],
    ligatures: {"ffl": 762, "ff": 533, "fl": 500, "fi": 500},
    kern: {"AC":-50,"Ac":-20,"Ae":-15,"AG":-45,"Ag":-25,"A-":-10,"AO":-45,"Ao":-15,"AQ":-45,"Aq":-10,"AT":-15,"AU":-55,"AV":-80,"Av":-50,"AW":-75,"Aw":-45,"AY":-20,"Ay":-55,"Aç":-20,"AÖ":-45,"Aö":-15,"Aø":-15,"A”":-140,"A’":-140,"AÜ":-55,"aj":-20,"a’":-30,"BA":-20,"BO":-15,"BV":-30,"BW":-30,"BY":-40,"BÄ":-20,"BÅ":-20,"BÖ":-15,"CA":-15,"CH":-15,"CK":-20,"CO":-20,"CÄ":-15,"CÅ":-15,"CÖ":-20,"ch":-30,"ck":-30,",”":-40,",’":-40,"DA":-35,"DJ":-30,"DV":-40,"DW":-35,"DX":-40,"DY":-50,"DÄ":-35,"DÅ":-35,"et":-15,"eV":-75,"e’":-20,"FA":-70,"Fa":-75,"F,":-95,"Fe":-80,"F-":-45,"Fi":-35,"FJ":-60,"Fj":-40,"FO":-40,"Fo":-80,"F.":-100,"Fr":-50,"Fu":-50,"FÄ":-70,"Fä":-40,"Fæ":-80,"FÅ":-70,"Få":-40,"Fé":-60,"Fè":-40,"FÖ":-40,"Fö":-40,"Fø":-80,"Fü":-25,"fa":-25,"fe":-30,"ff":30,"fi":15,"fj":15,"fl":40,"fo":-30,"fs":-20,"ft":20,"fä":-15,"fæ":-30,"få":-15,"fé":-25,"fè":-15,"fö":-15,"fø":-30,"f’":20,"GA":-15,"GT":-15,"GY":-10,"GÄ":-15,"GÅ":-15,"ga":-40,"ge":-45,"gl":-45,"gr":-20,"gä":-40,"gæ":-45,"gå":-40,"gè":-45,"h’":-30,"-T":-45,"-V":-45,"-W":-35,"-Y":-55,"ij":-30,"JA":-40,"JÄ":-40,"JÅ":-40,"KC":-55,"Ke":-20,"KG":-55,"K-":-55,"KO":-45,"Ko":-20,"KT":20,"Ky":-85,"Ké":-20,"Kè":-20,"KÖ":-45,"Kö":-20,"Kø":-20,"ka":10,"k,":25,"kg":-25,"k-":-25,"k.":25,"kV":-40,"kW":-30,"kä":10,"kå":10,"LA":45,"LG":10,"L-":45,"LS":20,"LT":-15,"Lu":10,"LV":-55,"LW":-50,"LY":-20,"Ly":-30,"LÄ":45,"LÅ":45,"L”":-90,"L’":-90,"Lü":10,"lv":-15,"NA":-20,"Na":-20,"NC":-20,"N,":-15,"Ne":-30,"NG":-15,"NO":-20,"No":-25,"N.":-15,"Nu":-25,"NÄ":-20,"Nä":-20,"Næ":-25,"NÅ":-20,"Nå":-20,"Né":-30,"Nè":-30,"NÖ":-20,"Nö":-25,"Nø":-25,"Nü":-25,"nT":-40,"n’":-35,"OA":-35,"OV":-45,"OW":-40,"OX":-40,"OY":-50,"OÄ":-35,"OÅ":-35,"oT":-60,"ot":-15,"ov":-20,"ow":-15,"ox":-30,"oy":-15,"o’":-25,"PA":-80,"Pa":-75,"P,":-115,"Pe":-80,"P-":-65,"PJ":-90,"Po":-70,"P.":-120,"PÄ":-80,"Pä":-75,"Pæ":-80,"PÅ":-80,"På":-75,"Pè":-80,"Pö":-70,"Pø":-70,"pt":-15,".”":-40,".’":-40,"qc":-15,"qu":-10,"qç":-15,"qü":-10,"RC":-25,"Re":-15,"RG":-20,"R-":-30,"RO":-25,"Ro":-15,"RU":-35,"RV":-30,"RW":-30,"RY":-20,"Ré":-15,"Rè":-15,"RÖ":-25,"Rö":-15,"Rø":-15,"RÜ":-35,"ra":-25,"rc":-25,"r:":-30,"r,":-70,"rd":-30,"re":-30,"rf":25,"rg":-20,"rh":-15,"r-":-50,"rk":-15,"rl":-20,"rm":15,"rn":15,"ro":-25,"rp":15,"r.":-70,"rq":-30,"rs":-15,"r;":-30,"rt":10,"ru":10,"rv":30,"rw":30,"ry":30,"rä":-25,"ræ":-35,"rå":-25,"rç":-25,"ré":-30,"rè":-30,"rñ":15,"rö":-25,"rø":-25,"rü":10,"St":-15,"st":-10,"s’":-20,"TA":-35,"Ta":-80,"TC":-15,"Tc":-85,"T:":-85,"T,":-70,"Te":-90,"Tg":-100,"T-":-70,"Ti":-15,"TJ":-40,"Tj":-20,"TO":-20,"To":-85,"T.":-70,"Tr":-85,"Ts":-75,"T;":-90,"Tu":-85,"TV":40,"Tv":-75,"TW":45,"Tw":-70,"TY":35,"Ty":-70,"TÄ":-35,"Tä":-40,"Tæ":-55,"TÅ":-35,"Tå":-40,"Tç":-85,"Té":-70,"Tè":-45,"TÖ":-20,"Tö":-45,"Tø":-85,"Tü":-45,"t:":-30,"te":-15,"th":-10,"to":-10,"t;":-25,"té":-15,"tè":-15,"tö":-10,"tø":-10,"t’":-20,"UA":-50,"U,":-35,"Um":-30,"Un":-30,"Up":-30,"U.":-40,"Ur":-40,"UÄ":-50,"UÅ":-50,"Uñ":-15,"u’":-30,"VA":-65,"Va":-65,"VC":-45,"V:":-80,"V,":-75,"Ve":-75,"VG":-40,"Vg":-85,"V-":-45,"Vi":-15,"VO":-45,"Vo":-70,"V.":-80,"Vr":-45,"VS":-15,"V;":-80,"VT":30,"Vu":-40,"Vy":-10,"VÄ":-65,"Vä":-35,"Væ":-55,"VÅ":-65,"Vå":-35,"Vé":-55,"Vè":-40,"VÖ":-45,"Vö":-35,"Vø":-70,"Vü":-20,"va":-25,"vc":-25,"v:":-50,"v,":-45,"ve":-30,"vg":-35,"vl":-30,"vo":-25,"v.":-50,"vs":-30,"v;":-50,"vä":-25,"væ":-25,"vå":-25,"vç":-25,"vé":-30,"vè":-30,"vö":-25,"vø":-25,"WA":-55,"Wa":-55,"WC":-40,"W:":-75,"W,":-60,"We":-60,"WG":-30,"Wg":-75,"W-":-30,"Wi":-20,"WO":-40,"Wo":-55,"W.":-60,"Wr":-40,"WS":-15,"W;":-75,"WT":30,"Wu":-35,"WÄ":-55,"Wä":-30,"Wæ":-55,"WÅ":-55,"Wå":-30,"Wé":-45,"Wè":-30,"WÖ":-40,"Wö":-30,"Wø":-55,"Wü":-20,"wa":-25,"wc":-30,"w:":-50,"w,":-45,"we":-30,"wg":-40,"wl":-30,"wo":-30,"w.":-50,"ws":-30,"w;":-50,"wä":-25,"wæ":-25,"wå":-25,"wç":-30,"wö":-30,"wø":-30,"XC":-50,"Xe":-15,"X-":-40,"XO":-45,"Xo":-15,"XQ":-40,"Xy":-60,"Xé":-15,"Xè":-15,"XÖ":-45,"Xö":-15,"Xø":-15,"YA":-25,"Ya":-70,"YC":-50,"Y:":-80,"Y,":-65,"Ye":-80,"YG":-45,"Yg":-95,"Y-":-60,"Yi":-15,"YJ":-40,"YO":-50,"Yo":-75,"Yp":-50,"Y.":-65,"YS":-15,"Y;":-85,"YT":30,"Yu":-60,"Yv":-35,"YÄ":-25,"Yä":-35,"Yæ":-55,"YÅ":-25,"Yå":-35,"Yé":-60,"Yè":-40,"YÖ":-50,"Yö":-40,"Yø":-75,"Yü":-30,"ya":-15,"yc":-15,"y:":-50,"y,":-25,"ye":-20,"yg":-35,"yl":-20,"yo":-15,"y.":-25,"ys":-20,"y;":-45,"yä":-15,"yæ":-25,"yå":-15,"yç":-15,"yö":-15,"yø":-15,"Zv":-10,"Zy":-30,"ÄC":-50,"Äc":-20,"Äe":-15,"ÄG":-45,"Äg":-25,"Ä-":-10,"ÄO":-45,"Äo":-15,"ÄQ":-45,"Äq":-10,"ÄT":-15,"ÄU":-55,"ÄV":-80,"Äv":-50,"ÄW":-75,"Äw":-45,"ÄY":-20,"Äy":-55,"Äç":-20,"ÄÖ":-45,"Äö":-15,"Äø":-15,"Ä”":-140,"Ä’":-140,"ÄÜ":-55,"äj":-20,"ä’":-30,"ÅC":-50,"Åc":-20,"Åe":-15,"ÅG":-45,"Åg":-25,"Å-":-10,"ÅO":-45,"Åo":-15,"ÅQ":-45,"Åq":-10,"ÅT":-15,"ÅU":-55,"ÅV":-80,"Åv":-50,"ÅW":-75,"Åw":-45,"ÅY":-20,"Åy":-55,"Åç":-20,"ÅÖ":-45,"Åö":-15,"Åø":-15,"Å”":-140,"Å’":-140,"ÅÜ":-55,"åj":-20,"å’":-30,"çh":-30,"çk":-30,"ét":-15,"èt":-15,"ñT":-40,"ñ’":-35,"ÖA":-35,"ÖV":-45,"ÖW":-40,"ÖX":-40,"ÖY":-50,"ÖÄ":-35,"ÖÅ":-35,"öT":-60,"öt":-15,"öv":-20,"öw":-15,"öx":-30,"öy":-15,"ö’":-25,"øT":-60,"øt":-15,"øv":-20,"øw":-15,"øx":-30,"øy":-15,"ø’":-25,"“A":-85,"“T":-20,"“V":-15,"“W":-15,"“Y":-25,"“Ä":-85,"“Å":-85,"”A":-95,"”T":-20,"”V":-20,"”W":-20,"”Y":-30,"”Ä":-95,"”Å":-95,"‘A":-80,"‘Y":-15,"‘Ä":-80,"‘Å":-80,"’A":-85,"’,":-75,"’d":-80,"’o":-80,"’.":-80,"’r":-55,"’s":-65,"’t":-50,"’v":-30,"’w":-25,"’y":-25,"’Ä":-85,"’Å":-85,"’ö":-80,"’ø":-80,"ÜA":-50,"Ü,":-35,"Üm":-30,"Ün":-30,"Üp":-30,"Ü.":-40,"Ür":-40,"ÜÄ":-50,"ÜÅ":-50,"Üñ":-15,"ü’":-30} },
  bold: { widths: [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,333,333,500,500,500,1000,1000,444,444,500,556,500,500,500,722,722,667,778,722,722,444,556,570,250,350,333],
    ligatures: {"ffl": 833, "ff": 610, "fl": 556, "fi": 556},
    kern: {"Ab":-20,"AC":-75,"Ac":-35,"Ad":-30,"Ae":-30,"AG":-70,"A-":-30,"AO":-70,"Ao":-35,"AQ":-70,"Aq":-40,"AT":-60,"At":-25,"AU":-65,"Au":-30,"AV":-130,"Av":-85,"AW":-115,"Aw":-80,"AY":-75,"Ay":-85,"Aç":-35,"AÖ":-70,"Aö":-35,"Aø":-35,"A”":-75,"A’":-110,"AÜ":-65,"Aü":-30,"aj":-40,"av":-40,"aw":-40,"ay":-45,"a’":-35,"BA":-35,"BO":-10,"BV":-45,"BW":-45,"BY":-45,"BÄ":-35,"BÅ":-35,"BÖ":-10,"bv":-40,"bw":-40,"by":-40,"CA":-25,"CO":-15,"CÄ":-25,"CÅ":-25,"CÖ":-15,"ch":-15,"ck":-20,",’":-25,"DA":-55,"DJ":-40,"DV":-60,"DW":-50,"DX":-50,"DY":-60,"DÄ":-55,"DÅ":-55,"et":-10,"eV":-85,"ev":-30,"ew":-30,"ex":-20,"ey":-30,"e’":-20,"FA":-80,"Fa":-50,"F,":-60,"Fe":-50,"F-":-35,"FJ":-40,"Fj":-25,"Fo":-55,"F.":-60,"FÄ":-80,"Fä":-25,"Fæ":-55,"FÅ":-80,"Få":-25,"Fé":-40,"Fè":-25,"Fö":-30,"Fø":-55,"fa":-15,"fe":-30,"ff":10,"fi":20,"fl":35,"fo":-30,"fä":-10,"fæ":-20,"få":-10,"fé":-25,"fè":-15,"fö":-15,"fø":-30,"f’":20,"GA":-25,"GT":-40,"GV":-35,"GW":-35,"GY":-35,"GÄ":-25,"GÅ":-25,"ga":-15,"ge":-20,"gä":-15,"gæ":-20,"gå":-15,"gè":-20,"hy":-35,"h’":-30,"-A":-20,"-T":-75,"-V":-70,"-W":-55,"-Y":-85,"-Ä":-20,"-Å":-20,"ij":-35,"iT":-20,"JA":-30,"JÄ":-30,"JÅ":-30,"KC":-60,"Ke":-20,"KG":-55,"K-":-45,"KO":-55,"Ko":-25,"KS":15,"Ku":-20,"Ky":-85,"Ké":-20,"Kè":-20,"KÖ":-55,"Kö":-25,"Kø":-25,"Kü":-20,"ke":-35,"k-":-45,"ko":-40,"kV":-45,"kW":-35,"ké":-35,"kè":-35,"kö":-40,"kø":-40,"LC":-10,"L-":25,"LT":-75,"LU":-30,"Lu":-10,"LV":-105,"LW":-85,"LY":-90,"Ly":-50,"L”":-35,"L’":-70,"LÜ":-30,"Lü":-10,"lv":-20,"ly":-20,"mp":-15,"mv":-30,"mw":-35,"my":-35,"NA":-20,"Na":-15,"NC":-20,"Ne":-15,"NG":-15,"NO":-15,"No":-15,"Nu":-15,"NÄ":-20,"Nä":-15,"Næ":-20,"NÅ":-20,"Nå":-15,"Né":-15,"Nè":-15,"NÖ":-15,"Nö":-15,"Nø":-15,"Nü":-15,"np":-15,"nT":-55,"nv":-30,"nw":-30,"ny":-30,"n’":-30,"OA":-55,"OV":-60,"OW":-55,"OX":-50,"OY":-60,"OÄ":-55,"OÅ":-55,"oT":-90,"ot":-10,"ov":-40,"ow":-40,"ox":-30,"oy":-45,"o’":-30,"PA":-80,"Pa":-20,"P,":-85,"Pe":-30,"P-":-40,"PJ":-70,"Po":-35,"P.":-85,"PÄ":-80,"Pä":-20,"Pæ":-25,"PÅ":-80,"På":-20,"Pè":-30,"Pö":-35,"Pø":-35,"pt":-10,"py":-35,".’":-25,"qc":-15,"qu":-15,"qç":-15,"qü":-15,"RC":-35,"Re":-20,"RG":-30,"R-":-30,"RO":-30,"Ro":-25,"RT":-25,"RU":-35,"Ru":-15,"RV":-55,"RW":-55,"RY":-50,"Ry":-25,"Ré":-20,"Rè":-20,"RÖ":-30,"Rö":-25,"Rø":-25,"RÜ":-35,"Rü":-15,"rc":-15,"r:":-15,"r,":-65,"rd":-15,"re":-10,"rf":10,"rh":-15,"r-":-20,"rj":-10,"rk":-15,"rl":-15,"ro":-15,"r.":-70,"rq":-15,"r;":-15,"rç":-15,"ré":-10,"rè":-10,"rö":-15,"rø":-15,"SA":-25,"ST":-15,"SÄ":-25,"SÅ":-25,"s’":-15,"TA":-45,"Ta":-65,"TC":-15,"Tc":-90,"T:":-85,"T,":-65,"Te":-85,"TG":-10,"Tg":-70,"T-":-75,"Ti":-15,"TJ":-45,"Tj":-40,"To":-90,"T.":-65,"Tr":-60,"Ts":-60,"T;":-85,"Tu":-90,"TV":10,"Tv":-105,"Tw":-105,"TY":10,"Ty":-105,"TÄ":-45,"Tä":-35,"Tæ":-70,"TÅ":-45,"Tå":-35,"Tç":-90,"Té":-65,"Tè":-45,"Tö":-45,"Tø":-90,"Tü":-45,"ta":10,"t:":-10,"tS":10,"t;":-10,"tä":10,"tå":10,"t’":-30,"UA":-55,"U,":-15,"Um":-25,"Un":-25,"Up":-30,"U.":-20,"Ur":-30,"UÄ":-55,"UÅ":-55,"Uñ":-15,"u’":-25,"VA":-115,"Va":-85,"VC":-70,"V:":-95,"V,":-95,"Ve":-85,"VG":-65,"Vg":-85,"V-":-70,"Vi":-10,"VO":-65,"Vo":-90,"V.":-95,"Vr":-60,"VS":-25,"V;":-95,"Vu":-60,"Vy":-55,"VÄ":-115,"Vä":-45,"Væ":-70,"VÅ":-115,"Vå":-45,"Vé":-65,"Vè":-45,"VÖ":-65,"Vö":-45,"Vø":-90,"Vü":-30,"va":-25,"vc":-40,"v:":-25,"v,":-55,"ve":-35,"vg":-25,"v-":-30,"vl":-15,"vo":-40,"v.":-55,"vs":-15,"v;":-25,"vä":-25,"væ":-25,"vå":-25,"vç":-40,"vé":-35,"vè":-35,"vö":-40,"vø":-40,"WA":-100,"Wa":-70,"WC":-60,"W:":-80,"W,":-70,"We":-70,"WG":-50,"Wg":-70,"W-":-50,"Wi":-10,"WO":-50,"Wo":-70,"W.":-75,"Wr":-50,"WS":-25,"W;":-80,"Wu":-45,"Wy":-45,"WÄ":-100,"Wä":-35,"Wæ":-70,"WÅ":-100,"Wå":-35,"Wé":-55,"Wè":-35,"WÖ":-50,"Wö":-35,"Wø":-70,"Wü":-25,"wa":-25,"wc":-35,"w:":-25,"w,":-50,"we":-35,"wg":-25,"w-":-25,"wl":-15,"wo":-35,"w.":-50,"ws":-15,"w;":-25,"wä":-25,"wæ":-25,"wå":-25,"wç":-35,"wö":-35,"wø":-35,"XC":-65,"Xe":-25,"X-":-45,"XO":-55,"Xo":-30,"XQ":-55,"Xu":-25,"Xy":-90,"Xé":-25,"Xè":-25,"XÖ":-55,"Xö":-30,"Xø":-30,"Xü":-25,"xc":-30,"xe":-30,"xo":-30,"xq":-30,"xç":-30,"xé":-30,"xè":-30,"xö":-30,"xø":-30,"YA":-65,"Ya":-85,"YC":-70,"Y:":-105,"Y,":-80,"Ye":-95,"YG":-65,"Yg":-85,"Y-":-85,"Yi":-15,"YJ":-35,"YO":-65,"Yo":-95,"Yp":-70,"Y.":-80,"YS":-25,"Y;":-105,"Yu":-75,"Yv":-80,"YÄ":-65,"Yä":-45,"Yæ":-70,"YÅ":-65,"Yå":-45,"Yé":-70,"Yè":-50,"YÖ":-65,"Yö":-50,"Yø":-95,"Yü":-40,"ya":-30,"yc":-45,"y:":-30,"y,":-55,"ye":-40,"yg":-30,"y-":-30,"yl":-20,"yo":-45,"y.":-55,"ys":-25,"y;":-30,"yä":-30,"yæ":-25,"yå":-30,"yç":-45,"yö":-45,"yø":-45,"Zv":-45,"Zy":-45,"Äb":-20,"ÄC":-75,"Äc":-35,"Äd":-30,"Äe":-30,"ÄG":-70,"Ä-":-30,"ÄO":-70,"Äo":-35,"ÄQ":-70,"Äq":-40,"ÄT":-60,"Ät":-25,"ÄU":-65,"Äu":-30,"ÄV":-130,"Äv":-85,"ÄW":-115,"Äw":-80,"ÄY":-75,"Äy":-85,"Äç":-35,"ÄÖ":-70,"Äö":-35,"Äø":-35,"Ä”":-75,"Ä’":-110,"ÄÜ":-65,"Äü":-30,"äj":-40,"äv":-40,"äw":-40,"äy":-45,"ä’":-35,"æv":-35,"æw":-35,"æy":-35,"Åb":-20,"ÅC":-75,"Åc":-35,"Åd":-30,"Åe":-30,"ÅG":-70,"Å-":-30,"ÅO":-70,"Åo":-35,"ÅQ":-70,"Åq":-40,"ÅT":-60,"Åt":-25,"ÅU":-65,"Åu":-30,"ÅV":-130,"Åv":-85,"ÅW":-115,"Åw":-80,"ÅY":-75,"Åy":-85,"Åç":-35,"ÅÖ":-70,"Åö":-35,"Åø":-35,"Å”":-75,"Å’":-110,"ÅÜ":-65,"Åü":-30,"åj":-40,"åv":-40,"åw":-40,"åy":-45,"å’":-35,"çh":-15,"çk":-20,"ét":-10,"èt":-10,"ñp":-15,"ñT":-55,"ñv":-30,"ñw":-30,"ñy":-30,"ñ’":-30,"ÖA":-55,"ÖV":-60,"ÖW":-55,"ÖX":-50,"ÖY":-60,"ÖÄ":-55,"ÖÅ":-55,"öT":-90,"öt":-10,"öv":-40,"öw":-40,"öx":-30,"öy":-45,"ö’":-30,"øT":-90,"øt":-10,"øv":-40,"øw":-40,"øx":-30,"øy":-45,"ø’":-30,"“A":-60,"“V":15,"“W":15,"“Y":15,"“Ä":-60,"“Å":-60,"”A":-70,"”Ä":-70,"”Å":-70,"‘A":-90,"‘T":-20,"‘V":-15,"‘W":-20,"‘Y":-15,"‘Ä":-90,"‘Å":-90,"’A":-90,"’,":-35,"’d":-30,"’o":-35,"’.":-35,"’r":-25,"’s":-15,"’t":-20,"’v":-25,"’w":-25,"’y":-20,"’Ä":-90,"’Å":-90,"’ö":-35,"’ø":-35,"ÜA":-55,"Ü,":-15,"Üm":-25,"Ün":-25,"Üp":-30,"Ü.":-20,"Ür":-30,"ÜÄ":-55,"ÜÅ":-55,"Üñ":-15,"ü’":-25} },
  boldItalic: { widths: [250,389,555,500,500,833,778,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,832,667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,722,667,556,611,722,667,889,667,611,611,333,278,333,570,500,333,500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,500,389,389,278,556,444,667,500,444,389,348,220,348,570,333,333,500,500,500,1000,1000,444,444,500,556,500,500,500,722,667,667,722,722,667,444,556,570,250,350,333],
    ligatures: {"ffl": 819, "ff": 617, "fl": 556, "fi": 556},
    kern: {"AC":-60,"Ac":-20,"Ae":-25,"AG":-60,"Ag":-20,"A-":-20,"AO":-55,"Ao":-25,"AQ":-55,"Aq":-20,"AT":-35,"AU":-60,"Au":-15,"AV":-110,"Av":-50,"AW":-105,"Aw":-55,"AY":-45,"Ay":-65,"Aç":-20,"AÖ":-55,"Aö":-25,"Aø":-25,"A”":-80,"A’":-100,"AÜ":-60,"Aü":-15,"a’":-20,"BA":-35,"BO":-20,"BV":-50,"BW":-50,"BY":-50,"BÄ":-35,"BÅ":-35,"BÖ":-20,"bv":-10,"bw":-10,"by":-15,"CA":-25,"CH":-25,"CK":-30,"CO":-25,"CÄ":-25,"CÅ":-25,"CÖ":-25,"ch":-20,"ck":-15,",’":-25,"DA":-50,"DJ":-65,"DT":-25,"DV":-60,"DW":-60,"DX":-65,"DY":-65,"DÄ":-50,"DÅ":-50,"eV":-85,"ex":-15,"e’":-15,"FA":-100,"Fa":-75,"F,":-95,"Fe":-85,"F-":-55,"Fi":-30,"FJ":-90,"Fj":-35,"FO":-50,"Fo":-80,"F.":-95,"Fr":-30,"Fu":-35,"FÄ":-100,"Fä":-40,"Fæ":-85,"FÅ":-100,"Få":-40,"Fé":-65,"Fè":-45,"FÖ":-50,"Fö":-40,"Fø":-80,"Fü":-20,"fa":-25,"fe":-35,"fi":20,"fj":10,"fl":45,"fo":-30,"fs":-15,"fä":-15,"fæ":-30,"få":-15,"fé":-25,"fè":-20,"fö":-15,"fø":-30,"f’":10,"GA":-15,"GT":-40,"GV":-25,"GW":-25,"GY":-30,"GÄ":-15,"GÅ":-15,"ga":-25,"ge":-30,"gl":-20,"gä":-25,"gæ":-35,"gå":-25,"gè":-30,"hy":-20,"h’":-35,"-A":-10,"-T":-60,"-V":-60,"-W":-60,"-Y":-70,"-Ä":-10,"-Å":-10,"iT":-20,"JA":-40,"JÄ":-40,"JÅ":-40,"KC":-50,"Ke":-15,"KG":-45,"K-":-30,"KO":-45,"Ko":-15,"Ky":-70,"Ké":-15,"Kè":-15,"KÖ":-45,"Kö":-15,"Kø":-15,"k,":20,"kg":-15,"k.":15,"kV":-45,"kW":-35,"LA":30,"L-":40,"LT":-30,"LU":-15,"LV":-75,"LW":-75,"LY":-40,"Ly":-25,"LÄ":30,"LÅ":30,"L”":-45,"L’":-70,"LÜ":-15,"lv":-10,"mv":-15,"mw":-15,"my":-15,"NA":-40,"Na":-25,"NC":-30,"N,":-25,"Ne":-35,"NG":-25,"NO":-30,"No":-30,"N.":-25,"Nu":-30,"NÄ":-40,"Nä":-25,"Næ":-35,"NÅ":-40,"Nå":-25,"Né":-35,"Nè":-35,"NÖ":-30,"Nö":-30,"Nø":-30,"Nü":-30,"nT":-55,"nv":-20,"nw":-20,"ny":-20,"n’":-35,"OA":-55,"OT":-20,"OV":-50,"OW":-55,"OX":-60,"OY":-55,"OÄ":-55,"OÅ":-55,"oT":-75,"ov":-20,"ow":-20,"ox":-25,"oy":-30,"o’":-20,"PA":-90,"Pa":-55,"P,":-110,"Pe":-60,"P-":-55,"PJ":-105,"Po":-55,"P.":-110,"PÄ":-90,"Pä":-55,"Pæ":-60,"PÅ":-90,"På":-55,"Pè":-60,"Pö":-55,"Pø":-55,"py":-10,".’":-30,"RC":-35,"Re":-20,"RG":-30,"R-":-30,"RO":-35,"Ro":-20,"RT":-25,"RU":-45,"Ru":-15,"RV":-45,"RW":-50,"RY":-40,"Ry":-10,"Ré":-20,"Rè":-20,"RÖ":-35,"Rö":-20,"Rø":-20,"RÜ":-45,"Rü":-15,"ra":-15,"rc":-15,"r:":-30,"r,":-70,"rd":-15,"re":-20,"rh":-15,"r-":-15,"ri":15,"rj":10,"rk":-10,"rl":-15,"ro":-15,"rp":15,"r.":-70,"rq":-20,"rr":15,"r;":-30,"rt":10,"rv":20,"rw":20,"ry":20,"rä":-15,"ræ":-20,"rå":-15,"rç":-15,"ré":-20,"rè":-20,"rö":-15,"rø":-15,"SA":-10,"ST":-35,"SV":-20,"SW":-20,"SY":-25,"SÄ":-10,"SÅ":-10,"s’":-20,"TA":-50,"Ta":-85,"TC":-15,"Tc":-90,"T:":-100,"T,":-75,"Te":-95,"Tg":-95,"T-":-75,"Ti":-20,"TJ":-65,"Tj":-25,"TO":-20,"To":-90,"T.":-80,"Tr":-75,"TS":-15,"Ts":-80,"T;":-100,"Tu":-90,"TV":15,"Tv":-90,"TW":15,"Tw":-90,"TY":10,"Ty":-85,"TÄ":-50,"Tä":-45,"Tæ":-50,"TÅ":-50,"Tå":-45,"Tç":-90,"Té":-70,"Tè":-50,"TÖ":-20,"Tö":-45,"Tø":-90,"Tü":-45,"t:":-20,"tS":-10,"t;":-25,"t’":-20,"UA":-65,"U,":-40,"Um":-35,"Un":-40,"Up":-30,"U.":-40,"Ur":-30,"UÄ":-65,"UÅ":-65,"Uñ":-20,"u’":-35,"VA":-100,"Va":-75,"VC":-60,"V:":-95,"V,":-95,"Ve":-85,"VG":-55,"Vg":-80,"V-":-60,"Vi":-10,"VO":-65,"Vo":-80,"V.":-95,"Vr":-40,"VS":-30,"V;":-95,"Vu":-45,"Vy":-35,"VÄ":-100,"Vä":-40,"Væ":-50,"VÅ":-100,"Vå":-40,"Vé":-65,"Vè":-45,"VÖ":-65,"Vö":-40,"Vø":-80,"Vü":-25,"va":-20,"vc":-25,"v:":-50,"v,":-50,"ve":-30,"vg":-20,"vl":-25,"vo":-25,"v.":-50,"vs":-20,"v;":-50,"vä":-20,"væ":-25,"vå":-20,"vç":-25,"vé":-30,"vè":-30,"vö":-25,"vø":-25,"WA":-80,"Wa":-50,"WC":-45,"W:":-80,"W,":-60,"We":-65,"WG":-40,"Wg":-65,"W-":-35,"Wi":-10,"WO":-50,"Wo":-60,"W.":-65,"Wr":-30,"WS":-30,"W;":-80,"Wu":-35,"Wy":-25,"WÄ":-80,"Wä":-25,"Wæ":-50,"WÅ":-80,"Wå":-25,"Wé":-50,"Wè":-35,"WÖ":-50,"Wö":-30,"Wø":-60,"Wü":-20,"wa":-25,"wc":-30,"w:":-55,"w,":-55,"we":-35,"wg":-25,"wl":-30,"wo":-30,"w.":-55,"ws":-25,"w;":-55,"wä":-25,"wæ":-25,"wå":-25,"wç":-30,"wö":-30,"wø":-30,"XC":-55,"Xe":-30,"X-":-45,"XO":-55,"Xo":-25,"XQ":-55,"Xu":-20,"Xy":-80,"Xé":-30,"Xè":-30,"XÖ":-55,"Xö":-25,"Xø":-25,"Xü":-20,"xe":-15,"xq":-10,"xé":-15,"xè":-15,"YA":-45,"Ya":-70,"YC":-60,"Y:":-90,"Y,":-65,"Ye":-80,"YG":-55,"Yg":-80,"Y-":-65,"Yi":-10,"YJ":-40,"YO":-60,"Yo":-75,"Yp":-50,"Y.":-70,"YS":-30,"Y;":-90,"Yu":-55,"Yv":-55,"YÄ":-45,"Yä":-35,"Yæ":-50,"YÅ":-45,"Yå":-35,"Yé":-60,"Yè":-40,"YÖ":-60,"Yö":-40,"Yø":-75,"Yü":-30,"ya":-10,"yc":-15,"y:":-45,"y,":-25,"ye":-20,"yg":-25,"yl":-15,"yo":-15,"y.":-25,"ys":-15,"y;":-45,"yä":-10,"yæ":-25,"yå":-10,"yç":-15,"yö":-15,"yø":-15,"Zv":-25,"Zy":-40,"ÄC":-60,"Äc":-20,"Äe":-25,"ÄG":-60,"Äg":-20,"Ä-":-20,"ÄO":-55,"Äo":-25,"ÄQ":-55,"Äq":-20,"ÄT":-35,"ÄU":-60,"Äu":-15,"ÄV":-110,"Äv":-50,"ÄW":-105,"Äw":-55,"ÄY":-45,"Äy":-65,"Äç":-20,"ÄÖ":-55,"Äö":-25,"Äø":-25,"Ä”":-80,"Ä’":-100,"ÄÜ":-60,"Äü":-15,"ä’":-20,"ÅC":-60,"Åc":-20,"Åe":-25,"ÅG":-60,"Åg":-20,"Å-":-20,"ÅO":-55,"Åo":-25,"ÅQ":-55,"Åq":-20,"ÅT":-35,"ÅU":-60,"Åu":-15,"ÅV":-110,"Åv":-50,"ÅW":-105,"Åw":-55,"ÅY":-45,"Åy":-65,"Åç":-20,"ÅÖ":-55,"Åö":-25,"Åø":-25,"Å”":-80,"Å’":-100,"ÅÜ":-60,"Åü":-15,"å’":-20,"çh":-20,"çk":-15,"ñT":-55,"ñv":-20,"ñw":-20,"ñy":-20,"ñ’":-35,"ÖA":-55,"ÖT":-20,"ÖV":-50,"ÖW":-55,"ÖX":-60,"ÖY":-55,"ÖÄ":-55,"ÖÅ":-55,"öT":-75,"öv":-20,"öw":-20,"öx":-25,"öy":-30,"ö’":-20,"øT":-75,"øv":-20,"øw":-20,"øx":-25,"øy":-30,"ø’":-20,"“A":-75,"“T":-10,"“Ä":-75,"“Å":-75,"”A":-70,"”Ä":-70,"”Å":-70,"‘A":-80,"‘T":-20,"‘Ä":-80,"‘Å":-80,"’A":-95,"’,":-55,"’d":-50,"’o":-50,"’.":-55,"’r":-25,"’s":-25,"’t":-20,"’v":-25,"’w":-25,"’y":-15,"’Ä":-95,"’Å":-95,"’ö":-50,"’ø":-50,"ÜA":-65,"Ü,":-40,"Üm":-35,"Ün":-40,"Üp":-30,"Ü.":-40,"Ür":-30,"ÜÄ":-65,"ÜÅ":-65,"Üñ":-20,"ü’":-35} },
};
const LIGATURES = ['ffl', 'ff', 'fl', 'fi'];

// What TeX's input ligatures make of the text: quotes curled, dashes from hyphens.
export const texText = text => text.replace(/---/g, '\u2014').replace(/--/g, '\u2013').replace(/``/g, '\u201c').replace(/''/g, '\u201d').replace(/`/g, '\u2018').replace(/'/g, '\u2019');

/**
 * The width in points of `text` as the reference sets it: Termes at `style.size` points, kerned,
 * with its f-ligatures and TeX's quotes and dashes; code in Consolas, 0.55 em a character at its
 * own size (the reference's and the sheet's 0.88 of the text's).
 */
export function termesWidth(text, style = {}) {
  const size = style.size ?? 10;
  if (style.code) return [...text].length * 0.55 * size;
  const font = TERMES[style.bold ? (style.italic ? 'boldItalic' : 'bold') : style.italic ? 'italic' : 'regular'];
  const chars = [...texText(text.replace(/\u00ad/g, ''))];
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const ligature = chars[i] === 'f' && LIGATURES.find(l => chars.slice(i, i + l.length).join('') === l);
    if (ligature && font.ligatures[ligature]) { width += font.ligatures[ligature]; i += ligature.length - 1; continue; }
    width += font.widths[TIMES_AT.get(chars[i])] ?? 500;
    if (i + 1 < chars.length) width += font.kern[chars[i] + chars[i + 1]] ?? 0;
  }
  return width * size / 1000;
}

// How far a character reaches below the baseline in TeX Gyre Termes, in thousandths of an em, as
// TeX measures it; a letter or figure not named reaches 10, anything else nothing.
const DEPTH = {
  regular: { g: 218, j: 218, p: 217, q: 217, y: 218, Q: 178, '(': 177, ')': 177, '{': 181, '}': 181, '[': 156, ']': 156, '|': 156, ',': 141, ';': 141, _: 125, $: 87 },
  italic: { f: 207, g: 206, j: 207, p: 205, q: 205, y: 206, z: 81, Q: 182, '(': 181, ')': 180, '{': 177, '}': 177, '[': 153, ']': 153, ',': 129, ';': 129, _: 125, $: 89 },
  bold: { g: 206, j: 203, p: 205, q: 205, y: 205, Q: 176, J: 96, '(': 168, ')': 168, '{': 175, '}': 175, '[': 149, ']': 149, ',': 180, ';': 180, _: 125, $: 99 },
};

/**
 * How far a line reaches below its baseline, in points: the deepest of its characters. TeX leaves
 * the room under a picture or a table from there, so the room depends on the line above it.
 */
export function lineDepth(parts) {
  let depth = 0;
  for (const { text, style = {} } of parts) {
    const table = DEPTH[style.bold ? 'bold' : style.italic ? 'italic' : 'regular'], size = style.size ?? 10;
    for (const c of text) depth = Math.max(depth, (table[c] ?? (/[A-Za-z0-9]/.test(c) ? 10 : 0)) * size / 1000);
  }
  return depth;
}

/**
 * A paragraph set into lines as TeX sets it. `pieces` are its runs of text in order, each
 * {text, style} with the style `measure` reads; a soft hyphen in a word is a place TeX may
 * hyphenate it, and a hyphen between letters one where it may break. `space` is the interword
 * space {width, stretch, shrink, extra}, `widths(n)` line n's width. Returns the lines, each
 * {parts, hyphen, last}: its words' pieces {piece, text} and the spaces between them {space,
 * natural} at the width TeX's ratio gives them, and a hyphen {piece, text} when it ends in a
 * broken word; or null when no set of breaks fits.
 */
export function setLines(pieces, { measure, space, widths, params = TEX }) {
  const words = [];
  let word = null;
  for (const piece of pieces) {
    for (const part of piece.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { if (word) words.push(word); word = null; continue; }
      (word ??= []).push({ piece, text: part });
    }
  }
  if (word) words.push(word);
  if (!words.length) return null;
  // The items of a pass: TeX's first sets whole words, its second the pieces between the places
  // it may hyphenate, each measured alone, so the kerning across such a place is lost there.
  const itemsFor = hyphenate => {
    const items = [];
    words.forEach((w, n) => {
      let segment = [];
      const close = () => { if (segment.length) { items.push({ type: 'box', width: segment.reduce((s, p) => s + measure(p.text, p.piece.style), 0), segment }); segment = []; } };
      // TeX hyphenates a word only after glue, so never a paragraph's first.
      for (const part of n === 0 || !hyphenate ? w.map(p => ({ ...p, text: p.text.replace(/­/g, '') })) : w) {
        for (const s of part.text.split(/(­|(?<=[A-Za-z]-)(?=[A-Za-z]))/)) {
          if (s === undefined) continue;
          if (s === '­') { close(); items.push({ type: 'penalty', width: measure('-', part.piece.style), penalty: params.hyphenpenalty, flagged: true, soft: true, piece: part.piece }); continue; }
          if (s === '') { close(); items.push({ type: 'penalty', width: 0, penalty: params.exhyphenpenalty, flagged: true }); continue; }
          segment.push({ piece: part.piece, text: s });
        }
      }
      close();
      if (n < words.length - 1) items.push(params.french ? { type: 'glue', width: space.width, stretch: space.stretch, shrink: space.shrink } : spaceAfter(w.map(p => p.text).join('').replace(/­/g, ''), space));
    });
    items.push({ type: 'glue', width: 0, stretch: 0, shrink: 0, fil: true }, { type: 'penalty', width: 0, penalty: -INFINITE, flagged: false });
    return items;
  };
  let items = itemsFor(false);
  let breaks = breakLines(items, widths, { ...params, tolerance: params.pretolerance }, false);
  if (!breaks) { items = itemsFor(true); breaks = breakLines(items, widths, params, true); }
  // A third pass, as TeX makes when \emergencystretch is set: every line judged with that much more stretch.
  if (!breaks && params.emergencystretch > 0) breaks = breakLines(items, widths, { ...params, background: params.emergencystretch }, true);
  if (!breaks) return null;
  const lines = [];
  let start = 0;
  breaks.forEach((at, n) => {
    const content = items.slice(start, at), end = items[at], last = n === breaks.length - 1;
    const hyphen = end.type === 'penalty' && end.soft ? end : null;
    let natural = hyphen ? hyphen.width : 0, stretch = 0, shrink = 0;
    for (const item of content) {
      if (item.type === 'box') natural += item.width;
      else if (item.type === 'glue' && !item.fil) { natural += item.width; stretch += item.stretch; shrink += item.shrink; }
    }
    const target = widths(n);
    const ratio = last || params.ragged ? Math.min(0, shrink ? (target - natural) / shrink : 0)
      : natural < target ? (stretch ? (target - natural) / stretch : 0) : (shrink ? (target - natural) / shrink : 0);
    const parts = [];
    for (const item of content) {
      if (item.type === 'box') for (const s of item.segment) parts.push({ piece: s.piece, text: s.text.replace(/­/g, '') });
      else if (item.type === 'glue' && !item.fil) parts.push({ space: item.width + (ratio >= 0 ? ratio * item.stretch : ratio * item.shrink), natural: space.width });
    }
    lines.push({ parts, hyphen: hyphen ? { piece: hyphen.piece, text: '-' } : null, last, ragged: !!params.ragged, width: target });
    start = at + 1;
    while (start < items.length && items[start].type !== 'box') start++;
  });
  return lines;
}

/**
 * The widths of a line's spaces when its words are drawn in another font, measured by `measure`,
 * than the one TeX set them in, measured by `reference`: each space ends where TeX starts the
 * word after it, so the words stand where TeX's stand; on a line TeX justified the last space
 * also takes up the difference in the last word, so the line still ends at its width. Words that
 * would run past the line have their spaces shrunk to fit.
 */
export function drawnSpaces(line, measure, reference = termesWidth) {
  const spaces = line.parts.filter(p => p.space !== undefined).map(p => p.space);
  if (!spaces.length) return spaces;
  const gain = part => reference(part.text, part.piece.style) - measure(part.text, part.piece.style);
  const out = [];
  let ahead = 0, words = line.hyphen ? measure('-', line.hyphen.piece.style) : 0;
  for (const part of line.parts) {
    if (part.space === undefined) { ahead += gain(part); words += measure(part.text, part.piece.style); }
    else { out.push(part.space + ahead); ahead = 0; }
  }
  const room = line.width - words, used = out.reduce((a, b) => a + b, 0);
  if (!(line.last || line.ragged)) out[out.length - 1] += room - used;
  else if (used > room) return out.map(space => space * room / used);
  return out;
}

/**
 * Where revtex balances two columns of unbreakable blocks (\balance@two): `counts` are their
 * lines, `pitch` the distance between baselines and `top` the first baseline's height, in points.
 * It splits off the first column at half the height, then moves the split by half as much again
 * each time towards the longer column, until the two end within half a TeX point of each other
 * or the step is under half a point; the last split stands. Returns how many blocks the first
 * column takes.
 */
export function balancedSplit(counts, pitch, top) {
  const height = n => n ? top + (n - 1) * pitch : 0;
  const total = counts.reduce((a, b) => a + b, 0), half = 0.5 * 72 / 72.27;
  let at = height(total) / 2, step = at, taken = 0;
  for (;;) {
    let lines = 0;
    taken = 0;
    while (taken < counts.length && height(lines + counts[taken]) <= at) lines += counts[taken++];
    step /= 2;
    const difference = height(lines) - height(total - lines);
    if (Math.abs(difference) < half || step < half) return taken;
    at += difference < 0 ? step : -step;
  }
}
