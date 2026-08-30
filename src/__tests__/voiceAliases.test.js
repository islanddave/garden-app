// V5-VOICEALIAS-001 — the learned-mishearing layer.
//
// What these pin, in order of how much they matter:
//   1. LAYER ORDER. strict > learned > fuzzy. A teach must never shadow an exact name match, and a
//      fuzzy guess must never outrank a human's correction.
//   2. THE FAIL ASYMMETRY. A failed READ is swallowed (the chooser degrades to v4.78.0 and keeps
//      working); a failed WRITE throws (the user must be told, because they are about to trust it).
//   3. NORMALISATION. A stored key that is not a looseKey() output inserts fine and then never
//      matches — the feature failing silently, which is the outcome the whole design refuses.
import { describe, it, expect, vi } from 'vitest'
import { looseKey } from '../lib/comboboxInput.js'
import {
  indexAliases, resolveAlias, fetchAliases, teachAlias, MIN_ALIAS_CHARS,
} from '../lib/voiceAliases.js'
import { matchPlantingsWithRescue } from '../pages/VoiceHarvest.jsx'

const p = (id, name, variety, slug, varietyId) => ({
  id,
  name,
  variety_ref: variety ? { id: varietyId ?? `v-${id}`, name: variety, crop_type_slug: slug } : null,
})

const GARDEN = [
  p('suyo', 'Suyo Long', 'Suyo Long', 'cucumber', 'v-suyo'),
  p('suyo2', 'Suyo Long (bed 2)', 'Suyo Long', 'cucumber', 'v-suyo'),
  p('1884', '1884', '1884', 'tomato', 'v-1884'),
  p('stupice', 'Stupice', 'Stupice', 'tomato', 'v-stupice'),
]

describe('indexAliases', () => {
  it('maps heard_key to variety_id and ignores malformed rows', () => {
    const idx = indexAliases([
      { heard_key: 'studiolong', variety_id: 'v-suyo' },
      { heard_key: '', variety_id: 'v-x' },        // no key
      { heard_key: 'nope' },                        // no variety
      null,
    ])
    expect(idx.get('studiolong')).toBe('v-suyo')
    expect(idx.size).toBe(1)
  })

  it('survives null/undefined without throwing', () => {
    expect(indexAliases(null).size).toBe(0)
    expect(indexAliases(undefined).size).toBe(0)
  })
})

describe('resolveAlias', () => {
  const idx = indexAliases([// DERIVED, never hand-written: looseKey collapses the doubled "e" in "eighteen", so the real
// stored key is "eightenightyfour". Typing the obvious-looking literal here produced a key that
// inserted fine and matched nothing — the exact silent failure the CHECK constraint and
// post_no_unnormalised_keys exist to prevent, reproduced by hand in the first draft of this test.
{ heard_key: looseKey('eighteen eighty four'), variety_id: 'v-1884' }])

  it('resolves a phrase edit distance could never reach', () => {
    // The measured limit of the fuzzy layer: "eighteen eighty four" ranks helichrysum 0.353 against
    // a planting named 1884. No scorer bridges that; a taught alias does, exactly.
    const hits = resolveAlias(idx, 'eighteen eighty four', GARDEN)
    expect(hits.map((h) => h.id)).toEqual(['1884'])
  })

  it('returns EVERY live planting of the variety, not one', () => {
    // An alias names a VARIETY. Two beds of Suyo Long are both legitimate answers and the caller
    // disambiguates with the existing candidate list — the alias narrowed 239 rows to 2.
    const suyoIdx = indexAliases([{ heard_key: 'studiolong', variety_id: 'v-suyo' }])
    expect(resolveAlias(suyoIdx, 'studio long', GARDEN).map((h) => h.id)).toEqual(['suyo', 'suyo2'])
  })

  it('an empty result means NO OPINION, so the caller falls through to fuzzy', () => {
    expect(resolveAlias(idx, 'something else entirely', GARDEN)).toEqual([])
    expect(resolveAlias(null, 'eighteen eighty four', GARDEN)).toEqual([])
    expect(resolveAlias(new Map(), 'eighteen eighty four', GARDEN)).toEqual([])
  })

  it('refuses a phrase too short to be meaningful', () => {
    const shortIdx = indexAliases([{ heard_key: 'abc', variety_id: 'v-1884' }])
    expect(resolveAlias(shortIdx, 'abc', GARDEN)).toEqual([])
    expect(MIN_ALIAS_CHARS).toBe(4)
  })

  it('matches on the looseKey of the utterance, not its raw text', () => {
    // The recogniser's spacing and punctuation vary run to run; the stored key does not.
    const i2 = indexAliases([{ heard_key: looseKey('Studio Long'), variety_id: 'v-suyo' }])
    for (const spoken of ['studio long', 'Studio  Long', 'studio-long', 'STUDIO LONG']) {
      expect(resolveAlias(i2, spoken, GARDEN).map((h) => h.id)).toEqual(['suyo', 'suyo2'])
    }
  })
})

describe('layer order — the safety argument', () => {
  const aliasIdx = indexAliases([
    { heard_key: 'stupice', variety_id: 'v-1884' },        // a DELIBERATELY WRONG teach
    // DERIVED, never hand-written: looseKey collapses the doubled "e" in "eighteen", so the real
// stored key is "eightenightyfour". Typing the obvious-looking literal here produced a key that
// inserted fine and matched nothing — the exact silent failure the CHECK constraint and
// post_no_unnormalised_keys exist to prevent, reproduced by hand in the first draft of this test.
{ heard_key: looseKey('eighteen eighty four'), variety_id: 'v-1884' },
  ])

  it('a strict match is never shadowed by an alias', () => {
    // The wrong teach above claims "stupice" means 1884. It must NOT win: one bad teach cannot be
    // allowed to make a real planting unreachable by its own exact name.
    const { hits, rescued } = matchPlantingsWithRescue(GARDEN, 'stupice', aliasIdx)
    expect(hits.map((h) => h.id)).toEqual(['stupice'])
    expect(rescued).toBeNull()
  })

  it('a learned alias beats fuzzy', () => {
    const { hits, rescued } = matchPlantingsWithRescue(GARDEN, 'eighteen eighty four', aliasIdx)
    expect(hits.map((h) => h.id)).toEqual(['1884'])
    expect(rescued).toBe('learned')
  })

  it('with no alias index the behaviour is byte-identical to v4.78.0', () => {
    expect(matchPlantingsWithRescue(GARDEN, 'studio long', null))
      .toEqual(matchPlantingsWithRescue(GARDEN, 'studio long'))
  })
})

describe('the fail asymmetry', () => {
  it('a failed READ is swallowed — the chooser keeps working', () => {
    const boom = vi.fn().mockRejectedValue(new Error('offline'))
    return expect(fetchAliases(boom)).resolves.toEqual([])
  })

  it('a malformed READ response is swallowed too', async () => {
    expect(await fetchAliases(vi.fn().mockResolvedValue({ aliases: 'not an array' }))).toEqual([])
    expect(await fetchAliases(vi.fn().mockResolvedValue(null))).toEqual([])
  })

  it('a failed WRITE THROWS — the user must be told', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(teachAlias(boom, { heardText: 'studio long', varietyId: 'v-suyo' }))
      .rejects.toThrow('offline')
  })

  it('teach posts a normalised key alongside the raw text', async () => {
    const api = vi.fn().mockResolvedValue({ ok: true })
    await teachAlias(api, { heardText: 'Studio Long', varietyId: 'v-suyo' })
    const body = JSON.parse(api.mock.calls[0][1].body)
    expect(body.heard_key).toBe('studiolong')     // matches the server CHECK
    expect(body.heard_text).toBe('Studio Long')   // raw kept for forensics
    expect(body.variety_id).toBe('v-suyo')
    expect(body.heard_key).toBe(looseKey(body.heard_text))
  })

  it('refuses locally rather than round-tripping to a 400', async () => {
    const api = vi.fn()
    await expect(teachAlias(api, { heardText: 'ab', varietyId: 'v-suyo' })).rejects.toThrow(/Too short/)
    await expect(teachAlias(api, { heardText: 'studio long', varietyId: null })).rejects.toThrow(/No variety/)
    expect(api).not.toHaveBeenCalled()
  })
})
