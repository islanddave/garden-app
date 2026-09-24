// V5-VOICECARE-001 — the resolver: a spoken care command -> an exact plant set, or a refusal.
//
// WHAT THESE TESTS ARE FOR. A care batch that skips the wrong plant, or silently skips none, looks
// exactly like success afterwards. So most of this file is the shapes that must REFUSE, the measured
// traps that must NOT resolve the way a naive matcher would, and a read-back that must name what the
// app actually resolved. The fixture is the real ?view=picker vocabulary (2026-09-23 snapshot) — see
// voiceCare.fixture.js for why a hand-made garden would not do.
//
// Rules are the Resolution contract R0–R7 in
// Projects/Gardening/_roadmapexec_20260916/lane-G-voicecare-hostres.md.
import { describe, it, expect } from 'vitest'
import { classifyCareCommand } from '../lib/voiceCareGrammar.js'
import {
  resolveCareScope, resolveCareCommand, careConfirmDecision, careLocations, careTerms, voiceKey,
  CARE_CONFIRM_PROMPT,
} from '../lib/voiceCareResolve.js'
import { indexAliases } from '../lib/voiceAliases.js'
import { looseKey } from '../lib/comboboxInput.js'
import { fuzzyMatch } from '../lib/voiceFuzzyMatch.js'
import { plantingAliases } from '../pages/VoiceHarvest.jsx'
import { LOCATIONS, U, byName, dryRun, locationByPath, statusOf } from './voiceCare.fixture.js'

const BAG = 'Pasture > Bag Area'
const IN_GROUND = 'Pasture > In-Ground'
const LEGACY = 'Pasture > Legacy Pasture In-Ground'

// Dave's taught aliases that the design measured as traps (§2e, §2g), keyed exactly as teachAlias
// stores them.
const ALIASES = indexAliases([
  { heard_key: looseKey('cucumber one'), variety_id: byName('Suyo Long').variety_ref.id },
  { heard_key: looseKey('damn i\'ll see you'), variety_id: byName('Cucamelon').variety_ref.id },
  // Synthetic: a heard phrase that no planting term contains, taught for a variety with two plantings.
  { heard_key: looseKey('celery tea'), variety_id: byName('Celebrity').variety_ref.id },
])

// The whole pipeline the host runs: grammar -> scope -> dry run (S) -> resolve.
function resolve(transcript, opts = {}) {
  const care = classifyCareCommand(transcript)
  const scope = resolveCareScope(care, LOCATIONS)
  const scopeSet = scope?.kind === 'care_scope' ? dryRun(scope.location.id) : undefined
  return resolveCareCommand({
    care, plantings: U, locations: LOCATIONS, aliasIndex: ALIASES, scopeSet, ...opts,
  })
}

const idsOf = (...names) => names.map((n) => byName(n).id)
const sIds = (path) => dryRun(locationByPath(path).id).plantings.map((p) => p.id)

describe('fixture — the snapshot matches the 2026-09-23 prod read it was taken from', () => {
  it('reproduces the live counts per area', () => {
    // Measured on prod (read-only) the same day: Bag Area 101 live, In-Ground 24, Pasture subtree
    // 127, Legacy 1, U = 244. If this drifts, the fixture was edited, not the garden.
    expect(U).toHaveLength(244)
    expect(dryRun(locationByPath(BAG).id).count).toBe(101)
    expect(dryRun(locationByPath(IN_GROUND).id).count).toBe(24)
    expect(dryRun(locationByPath('Pasture').id).count).toBe(127)
    expect(dryRun(locationByPath(LEGACY).id).count).toBe(1)
  })

  it('carries no status or location on the U rows, as the real picker payload does not', () => {
    for (const p of U) {
      expect(p).not.toHaveProperty('status')
      expect(p).not.toHaveProperty('location_id')
    }
  })
})

describe('voiceKey / careTerms', () => {
  it('careTerms is exactly VoiceHarvest.jsx plantingAliases — the one copied function, pinned', () => {
    const shapes = [
      ...U,
      { id: 'x', name: 'Bare' },
      { id: 'y', name: null, variety_ref: { name: 'V', crop_type_slug: null } },
      { id: 'z', name: 'N', variety_ref: null, crop_aliases: ['a', 'b'] },
      null,
    ]
    for (const p of shapes) expect(careTerms(p)).toEqual(plantingAliases(p))
  })

  it('strips what speech never produces, so a punctuated name can be said exactly', () => {
    expect(voiceKey('Hot & Spicy Oregano')).toBe(voiceKey('hot spicy oregano'))
    expect(voiceKey('Holy Basil (Tulsi)')).toBe(voiceKey('holy basil tulsi'))
    expect(voiceKey('Pasture > In-Ground')).toBe(voiceKey('pasture in ground'))
    // looseKey alone cannot do it — that is the reason voiceKey exists.
    expect(looseKey('Hot & Spicy Oregano')).not.toBe(looseKey('hot spicy oregano'))
  })

  it('re-collapses letters that punctuation had kept apart', () => {
    // "Hot & Tangy" -> looseKey "hot&tangy" -> stripped "hottangy"; spoken "hot tangy" -> "hotangy".
    // Without the second looseKey pass the two would never meet.
    expect(voiceKey('Hot & Tangy')).toBe(voiceKey('hot tangy'))
  })

  it('keeps digits as identity, like looseKey', () => {
    expect(voiceKey('1884')).not.toBe(voiceKey('184'))
  })
})

describe('R0 — what reaches the resolver at all', () => {
  it('null (not a care command) passes through as null', () => {
    expect(resolveCareScope(null, LOCATIONS)).toBeNull()
    expect(resolveCareCommand({ care: classifyCareCommand('suyo long'), plantings: U, locations: LOCATIONS })).toBeNull()
    expect(resolveCareScope({ kind: 'something-else' }, LOCATIONS)).toBeNull()
  })

  it('the Watermelon guard still returns null end to end', () => {
    // "water melon" is a crop Chrome split in two, never a watering command.
    expect(classifyCareCommand('water melon all bag area')).toBeNull()
    expect(resolve('water melon all bag area')).toBeNull()
  })

  it('care_refused passes through as a spoken refusal', () => {
    const cut = resolve('water all bag area except')
    expect(cut).toMatchObject({ kind: 'care_refusal', rule: 'R0', reason: 'empty-exclusion-list' })
    expect(cut.spokenReason).toMatch(/Nothing was logged\.$/)
    expect(resolve('water except zephyr')).toMatchObject({ kind: 'care_refusal', rule: 'R0', reason: 'no-scope' })
    expect(resolveCareScope({ kind: 'care_refused', reason: 'new-reason' }, LOCATIONS).spokenReason)
      .toMatch(/Nothing was logged/)
  })
})

describe('R1 — the scope', () => {
  it('"pasture in ground": the exact key wins over two substring hits', () => {
    // The key "pastureinground" is the full path of Pasture > In-Ground AND a substring of Legacy
    // Pasture In-Ground (name and path) — the deliberately unmanaged legacy bed.
    const s = resolveCareScope(classifyCareCommand('fed all pasture in ground'), LOCATIONS)
    expect(s).toMatchObject({ kind: 'care_scope', match: 'exact' })
    expect(s.location.full_path).toBe(IN_GROUND)
    const legacy = locationByPath(LEGACY)
    expect(voiceKey(legacy.name).includes(voiceKey('pasture in ground'))).toBe(true)
  })

  it('"stable" is the zone Stable, not the one-plant "Yard - Stable" it is a substring of', () => {
    const s = resolveCareScope(classifyCareCommand('water all stable'), LOCATIONS)
    expect(s.location.full_path).toBe('Stable')
    expect(s.match).toBe('exact')
    expect(resolve('water all stable').keepIds).toHaveLength(20)
  })

  it('a zone is reachable by its exact name, and never by a substring', () => {
    expect(resolveCareScope(classifyCareCommand('water all pasture'), LOCATIONS).location.full_path).toBe('Pasture')
    // The read-back names the zone and its WHOLE count.
    expect(resolve('water all pasture').readBackText).toBe('Water 127 in Pasture.')
    // "pastur" is inside the zone name and four child paths: never the zone, and four is ambiguous.
    expect(resolveCareScope(classifyCareCommand('water all pastur'), LOCATIONS))
      .toMatchObject({ kind: 'care_refusal', rule: 'R1', reason: 'scope-ambiguous' })
    // "deck" is only a zone; "dec" may not reach it.
    expect(resolveCareScope(classifyCareCommand('water all dec'), LOCATIONS))
      .toMatchObject({ kind: 'care_refusal', reason: 'scope-unknown' })
  })

  it('one substring hit is accepted and read back by its full path', () => {
    const s = resolveCareScope(classifyCareCommand('water all legacy'), LOCATIONS)
    expect(s).toMatchObject({ kind: 'care_scope', match: 'substring' })
    expect(resolve('water all legacy').readBackText).toBe(`Water 1 in ${LEGACY}.`)
  })

  it('several substring hits are refused, naming them', () => {
    const r = resolveCareScope(classifyCareCommand('water all shade'), LOCATIONS)
    expect(r).toMatchObject({ kind: 'care_refusal', reason: 'scope-ambiguous' })
    expect(r.spokenReason).toContain('Drive > Drive-Shade')
    expect(r.spokenReason).toContain('Pasture > Pasture-Shade')
    // Five shelves: three are named, the rest counted.
    expect(resolveCareScope(classifyCareCommand('water all shelf'), LOCATIONS).spokenReason).toMatch(/or 2 more/)
  })

  it('two exact hits are refused, not guessed between', () => {
    const twins = [...LOCATIONS, { id: 'twin', name: 'Bag Area', full_path: 'Drive > Bag Area', level: 1 }]
    expect(resolveCareScope(classifyCareCommand('water all bag area'), twins))
      .toMatchObject({ kind: 'care_refusal', reason: 'scope-ambiguous' })
  })

  it('drops a leading "all", and "all" alone is refused rather than read as everything', () => {
    expect(resolveCareScope(classifyCareCommand('water all bag area'), LOCATIONS).heard).toBe('bag area')
    expect(resolveCareScope(classifyCareCommand('water bag area'), LOCATIONS).location.full_path).toBe(BAG)
    expect(resolve('water all')).toMatchObject({ kind: 'care_refusal', rule: 'R1', reason: 'no-scope' })
  })

  it('an unknown area is refused — the scope is never fuzzy-matched', () => {
    // "bag aria" is one letter from "bag area". A fuzzy scope would take it; a wrong area is the
    // largest blast radius there is.
    expect(resolve('water all bag aria')).toMatchObject({ kind: 'care_refusal', reason: 'scope-unknown' })
  })

  it('a location row without a level is treated as a zone (exact only)', () => {
    const noLevel = [{ id: 'q', name: 'Quarry Bed', full_path: 'Quarry Bed', parent_id: null }]
    expect(resolveCareScope(classifyCareCommand('water all quarry'), noLevel))
      .toMatchObject({ kind: 'care_refusal', reason: 'scope-unknown' })
    expect(resolveCareScope(classifyCareCommand('water all quarry bed'), noLevel).location.id).toBe('q')
    const child = [{ id: 'c', name: 'Quarry Bed', full_path: 'X > Quarry Bed', parent_id: 'x' }]
    expect(resolveCareScope(classifyCareCommand('water all quarry'), child).location.id).toBe('c')
  })

  it('careLocations joins GET /api/locations name + full_path', () => {
    const res = {
      locations: [{ id: 'a', name: 'In-Ground', level: 1, parent_id: 'p' }, { id: 'p', name: 'Pasture', level: 0 }],
      locations_with_path: [{ id: 'a', full_path: 'Pasture > In-Ground' }],
    }
    expect(careLocations(res)).toEqual([
      { id: 'a', name: 'In-Ground', full_path: 'Pasture > In-Ground', level: 1, parent_id: 'p' },
      { id: 'p', name: 'Pasture', full_path: 'Pasture', level: 0, parent_id: null },
    ])
    expect(careLocations(LOCATIONS)).toBe(LOCATIONS)
    expect(careLocations(null)).toEqual([])
  })

  it('refuses when S is missing, for another area, empty, or capped', () => {
    const care = classifyCareCommand('water all bag area')
    const base = { care, plantings: U, locations: LOCATIONS }
    const bag = locationByPath(BAG).id
    expect(resolveCareCommand({ ...base })).toMatchObject({ reason: 'scope-set-mismatch' })
    expect(resolveCareCommand({ ...base, scopeSet: dryRun(locationByPath(IN_GROUND).id) }))
      .toMatchObject({ reason: 'scope-set-mismatch' })
    expect(resolveCareCommand({ ...base, scopeSet: { locationId: bag, capped: false, plantings: [] } }))
      .toMatchObject({ rule: 'R1', reason: 'scope-empty' })
    expect(resolveCareCommand({ ...base, scopeSet: { ...dryRun(bag), capped: true } }))
      .toMatchObject({ rule: 'R1', reason: 'scope-capped' })
    // An empty area names the verb it would have done.
    expect(resolveCareCommand({ ...base, scopeSet: { locationId: bag, plantings: [] } }).spokenReason)
      .toContain('nothing to water in Pasture > Bag Area')
  })

  it('accepts S whatever the case of its ids', () => {
    const care = classifyCareCommand('water all bag area')
    const set = dryRun(locationByPath(BAG).id)
    const upper = { ...set, locationId: set.locationId.toUpperCase(), plantings: set.plantings.map((p) => ({ ...p, id: p.id.toUpperCase() })) }
    const plan = resolveCareCommand({ care, plantings: U, locations: LOCATIONS, scopeSet: upper })
    expect(plan.keepIds).toEqual(set.plantings.map((p) => p.id))
  })
})

describe("Dave's two utterances", () => {
  it('"water all bag area" -> every live plant in the Bag Area (Q-A), no skips', () => {
    const plan = resolve('water all bag area')
    expect(plan.kind).toBe('care_plan')
    expect(plan.eventType).toBe('watering')
    expect(plan.keepIds).toEqual(sIds(BAG))
    expect(plan.exclusions).toEqual([])
    expect(plan.readBackText).toBe('Water 101 in Pasture > Bag Area.')
    expect(plan.readBackSpoken).toBe('Water 101 in Pasture Bag Area.')
  })

  it('"fed all pasture in ground except zephyr, crimson sweet, king richard"', () => {
    const plan = resolve('fed all pasture in ground except zephyr, crimson sweet, king richard')
    const skipped = idsOf('Zephyr Squash', 'Crimson Sweet', 'King Richard')
    expect(plan.keepIds).toEqual(sIds(IN_GROUND).filter((id) => !skipped.includes(id)))
    expect(plan.keepIds).toHaveLength(21)
    // Every skip is named by its RESOLVED planting name. "zephyr" was an exact variety match, so no
    // "heard" note — the design's own example read-back.
    expect(plan.readBackText).toBe(
      'Feed 21 in Pasture > In-Ground, skipping 3: Zephyr Squash, Crimson Sweet, King Richard.')
    expect(plan.exclusions.map((e) => e.how)).toEqual(['strict', 'strict', 'strict'])
  })

  it('the same list with no commas splits exactly one way', () => {
    const plan = resolve('fed all pasture in ground except zephyr crimson sweet king richard')
    expect(plan.exclusions.map((e) => e.resolvedName)).toEqual(['Zephyr Squash', 'Crimson Sweet', 'King Richard'])
  })

  it('a partly punctuated list still splits the multi-name segment', () => {
    // The grammar only flags ambiguousList for a SINGLE segment; this one is flagged unambiguous.
    const care = classifyCareCommand('fed all pasture in ground except zephyr crimson sweet and king richard')
    expect(care.ambiguousList).toBe(false)
    expect(care.exclusions).toEqual(['zephyr crimson sweet', 'king richard'])
    expect(resolve(care.transcript).exclusions.map((e) => e.resolvedName))
      .toEqual(['Zephyr Squash', 'Crimson Sweet', 'King Richard'])
  })
})

describe('R2 — splitting an unpunctuated list', () => {
  it('fewest parts wins: "garlic chives" is one planting, not Garlic + the chives group', () => {
    // "garlic" and "chives" are each an exact term (the Garlic planting; the chives crop), and the
    // two-part reading is disjoint — so only fewest-parts keeps this the one planting he named.
    const plan = resolve('water all bag area except garlic chives')
    expect(plan.exclusions).toHaveLength(1)
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: 'Garlic Chives', count: 1, exact: true })
  })

  it('two fewest-part readings naming different plantings are refused', () => {
    // Real vocabulary: "copenhagen market | cabbage unknown" (two cabbages) versus "copenhagen market
    // cabbage | unknown" (a cabbage and the Unknown tomato cuttings). Both are two exact names.
    const r = resolve('water all bag area except copenhagen market cabbage unknown')
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R2', reason: 'split-ambiguous' })
  })

  it('parts must name disjoint plantings — a stutter is one name, not two', () => {
    // "celebrity" (both Celebrity plantings) + "celebrity rescue" overlap, so that reading is not
    // allowed; the whole segment falls to the later layers and resolves to the one planting.
    const plan = resolve('water all bag area except celebrity celebrity rescue')
    expect(plan.exclusions).toHaveLength(1)
    expect(plan.exclusions[0].plantingIds).toEqual(idsOf('Celebrity Rescue'))
    expect(plan.exclusions[0].exact).toBe(false)
  })

  it('with no exact reading the whole segment is one name, and an unknown one refuses', () => {
    expect(resolve('fed all pasture in ground except zephyr crimsen sweet king richard'))
      .toMatchObject({ kind: 'care_refusal', rule: 'R3' })
  })

  it('refuses rather than enumerating a pathological list forever', () => {
    // 40 one-word plantings named "a" .. and a 40-word segment of them: every word is a name, so the
    // readings explode. The budget refuses; it never guesses.
    const letters = Array.from({ length: 40 }, (_, i) => `w${i}`)
    const plantings = [
      ...letters.map((w, i) => ({ id: `00000000-0000-4000-b000-${String(i).padStart(12, '0')}`, name: w })),
      ...letters.slice(0, 39).map((w, i) => ({
        id: `00000000-0000-4000-c000-${String(i).padStart(12, '0')}`, name: `${w} ${letters[i + 1]}`,
      })),
    ]
    const loc = { id: 'L', name: 'Row', full_path: 'Row', level: 0 }
    const care = classifyCareCommand(`water all row except ${letters.join(' ')}`)
    const r = resolveCareCommand({
      care, plantings, locations: [loc],
      scopeSet: { locationId: 'L', plantings: plantings.map((p) => ({ id: p.id })) },
    })
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R2', reason: 'split-too-many' })
  })
})

describe('R3 — resolve every name against the WHOLE household list, never the area', () => {
  it('"cucumber one" (taught for Suyo Long) is refused in In-Ground — never taken as Cucamelon', () => {
    // THE MEASURED TRAP (design §2g). Narrowed to In-Ground, the taught alias finds nothing (Suyo Long
    // lives in the Bag Area) and fuzzy then auto-selects Cucamelon. Against U the alias resolves to
    // Suyo Long, and membership refuses it — which is how a misheard name shows itself.
    const r = resolve('fed all pasture in ground except cucumber one')
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R4', reason: 'not-in-scope' })
    expect(r.spokenReason).toContain('Suyo Long')
    expect(r.spokenReason).toContain('cucumber one')
    // The trap is real on this vocabulary: fuzzy over the In-Ground set alone DOES pick Cucamelon.
    const inGround = U.filter((p) => sIds(IN_GROUND).includes(p.id))
    const narrowed = fuzzyMatch(inGround, 'cucumber one', careTerms, looseKey)
    expect(narrowed.kind).toBe('one')
    expect(narrowed.planting.name).toBe('Cucamelon')
  })

  it('"king" is ambiguous in the household even though only one King is in the Bag Area', () => {
    const r = resolve('water all bag area except king')
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R3', reason: 'name-ambiguous' })
    // The in-area candidate is named first.
    expect(r.spokenReason).toMatch(/King of the North or King Richard/)
  })

  it('"orange" is refused, not taken as the one orange in the Bag Area', () => {
    // Taught for Tender Sweet Orange (In-Ground); inside the Bag Area it would silently become
    // Unknown Sweet Orange.
    expect(resolve('water all bag area except orange')).toMatchObject({ rule: 'R3', reason: 'name-ambiguous' })
  })

  it('exact before substring: "san marzano" is the planting whose variety IS San Marzano', () => {
    // Substring alone would hit San Marzano Roma too, and refuse.
    const plan = resolve('water all bag area except san marzano')
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: 'San Marzano rescue', exact: true, how: 'strict' })
  })

  it('a single substring hit is accepted and read back with what was heard', () => {
    const plan = resolve('fed all pasture in ground except crimson')
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: 'Crimson Sweet', how: 'strict', exact: false })
    expect(plan.readBackText).toContain('Crimson Sweet — heard ‘crimson’')
  })

  it('learned: a taught mishearing resolves to its planting', () => {
    const plan = resolve('fed all pasture in ground except damn i\'ll see you')
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: 'Cucamelon', how: 'alias', exact: false })
  })

  it('learned: an alias for a variety with two plantings is a counted group', () => {
    const plan = resolve('water all bag area except celery tea')
    expect(plan.exclusions[0]).toMatchObject({ how: 'alias', count: 2, resolvedName: 'Celebrity' })
    expect(plan.readBackText).toContain('2 Celebrity plants — heard ‘celery tea’')
  })

  it('learned never outranks strict: a taught phrase that is also a substring stays strict', () => {
    // Same order as harvest (matchPlantingsWithRescue): one bad teach must not make a planting
    // unreachable by its own name. "celebrity" is taught here, wrongly, for Suyo Long — and still
    // resolves to the Celebrity plantings, because the strict layer answers first.
    const withBadTeach = indexAliases([{ heard_key: looseKey('celebrity'), variety_id: byName('Suyo Long').variety_ref.id }])
    const plan = resolve('water all bag area except celebrity', { aliasIndex: withBadTeach })
    expect(plan.exclusions[0]).toMatchObject({ how: 'group', resolvedName: 'Celebrity' })
  })

  it('a failed alias read (no index) degrades silently to the next layer', () => {
    const care = classifyCareCommand('fed all pasture in ground except cucumber one')
    const loc = locationByPath(IN_GROUND)
    const r = resolveCareCommand({ care, plantings: U, locations: LOCATIONS, aliasIndex: null, scopeSet: dryRun(loc.id) })
    // Without the alias, fuzzy over U ranks Suyo Long (0.727, by its crop word) over Cucamelon
    // (0.636) — a margin under AUTO_MARGIN, so 'many', so refused. Still never Cucamelon, and the
    // in-area candidate is named first.
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R3', reason: 'name-ambiguous' })
    expect(r.spokenReason).toBe('“cucumber one” could be Cucamelon or Suyo Long. Nothing was logged.')
  })

  it('folded number words reach a digit-named planting, announced as heard', () => {
    const plan = resolve('water all bag area except eighteen eighty four')
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: '1884', exact: false })
    expect(resolve('water all bag area except 1884').exclusions[0].exact).toBe(true)
    expect(resolve('water all bag area except super sweet one hundred').exclusions[0])
      .toMatchObject({ how: 'group', count: 2, exact: false })
  })

  it('Q-C: a confident fuzzy guess is accepted and SAID with what was heard', () => {
    const plan = resolve('water all bag area except studio long')
    expect(plan.exclusions[0]).toMatchObject({ resolvedName: 'Suyo Long', how: 'fuzzy', exact: false })
    expect(plan.readBackText).toBe('Water 100 in Pasture > Bag Area, skipping 1: Suyo Long — heard ‘studio long’.')
    expect(plan.readBackSpoken).toBe('Water 100 in Pasture Bag Area, skipping 1: Suyo Long — heard studio long.')
  })

  it('fuzzy "many" is refused — a care command has nowhere to show a list', () => {
    expect(resolve('water all bag area except cheroky green')).toMatchObject({ rule: 'R3', reason: 'name-ambiguous' })
  })

  it('nothing at all is refused, and marked teachable for after the cancel (R9)', () => {
    const r = resolve('water all bag area except blorp')
    expect(r).toMatchObject({ rule: 'R3', reason: 'name-unknown', teachable: 'blorp' })
  })

  it('a group is several plantings sharing the VARIETY or CROP word that was said exactly', () => {
    expect(resolve('water all bag area except celebrity').exclusions[0])
      .toMatchObject({ how: 'group', count: 2, resolvedName: 'Celebrity', exact: true })
    expect(resolve('fed all pasture in ground except green bean').exclusions[0])
      .toMatchObject({ how: 'group', count: 3, resolvedName: 'green bean' })
    // A crop slug reads as words.
    expect(resolve('fed all pasture in ground except watermelon').readBackText).toContain('3 watermelon plants')
  })

  it('a planting NAMED the word plus another merely carrying it is not a group — refused', () => {
    const loc = { id: 'L', name: 'Row', full_path: 'Row', level: 0 }
    const plantings = [
      { id: 'a1', name: 'Tulsi', variety_ref: { id: 'v1', name: 'Holy Basil', crop_type_slug: 'basil' } },
      { id: 'a2', name: 'Other', variety_ref: { id: 'v2', name: 'Tulsi', crop_type_slug: 'basil' } },
    ]
    const r = resolveCareCommand({
      care: classifyCareCommand('water all row except tulsi'), plantings, locations: [loc],
      scopeSet: { locationId: 'L', plantings: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] },
    })
    expect(r).toMatchObject({ rule: 'R3', reason: 'name-ambiguous' })
  })
})

describe('R4 — membership', () => {
  it('a name outside the area is refused, naming the area and its count', () => {
    const r = resolve('water all bag area except zephyr')
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R4', reason: 'not-in-scope' })
    expect(r.spokenReason).toBe('Zephyr Squash isn’t one of the 101 plants in Pasture > Bag Area. Nothing was logged.')
  })

  it('an ENDED planting standing in the bed is refused truthfully ("isn\'t one of the N plants")', () => {
    // Cantaloupe is in In-Ground but `ended` since 09-16, so it is not in S.
    expect(statusOf(byName('Cantaloupe').id)).toBe('ended')
    const r = resolve('fed all pasture in ground except cantaloupe')
    expect(r.spokenReason).toBe('Cantaloupe isn’t one of the 24 plants in Pasture > In-Ground. Nothing was logged.')
  })

  it('a group excludes only its members in the area, and says how many', () => {
    // "onion" is three plantings in U (Red and Yellow Onions are ended in the Bag Area); one is live
    // in In-Ground, and a group of one is read back by that planting's name.
    const plan = resolve('fed all pasture in ground except onion')
    expect(plan.exclusions[0]).toMatchObject({ how: 'group', count: 1, resolvedName: 'Flat of Italy Bulb Cipollini Onion' })
    expect(plan.exclusions[0].plantingIds).toEqual(idsOf('Flat of Italy Bulb Cipollini Onion'))

    const tomatoesInU = U.filter((p) => p.variety_ref?.crop_type_slug === 'tomato').map((p) => p.id)
    const tomatoesInS = tomatoesInU.filter((id) => sIds(BAG).includes(id))
    expect(tomatoesInS.length).toBeLessThan(tomatoesInU.length)
    const tomato = resolve('water all bag area except tomato')
    expect(tomato.exclusions[0].plantingIds.sort()).toEqual([...tomatoesInS].sort())
    expect(tomato.exclusions[0].count).toBe(tomatoesInS.length)
    expect(tomato.readBackText).toContain(`skipping ${tomatoesInS.length}: ${tomatoesInS.length} tomato plants`)
  })

  it('a group with no member in the area is refused', () => {
    // Every "honeydew" (a melon alias) planting is ended.
    expect(resolve('fed all pasture in ground except honeydew').spokenReason)
      .toBe('honeydew isn’t one of the 24 plants in Pasture > In-Ground. Nothing was logged.')
  })
})

describe('R5 — all or nothing', () => {
  it('one unresolvable name refuses the whole command, even after good ones', () => {
    const r = resolve('fed all pasture in ground except zephyr, crimson sweet, blorp')
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R3', reason: 'name-unknown' })
    expect(r).not.toHaveProperty('keepIds')
  })

  it('one out-of-area name refuses the whole command', () => {
    expect(resolve('fed all pasture in ground except zephyr, suyo long, king richard'))
      .toMatchObject({ kind: 'care_refusal', rule: 'R4' })
  })

  it('an exclusion list that covers the whole area is refused', () => {
    // Legacy Pasture In-Ground holds one live planting.
    expect(resolve('water all legacy pasture in ground except peach'))
      .toMatchObject({ kind: 'care_refusal', rule: 'R5', reason: 'nothing-left' })
  })
})

describe('R6 — the read-back', () => {
  it('names the planting it RESOLVED, even when that is not what he meant', () => {
    // "tender sweet orange" with "orange" lost at a pause is "tender sweet" — an exact key for the
    // CARROT Tendersweet. Nothing in the resolver can object; only naming it exposes it (design §2h).
    const plan = resolve('fed all pasture in ground except tender sweet')
    expect(plan.readBackText).toBe('Feed 23 in Pasture > In-Ground, skipping 1: Tendersweet Carrot.')
  })

  it('merges two pieces that land on one planting, and says both', () => {
    // The grammar splits "pick and pop" on "and"; both halves are the one planting.
    const plan = resolve('water all bag area except pick and pop')
    expect(plan.exclusions).toHaveLength(1)
    expect(plan.excludedCount).toBe(1)
    expect(plan.exclusions[0].heardAll).toEqual(['pick', 'pop'])
    expect(plan.readBackText).toContain('skipping 1: Pick and Pop — heard ‘pick’, ‘pop’.')
  })

  it('merging keeps a heard note when either piece was inexact', () => {
    const plan = resolve('water all bag area except 1884, eighteen eighty four')
    expect(plan.exclusions).toHaveLength(1)
    expect(plan.exclusions[0].exact).toBe(false)
  })

  it('counts distinct plantings when two entries overlap', () => {
    const plan = resolve('water all bag area except celebrity, celebrity rescue')
    expect(plan.exclusions).toHaveLength(2)
    expect(plan.excludedCount).toBe(2)
    expect(plan.keepIds).toHaveLength(99)
  })

  it('the rain note: watering + rain due + an in-ground bed being watered', () => {
    const inGround = sIds(IN_GROUND)
    expect(resolve('water all pasture in ground', { rainTomorrow: true, inGroundIds: inGround }).readBackText)
      .toBe('Water 24 in Pasture > In-Ground. Rain is forecast tomorrow.')
    // No in-ground bed among what is being watered: no note.
    expect(resolve('water all bag area', { rainTomorrow: true, inGroundIds: inGround }).needsRainNote).toBe(false)
    // In-ground unknown to the host: the note is given (a spurious sentence beats a missing one).
    expect(resolve('water all bag area', { rainTomorrow: true }).needsRainNote).toBe(true)
    // No rain due, or not watering: no note.
    expect(resolve('water all pasture in ground', { rainTomorrow: false, inGroundIds: inGround }).needsRainNote).toBe(false)
    expect(resolve('fed all pasture in ground', { rainTomorrow: true, inGroundIds: inGround }).needsRainNote).toBe(false)
    // The skipped beds do not count.
    const onlyZephyr = idsOf('Zephyr Squash')
    expect(resolve('water all pasture in ground except zephyr', { rainTomorrow: true, inGroundIds: new Set(onlyZephyr) })
      .needsRainNote).toBe(false)
  })

  it('reads back every verb the grammar produces', () => {
    expect(resolve('mulch all bag area').readBackText).toBe('Mulch 101 in Pasture > Bag Area.')
    expect(resolve('weeded all bag area').readBackText).toBe('Weed 101 in Pasture > Bag Area.')
  })
})

describe('R7 — the go-ahead is "next" and nothing else (Q-B)', () => {
  it('confirms on the harvest save-and-advance word and its exact phrases', () => {
    for (const w of ['next', 'Next.', 'next one', 'save and next']) expect(careConfirmDecision(w), w).toBe('confirm')
  })

  it('cancels on anything else that carries words', () => {
    for (const w of [
      'yes', 'okay', 'save', 'done', 'stop',
      'text',                         // the measured mishear of "next"
      'next next',                    // a doubled final — fails safe, he says it again
      'except zephyr crimson sweet',  // the continuation after a pause (design §3)
      'fed all pasture in ground',
    ]) expect(careConfirmDecision(w), w).toBe('cancel')
  })

  it('ignores an empty final, which Chrome emits routinely and is not an utterance', () => {
    expect(careConfirmDecision('')).toBe('ignore')
    expect(careConfirmDecision('   ')).toBe('ignore')
    expect(careConfirmDecision(null)).toBe('ignore')
  })

  it('exports the prompt the host shows with the read-back', () => {
    expect(CARE_CONFIRM_PROMPT).toMatch(/next/)
  })
})
