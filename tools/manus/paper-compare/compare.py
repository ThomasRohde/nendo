"""Compares the paper's renders with the LaTeX reference, for Compare-ManusPaper.ps1.

Each block of the export plan is found in each render by its first words, in reading order, and
its first line's page, column, left edge and baseline are set beside the reference's. Each page is
then compared pixel by pixel: its ink (darker than mid grey, at 96 dpi) against the reference's,
a pixel of either counting as matched when the other has ink within one pixel of it, so the
score is how much of the two pages' ink lies where the other's does (an F1: 1 for identical
pages; the fonts differ, Termes against Times New Roman, so even a page set line for line scores
below 1). Writes report.txt (the summary, then every block), and per page side-by-side
(sheets-N.png: LaTeX, Word, Word as typeset, preview) and overlay pictures (overlay-NAME-N.png:
the reference in cyan, the other in red, ink both share in black). Needs Pillow.
"""
import json, pathlib, re, statistics, sys
from PIL import Image, ImageChops, ImageFilter

RENDERS = ('latex', 'word', 'wordset', 'preview')


def ink(image):
    """The page's ink as a 1-bit picture: white where it is darker than mid grey."""
    return image.convert('L').point(lambda v: 255 if v < 128 else 0).convert('1')


def ink_score(reference, other):
    """How much of each page's ink lies within a pixel of the other's: precision, recall, F1."""
    a, b = ink(reference), ink(other.resize(reference.size))
    near = lambda m: m.convert('L').filter(ImageFilter.MaxFilter(3)).convert('1')
    count = lambda m: m.convert('L').histogram()[255]
    na, nb = count(a), count(b)
    if not na or not nb: return 0.0, 0.0, 0.0
    precision = count(ImageChops.logical_and(b, near(a))) / nb
    recall = count(ImageChops.logical_and(a, near(b))) / na
    return precision, recall, 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def norm(text):
    text = re.sub(r'\[\^b-[^\]]+\]|!\[[^\]]*\]\([^)]*\)|<[^>]+>|[*_`\\]', '', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    return re.sub(r'[^0-9a-z]', '', text.lower())


def flow(pages):
    return [(n, l, norm(l['text'])) for n, p in enumerate(pages, 1) for l in p['lines'] if l['base'] >= 64]


def anchors_of(plan):
    out = []
    for i, item in enumerate(plan['items']):
        if item['type'] in ('picture', 'table'): continue
        text = re.sub(r'^\*?(Figure|Table)\s+\d+\.\*?\s*', '', item.get('text', ''))
        if item['type'] == 'heading': text = re.sub(r'^\d+(\\?\.\d+)*\\?\.?\s+', '', text)
        key = norm(text)[:18]
        if len(key) >= 6: out.append((i, item['type'], key, text[:44]))
    return out


def locate(pages, anchors):
    lines, at, found = flow(pages), 0, {}
    for i, _, key, _ in anchors:
        for j in range(at, len(lines)):
            text = lines[j][2]
            # A label may stand before the words: "1." of a list, or a short line of its own.
            if key[:10] in text[:40] or (j + 1 < len(lines) and len(text) <= 3 and key[:10] in (text + lines[j + 1][2])[:40]):
                n, l, _ = lines[j]
                found[i] = (n, 'L' if l['x0'] < pages[n - 1]['w'] / 2 - 20 else 'R', l['x0'], l['base'])
                at = j + 1
                break
    return found


def main(folder):
    d = pathlib.Path(folder)
    plan = json.loads((d / 'plan.json').read_text(encoding='utf-8'))
    renders = {n: json.loads((d / f'{n}.json').read_text(encoding='utf-8')) for n in RENDERS if (d / f'{n}.json').exists()}
    anchors = anchors_of(plan)
    where = {n: locate(p, anchors) for n, p in renders.items()}
    report = [f"Pages: {', '.join(f'{n} {len(p)}' for n, p in renders.items())}; {len(anchors)} blocks compared with the LaTeX reference."]
    for other in [n for n in renders if n != 'latex']:
        same, near, dy, dx = 0, 0, [], []
        for i, *_ in anchors:
            a, b = where['latex'].get(i), where[other].get(i)
            if a and b and a[:2] == b[:2]:
                same += 1; dy.append(abs(a[3] - b[3])); dx.append(abs(a[2] - b[2])); near += abs(a[3] - b[3]) <= 1
        report.append(f'{other}: {same}/{len(anchors)} blocks on the same page and column, {near} within 1pt of the reference; '
                      f'baseline offset median {statistics.median(dy) if dy else 0:.1f}pt, largest {max(dy) if dy else 0:.1f}pt; '
                      f'left edge offset median {statistics.median(dx) if dx else 0:.1f}pt.')
    # Pixel by pixel, page by page, against the reference.
    pages = len(renders['latex'])
    for other in [n for n in renders if n != 'latex']:
        scores = []
        for n in range(1, pages + 1):
            ref, img = d / f'latex-{n}.png', d / f'{other}-{n}.png'
            scores.append(ink_score(Image.open(ref), Image.open(img))[2] if ref.exists() and img.exists() else 0.0)
        report.append(f'{other} ink against the reference, F1 per page: ' + ' '.join(f'{s:.3f}' for s in scores) + f'; mean {statistics.mean(scores):.3f}, lowest {min(scores):.3f}.')
    report.append('')
    report.append('block  kind  words                                         latex              ' + '  '.join(f'{n:18}' for n in renders if n != 'latex'))
    for i, kind, _, text in anchors:
        cells = []
        for n in renders:
            p = where[n].get(i)
            cells.append(f'p{p[0]}{p[1]} {p[3]:6.1f}' if p else 'missing')
            if n != 'latex' and p and where['latex'].get(i) and where['latex'][i][:2] == p[:2]: cells[-1] += f' {p[3] - where["latex"][i][3]:+5.1f}'
        report.append(f'{i:5d}  {kind[:4]:4}  {text:44}  ' + '  '.join(f'{c:18}' for c in cells))
    (d / 'report.txt').write_text('\n'.join(report) + '\n', encoding='utf-8')
    print('\n'.join(report[:2 * len(renders) - 1]))
    for n in range(1, max(len(p) for p in renders.values()) + 1):
        sheets = [Image.open(d / f'{name}-{n}.png').convert('RGB') if (d / f'{name}-{n}.png').exists() else Image.new('RGB', (816, 1056), 'white') for name in RENDERS]
        side = Image.new('RGB', (sum(s.width for s in sheets) + 20, max(s.height for s in sheets)), (120, 120, 120))
        x = 0
        for s in sheets: side.paste(s, (x, 0)); x += s.width + 10
        side.save(d / f'sheets-{n}.png')
        reference = sheets[0].convert('L')
        for name, sheet in zip(RENDERS[1:], sheets[1:]):
            Image.merge('RGB', (sheet.convert('L').resize(reference.size), reference, reference)).save(d / f'overlay-{name}-{n}.png')


if __name__ == '__main__':
    main(sys.argv[1])
