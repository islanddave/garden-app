// V4-BACKNAV-001 Slice 3a — the registered LAYER must equal what the surface actually PAINTS.
//
// dismissLayers.js exists on one premise: "layer is derived from the SAME scale that paints, and
// topmost = highest layer with insertion order as the tiebreak." An arbiter whose stack order
// disagrees with paint order dismisses a surface the user cannot see is on top.
//
// v3.103.0 shipped four surfaces violating it — registering DIALOG (1000) while painting 200–300 —
// which meant ESCAPE COULD ALREADY RESOLVE TO THE WRONG SURFACE in prod, with no Back involved.
// The live proof was DismissRegistrySlice2's two-popover test, which pinned the defect as if it
// were the spec: CritterFactsPopover paints 1000, LoveMehPopover paints 200, both registered
// DIALOG, and Escape closed the one UNDERNEATH.
//
// STATIC, not behavioural, and deliberately so. A rendering test can only cover pairs someone
// thought to compose; this reads every call site and fails on a NEW surface that picks a layer
// unrelated to its zIndex. Same reasoning as modalSurfaceFreeze.static.test.js — the hand-kept
// inventory in this program has been wrong three separate times.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Z, LAYER } from '../lib/dismissLayers.js'

const SRC = path.resolve(__dirname, '..')

// file -> the zIndex its dismissable surface paints at. Hand-verified 2026-08-06 against the render
// site in each file; the assertions below re-derive both halves from source so a drift in either
// direction fails.
const SURFACES = [
  { file: 'components/forms/Sheet.jsx', layer: 'SHEET', paints: Z.sheet },
  { file: 'components/Lightbox.jsx', layer: 'DIALOG', paints: Z.dialog },
  { file: 'components/CritterFactsPopover.jsx', layer: 'DIALOG', paints: Z.dialog },
  { file: 'components/VarietyPicker.jsx', layer: 'DIALOG', paints: Z.dialog },
  { file: 'pages/Dashboard.jsx', layer: 'DIALOG', paints: Z.dialog },
  // The four corrected in Slice 3a.
  { file: 'pages/PhotoLibrary.jsx', layer: 'SHEET', paints: Z.sheet },
  { file: 'components/SpaceAttachPicker.jsx', layer: 'SHEET', paints: Z.sheet },
  { file: 'components/LoveMehPopover.jsx', layer: 'SHEET', paints: Z.sheet },
  { file: 'components/FacebookShareSheet.jsx', layer: 'OVERLAY', paints: Z.overlay },
]

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

describe('registered LAYER agrees with painted zIndex', () => {
  it.each(SURFACES)('$file registers $layer and paints $paints', ({ file, layer, paints }) => {
    const src = read(file)
    expect(src).toMatch(new RegExp(`layer:\\s*LAYER\\.${layer}\\b`))
    // The painted value must appear as a zIndex literal somewhere in the file. Loose on purpose:
    // several of these render a backdrop and a panel at adjacent values, and pinning the exact line
    // would make the guard brittle without making it stricter about the thing that matters.
    expect(src).toMatch(new RegExp(`zIndex:\\s*${paints}\\b`))
    expect(LAYER[layer]).toBe(paints)
  })

  // Bidirectional: a new surface that registers a layer must be listed above. Without this the
  // inventory goes stale silently, which is exactly how the four bad registrations survived.
  it('every useDismissable call site with an explicit layer is inventoried here', () => {
    const listed = new Set(SURFACES.map((s) => s.file))
    const found = []
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) { if (ent.name !== '__tests__') walk(p); continue }
        if (!/\.jsx?$/.test(ent.name)) continue
        const src = fs.readFileSync(p, 'utf8')
        if (/layer:\s*LAYER\./.test(src)) found.push(path.relative(SRC, p))
      }
    }
    walk(SRC)
    // ZoomableImage is dead code (its only importer is its own test) but still registers; it is
    // deliberately excluded rather than inventoried, so the list describes live surfaces only.
    const live = found.filter((f) => !f.endsWith('ZoomableImage.jsx'))
    expect([...live].sort()).toEqual([...listed].sort())
  })
})
