// V4-ICON-001 (Pass B V101 §14, boss-added) — region-seam gate for color-candidates.
// For every multi-region color-candidate target (the top-level master if it declares
// regions, AND every multi-region variant): render each declared region in a DISTINCT
// opaque fill, then (a) assert each region actually paints (no missing region), and
// (b) flood-fill the background from the border and assert NO interior transparent holes
// — a hole between/within fill regions = the hairline seam the color pass would inherit.
// Backs the §1 "zero geometry redraw" promise. Engine = resvg.
import { GLYPHS } from '../../src/lib/iconRegistry.js'
import { renderInner } from './_render.mjs'

const PALETTE = ['#ff0000', '#0000ff', '#00aa00', '#aa00aa'] // distinct per region
let fail = 0, checked = 0
const checkedByKey = new Map() // key -> targets actually checked; backs the vacuity floor below

for (const [key, e] of Object.entries(GLYPHS)) {
  if (e.class !== 'color-candidate') continue
  checkedByKey.set(key, 0)
  // targets: top-level master if it declares regions, plus every multi-region variant.
  const targets = []
  if (e.svg24 && /data-region=/.test(e.svg24)) targets.push(['base', e])
  if (e.variants) for (const [vn, v] of Object.entries(e.variants)) if (v.svg24) targets.push([vn, v])
  for (const [vn, v] of targets) {
    const regions = [...new Set([...v.svg24.matchAll(/data-region="([^"]+)"/g)].map(m => m[1]))]
    if (regions.length < 1) continue
    checked++; checkedByKey.set(key, checkedByKey.get(key) + 1)
    const fills = Object.fromEntries(regions.map((r, i) => [r, PALETTE[i % PALETTE.length]]))
    const { data, W, H } = renderInner(v.svg24, { fills })
    const op = (x, y) => data[(y * W + x) * 4 + 3] > 128
    // (a) each region's fill colour present
    const present = new Set()
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) present.add(`${data[i]},${data[i+1]},${data[i+2]}`)
    for (const [r, c] of Object.entries(fills)) {
      const rgb = `${parseInt(c.slice(1,3),16)},${parseInt(c.slice(3,5),16)},${parseInt(c.slice(5,7),16)}`
      const near = [...present].some(p => p.split(',').every((n, j) => Math.abs(+n - +rgb.split(',')[j]) < 40))
      if (!near) { console.log(`✗ ${key}:${vn} region "${r}" did not paint`); fail++ }
    }
    // (b) flood-fill background from border → interior transparent = seam hole
    const bg = new Uint8Array(W * H); const st = []
    for (let x = 0; x < W; x++) { st.push([x,0],[x,H-1]) } for (let y = 0; y < H; y++) { st.push([0,y],[W-1,y]) }
    while (st.length) { const [x,y] = st.pop(); if (x<0||y<0||x>=W||y>=H) continue; const idx=y*W+x; if (bg[idx]||op(x,y)) continue; bg[idx]=1; st.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]) }
    let holes = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const idx=y*W+x; if (!op(x,y) && !bg[idx]) holes++ }
    const holePct = +(100 * holes / (W * H)).toFixed(3)
    if (holePct > 0.05) { console.log(`✗ ${key}:${vn} interior seam holes: ${holePct}% of canvas`); fail++ }
    else console.log(`✓ ${key}:${vn} ${regions.length} region(s) paint, no interior seam (holes ${holePct}%)`)
  }
}
// --- Vacuity floor -----------------------------------------------------------------
// `checked` was counted but never asserted, and every check above lives inside the target
// loop — so a subject list of zero was a clean PASS with exit 0, printing
// "PASS (0 color-candidate target(s))". Two proven mutations both slipped past it:
// (a) GLYPHS/`class: 'color-candidate'` stop matching (registry key or class rename),
//     proven with an empty-GLYPHS import stub;
// (b) a color-candidate glyph's `data-region="..."` attributes are deleted — the exact
//     regression this gate exists to catch. The base target is only enrolled when svg24
//     already matches /data-region=/, and the `regions.length < 1` skip above drops the
//     rest, so stripping the region markup REMOVED the glyph from its own gate.
// Per-key rather than a bare total, so (b) still fails when only one glyph is stripped.
// Region-less VARIANTS stay legitimately skippable — the assertion is per glyph key.
const MIN_TARGETS = 6 // 7 targets across 7 color-candidate glyphs at d9afab95.
const unchecked = [...checkedByKey].filter(([, n]) => n === 0).map(([k]) => k)
if (unchecked.length) {
  console.log(`✗ coverage: color-candidate glyph(s) contributed NO checked target: ${unchecked.join(', ')}. Their data-region markup is missing, so they are silently exempt from the seam gate.`)
  fail++
}
if (checked < MIN_TARGETS) {
  console.log(`✗ coverage floor: checked ${checked} target(s), expected >= ${MIN_TARGETS}. The color-candidate filter matched (almost) nothing — this gate is not covering the color pass.`)
  fail++
}

console.log(fail ? `\nREGION-SEAM: FAIL (${fail})` : `\nREGION-SEAM: PASS (${checked} color-candidate target(s))`)
process.exit(fail ? 1 : 0)
