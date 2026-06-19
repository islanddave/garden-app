import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { animatedArtUrl, resolveCritterArt, prefersReducedMotion } from '../lib/critterArt.js'
import roster from '../data/critters-roster.json'

describe('critterArt.animatedArtUrl', () => {
  it('maps a static /critters/ path to the animated/ sibling', () => {
    expect(animatedArtUrl('/critters/C001-honeybee.svg')).toBe('/critters/animated/C001-honeybee.svg')
  })
  it('is idempotent on already-animated paths', () => {
    expect(animatedArtUrl('/critters/animated/C001-honeybee.svg')).toBe('/critters/animated/C001-honeybee.svg')
  })
  it('leaves non-/critters/ paths untouched (e.g. launch-5 prototype art)', () => {
    expect(animatedArtUrl('/critters/sub/x.svg')).toBe('/critters/sub/x.svg')
    expect(animatedArtUrl('/img/foo.svg')).toBe('/img/foo.svg')
    expect(animatedArtUrl('')).toBe('')
    expect(animatedArtUrl(null)).toBe(null)
  })
})

describe('critterArt.resolveCritterArt', () => {
  it('returns animated when motion is allowed', () => {
    expect(resolveCritterArt('/critters/C001-honeybee.svg', { reducedMotion: false }))
      .toBe('/critters/animated/C001-honeybee.svg')
  })
  it('returns the static reserve when reduced motion is preferred', () => {
    expect(resolveCritterArt('/critters/C001-honeybee.svg', { reducedMotion: true }))
      .toBe('/critters/C001-honeybee.svg')
  })
})

describe('prefersReducedMotion', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('reads matchMedia and is false-safe when it throws', () => {
    vi.stubGlobal('matchMedia', () => { throw new Error('no') })
    expect(prefersReducedMotion()).toBe(false)
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('reduce') }))
    expect(prefersReducedMotion()).toBe(true)
  })
})

// Parity guard: every roster critter must have an animated asset on disk so the
// default-swap never 404s. Static reserve is assumed present (pre-existing set).
describe('animated asset parity (V3-CRITANIM-001)', () => {
  const animDir = path.resolve(__dirname, '../../public/critters/animated')
  it('has an animated SVG for every roster image_url', () => {
    const missing = []
    for (const c of roster) {
      const file = (c.image_url || '').split('/').pop()
      if (!file) { missing.push(`${c.id}:no-image_url`); continue }
      if (!fs.existsSync(path.join(animDir, file))) missing.push(`${c.id}:${file}`)
    }
    expect(missing).toEqual([])
  })
})
