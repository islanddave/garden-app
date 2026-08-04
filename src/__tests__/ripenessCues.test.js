// V4-RIPECUE-001 — the content guards matter as much as the resolver here. The crucible's ruling
// was that a confidently wrong cue is worse than a blank one, so these tests enforce the two ways
// this file can go wrong silently: an unsourced entry slipping in, and an entry whose key can never
// match anything (which looks identical to "no cue for that crop" in the UI).
import { describe, it, expect } from 'vitest'
import {
  CUES_BY_CROP_TYPE, CUES_BY_CULTIVAR, cueKey, resolveRipenessCues,
} from '../lib/ripenessCues.js'

const ALL = [
  ...Object.entries(CUES_BY_CROP_TYPE).map(([k, v]) => ['crop_type', k, v]),
  ...Object.entries(CUES_BY_CULTIVAR).map(([k, v]) => ['cultivar', k, v]),
]

describe('ripeness cue content — no unsourced cue ships', () => {
  it('every cue carries a real source URL, a confidence and an assertion date', () => {
    for (const [grain, key, rec] of ALL) {
      const where = `${grain}:${key}`
      expect(rec.cue, where).toBeTruthy()
      expect(rec.source, where).toBeTruthy()
      expect(rec.source_url, where).toMatch(/^https:\/\//)
      expect(['high', 'medium', 'low'], where).toContain(rec.confidence)
      expect(rec.asserted_on, where).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('a low-confidence cue MUST carry a caveat, because it renders one', () => {
    // 'low' means the cue was DERIVED from the source rather than stated by it. Without a caveat it
    // would sit on the card looking exactly like a quoted extension instruction. This is the guard
    // against flattening provenance — the reader has to be able to see which is which.
    for (const [grain, key, rec] of ALL) {
      if (rec.confidence !== 'low') continue
      expect(rec.caveat, `${grain}:${key} is low-confidence and needs a caveat`).toBeTruthy()
      expect(String(rec.caveat).trim().length).toBeGreaterThan(0)
    }
  })

  it('cues stay short enough to read on a phone card', () => {
    for (const [grain, key, rec] of ALL) {
      expect(rec.cue.length, `${grain}:${key} is ${rec.cue.length} chars`).toBeLessThanOrEqual(160)
    }
  })

  it('cultivar keys are pre-normalized, so they can actually match', () => {
    // A key like 'Pick-N-Pop Yellow' would never be looked up — resolveRipenessCues normalizes the
    // incoming cultivar name, so an un-normalized key here renders nothing and looks like a gap.
    for (const key of Object.keys(CUES_BY_CULTIVAR)) {
      expect(cueKey(key), `key ${key}`).toBe(key)
    }
  })
})

describe('resolveRipenessCues', () => {
  it('returns nothing for an unsourced crop — the designed outcome, not a bug', () => {
    expect(resolveRipenessCues({ crop_type_slug: 'fittonia', name: 'Nerve Plant' }))
      .toEqual({ target: null, mechanic: null })
  })

  it('returns nothing for a missing / malformed variety_ref', () => {
    expect(resolveRipenessCues(null)).toEqual({ target: null, mechanic: null })
    expect(resolveRipenessCues({})).toEqual({ target: null, mechanic: null })
    expect(resolveRipenessCues({ crop_type_slug: null, name: null })).toEqual({ target: null, mechanic: null })
  })

  it('resolves the crop-level mechanic', () => {
    const { mechanic } = resolveRipenessCues({ crop_type_slug: 'tomato', name: 'Some Unknown Slicer' })
    expect(mechanic).toBeTruthy()
    expect(mechanic.source_url).toMatch(/^https:\/\//)
  })

  it('matches a cultivar name case- and punctuation-insensitively', () => {
    expect(cueKey('Pick-N-Pop Yellow')).toBe('picknpopyellow')
    expect(cueKey('Bulgarian Carrot (Shipka)')).toBe('bulgariancarrotshipka')
    expect(cueKey('  CHEROKEE   green ')).toBe('cherokeegreen')
  })

  it('falls back to the name with the vendor parenthetical stripped', () => {
    // Live data carries 'Shishito (Burpee)' and 'Cherry Stuffer (Burpee)' — the vendor suffix must
    // not defeat a cultivar entry keyed on the plain cultivar name.
    const withParen = resolveRipenessCues({ crop_type_slug: 'pepper', name: 'Shishito (Burpee)' })
    const plain = resolveRipenessCues({ crop_type_slug: 'pepper', name: 'Shishito' })
    expect(withParen.target).toEqual(plain.target)
  })
})

describe('sparse by design — an ordinary red slicer gets no cultivar cue', () => {
  // Research came back "ORDINARY RED" for all 14 of these: they ripen red, you pick them red.
  // "Pick when it's red" is not information, it is chrome that teaches the reader to stop looking
  // at the field. A cultivar cue has to CORRECT an intuition to earn its pixels — Black Krim's
  // green shoulders, Cherokee Green never reddening, Shishito picked green on purpose.
  const ORDINARY_RED = [
    'Celebrity', 'Beefsteak', 'Big Boy', 'Jet Star', 'Stupice', 'Moskvich Heirloom',
    'Delicious', 'Oregon Spring', 'Sub Arctic Plenty', 'Bush Early Girl', 'Manitoba',
    // 'Floridade' was corrected to 'Floradade' in plant_varieties on 20260804 (UF 1976 release;
    // the row's own care_notes and its victoryseeds "flora-dade" source_url both already said so,
    // and the nursery sign OCR reads "Tomato - Floradade"). V4-CULTIVARNAME-001 then propagated that
    // rename to plants.name and entity.display_name and added the trigger that keeps the mirror in
    // step, so 'Floradade' is now the live spelling on every surface. 'Floridade' STAYS listed: it
    // is still the literal in immutable history (audit_events, the pre-rename daily_plan snapshots)
    // and in the migration's rollback, and the assertion is cheap. Same for the Czech pair below.
    'New Yorker', 'Floridade', 'Floradade', 'Mountain Fresh Plus',
    // 20260804: eight more, each CONFIRMED plain-red against a fetched listing rather than assumed
    // from the name. That matters — the list is an assertion that research was DONE and came back
    // negative, not a list of cultivars nobody got to. Sources, in order:
    //   Cherry Falls      kitchengardenseeds.com/tomato-cherry-falls.html
    //   Thessaloniki      trueleafmarket.com/products/tomato-thessaloniki-seeds
    //   Czech's Bush      plantgoodseed.com/products/czech-bush-tomato-seeds-solanum-lycerpersicum
    //                     (renamed from 'Czech Bush Slicer' 20260804 by V4-CULTIVARNAME-001 — that
    //                     spelling is attested by no seed house or reference; the cultivar is the
    //                     Quisenberry/Sodomka 1976 heirloom, tatianastomatobase.com/wiki/Czech's_Bush)
    //   Granadero         johnnyseeds.com .../granadero-organic-f1-tomato-seed-2584G.html
    //   San Marzano Roma  territorialseed.com/products/tomato-san-marzano
    //   Large Red Cherry  totallytomato.com/product/T00424/82
    //   Red Grape         harrisseeds.com/products/11888-tomato-red-grape-f1
    //   Super Sweet 100   johnnyseeds.com .../supersweet-100-f1-tomato-seed-3981.html
    'Cherry Falls', 'Thessaloniki', 'Czech Bush Slicer', "Czech's Bush", 'Granadero',
    'San Marzano Roma', 'Large Red Cherry', 'Red Grape', 'Super Sweet 100',
  ]

  it.each(ORDINARY_RED)('%s carries no cultivar-level cue', (name) => {
    expect(resolveRipenessCues({ crop_type_slug: 'tomato', name }).target).toBeNull()
  })

  it('absence is absence — no entry is ever an empty string standing in for "unknown"', () => {
    // An empty-string cue would render a blank labelled row instead of collapsing the section.
    for (const [, key, rec] of ALL) {
      expect(rec.cue, key).not.toBe('')
      expect(String(rec.cue).trim().length, key).toBeGreaterThan(0)
    }
  })
})

describe('grain discipline — crop-level cues must not make cultivar-varying colour claims', () => {
  // 16 of 41 live tomato cultivars do not ripen red and several live peppers are picked green on
  // purpose, so a crop-level "wait until it is red" is actively harmful. Negative statements
  // ("you never have to wait for red") are the safe direction and are allowed.
  const PRESCRIBES_A_COLOUR =
    /\b(?:wait\s+(?:for|until)|pick|harvest)\b[^.]{0,30}\b(?:red|orange|purple|black|brown)\b/i
  const NEGATED = /\b(?:never|not|no need|don'?t|without)\b/i

  it('no crop-level cue tells the gardener to wait for a specific colour', () => {
    for (const [slug, rec] of Object.entries(CUES_BY_CROP_TYPE)) {
      const prescribes = PRESCRIBES_A_COLOUR.test(rec.cue) && !NEGATED.test(rec.cue)
      expect(prescribes, `${slug}: "${rec.cue}"`).toBe(false)
    }
  })
})
