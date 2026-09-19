// V5-SEEDCARDS-001 — the supplier palette (src/lib/supplierPalette.js). Re-checks the measured rules
// the colour seat derived the pairs under, so a later edit that breaks one is red here rather than
// found on a phone: chip text >= 4.5:1 on its fill, the fill >= 3:1 as a stripe on white and cream,
// every in-use supplier curated, the key identical to the registry's fold, and a stable, never-blank
// fallback for a supplier added later.
import { describe, it, expect } from 'vitest'
import {
  supplierKey, supplierColors, supplierLabel, shortSupplierLabel, SUPPLIER_COLORS, FALLBACK_SLOTS, NO_SUPPLIER,
} from '../lib/supplierPalette.js'
import { foldSourceKey } from '../../lambda/varieties/validate.js'
import { P } from '../lib/constants.js'

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

// The 20 suppliers on prod seed rows, 2026-09-19 (lots.jsonl in _seedpacket_20260919).
const IN_USE = [
  'Botanical Interests', 'Bentley Seeds', "Mary's Heirloom Seeds", 'Sandia Seed Company', 'Amazon',
  "Johnny's Selected Seeds", 'High Mowing Organic Seeds', 'Seed Savers Exchange', 'Hillfolk Seed Collective',
  'Belchertown Plant Swap', 'Own garden', 'Greenfield Farmers Co-op', 'Massachusetts Flower Growers Association',
  'Magic Wings', "Gurney's Seed & Nursery Co.", "Jen's uncle", 'Panorama Tours', 'Livingston Seed',
  'UMass Amherst Libraries Common Seed Project', 'Lake Valley Seed',
]

describe('supplier palette', () => {
  const entries = [...Object.values(SUPPLIER_COLORS), ...FALLBACK_SLOTS]

  it('every pair: chip text >= 4.5:1 on its fill; the fill >= 3:1 as a stripe on white and on cream', () => {
    for (const c of entries) {
      expect(contrast(c.on, c.primary), `${c.name ?? c.primary} on/primary`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c.primary, P.white), `${c.name ?? c.primary} stripe on white`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.primary, P.cream), `${c.name ?? c.primary} stripe on cream`).toBeGreaterThanOrEqual(3)
    }
  })

  it('every supplier on a seed row today resolves to a CURATED pair, and no two share a fill', () => {
    const fills = new Set()
    for (const name of IN_USE) {
      const c = supplierColors(name)
      expect(c.fallback, name).toBeUndefined()
      expect(fills.has(c.primary), `${name} shares a fill`).toBe(false)
      fills.add(c.primary)
    }
    expect(Object.keys(SUPPLIER_COLORS)).toHaveLength(IN_USE.length)
  })

  it('the key is the registry\'s own fold (foldSourceKey / source.match_key), never a uuid', () => {
    for (const name of [...IN_USE, 'Fedco Seeds', 'Baker Creek Heirloom Seeds', 'Épinard Co.']) {
      expect(supplierKey(name)).toBe(foldSourceKey(name))
    }
    expect(supplierKey(null)).toBe('')
    expect(supplierColors('')).toBeNull()
  })

  it('a supplier the map does not know gets a stable fallback pair, never blank, and a short label', () => {
    const a = supplierColors('Fedco Seeds')
    expect(a.fallback).toBe(true)
    expect(FALLBACK_SLOTS.some((s) => s.primary === a.primary)).toBe(true)
    expect(supplierColors('Fedco Seeds')).toEqual(a)
    expect(supplierLabel('Fedco Seeds')).toBe('Fedco')
    expect(shortSupplierLabel('Baker Creek Heirloom Seeds')).toBe('Baker Creek')
    expect(shortSupplierLabel('Refining Fire Chiles')).toBe('Refining')
    expect(shortSupplierLabel('Seeds')).toBe('Seeds')
  })

  it('every chip label fits the 12-character budget; the full name stays available', () => {
    for (const name of IN_USE) {
      expect(supplierLabel(name).length, name).toBeLessThanOrEqual(12)
      expect(supplierColors(name).name).toBe(name)
    }
    expect(supplierLabel('Botanical Interests')).toBe('Botanical')
    expect(supplierLabel("Johnny's Selected Seeds")).toBe("Johnny's")
  })

  it('a source that is not a shop is marked (its chip border is dashed); no supplier has no stripe', () => {
    expect(supplierColors('Belchertown Plant Swap').shop).toBe(false)
    expect(supplierColors("Jen's uncle").shop).toBe(false)
    expect(supplierColors('Botanical Interests').shop).toBe(true)
    expect(NO_SUPPLIER.stripe).toBeNull()
  })
})
