#!/usr/bin/env python3
"""V4-APPBANNER-001 curation-time contrast + size gate (boss condition 1/4).
Run after ANY banner pool change: python3 scripts/banner_contrast.py
Verifies every committed banner asset against the TopChrome scrim (STOPS must mirror
the DIM_SCRIM constant in src/components/TopChrome.jsx) across a viewport width matrix —
background-size:cover makes the visible window viewport-dependent, so single-width
checks are decorative. Hard-fails <4.5:1 wordmark contrast or >80KB asset size.
Requires: pillow. Not a CI job (assets change ~quarterly); committed here so
re-curation re-runs it. Deps intentionally NOT in package.json.

V4-HEADERPARITY-001 (2026-08-18): re-pointed from the 88px root header + breathing SCRIM
to the ONE 52px header + DIM_SCRIM that now ships. This was not bookkeeping — the old
gradient's 0.42-alpha stop at 70% sits behind the wordmark once the bar is 52px, and every
banner in the pool drops to ~1.7-3.2:1 against a 4.5:1 floor. DIM_SCRIM at 52px passes.
"""
import glob, os, sys
from PIL import Image

PEACH = (249, 227, 214)
INK = (0x1F, 0x51, 0x38)              # P.greenDeep — wordmark ink
STOPS = [(0, .95), (1, .90)]          # == TopChrome DIM_SCRIM
BAR_H = 52                            # == TopChrome BAR_H
WIDTHS = (320, 375, 430, 768)         # viewport matrix
TEXT_X = (14, 190)                    # wordmark zone, CSS px
TEXT_Y = (14, 38)                     # wordmark rows, CSS px of BAR_H (0.9rem brand, centred)
SIZE_CAP = 80 * 1024
MIN_CONTRAST = 4.5

def rellum(c):
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(x) for x in c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

INKL = rellum(INK)

def contrast(bg):
    L = rellum(bg)
    hi, lo = max(L, INKL), min(L, INKL)
    return (hi + 0.05) / (lo + 0.05)

def scrim_alpha(y):
    for (y0, a0), (y1, a1) in zip(STOPS, STOPS[1:]):
        if y0 <= y <= y1:
            return a0 + (a1 - a0) * (y - y0) / (y1 - y0)
    return STOPS[0][1]

def check(path):
    fails = {}
    size = os.path.getsize(path)
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    for wcss in WIDTHS:
        winfrac = min(1.0, (wcss / BAR_H) / (W / H))
        x0 = int((0.5 - winfrac / 2) * W)
        scale = (winfrac * W) / wcss
        tx0, tx1 = x0 + int(TEXT_X[0] * scale), x0 + int(TEXT_X[1] * scale)
        worst = 99
        for y in range(int(TEXT_Y[0] / BAR_H * H), int(TEXT_Y[1] / BAR_H * H), 2):
            a = scrim_alpha(y / H)
            for x in range(tx0, min(tx1, W - 1), 3):
                r, g, b = px[x, y]
                comp = (r * (1 - a) + PEACH[0] * a,
                        g * (1 - a) + PEACH[1] * a,
                        b * (1 - a) + PEACH[2] * a)
                c = contrast(comp)
                if c < worst:
                    worst = c
        if worst < MIN_CONTRAST:
            fails[wcss] = round(worst, 2)
    return size, fails

def main():
    root = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'banners')
    assets = sorted(glob.glob(os.path.join(root, '*.webp')))
    if not assets:
        print('FAIL: no banner assets found at', root)
        return 1
    rc = 0
    for a in assets:
        size, fails = check(a)
        ok_size = size <= SIZE_CAP
        if fails or not ok_size:
            rc = 1
        print(f"{os.path.basename(a)}: {size // 1024}KB {'OK' if ok_size else 'OVER-CAP'}",
              'PASS' if not fails else f'FAIL {fails}')
    print('ALL PASS' if rc == 0 else 'GATE FAILED')
    return rc

if __name__ == '__main__':
    sys.exit(main())
