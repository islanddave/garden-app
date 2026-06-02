#!/usr/bin/env python3
"""preview_critter_themes.py — render a self-contained HTML preview of the themed
Collection grid (themed bg + real SVG art + caption strip), so theming can be
evaluated locally without a dev/staging deploy. Reads the themed roster; inlines
each critter's SVG. Output: a single portable .html."""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ROSTER = os.path.join(ROOT, "src/data/critters-roster.json")
SVG_DIR = os.path.join(ROOT, "public/critters")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "critter-theme-preview.html")

THEMES = {
    "peach":      {"bg": "#fbe6d6", "strip": "#b9551f", "name": "#5a2a16"},
    "apricot":    {"bg": "#fbe0c8", "strip": "#b05420", "name": "#5a2e15"},
    "honey":      {"bg": "#f2e6cd", "strip": "#6e4a24", "name": "#4a3216"},
    "butter":     {"bg": "#fbeec2", "strip": "#9a6b1e", "name": "#5e4410"},
    "rose":       {"bg": "#f7dde2", "strip": "#9e3a52", "name": "#5e2231"},
    "blush":      {"bg": "#fbe1e8", "strip": "#b04a6a", "name": "#5e2236"},
    "lilac":      {"bg": "#e7e1f3", "strip": "#5c4a8c", "name": "#34295e"},
    "periwinkle": {"bg": "#d9def4", "strip": "#474c8c", "name": "#2e3370"},
    "sky":        {"bg": "#dcebf5", "strip": "#2f5d86", "name": "#1f3f5e"},
    "oat":        {"bg": "#efe7d6", "strip": "#7a5c34", "name": "#4a3a1c"},
    "stone":      {"bg": "#e6e6dd", "strip": "#5a5a4e", "name": "#3c3c30"},
    "teal":       {"bg": "#d6e8e6", "strip": "#2f6f6b", "name": "#1f4f4a"},
}
GROUP_LABEL = {"wild": "Around the garden", "legacy": "Legacy", "cryptid": "Curiosities"}
GROUP_ORDER = ["wild", "legacy", "cryptid"]
SAMPLES = {"C011", "C012", "C029"}  # cardinal / chickadee / goldfinch

def svg_inline(path, scale):
    try:
        s = open(path).read()
    except FileNotFoundError:
        return ""
    i = s.find("<svg")
    if i > 0:
        s = s[i:]
    return f'<div class="art" style="transform:scale({scale})">{s}</div>'

def main():
    roster = json.load(open(ROSTER))
    by_group = {}
    for c in roster:
        by_group.setdefault(c.get("group", "wild"), []).append(c)

    cards = []
    for g in GROUP_ORDER:
        if g not in by_group:
            continue
        cards.append(f'<h2 class="grouphead">{GROUP_LABEL[g]}</h2><div class="grid">')
        for c in by_group[g]:
            t = THEMES.get(c.get("theme"), THEMES["oat"])
            svg = svg_inline(os.path.join(SVG_DIR, os.path.basename(c["image_url"])),
                             c.get("view_scale", 1))
            mark = '<span class="mark">●</span>' if c["id"] in SAMPLES else ""
            cards.append(
                f'<div class="card" style="background:{t["bg"]}">'
                f'{mark}<div class="stage">{svg}</div>'
                f'<div class="cname" style="color:{t["name"]}">{c["name"]}</div>'
                f'<div class="strip" style="background:{t["strip"]}">{c.get("theme","?")}</div>'
                f'</div>'
            )
        cards.append("</div>")

    # tone distribution
    from collections import Counter
    dist = Counter(c.get("theme") for c in roster)
    chips = " ".join(
        f'<span class="chip" style="background:{THEMES[k]["bg"]};border-color:{THEMES[k]["strip"]}">'
        f'{k} {v}</span>' for k, v in dist.most_common())

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Critter theme preview</title>
<style>
 body{{margin:0;background:#f3eee3;font-family:-apple-system,system-ui,sans-serif;color:#3a3a30;padding:16px}}
 h1{{font-size:1.3rem;margin:4px 0 2px}} .sub{{color:#6b6b5c;font-size:.85rem;margin:0 0 14px}}
 .legend{{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px}}
 .chip{{font-size:.72rem;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid}}
 .grouphead{{font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:#7a5c34;margin:18px 0 10px}}
 .grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}
 @media(min-width:560px){{.grid{{grid-template-columns:repeat(4,minmax(0,1fr))}}}}
 @media(min-width:760px){{.grid{{grid-template-columns:repeat(6,minmax(0,1fr))}}}}
 .card{{position:relative;height:200px;border-radius:14px;box-shadow:0 2px 4px rgba(40,30,10,.10),0 6px 16px rgba(40,30,10,.16);
   display:flex;flex-direction:column;align-items:center;padding:10px 6px 42px;box-sizing:border-box;overflow:hidden}}
 .stage{{width:min(86%,120px);aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}}
 .art{{width:100%;height:100%;transform-origin:center}} .art svg{{width:100%;height:100%;display:block}}
 .cname{{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;text-align:center;
   font-weight:700;font-size:.82rem;line-height:1.15;margin-top:6px;overflow:hidden;padding:0 4px;word-break:break-word}}
 .strip{{position:absolute;left:0;right:0;bottom:0;height:34px;display:flex;align-items:center;justify-content:center;
   color:#ffcf7a;font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}}
 .mark{{position:absolute;top:6px;right:8px;color:#e0492f;font-size:.8rem;z-index:2}}
</style></head><body>
<h1>Critter theme preview — §3.4 auto-assignment</h1>
<p class="sub">All 168 shown in full colour to evaluate the palette (in-app, undiscovered render as silhouettes on this same bg). ● = your three current birds (cardinal / chickadee / goldfinch). Strip label = assigned tone.</p>
<div class="legend">{chips}</div>
{''.join(cards)}
</body></html>"""
    open(OUT, "w").write(html)
    print("wrote", OUT, f"({len(html)//1024} KB)")

if __name__ == "__main__":
    main()
