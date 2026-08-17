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

// V4-TROPICALCOLD-001 (2026-08-17) — THE UNIVERSE WAS THE BUG, not the invariant.
//
// The three static surfaces below have one property in common: a crop only appears in them once
// somebody edits a file. A crop_type that exists ONLY in the live DB is invisible to every one of
// them, so this guard's universe silently excluded exactly the crops most likely to be unmapped —
// the new ones. Measured this run against prod: 125 live crop_type_slug values, of which `aloe`,
// `calibrachoa`, `dogwood`, `ginger` and `lantana` appeared in NO static surface at all. Ginger, a
// tropical needing to come indoors at 55F, was therefore unbanded, uncold-profiled, and unseen by a
// guard whose entire stated job is to catch unbanded slugs. It was invisible, not tolerated.
//
// LIVE_DOMAIN closes that. It is a pinned snapshot of `select slug from crop_types` (prod,
// 2026-08-17, 142 values). Note the TABLE: frostClass.js and frostClass.test.js both pin
// `plant_varieties.crop_type_slug` (125 values), which is NARROWER and is the wrong universe for a
// coverage guard — a crop_type with no variety row yet is precisely the crop nobody has mapped.
// Re-pinning from crop_types exposed 16 further unbanded slugs (the tree fruit, rhubarb, and the
// claytonia/mache/mizuna/tatsoi overwintering greens), all with zero live plantings, i.e. bought
// before the planting existed. `chard` is the standing proof the two tables differ: it is a
// crop_type with zero varieties, and it is why the drift check below runs against THIS list.
const LIVE_DOMAIN = ('aloe althaea apple apricot artichoke arugula asparagus avocado basil bay bean bee_balm beet '
  + 'begonia bitter_melon black_raspberry blackberry blackberry_lily blueberry bok_choy borage broccoli '
  + 'brussels_sprouts bunching_onion cabbage cactus calibrachoa carnation carrot celery chard cherry chervil chives '
  + 'christmas_cactus chrysanthemum cilantro claytonia cobaea coleus collard columbine cranberry crown_of_thorns '
  + 'cucamelon cucumber culantro delphinium dill dogwood dracaena echeveria edelweiss eggplant elderberry endive '
  + 'fittonia flower_mix four_o_clock foxglove garlic geranium ginger grape haworthia helichrysum hibiscus hollyhock '
  + 'hosta jade japanese_maple kale kohlrabi lantana leek lemon_verbena lemongrass lettuce lithops luffa mache '
  + 'marigold melon milkweed mint mizuna money_plant morning_glory mustard nasturtium nectarine okra onion oregano '
  + 'parsley parsnip pea peach pear pepper perilla petunia pineapple plum poppy potato pothos radicchio radish '
  + 'raspberry rat_tail_radish red_raspberry rhubarb rose rosemary sage sedum sempervivum shallot sour_cherry '
  + 'spider_plant spinach squash stock strawberry succulent sunflower sweet_potato tarragon tatsoi thunbergia thyme '
  + 'tomatillo tomato torenia tradescantia tweedia vietnamese_coriander viola watermelon wineberry winter_squash')
  .split(' ')

// Every slug the app names in static config, PLUS the live crop-type domain. Union, not intersection:
// a slug is "known" if ANY surface mentions it, because any one of them can put it in front of the
// frost engine — and the DB can do so without any file being edited at all.
const MENTIONED = Object.freeze([
  ...new Set([
    ...CROP_TYPE_SLUGS,
    ...Object.keys(CUES_BY_CROP_TYPE),
    ...Object.values(CROP_GUESS_SYNONYMS),
    ...LIVE_DOMAIN,
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

describe('V4-TROPICALCOLD-001 — cold-profile coverage', () => {
  // THE DEFECT CLASS THIS EXISTS FOR: a chill-sensitive crop with no cold profile produces NO
  // bring-indoors task at ANY temperature, silently. engine.coldFor reads a profile keyed first by
  // variety (cadence-data-v2.json, 171 entries) and now by crop_type (frostClass.COLD_BY_CROP_TYPE);
  // when neither has an entry it returns null. Null is indistinguishable from "this plant is fine in
  // the cold", so the failure renders as silence rather than as an error — the same shape as the
  // unmapped-band failure above, one hop further down, and it cost a real plant its only warning.
  //
  // The requirement is DERIVED, not hand-listed: membership of a band in
  // COLD_PROFILE_REQUIRED_BANDS is the declaration, so adding a slug to the tropical band is by
  // itself enough to make this guard demand a profile for it. A second hand-kept list is exactly how
  // the two surfaces disagreed in the first place.
  it('every crop in a cold-profile-required band HAS a cold profile', () => {
    const required = fc.COLD_PROFILE_REQUIRED_BANDS.flatMap((b) => fc.SLUGS_BY_BAND[b])
    const missing = required.filter((s) => !fc.coldProfileForSlug(s)).sort()
    expect(
      missing,
      `Crop(s) are banded cold-sensitive but have NO cold profile, so engine.coldFor returns null for ` +
        `them at every temperature and they can never produce a "bring in tonight" task. Add each to ` +
        `COLD_BY_CROP_TYPE in lambda/daily-plan/frostClass.js: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('ginger specifically can produce a bring-indoors signal in the low 50s', () => {
    // The plant this item exists for. Pinned by name, not just by the coverage rule above, because
    // the coverage rule would still pass if ginger were quietly moved out of the tropical band.
    const prof = fc.coldProfileForSlug('ginger')
    expect(prof, 'ginger must have a cold profile').toBeTruthy()
    expect(prof.tender).toBe(true)
    expect(prof.protect_below_F).toBeGreaterThanOrEqual(50)
    expect(fc.BAND_BY_SLUG.ginger).toBe('tropical')
  })

  it('a cold profile is never the muted tender baseline for a true tropical', () => {
    // The trap the panel walked into: the tropical BAND is deliberately held to 40/38/33, so a fix
    // that only banded the crop would produce a first warning in mid-October, about six weeks after
    // ginger needed to move. A profile at or below the band's advisory point would be that same
    // non-fix wearing a different hat.
    const advisory = fc.BAND_THRESHOLDS.tender.ADVISORY_LOW_F
    for (const slug of ['ginger', 'pineapple', 'fittonia']) {
      expect(fc.coldProfileForSlug(slug).protect_below_F, `${slug} must warn above the tender band`)
        .toBeGreaterThan(advisory)
    }
  })

  it('no cold profile exists for a crop that is not cold-sensitive', () => {
    // The inverse error: a profile on a hardy crop emits a nightly "bring in tonight" card for a
    // plant that is fine outdoors, which is how the channel gets muted by its owner.
    const stray = Object.keys(fc.COLD_BY_CROP_TYPE)
      .filter((s) => !fc.COLD_PROFILE_REQUIRED_BANDS.includes(fc.BAND_BY_SLUG[s]))
      .sort()
    expect(stray, `cold profile on a crop that is not in a cold-sensitive band: ${stray.join(', ')}`).toEqual([])
  })
})

describe('V4-SLUGCONSIST-001 — the guard itself', () => {
  it('the pinned live domain has not drifted behind the static surfaces', () => {
    // LIVE_DOMAIN is a snapshot and will go stale — that is not preventable in a unit test with no
    // DB. What IS preventable is stale-and-unnoticed. Any slug the static config knows about must
    // also be in the snapshot; when that fails, the snapshot is provably behind and needs re-pulling
    // with the query in its header comment. This is a weaker signal than a live query and is chosen
    // deliberately over adding a DB dependency to the unit suite.
    const snapshot = new Set(LIVE_DOMAIN)
    const behind = [...new Set([...CROP_TYPE_SLUGS, ...Object.keys(CUES_BY_CROP_TYPE)])]
      .filter((s) => !snapshot.has(s)).sort()
    expect(behind, `LIVE_DOMAIN is behind the static surfaces; re-pull it: ${behind.join(', ')}`).toEqual([])
  })

  it('is actually looking at a populated universe', () => {
    // Without this, an import that silently resolved to an empty object would make every assertion
    // above pass vacuously — a green test asserting nothing, which is the exact failure class this
    // file exists to catch.
    expect(MENTIONED.length).toBeGreaterThan(70)
    expect(Object.keys(fc.BAND_BY_SLUG).length).toBeGreaterThan(50)
    expect(Object.keys(CUES_BY_CROP_TYPE).length).toBeGreaterThan(50)
  })
})
