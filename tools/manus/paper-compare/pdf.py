"""PDF pages as pictures and lines, for Compare-ManusPaper.ps1. Needs PyMuPDF.

    pdf.py pages <out-folder> <name> <file.pdf>   pictures at 96 dpi (<name>-N.png) and lines (<name>.json)
    pdf.py stranded <file.pdf> <plan.json>        headings the reference left at a column's foot
"""
import json, pathlib, re, sys, warnings
warnings.filterwarnings('ignore')
import pymupdf


def norm(text):
    return re.sub(r'[^0-9a-z]', '', text.lower())


def lines_of(page):
    out = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            spans = [s for s in line['spans'] if s['text'].strip()]
            if not spans: continue
            out.append({'x0': round(min(s['bbox'][0] for s in spans), 1), 'x1': round(max(s['bbox'][2] for s in spans), 1),
                        'base': round(spans[0]['origin'][1], 1), 'size': round(spans[0]['size'], 2), 'font': spans[0]['font'],
                        'text': ''.join(s['text'] for s in spans)})
    return out


def pages(out, name, pdf):
    out = pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(pdf)
    for n, page in enumerate(doc, 1):
        page.get_pixmap(dpi=96).save(out / f'{name}-{n}.png')
    (out / f'{name}.json').write_text(json.dumps([{'w': p.rect.width, 'h': p.rect.height, 'lines': lines_of(p)} for p in doc]), encoding='utf-8')
    print(f'{name}: {len(doc)} pages')


def stranded(pdf, plan_path, foot=716.85):
    """A heading that is a column's last line, or the references' heading with no room for two entries."""
    plan = json.loads(pathlib.Path(plan_path).read_text(encoding='utf-8'))
    headings = {norm(re.sub(r'^\d+(\\?\.\d+)*\\?\.?\s+', '', i['text'])): i['text'] for i in plan['items'] if i['type'] == 'heading'}
    found = []
    for page in pymupdf.open(pdf):
        lines = [l for l in lines_of(page) if l['base'] > 64]
        middle = page.rect.width / 2
        for l in lines:
            if norm(l['text']) in headings and l['x0'] < middle < l['x1'] and l['base'] + 18.6 + 13 > foot + 0.5: found.append(headings[norm(l['text'])])
        for side in (lambda l: l['x0'] < middle - 20, lambda l: l['x0'] >= middle - 20 or l['x1'] > middle + 20):
            column = [l for l in lines if side(l)]
            if not column: continue
            last = max(column, key=lambda l: l['base'])
            key = norm(re.sub(r'^\d+(\.\d+)*\.?\s*', '', last['text']))
            if key in headings and last['base'] > 600: found.append(headings[key])
    for text in dict.fromkeys(found): print(text)


if __name__ == '__main__':
    if sys.argv[1] == 'pages': pages(*sys.argv[2:5])
    elif sys.argv[1] == 'stranded': stranded(*sys.argv[2:4])
    else: raise SystemExit(__doc__)
