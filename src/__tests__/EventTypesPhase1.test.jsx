// Phase 1 (V3-EVENT-004 + V3-EVENT-002): Brought Inside/Outside + Mulched event
// types + primary quick-pick rebalance (promote hardening_off, demote observation).
// Pure list/shape assertions on the exported vocabulary — no render needed.
// Heavy deps are mocked only so EventNew.jsx loads as a module without a DOM tree.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn() }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children }) => children,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))

import { EVENT_TYPES_UI, EVENT_TYPE_META, SECONDARY_GROUPS } from '../pages/EventNew.jsx'
import { EVENT_TYPES } from '../lib/constants.js'

// A label is "raw snake_case" if it is only lowercase letters/underscores —
// i.e. the value leaked through unmapped. Human labels carry caps/spaces/glyphs.
const isRaw = (s) => /^[a-z_]+$/.test(s)

describe('V3-EVENTZONE-001 — first-class quick-pick set (braindump-exact, Dave 2026-06-18)', () => {
  const primary = EVENT_TYPES_UI.map((t) => t.value)
  // Supersedes the V3-EVENT-004/005 rebalance: Dave chose the braindump set exactly.
  const FIRST_CLASS = ['watering', 'transplant', 'fertilizing', 'mulched', 'suckered', 'fruit_set', 'harvest']

  it('primary quick-picks are exactly the braindump first-class set, in order', () => {
    expect(primary).toEqual(FIRST_CLASS)
  })

  it('demotes the former primaries (in/out, hardening, pruned, photo, potted-up) + observation to "More"', () => {
    for (const v of ['brought_inside', 'brought_outside', 'hardening_off', 'pruning', 'photo', 'potting_up', 'observation']) {
      expect(primary, v).not.toContain(v)
    }
  })

  it('every primary pick has a glyph and a non-raw label', () => {
    for (const t of EVENT_TYPES_UI) {
      expect(t.emoji && t.emoji.length, t.value).toBeGreaterThan(0)
      expect(isRaw(t.label), t.value).toBe(false)
    }
  })

  it('no emoji collision among the primary picks', () => {
    const emojis = EVENT_TYPES_UI.map((t) => t.emoji)
    expect(new Set(emojis).size).toBe(emojis.length)
  })
})

describe('Phase 1 — demoted/new types render non-raw in "More"', () => {
  const flat = SECONDARY_GROUPS.flatMap(([, types]) => types)
  const byValue = Object.fromEntries(flat.map((t) => [t.value, t]))

  it('observation appears in a secondary group with a non-raw label + glyph', () => {
    expect(byValue.observation).toBeTruthy()
    expect(isRaw(byValue.observation.label)).toBe(false)
    expect(byValue.observation.emoji.length).toBeGreaterThan(0)
  })

  it('no secondary value falls through to the raw 📌 fallback', () => {
    for (const t of flat) {
      const isRawFallback = t.label === t.value && t.emoji === '📌'
      expect(isRawFallback, t.value).toBe(false)
    }
  })

  it('EVENT_TYPE_META carries the three Phase-1 types', () => {
    for (const v of ['brought_inside', 'brought_outside', 'mulched']) {
      expect(EVENT_TYPE_META[v], v).toBeTruthy()
      expect(isRaw(EVENT_TYPE_META[v].label), v).toBe(false)
    }
  })

  it('EVENT_TYPE_META carries the three V3-EVENT-007 types', () => {
    for (const v of ['caged', 'staked', 'mesh_netting']) {
      expect(EVENT_TYPE_META[v], v).toBeTruthy()
      expect(isRaw(EVENT_TYPE_META[v].label), v).toBe(false)
    }
  })
})

describe('Phase 1 — EVENT_TYPES master soft-enum', () => {
  it('includes the three Phase-1 event types', () => {
    expect(EVENT_TYPES).toContain('brought_inside')
    expect(EVENT_TYPES).toContain('brought_outside')
    expect(EVENT_TYPES).toContain('mulched')
  })

  it('includes the three V3-EVENT-007 event types', () => {
    expect(EVENT_TYPES).toContain('caged')
    expect(EVENT_TYPES).toContain('staked')
    expect(EVENT_TYPES).toContain('mesh_netting')
  })
})

