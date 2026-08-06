// V4-SLUGCONSIST-001 — the slug universe is duplicated across independent surfaces, and every one
// of them fails by rendering NOTHING rather than by erroring. Adding a crop type today means
// remembering all of them; nothing fails when one is missed.
//
// This is not hypothetical. The 2026-08-05 crucible found that splitting Rapini/Kailaan into new
// crop_types slugs would have (a) flipped a live planting from the never-alerted `hardy` frost band
// to `tender` (advisory 40F), because unmapped slugs fall through to UNKNOWN_BAND, and (b) silently
// dropped both cultivars' CropCard ripeness cues, because CUES_BY_CROP_TYPE is looked up strictly
// by crop_type_slug with no fallback. Neither would have failed a single test: frostClass.test.js
// asserts against a hand-pinned LIVE_DOMAIN snapshot rather than against the slug list itself.
//
// WHAT IS AND IS NOT THE VOCABULARY. `CROP_TYPE_SLUGS` is NOT the app's crop-type vocabulary and
// must not be used as one — it is a 73-entry static FALLBACK for callers with no DB access, and it
// has drifted well behind the live table (135 live crop_types; the static list is missing kale,
// carrot and bean outright). This is the same drift V4-SEEDLOAD-001 already fixed in the seed
// loader by gating on the LIVE catalog instead of this list. The first draft of this file asserted
// cue keys against it and failed on ten legitimate slugs.
//
// So the invariant here is deliberately DIRECTIONAL rather than an equality: every slug the app
// mentions ANYWHERE in static config must have a decided frost band. That direction is the one with
// a real failure mode — an unmapped slug silently starts emitting cold-protection alerts at 40F —
// and it holds regardless of how stale any individual list is. Exempt is a fine answer; silent is
// not.

import { describe, it, expect } from 'vitest'
import { CROP_TYPE_SLUGS, CROP_GUESS_SYNONYMS } from '../lib/parseSowProfile.js'
import { CUES_BY_CROP_TYPE } from '../lib/ripenessCues.js'
import fc from '../../lambda/daily-plan/frostClass.js'

// Every slug the app names in static config, from all three surfaces. Union, not intersection:
// a slug is "known" if ANY surface mentions it, because any one of them can put it in front of the
// frost engine.
const MENTIONED = Object.freeze([
  ...new Set([
    ...CROP_TYPE_SLUGS,
    ...Object.keys(CUES_BY_CROP_TYPE),
    ...Object.values(CROP_GUESS_SYNONYMS),
  ]),
].sort())

describe('V4-SLUGCONSIST-001 — frost band coverage', () => {
  it('every slug the app mentions has a decided frost band, or is explicitly exempt', () => {
    // frostClass.UNCERTAIN_SLUGS is the existing machine-readable "deliberately unmapped" list and
    // carries a per-slug rationale in its own comment. Reuse it rather than starting a second
    // allowlist that could disagree with it.
    const exempt = new Set(fc.UNCERTAIN_SLUGS)
    const unmapped = MENTIONED.filter((s) => !fc.BAND_BY_SLUG[s] && !exempt.has(s))
    expect(
      unmapped,
      `Unmapped slug(s) fall through to UNKNOWN_BAND ('${fc.UNKNOWN_BAND}') and would start emitting ` +
        `frost alerts at its thresholds. Add each to SLUGS_BY_BAND in lambda/daily-plan/frostClass.js, ` +
        `or to UNCERTAIN_SLUGS with a stated reason: ${unmapped.join(', ')}`
    ).toEqual([])
  })
})

describe('V4-SLUGCONSIST-001 — crop-guess synonym targets', () => {
  it('every synonym target is a slug some other surface also knows', () => {
    // A synonym pointing at a slug nothing else recognises is almost always a typo, and it fails
    // silently: checkCropGuess resolves it, intake writes a crop_type_slug the rest of the app has
    // no config for, and the packet lands untyped or unstyled with no error. Checked against the
    // union of the OTHER two surfaces so a stale static list cannot cause a false failure.
    const elsewhere = new Set([...CROP_TYPE_SLUGS, ...Object.keys(CUES_BY_CROP_TYPE), ...Object.keys(fc.BAND_BY_SLUG)])
    const dangling = Object.entries(CROP_GUESS_SYNONYMS)
      .filter(([, target]) => !elsewhere.has(target))
      .map(([alias, target]) => `${alias} -> ${target}`)
    expect(
      dangling,
      `Synonym target(s) are unknown to every other surface — likely a typo, and it would fail ` +
        `silently at intake: ${dangling.join(', ')}`
    ).toEqual([])
  })
})

describe('V4-SLUGCONSIST-001 — the guard itself', () => {
  it('is actually looking at a populated universe', () => {
    // Without this, an import that silently resolved to an empty object would make every assertion
    // above pass vacuously — a green test asserting nothing, which is the exact failure class this
    // file exists to catch.
    expect(MENTIONED.length).toBeGreaterThan(70)
    expect(Object.keys(fc.BAND_BY_SLUG).length).toBeGreaterThan(50)
    expect(Object.keys(CUES_BY_CROP_TYPE).length).toBeGreaterThan(50)
  })
})
