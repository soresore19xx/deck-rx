#!/usr/bin/env python3
"""Detect overlapping <text> / <polygon> elements in deck-rx LCD dump SVGs.

Reports:
- text vs text overlaps (e.g. clock vs unit label)
- text vs polygon overlaps (e.g. clock vs 7-seg digits in dial-tune)

Skips:
- polygon vs polygon (7-seg digit segments are adjacent on purpose)

Approximates rsvg-convert / fontconfig font metrics — won't match the
Stream Deck SDK's Core Text rendering pixel-for-pixel, but flags
rsvg-side collisions which is the actual problem in the ~/ICON dump
pipeline (the SDK on-device output is a separate render path).

Usage:
  ./scripts/lint-lcd.py                 # lint all ~/ICON LCD SVGs
  ./scripts/lint-lcd.py <svg> [<svg>…]  # lint specific files
Exit: 0 = clean, 1 = overlap(s), >=2 = parse / usage error.

Tunables:
  OVERLAP_MARGIN_PX (default 1.0): minimum overlap in px to flag.
    Raise to suppress sub-pixel false positives, lower if you want
    tighter checks.
  EM (per-family em-width): adjust if rsvg fontconfig resolves your
    families to different fonts. Defaults match Linux/macOS fontconfig.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

EM = {
    'monospace': 0.60, 'mono': 0.60,
    'sans-serif': 0.55, 'sans': 0.55, 'helvetica': 0.55,
    'serif': 0.50,
}
NS = '{http://www.w3.org/2000/svg}'
OVERLAP_MARGIN_PX = 1.0
ASCENT_FRAC = 0.70   # bbox top above baseline (Helvetica / Liberation Mono ≈ 0.7 fs)
DESCENT_FRAC = 0.20  # bbox bottom below baseline

def parse_translate(transform):
    if not transform:
        return (0.0, 0.0)
    m = re.search(r'translate\(\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*\)', transform)
    return (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)

def text_bbox(elem, ax, ay):
    x = float(elem.get('x', 0)) + ax
    y = float(elem.get('y', 0)) + ay
    fs = float(elem.get('font-size', 12))
    family = elem.get('font-family', 'sans-serif').lower().split(',')[0].strip(' "\'')
    em = EM.get(family, 0.55)
    text = ''.join(elem.itertext())
    w = len(text) * fs * em
    anchor = elem.get('text-anchor', 'start')
    if anchor == 'middle':
        x_left = x - w / 2
    elif anchor == 'end':
        x_left = x - w
    else:
        x_left = x
    return ('text', x_left, y - fs * ASCENT_FRAC, x_left + w, y + fs * DESCENT_FRAC, text.strip())

def polygon_bbox(elem, ax, ay):
    pts = elem.get('points', '')
    coords = re.findall(r'-?\d+(?:\.\d+)?', pts)
    if len(coords) < 4:
        return None
    xs = [float(coords[i]) + ax for i in range(0, len(coords) - 1, 2)]
    ys = [float(coords[i]) + ay for i in range(1, len(coords), 2)]
    if not xs or not ys:
        return None
    return ('polygon', min(xs), min(ys), max(xs), max(ys), '<polygon>')

def collect_shapes(elem, ax=0.0, ay=0.0):
    out = []
    for child in elem:
        tag = child.tag.replace(NS, '')
        tx, ty = parse_translate(child.get('transform', ''))
        if tag == 'text':
            out.append(text_bbox(child, ax + tx, ay + ty))
        elif tag == 'polygon':
            bbox = polygon_bbox(child, ax + tx, ay + ty)
            if bbox:
                out.append(bbox)
        elif tag == 'g':
            out.extend(collect_shapes(child, ax + tx, ay + ty))
    return out

def overlap(a, b, margin=OVERLAP_MARGIN_PX):
    # Shape: (kind, x1, y1, x2, y2, label)
    x_overlap = min(a[3], b[3]) - max(a[1], b[1])
    y_overlap = min(a[4], b[4]) - max(a[2], b[2])
    return x_overlap > margin and y_overlap > margin

def lint(path):
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        print(f'{path}: parse error: {e}', file=sys.stderr)
        return None
    shapes = collect_shapes(root)
    pairs = []
    n = len(shapes)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = shapes[i], shapes[j]
            # Skip polygon-polygon (7-seg segments overlap by design).
            if a[0] != 'text' and b[0] != 'text':
                continue
            if overlap(a, b):
                pairs.append((a, b))
    # Collapse identical text-vs-polygon pair sets so a clock overlapping
    # 5 different 7-seg polygons is reported once with all polygon bboxes
    # merged, not as 5 separate lines of "<polygon>" noise.
    text_polygon_groups = {}
    text_text_pairs = []
    for a, b in pairs:
        if a[0] == 'text' and b[0] == 'text':
            text_text_pairs.append((a, b))
        else:
            t = a if a[0] == 'text' else b
            p = b if a[0] == 'text' else a
            key = id(t)
            grp = text_polygon_groups.setdefault(key, (t, []))
            grp[1].append(p)
    return text_text_pairs, text_polygon_groups

def fmt_bbox(s):
    return f'{s[5]!r} ({s[1]:.1f},{s[2]:.1f}-{s[3]:.1f},{s[4]:.1f})'

def main():
    if len(sys.argv) > 1:
        paths = [Path(p) for p in sys.argv[1:]]
    else:
        paths = sorted((Path.home() / 'ICON').glob('deck-rx-lcd-*.svg'))
    if not paths:
        print('no SVGs to lint', file=sys.stderr)
        sys.exit(2)
    bad = False
    for p in paths:
        result = lint(p)
        if result is None:
            sys.exit(2)
        text_text_pairs, text_polygon_groups = result
        total = len(text_text_pairs) + len(text_polygon_groups)
        if total == 0:
            print(f'{p.name}: clean')
            continue
        bad = True
        print(f'{p.name}: {total} overlap(s)')
        for a, b in text_text_pairs:
            print(f'  - text/text  {fmt_bbox(a)}')
            print(f'               <> {fmt_bbox(b)}')
        for t, polys in text_polygon_groups.values():
            xs = [pp[1] for pp in polys] + [pp[3] for pp in polys]
            ys = [pp[2] for pp in polys] + [pp[4] for pp in polys]
            agg = ('polygon-cluster', min(xs), min(ys), max(xs), max(ys), f'<{len(polys)} polygons>')
            print(f'  - text/poly  {fmt_bbox(t)}')
            print(f'               <> {fmt_bbox(agg)}')
    sys.exit(1 if bad else 0)

if __name__ == '__main__':
    main()
