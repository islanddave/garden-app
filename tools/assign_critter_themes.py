#!/usr/bin/env python3
"""
assign_critter_themes.py — §3.4 curation auto-suggest pass.

Implements critter-collection-visual-identity-spec-V001 §3.2/§3.3:
sample each critter's vector art for its DOMINANT hue (area-weighted fill),
map that hue family to a CONTRASTING tone from the 12-tone candy-pastel palette,
and write a FROZEN `theme` key into each critter's roster record.

Sampling: no rasterizer available in this env, and the critter SVGs are flat-color
vector shapes, so we parse fills and weight each fill colour by the approximate area
of the shape it fills (circle/ellipse/rect/polygon exact; path via coordinate bbox).
That gives the dominant body colour reliably (outlines/details wash out by area).

Selection within a hue family is deterministic by slug hash, so same-family critters
spread across the family's allowed tones (variety) while staying spec-contrasting.

Idempotent + frozen: re-running yields identical output. `theme` is only (re)assigned
here; the renderer (getTheme) reads it and only falls back if it is ever missing.

Usage:
  python3 tools/assign_critter_themes.py            # write roster in place (+ .bak)
  python3 tools/assign_critter_themes.py --dry-run  # print the assignment table only
"""
import json, os, re, sys, colorsys, hashlib, xml.etree.ElementTree as ET
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ROSTER = os.path.join(ROOT, "src/data/critters-roster.json")
SVG_DIR = os.path.join(ROOT, "public/critters")

# 12-tone palette keys (must match THEMES in Collection.jsx).
# Per-family allowed CONTRASTING tones, §3.2 (dominant hue -> contrasting tone).
FAMILY_TONES = {
    "yellow":  ["periwinkle", "lilac", "sky"],        # avoid butter/honey (low contrast)
    "blue":    ["peach", "apricot", "butter", "oat"],
    "red":     ["sky", "oat", "stone"],                # red/orange (teal dropped from
                                                       # rotation per §3.1 "sparingly / never
                                                       # green-heavy"; available as manual override)
    "green":   ["rose", "blush", "peach"],
    "dark":    ["honey", "oat", "butter", "peach", "stone"],   # black/brown/dark
    "pale":    ["lilac", "periwinkle", "rose"],        # white/gray
    "muddy":   ["oat", "stone"],                        # multi-color / muddy default
}

def parse_hex(c):
    c = c.strip().lower()
    if not c.startswith("#"):
        return None
    c = c[1:]
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        return None
    try:
        return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))
    except ValueError:
        return None

def nums(s):
    return [float(x) for x in re.findall(r"-?\d*\.?\d+(?:e-?\d+)?", s or "")]

def shape_area(tag, a):
    """Approx area in viewBox units for a shape element."""
    try:
        if tag == "circle":
            r = float(a.get("r", 0)); return 3.14159 * r * r
        if tag == "ellipse":
            rx = float(a.get("rx", 0)); ry = float(a.get("ry", 0)); return 3.14159 * rx * ry
        if tag == "rect":
            return float(a.get("width", 0)) * float(a.get("height", 0))
        if tag in ("polygon", "polyline"):
            pts = nums(a.get("points", ""))
            xs, ys = pts[0::2], pts[1::2]
            if len(xs) < 3: return 0.0
            s = 0.0
            for i in range(len(xs)):
                j = (i + 1) % len(xs)
                s += xs[i] * ys[j] - xs[j] * ys[i]
            return abs(s) / 2.0
        if tag == "path":
            pts = nums(a.get("d", ""))
            xs, ys = pts[0::2], pts[1::2]
            if not xs or not ys: return 0.0
            # bbox proxy (control points slightly inflate it; fine as a relative weight)
            return (max(xs) - min(xs)) * (max(ys) - min(ys))
    except (TypeError, ValueError):
        return 0.0
    return 0.0

def classify(rgb_area):
    """rgb_area: dict {(r,g,b): area}. Return a hue-family key."""
    chromatic = defaultdict(float)   # family -> area, for saturated colours
    dark_area = 0.0
    pale_area = 0.0
    total = sum(rgb_area.values()) or 1.0
    for (r, g, b), area in rgb_area.items():
        h, s, v = colorsys.rgb_to_hsv(r/255, g/255, b/255)
        hue = h * 360
        if v < 0.22:                       # near-black: outline / dark body
            dark_area += area; continue
        if s < 0.16:                       # near-neutral
            if v < 0.5: dark_area += area
            else: pale_area += area
            continue
        # brown = dark, low-ish value warm hue
        if (hue < 45 or hue >= 330) and v < 0.5 and s < 0.7:
            dark_area += area; continue
        if 45 <= hue < 70:        fam = "yellow"
        elif 70 <= hue < 170:     fam = "green"
        elif 170 <= hue < 265:    fam = "blue"
        elif 265 <= hue < 320:    fam = "blue"     # purple -> treat as blue family
        else:                     fam = "red"       # red/orange/magenta
        chromatic[fam] += area

    chroma_total = sum(chromatic.values())
    if chroma_total >= 0.18 * total:
        return max(chromatic.items(), key=lambda kv: kv[1])[0]
    # mostly neutral
    if dark_area >= pale_area:
        return "dark"
    return "pale"

def pick_tone(family, slug):
    tones = FAMILY_TONES[family]
    idx = int(hashlib.sha1(slug.encode()).hexdigest(), 16) % len(tones)
    return tones[idx]

def dominant_family(svg_path):
    try:
        tree = ET.parse(svg_path); root = tree.getroot()
    except (ET.ParseError, FileNotFoundError):
        return "muddy"
    rgb_area = defaultdict(float)
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        fill = el.get("fill")
        if not fill or fill == "none":
            continue
        rgb = parse_hex(fill)
        if rgb is None:
            continue
        rgb_area[rgb] += shape_area(tag, el.attrib)
    if not rgb_area or sum(rgb_area.values()) == 0:
        return "muddy"
    return classify(rgb_area)

def main():
    dry = "--dry-run" in sys.argv
    roster = json.load(open(ROSTER))
    rows = []
    dist = defaultdict(int)
    for c in roster:
        svg = os.path.join(SVG_DIR, os.path.basename(c["image_url"]))
        fam = dominant_family(svg)
        tone = pick_tone(fam, c["slug"])
        c["theme"] = tone
        dist[tone] += 1
        rows.append((c["id"], c["slug"], fam, tone))
    # report
    print(f"assigned {len(roster)} critters")
    print("tone distribution:", dict(sorted(dist.items(), key=lambda kv: -kv[1])))
    for sid in ("C011", "C012", "C029"):
        for r in rows:
            if r[0] == sid:
                print(f"  sample {r[0]} {r[1]:28s} family={r[2]:7s} -> theme={r[3]}")
    if dry:
        print("DRY RUN — roster not written")
        return
    bak = ROSTER + ".pretheme.bak"
    if not os.path.exists(bak):
        json.dump(json.load(open(ROSTER)), open(bak, "w"))  # one-time backup of pre-theme state
    with open(ROSTER, "w") as f:
        json.dump(roster, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {ROSTER} (backup at {bak})")

if __name__ == "__main__":
    main()
