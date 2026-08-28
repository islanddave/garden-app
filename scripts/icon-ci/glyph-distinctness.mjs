// V4-GERMVSTRANSPLANT-001 — distinctness gate for glyph pairs that are read SIDE BY SIDE.
//
// WHY A NEW GATE. Every existing icon gate measures a glyph ALONE: optical-weight checks ink
// coverage against a golden, region-seam checks colour geometry. Neither can express "these two are
// too alike", which is the whole defect here — event.germination and event.transplant were the same
// drawing at two scales (byte-identical ground lines; stems of 5.5 vs 8.2 units) sitting as ADJACENT
// ROWS on a plant's life story. They passed every gate in the repo, forever, because being
// indistinguishable from your neighbour is not a property any single-glyph check can see.
//
// THE FIRST METRIC I TRIED WAS WRONG, AND THE MEASUREMENT SAID SO. Rasterising each pair at ship
// size and scoring 1 - IoU of the raw ink masks INVERTS the ordering: the shipped defect scored
// 0.402 while transplant vs care.plantedOut — the pair the icon lane deliberately drew apart and
// signed off — scored 0.367. Any floor that failed the defect would have failed the known-good pair
// too. The reason is the point of the whole ticket: a SCALE change moves a lot of pixels while
// reading as the same shape, and a STRUCTURAL change (plantedOut's hollow in the baseline) moves few
// pixels while reading as a different object. Raw pixel overlap measures the thing humans ignore.
//
// SO THE MASKS ARE SCALE-NORMALISED FIRST: crop each glyph to its ink bounding box, resample into a
// common 32x32 grid, then score 1 - IoU. That makes the metric blind to size and sensitive to form —
// literally the "differentiate by SILHOUETTE, not by scale" rule the ledger row asks for. Measured,
// same four pairs:
//     old germination vs transplant (the defect)   0.171   <- now correctly the lowest
//     transplant vs care.plantedOut (known-good)   0.489
//     new germination vs transplant                0.697
//     new germination vs care.plantedOut           0.589
// A floor between 0.171 and 0.489 is now meaningful, where no floor on the raw metric was.
//
// Run: npm run icon:distinct
import { Resvg } from '@resvg/resvg-js'
import { GLYPHS } from '../../src/lib/iconRegistry.js'

const REND = 240          // render resolution; high enough that the bbox crop is not quantised
const GRID = 32           // normalised comparison grid
const STROKE = 1.75       // the 24-master's authored stroke (ICON.stroke)
// 22px ships, and 22 >= 21, so Icon.jsx selects the svg24 master. Measuring svg18 would score a
// master the timeline never shows.
const MASTER = 'svg24'

function inkMask(inner) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${REND}" height="${REND}" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${inner.replaceAll('currentColor', '#000')}</svg>`
  const px = new Resvg(svg, { background: 'rgba(255,255,255,0)' }).render().pixels
  const m = new Uint8Array(REND * REND)
  for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] > 128 ? 1 : 0
  return m
}

// Crop to the ink bbox and resample to GRID x GRID. A cell is inked if ANY source pixel under it is
// — dilation rather than averaging, so a hairline stroke survives the downsample instead of being
// averaged out of the comparison.
function normalized(mask) {
  let x0 = REND, y0 = REND, x1 = -1, y1 = -1
  for (let y = 0; y < REND; y++) for (let x = 0; x < REND; x++) {
    if (mask[y * REND + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) return null                       // no ink at all
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const g = new Uint8Array(GRID * GRID)
  const stepX = Math.max(1, Math.floor(w / GRID)), stepY = Math.max(1, Math.floor(h / GRID))
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const sx = x0 + Math.floor(i * w / GRID), sy = y0 + Math.floor(j * h / GRID)
    let hit = 0
    for (let dy = 0; dy < stepY && !hit; dy++) for (let dx = 0; dx < stepX; dx++) {
      if (mask[(sy + dy) * REND + (sx + dx)]) { hit = 1; break }
    }
    g[j * GRID + i] = hit
  }
  return g
}

function distinctness(a, b) {
  const ga = normalized(inkMask(a)), gb = normalized(inkMask(b))
  if (!ga || !gb) return null
  let inter = 0, union = 0
  for (let i = 0; i < ga.length; i++) { if (ga[i] || gb[i]) union++; if (ga[i] && gb[i]) inter++ }
  return union === 0 ? 0 : +(1 - inter / union).toFixed(3)
}

// Pairs a reader actually compares. Each carries WHY it is confusable, so a future editor knows what
// the number protects rather than treating it as a magic constant.
const PAIRS = [
  ['event.germination', 'event.transplant', 'adjacent life-story rows; were the same drawing at two scales'],
  ['event.germination', 'care.plantedOut', 'both are a plant meeting a soil line'],
  ['event.transplant', 'care.plantedOut', "named in care.plantedOut's own docstring as the pair it must not collapse into"],
  ['event.germination', 'event.sowing', 'germination now carries a seed, and sowing IS a seed'],
]

// Anchored between two MEASURED points, not chosen by feel: above the 0.171 defect, below the 0.489
// pair the icon lane already accepted. Raising it past ~0.48 would red-flag shipped, signed-off work.
const FLOOR = 0.40

let fail = 0, checked = 0
for (const [a, b, why] of PAIRS) {
  const ga = GLYPHS[a], gb = GLYPHS[b]
  if (!ga?.[MASTER] || !gb?.[MASTER]) {
    console.log(`✗ ${a} vs ${b}: one or both keys missing a ${MASTER} master — cannot measure`)
    fail++; continue
  }
  const d = distinctness(ga[MASTER], gb[MASTER])
  if (d === null) { console.log(`✗ ${a} vs ${b}: a glyph rendered NO ink`); fail++; continue }
  checked++
  const ok = d >= FLOOR
  if (!ok) fail++
  console.log(`${ok ? '✓' : '✗'} ${a} vs ${b}: ${d} ${ok ? '>=' : '<'} ${FLOOR}  (${why})`)
}

// Vacuity floor, same reasoning as region-seam.mjs: every check lives inside the loop, so an empty
// or key-renamed PAIRS list would print a clean PASS and exit 0. A gate that measures nothing is
// worse than no gate, because it stops the next reader from looking.
if (checked < PAIRS.length) {
  console.log(`✗ coverage: measured ${checked} of ${PAIRS.length} declared pairs — the gate is not covering what it claims`)
  fail++
}

console.log(fail ? `\nGLYPH-DISTINCTNESS: FAIL (${fail})` : `\nGLYPH-DISTINCTNESS: PASS (${checked} pairs, scale-normalised)`)
process.exit(fail ? 1 : 0)
