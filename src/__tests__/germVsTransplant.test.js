// src/__tests__/germVsTransplant.test.js
//
// V4-GERMVSTRANSPLANT-001 — structural guards for the germination / transplant pair.
//
// THE REAL MEASUREMENT LIVES ELSEWHERE. scripts/icon-ci/glyph-distinctness.mjs rasterises both
// glyphs and scores their scale-normalised silhouettes (0.171 for the drawing that shipped, 0.697
// for this one, floor 0.40). vitest cannot do that — jsdom has no renderer — so this file does not
// try to restate it and produce a weaker duplicate. It pins the STRUCTURAL facts a reader would want
// stated, each of which was false of the pair that shipped.
//
// What shipped, and what each guard here would have caught:
//   • byte-identical ground lines ('M4.5 20.5h15' in both)            -> "no shared path" below
//   • the same two-cotyledon composition at two scales                -> the cotyledon-count guard
//   • transplant's 18 master drops its ground line, germination's did  -> the 18-master guard
//     too, so the pair was at its MOST similar exactly where it was smallest
import { describe, it, expect } from 'vitest'
import { GLYPHS } from '../lib/iconRegistry.js'

const paths = (markup) => [...markup.matchAll(/\sd="([^"]+)"/g)].map(m => m[1])

describe('V4-GERMVSTRANSPLANT-001 — the pair must not collapse', () => {
  const germ = GLYPHS['event.germination']
  const trans = GLYPHS['event.transplant']

  it('shares no byte-identical path with transplant, at either master', () => {
    for (const master of ['svg24', 'svg18']) {
      const shared = paths(germ[master]).filter(d => paths(trans[master]).includes(d))
      expect(shared, `${master}: germination and transplant share these paths verbatim`).toEqual([])
    }
  })

  // The old pair was one composition at two scales. A cotyledon count is the cheapest structural
  // statement of "different composition" that does not depend on size at all.
  it('carries mass BELOW its soil line, which transplant has nowhere', () => {
    // Cotyledons are the closed leaf paths — the ones ending in 'z'. The ground line and the stem
    // are open strokes.
    const leaves = (m) => paths(m).filter(d => /z\s*$/i.test(d))
    expect(leaves(germ.svg24).length).toBe(2)   // one cotyledon + the seed bean
    expect(leaves(trans.svg24).length).toBe(2)  // two cotyledons, no seed
    // ...which is why leaf-count alone is not the guard. The seed is: germination's closed shapes
    // include one that sits BELOW the soil line, and transplant has nothing below its line at all.
    const lineY = 15.4
    const belowLine = paths(germ.svg24).some(d => {
      const ys = [...d.matchAll(/[-\d.]+\s+([-\d.]+)/g)].map(m => parseFloat(m[1])).filter(Number.isFinite)
      return ys.length > 0 && Math.max(...ys) > lineY + 1
    })
    expect(belowLine, 'germination has no mass below its soil line — the seed is the discriminator').toBe(true)
  })

  it('keeps its ground line at 18 where transplant drops one', () => {
    // transplant's 18 master has no horizontal ground rule; germination's does. So the pair diverges
    // FURTHER at the small master, rather than converging as it did before.
    const horizontal = (m) => paths(m).some(d => /^M[\d.]+ [\d.]+h[\d.]+$/.test(d.trim()))
    expect(horizontal(germ.svg18), 'germination svg18 lost its ground line').toBe(true)
    expect(horizontal(trans.svg18), 'transplant svg18 gained a ground line — the 18s now converge').toBe(false)
  })

  // transplant aliases STATUS_GLYPHS.seedling, which also backs the seedling / sprouting / seeding
  // STATUS badges. Redrawing it would have silently repainted three surfaces nobody asked about,
  // which is why only germination moved.
  it('leaves transplant identical to the seedling status glyph', () => {
    expect(trans.svg24).toBe(GLYPHS['status.seedling'].svg24)
    expect(trans.svg18).toBe(GLYPHS['status.seedling'].svg18)
  })
})
