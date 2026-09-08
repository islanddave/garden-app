#!/usr/bin/env python3
# analyse.py — turn a measure-*.json capture into the tables the report needs.
# Reads nothing but the capture: every number here traces to a real getBoundingClientRect /
# getComputedStyle / Range.getClientRects in a real Chrome at a true 390x844.
import json, sys, collections, re

VW, VH = 390, 844

def load(p):
    return json.load(open(p))

def f(v):
    try: return float(str(v).replace('px', ''))
    except Exception: return 0.0

def is_wrapper(n):
    """A pure layout wrapper: paints nothing, draws nothing, is just a flex/block column."""
    s = n['style']
    bg = s['backgroundColor'] in ('rgba(0, 0, 0, 0)', 'transparent')
    bord = f(s['borderTopWidth']) == 0 and f(s['borderBottomWidth']) == 0
    rad = f(s['borderTopLeftRadius']) == 0
    return bg and bord and rad

def spine(d):
    """Render-order section list. Depth-1 children of the Today root, with pure layout wrappers
    (the hasPlan flex column) expanded one level so their children are the real sections."""
    by_path = {n['path']: n for n in d['tree']}
    out = []
    for n in d['tree']:
        if n['path'].count('.') != 1:      # '0.x'
            continue
        kids = [m for m in d['tree'] if m['path'].startswith(n['path'] + '.') and m['path'].count('.') == 2]
        if is_wrapper(n) and len(kids) > 1 and n['rect']['height'] > 100:
            out.extend(kids)
        else:
            out.append(n)
    return out

NAMES = [
    (r'^Today$', 'Page title "Today"'),
    (r'^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),', 'Date subtitle'),
    (r'^\d+°', 'WeatherWidget (temps, verdict, water rows, rain line, stamp)'),
    (r'planting\(s\) past the .* feed window', 'Substrate / feeding note'),
    (r'^Plan from overnight', '"Plan from overnight" basis stamp'),
    (r'^Needs care today', 'CareNeeded (the care list)'),
    (r'^Looking ahead', 'HarvestWatchBand ("Worth checking soon")'),
    (r'^Sow ', 'CultivationLead (sow link)'),
    (r'the rest of the household', 'Household-care toggle'),
    (r'^Your first daily plan', 'Empty state: "Your first daily plan is on its way"'),
    (r'use soon|Use soon', 'PutUpUseSoonBand'),
    (r'Compose|post', 'ComposeHarvestBand'),
]

def name_of(n):
    t = n['text'].strip()
    for pat, nm in NAMES:
        if re.search(pat, t):
            return nm
    return (n['testid'] or n['aria'] or n['tag']) + ' — ' + t[:40]

def ink_stats(ink, top, bottom):
    a, b = max(0, int(top)), min(len(ink), int(round(bottom)))
    if b <= a:
        return 0, 0
    seg = ink[a:b]
    return sum(seg), (b - a)

def blank_runs(ink, lo, hi, minlen=12):
    runs, start = [], None
    for y in range(int(lo), min(int(hi), len(ink))):
        if ink[y] == 0:
            if start is None: start = y
        else:
            if start is not None and y - start >= minlen: runs.append((start, y - start))
            start = None
    if start is not None and hi - start >= minlen: runs.append((start, int(hi) - start))
    return runs

def px(v):
    try: return round(float(str(v).replace('px', '')), 2)
    except Exception: return v

def main(path):
    d = load(path)
    ink = d['ink']['ink']
    H = d['viewport']['scrollHeight']
    secs = spine(d)

    print('=' * 100)
    print(f"STATE {d['state']}  ·  viewport {d['viewport']['innerWidth']}x{d['viewport']['innerHeight']}  ·  scrollHeight {H}px  = {H/VH:.2f} viewports  ·  hscroll {'YES' if d['viewport']['scrollWidth']>VW else 'no'}")
    tot_ink = sum(ink)
    print(f"page ink rows {tot_ink}/{H} = {100*tot_ink/H:.1f}%   blank rows {H-tot_ink} ({100*(H-tot_ink)/H:.1f}%)")
    print('=' * 100)

    print('\n## 1+2  SECTION INVENTORY, RENDER ORDER (cumulative scroll)\n')
    print(f"{'#':<3}{'section':<52}{'top':>7}{'height':>8}{'screens@top':>12}{'ink%':>7}{'blank px':>10}{'taps':>6}{'chars':>7}")
    prev_bottom = None
    rows = []
    for i, n in enumerate(secs, 1):
        r = n['rect']
        top, h = r['top'], r['height']
        ii, nn = ink_stats(ink, top, r['bottom'])
        taps = [t for t in d['taps'] if top - 1 <= t['top'] < r['bottom']]
        chars = len(n['text'])
        rows.append(dict(i=i, name=name_of(n), top=top, h=h, ink=ii, span=nn, taps=len(taps), node=n))
        gap = None if prev_bottom is None else round(top - prev_bottom, 1)
        if gap is not None and gap > 0.6:
            print(f"{'':<3}{'  ↕ gap ' + str(gap) + 'px':<52}")
        print(f"{i:<3}{name_of(n)[:50]:<52}{round(top):>7}{round(h):>8}{top/VH:>12.2f}{(100*ii/nn if nn else 0):>7.0f}{nn-ii:>10}{len(taps):>6}{chars:>7}")
        prev_bottom = r['bottom']
    tail = H - prev_bottom
    print(f"{'':<3}{'  ↕ trailing space ' + str(round(tail,1)) + 'px':<52}")

    print('\n## 3  WHITESPACE — biggest contiguous blank vertical runs (>=24px, no text/img/svg/control on the row)\n')
    runs = blank_runs(ink, 0, H, 24)
    runs.sort(key=lambda x: -x[1])
    def where(y):
        for r in rows:
            if r['top'] - 1 <= y < r['top'] + r['h']:
                return f"{r['i']}. {r['name'][:44]}"
        return 'between sections'
    print(f"{'y':>7}{'len':>6}  location")
    for y, l in runs[:22]:
        print(f"{y:>7}{l:>6}  {where(y)}")
    print(f"\n  {len(runs)} runs >=24px, {sum(l for _, l in runs)}px total ({100*sum(l for _,l in runs)/H:.1f}% of the page)")

    print('\n## 4  CONTAINER / CARD PATTERNS (computed, clustered by fingerprint)\n')
    wide = [c for c in d['containers'] if c['rect']['width'] >= 300]
    fps = collections.Counter(c['fp'] for c in wide)
    for fp, cnt in fps.most_common():
        ex = [c for c in wide if c['fp'] == fp]
        s = ex[0]['style']
        print(f"  x{cnt:<4} bg={s['backgroundColor']}({s['_bgToken'] or 'NOT A TOKEN'})  border={px(s['borderTopWidth'])}px {s['borderTopStyle']} {s['borderTopColor']}({s['_borderToken'] or '-'})  radius={px(s['borderTopLeftRadius'])}  shadow={s['boxShadow']}")
        print(f"        padding={px(s['paddingTop'])}/{px(s['paddingRight'])}/{px(s['paddingBottom'])}/{px(s['paddingLeft'])}  margin={px(s['marginTop'])}/{px(s['marginBottom'])}  w={ex[0]['rect']['width']}")
        print(f"        e.g. {[e['text'][:34] for e in ex[:3]]}")
    print(f"\n  DISTINCT WIDE-CONTAINER PATTERNS: {len(fps)} (of {len(wide)} containers >=300px wide; {len(d['containers'])} total incl. chips/rows)")

    print('\n## 4b  TYPE SCALE actually used (distinct size/weight, in render order of first use)\n')
    ramp = d['tokens']['type']
    ramp_px = {k: round(float(v.replace('rem', '')) * 16, 2) for k, v in ramp.items()}
    # Keyed on colour TOO. Keying on (size,weight) alone reported the first element's colour for the
    # whole bucket, which put a visually-hidden aria-live span's inherited black on the same row as
    # nine visible chevrons — a fabricated "hardcoded colour" finding. Colour is part of the pattern.
    seen = {}
    for t in d['typeRuns']:
        k = (t['fontSize'], t['fontWeight'], t['color'])
        if k not in seen:
            seen[k] = dict(first=t['top'], n=0, ex=t['text'][:40], color=t['color'], tok=t['colorToken'])
        seen[k]['n'] += 1
    print(f"{'size':>8}{'wt':>5}{'n':>5}  {'token?':<22}{'colour':<24}{'colour token':<16}example")
    for (fs, fw, _c), v in sorted(seen.items(), key=lambda kv: -kv[1]['n']):
        val = round(float(fs.replace('px', '')), 2)
        hit = [k for k, p in ramp_px.items() if abs(p - val) < 0.02]
        print(f"{val:>8}{fw:>5}{v['n']:>5}  {('T.type.'+hit[0] if hit else 'OFF-RAMP'):<22}{v['color']:<24}{str(v['tok'] or 'HARDCODED'):<16}{v['ex']}")
    print(f"\n  DISTINCT (size,weight,colour) TRIPLES: {len(seen)}   ramp = " + ', '.join(f'{k}={v}px' for k, v in ramp_px.items()))

    print('\n## 5  DENSITY — ink rows per section, worst first\n')
    print(f"{'#':<3}{'section':<52}{'height':>8}{'ink px':>8}{'ink%':>7}{'taps':>6}{'px/tap':>8}")
    for r in sorted(rows, key=lambda r: (r['ink'] / r['span']) if r['span'] else 0):
        pct = 100 * r['ink'] / r['span'] if r['span'] else 0
        print(f"{r['i']:<3}{r['name'][:50]:<52}{round(r['h']):>8}{r['ink']:>8}{pct:>7.0f}{r['taps']:>6}{(r['h']/r['taps'] if r['taps'] else 0):>8.0f}")

    print('\n## tap targets under 44px\n')
    small = [t for t in d['taps'] if t['under44'] and t['h'] > 0]
    for t in small[:25]:
        print(f"  {t['w']}x{t['h']}  top={t['top']}  {t['tag']} {repr(t['text'][:44])}")
    print(f"  {len(small)}/{len(d['taps'])} controls under the 44px floor on at least one axis")

    print('\n## 6  DRILL — inside the two sections that dominate the page\n')
    for r in sorted(rows, key=lambda r: -r['h'])[:2]:
        n = r['node']
        print(f"\n  ### {r['i']}. {r['name']}  ({round(r['h'])}px, {round(r['h'])/VH:.2f} viewports)")
        kids = [m for m in d['tree'] if m['path'].startswith(n['path'] + '.') and m['path'].count('.') == n['path'].count('.') + 1]
        for k in kids:
            kr = k['rect']
            ii, nn = ink_stats(ink, kr['top'], kr['bottom'])
            print(f"    {round(kr['top']):>6} +{round(kr['height']):>5}px  ink {100*ii/nn if nn else 0:>3.0f}%  blank {nn-ii:>5}px  {k['tag']:<8}{k['text'][:58]!r}")
        if len(kids) == 1:
            g = [m for m in d['tree'] if m['path'].startswith(kids[0]['path'] + '.') and m['path'].count('.') == kids[0]['path'].count('.') + 1]
            for k in g:
                kr = k['rect']
                ii, nn = ink_stats(ink, kr['top'], kr['bottom'])
                print(f"      {round(kr['top']):>6} +{round(kr['height']):>5}px  ink {100*ii/nn if nn else 0:>3.0f}%  blank {nn-ii:>5}px  {k['tag']:<8}{k['text'][:56]!r}")

    print('\n## padding / radius token conformance for wide containers\n')
    sp = d['tokens']['space']; rad = d['tokens']['radius']
    print(f"  space ramp {sp}   radius ramp {rad}")
    for c in wide:
        s = c['style']
        pads = [px(s['paddingTop']), px(s['paddingRight']), px(s['paddingBottom']), px(s['paddingLeft'])]
        radv = px(s['borderTopLeftRadius'])
        bad_p = [p for p in pads if p not in (0, *sp.values())]
        bad_r = radv not in (0, *rad.values())
        if bad_p or bad_r:
            print(f"  OFF-TOKEN pad={pads} radius={radv}  {c['text'][:44]!r}")

if __name__ == '__main__':
    main(sys.argv[1])
