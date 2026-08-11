// V4-RIPENESSCUES-001 — content rules for the harvest colour windows.
//
// These are content tests, not logic tests, and that is deliberate: the failure mode this dataset has
// is not a crash, it is a plausible sentence that sends Dave to the plant with the wrong idea. The
// rules below are the ones from the design doc that can be mechanically checked, so they are checked
// at build time instead of being hoped for at authoring time.

import { describe, it, expect } from 'vitest'
import {
  WINDOWS_BY_CULTIVAR, WINDOWS_BY_CROP_TYPE, resolveHarvestWindow, windowKey,
} from '../lib/harvestWindows.js'

const CULTIVARS = Object.entries(WINDOWS_BY_CULTIVAR)
const CROPS = Object.entries(WINDOWS_BY_CROP_TYPE)
const ALL = [...CROPS.map(([k, r]) => ['crop', k, r]), ...CULTIVARS.map(([k, r]) => ['cultivar', k, r])]

describe('provenance — nothing unsourced ships', () => {
  it('every window carries a real source URL, a confidence and an assertion date', () => {
    for (const [grain, key, rec] of ALL) {
      expect(rec.source_url, `${grain}:${key}`).toMatch(/^https?:\/\//)
      expect(rec.source, `${grain}:${key}`).toBeTruthy()
      expect(['high', 'medium', 'low'], `${grain}:${key}`).toContain(rec.confidence)
      expect(rec.asserted_on, `${grain}:${key}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  // Complete coverage is only safe because a derived record is LABELLED and the label renders. A
  // low-confidence record with no caveat is a confident wrong claim wearing a tag nobody sees — which
  // is exactly what the 2026-08-04 crucible's no-entry rule existed to prevent.
  it('a low-confidence window MUST carry a caveat, because the caveat renders', () => {
    for (const [grain, key, rec] of ALL) {
      if (rec.confidence === 'low') expect(rec.caveat, `${grain}:${key}`).toBeTruthy()
    }
  })
})

describe('window shape', () => {
  it('has 1–5 points, each with a stage, a look and a payoff', () => {
    for (const [grain, key, rec] of ALL) {
      expect(Array.isArray(rec.window), `${grain}:${key}`).toBe(true)
      expect(rec.window.length, `${grain}:${key}`).toBeGreaterThan(0)
      expect(rec.window.length, `${grain}:${key} — has to read on a phone`).toBeLessThanOrEqual(5)
      rec.window.forEach((p, i) => {
        for (const f of ['at', 'look', 'gives']) {
          expect(String(p?.[f] ?? '').trim().length, `${grain}:${key} window[${i}].${f}`).toBeGreaterThan(0)
        }
      })
    }
  })

  // A range, not a paragraph. Two deliberate allowances, both learned from real content rather than
  // guessed up front:
  //   - Crop-level labels run longer, because a crop label must say "the cultivar's own final ripe
  //     colour" rather than naming one.
  //   - 70 was calibrated on peppers and tomatoes, where a label is a colour pair ("dark green → red").
  //     It is wrong for the crops where colour is NOT the signal: a watermelon label has to carry
  //     ground spot, tendril and rind sheen, and a Charentais label has to carry slip and aroma. That
  //     content is the point of those entries, so the limit moved rather than the text.
  it('window_label is a compact range, not a paragraph', () => {
    for (const [grain, key, rec] of ALL) {
      expect(rec.window_label, `${grain}:${key}`).toBeTruthy()
      const max = grain === 'crop' ? 110 : 105
      expect(rec.window_label.length, `${grain}:${key}: "${rec.window_label}"`).toBeLessThanOrEqual(max)
    }
  })

  // Absence must be absence. An empty string would render a labelled blank row instead of collapsing
  // the section — the same trap ripenessCues.test.js guards against for `cue`.
  it('ripe_vs_unripe is a real string or null, never empty', () => {
    for (const [grain, key, rec] of ALL) {
      if ('ripe_vs_unripe' in rec && rec.ripe_vs_unripe !== null) {
        expect(String(rec.ripe_vs_unripe).trim().length, `${grain}:${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('content rule — a payoff is a consequence, never a permission', () => {
  // Dave, 2026-08-11, on the shipped cues: "The 'and you never have to wait for red' on the harvest
  // notes is not really useful. I know that." Reassurance teaches the reader to stop reading. This
  // test is the enforcement of that ruling, so the phrasing cannot drift back in later.
  // Scoped to permission about WAITING or PICKING. A blunter earlier version matched any "no need
  // to" and rejected "no need to peel" on Suyo Long — a consequence of thin skin, and exactly the kind
  // of payoff this dataset is for. The rejected shape is specifically "you don't have to wait for X".
  const PERMISSION = new RegExp(
    String.raw`\b(?:never|don'?t|do not|no)\s+(?:have to|need to)\s+(?:wait|leave|hold|pick|harvest)\b`
    + String.raw`|\byou can always\b|\bfeel free to\b`, 'i')

  it('no window point grants permission instead of naming a consequence', () => {
    for (const [grain, key, rec] of ALL) {
      for (const p of rec.window) {
        expect(PERMISSION.test(p.gives), `${grain}:${key}: "${p.gives}"`).toBe(false)
      }
    }
  })
})

describe('grain discipline — crop-level windows must not PRESCRIBE a colour', () => {
  // 16 of 41 live tomato cultivars do not ripen red, and several live peppers are picked green on
  // purpose, so "pick it when it's red" at crop level is wrong for a large minority of the plants it
  // renders on. The rule is against PRESCRIPTION, not against the word "red" — naming colours at crop
  // level is often the most useful thing the record does. The pepper record's best sentence is the
  // enumeration "may be red, or yellow, gold, orange, brown or purple depending on the variety, and
  // some varieties stop at a colour that is not red at all", which is the anti-prescription and the
  // exact correction Dave needs. An earlier draft of this test banned colour words outright and
  // failed on that sentence — the blunt rule punished the content it was written to protect.
  // Same shape as the guard shipped in ripenessCues.test.js: a colour near a picking verb, unless
  // negated or enumerated.
  const COLOUR = 'red|orange|purple|black|brown|yellow|pink'
  const PRESCRIBES = new RegExp(
    String.raw`\b(?:wait\s+(?:for|until)|pick|harvest)\b[^.]{0,30}\b(?:${COLOUR})\b`, 'i')
  // "before" negates: "harvest before yellow appears" is a boundary, not a colour to wait for.
  const NEGATED = /\b(?:never|not|no need|don'?t|without|before|any of|cultivar-specific)\b/i
  const ENUMERATES = new RegExp(
    String.raw`\b(?:${COLOUR})\b[^.]*\b(?:${COLOUR})\b[^.]*\b(?:${COLOUR})\b`, 'i')

  it('no crop-level look or payoff tells the gardener to wait for one specific colour', () => {
    for (const [slug, rec] of CROPS) {
      for (const p of rec.window) {
        for (const f of ['look', 'gives']) {
          const text = String(p[f])
          const prescribes = PRESCRIBES.test(text) && !NEGATED.test(text) && !ENUMERATES.test(text)
          expect(prescribes, `${slug} ${f}: "${text}"`).toBe(false)
        }
      }
    }
  })
})

describe('keys resolve', () => {
  it('cultivar keys are pre-normalized, so they can actually match', () => {
    for (const [key] of CULTIVARS) expect(windowKey(key), key).toBe(key)
  })

  it('resolves the crop-level mechanic', () => {
    const { crop } = resolveHarvestWindow({ crop_type_slug: 'tomato', name: 'Nothing In Particular' })
    expect(crop?.window_label).toBeTruthy()
  })

  it('returns nothing for an unsourced crop and for a malformed variety_ref', () => {
    expect(resolveHarvestWindow({ crop_type_slug: 'hosta', name: 'Hosta' })).toEqual({ cultivar: null, crop: null })
    expect(resolveHarvestWindow(null)).toEqual({ cultivar: null, crop: null })
    expect(resolveHarvestWindow(undefined)).toEqual({ cultivar: null, crop: null })
    expect(resolveHarvestWindow({})).toEqual({ cultivar: null, crop: null })
  })

  it('matches a cultivar name case- and punctuation-insensitively', () => {
    const [key, rec] = CULTIVARS[0] ?? []
    if (!key) return
    const spaced = (rec.display_name ?? key)
    expect(resolveHarvestWindow({ crop_type_slug: rec.crop, name: spaced }).cultivar).toEqual(rec)
    expect(resolveHarvestWindow({ crop_type_slug: rec.crop, name: spaced.toUpperCase() }).cultivar).toEqual(rec)
  })

  // The two datasets MUST key identically. If a cultivar resolves a ripeness cue but no window (or
  // vice versa) the card renders half an answer, which reads as a data bug to the person holding it.
  it('every cultivar window key is a valid normalized key with no stray whitespace or punctuation', () => {
    for (const [key] of CULTIVARS) expect(key).toMatch(/^[a-z0-9]+$/)
  })
})
