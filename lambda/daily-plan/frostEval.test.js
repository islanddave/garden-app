import { describe, it, expect } from 'vitest';
import frost from './frostEval.js';
const {
  frostEval, resolveThresholds, dedupKey, evalAdvisory, evalImminent, evalHeat,
  exposurePhrase, DEFAULT_THRESHOLDS,
} = frost;

// Every boundary test names the threshold via DEFAULT_THRESHOLDS rather than a literal, so a D2 change
// to the numbers keeps these tests meaningful instead of turning them into a find-and-replace chore.
const T = DEFAULT_THRESHOLDS;
const ADV = T.ADVISORY_LOW_F;        // §3-3 proposal 40
const IMM = T.IMMINENT_LOW_F;        // §3-3 proposal 38
const HF = T.HARD_FREEZE_LOW_F;      // §3-3 proposal 33
const HEAT = T.HEAT_HIGH_F;          // §3-3 proposal 95

const exposure = { tender: 138, unknown: 3, hardy: 40, tenderContainers: 61 };
const dates = ['2026-09-15', '2026-09-16', '2026-09-17'];

describe('threshold injection (D2 is unapproved — nothing may be hardcoded)', () => {
  it('ships the §3-3 proposed values as DEFAULTS only', () => {
    expect(T.ADVISORY_LOW_F).toBe(40);
    expect(T.IMMINENT_LOW_F).toBe(38);
    expect(T.HARD_FREEZE_LOW_F).toBe(33);
    expect(T.HEAT_HIGH_F).toBe(95);
  });

  it('every threshold is overridable per call — a D2 change needs no logic edit', () => {
    const r = resolveThresholds({ ADVISORY_LOW_F: 45, IMMINENT_LOW_F: 36, HARD_FREEZE_LOW_F: 30, HEAT_HIGH_F: 92 });
    expect(r).toMatchObject({ ADVISORY_LOW_F: 45, IMMINENT_LOW_F: 36, HARD_FREEZE_LOW_F: 30, HEAT_HIGH_F: 92 });
  });

  it('an overridden IMMINENT threshold actually moves the trip point (not just the record)', () => {
    // 36°F does NOT fire at the default 38 boundary... it does (36 <= 38). Use 39: above default, below 45.
    const at39 = frostEval({ tonightLow: 39 }, {});
    expect(at39.alert).toBe(false);
    const raised = frostEval({ tonightLow: 39 }, { thresholds: { IMMINENT_LOW_F: 45 } });
    expect(raised.tier).toBe('imminent');
    expect(raised.level).toBe('protect');
    // F5 rehearsal path: raise the trip point above today's forecast and observe a real end-to-end alert.
  });

  it('rejects an unknown threshold key instead of silently ignoring the typo', () => {
    expect(() => resolveThresholds({ IMMINENT_LOW: 30 })).toThrow(/unknown threshold/);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() => resolveThresholds({ IMMINENT_LOW_F: 'cold' })).toThrow(/non-numeric/);
  });

  it('null override falls back to the default rather than nulling the threshold', () => {
    expect(resolveThresholds({ IMMINENT_LOW_F: null }).IMMINENT_LOW_F).toBe(IMM);
  });
});

describe('evalImminent — Tier 2 boundaries (§3-3)', () => {
  it('exactly AT the imminent threshold fires PROTECT (<=, inclusive)', () => {
    const r = evalImminent(IMM, T);
    expect(r.fires).toBe(true);
    expect(r.level).toBe('protect');
    expect(r.lowF).toBe(IMM);
  });

  it('one degree ABOVE the imminent threshold does not fire', () => {
    const r = evalImminent(IMM + 1, T);
    expect(r.fires).toBe(false);
    expect(r.level).toBeNull();
    expect(r.reason).toBe('above_threshold');
  });

  it('one degree BELOW the imminent threshold fires PROTECT', () => {
    expect(evalImminent(IMM - 1, T)).toMatchObject({ fires: true, level: 'protect' });
  });

  it('exactly AT the hard-freeze threshold escalates to HARD FREEZE', () => {
    const r = evalImminent(HF, T);
    expect(r.fires).toBe(true);
    expect(r.level).toBe('hard_freeze');
  });

  it('one degree ABOVE hard freeze is still PROTECT, not HARD FREEZE', () => {
    expect(evalImminent(HF + 1, T).level).toBe('protect');
  });

  it('one degree BELOW hard freeze stays HARD FREEZE', () => {
    expect(evalImminent(HF - 1, T).level).toBe('hard_freeze');
  });

  it('a fractional low just under the threshold fires; just over does not', () => {
    expect(evalImminent(IMM + 0.1, T).fires).toBe(false);
    expect(evalImminent(IMM - 0.1, T).fires).toBe(true);
  });

  it('null / undefined / NaN tonightLow never fires and is flagged, not read as 0°F', () => {
    for (const v of [null, undefined, NaN, 'cold', {}]) {
      const r = evalImminent(v, T);
      expect(r.fires).toBe(false);
      expect(r.lowF).toBeNull();
      expect(r.reason).toBe('no_tonight_low');
    }
  });

  it('0°F is a real temperature, not an absence — it fires HARD FREEZE', () => {
    expect(evalImminent(0, T)).toMatchObject({ fires: true, level: 'hard_freeze', lowF: 0 });
  });

  it('a negative low fires HARD FREEZE', () => {
    expect(evalImminent(-5, T).level).toBe('hard_freeze');
  });
});

describe('evalAdvisory — Tier 1 from the 3-day forecast minimum (§3-3 / G5)', () => {
  it('exactly AT the advisory threshold fires (<=, inclusive)', () => {
    const r = evalAdvisory([50, ADV, 55], dates, T);
    expect(r.fires).toBe(true);
    expect(r.minLowF).toBe(ADV);
    expect(r.dayOffset).toBe(2);
    expect(r.date).toBe('2026-09-16');
  });

  it('one degree ABOVE the advisory threshold across all 3 days does not fire', () => {
    expect(evalAdvisory([ADV + 1, ADV + 2, ADV + 5], dates, T).fires).toBe(false);
  });

  it('one degree BELOW fires and reports the coldest night', () => {
    const r = evalAdvisory([48, 44, ADV - 1], dates, T);
    expect(r.fires).toBe(true);
    expect(r.minLowF).toBe(ADV - 1);
    expect(r.dayOffset).toBe(3);
  });

  it('takes the MINIMUM of the window, not the first or last value', () => {
    expect(evalAdvisory([60, 30, 60], dates, T).minLowF).toBe(30);
  });

  it('ties resolve to the EARLIEST day so the message states the soonest risk', () => {
    const r = evalAdvisory([35, 35, 35], dates, T);
    expect(r.dayOffset).toBe(1);
    expect(r.date).toBe('2026-09-15');
  });

  it('honours the horizon — a cold D4 outside the window is ignored', () => {
    const r = evalAdvisory([50, 55, 60, 20], [...dates, '2026-09-18'], T);
    expect(r.fires).toBe(false);
    expect(r.coveredDays).toBe(3);
  });

  it('nulls inside the window are skipped, never coerced to 0°F', () => {
    const r = evalAdvisory([null, 50, null], dates, T);
    expect(r.fires).toBe(false);
    expect(r.minLowF).toBe(50);
    expect(r.coveredDays).toBe(1);
    expect(r.partial).toBe(true);
  });

  it('an all-null / empty / missing forecast does not fire and says why', () => {
    for (const v of [[null, null, null], [], null, undefined, 'nope']) {
      const r = evalAdvisory(v, dates, T);
      expect(r.fires).toBe(false);
      expect(r.reason).toBe('no_forecast_lows');
      expect(r.minLowF).toBeNull();
    }
  });

  it('missing forecastDates degrades to a null date, not a crash', () => {
    const r = evalAdvisory([30, 40, 50], null, T);
    expect(r.fires).toBe(true);
    expect(r.date).toBeNull();
  });

  it('0°F in the window is a real value and fires', () => {
    expect(evalAdvisory([0, 60, 60], dates, T)).toMatchObject({ fires: true, minLowF: 0 });
  });
});

describe('evalHeat (§3-3 Tier-2-equivalent, D5-gated OFF by default)', () => {
  it('is disabled by default — frost ships alone in 2026 (D5)', () => {
    expect(evalHeat(HEAT + 20, T, false)).toMatchObject({ fires: false, reason: 'heat_disabled' });
  });

  it('exactly AT the heat threshold fires when enabled (>=, inclusive)', () => {
    expect(evalHeat(HEAT, T, true)).toMatchObject({ fires: true, level: 'heat', highF: HEAT });
  });

  it('one degree BELOW does not fire; one degree ABOVE does', () => {
    expect(evalHeat(HEAT - 1, T, true).fires).toBe(false);
    expect(evalHeat(HEAT + 1, T, true).fires).toBe(true);
  });

  it('null high never fires', () => {
    expect(evalHeat(null, T, true)).toMatchObject({ fires: false, reason: 'no_high_today', highF: null });
  });

  it('the heat threshold is injectable too', () => {
    const r = frostEval({ highToday: 90 }, { heatEnabled: true, thresholds: { HEAT_HIGH_F: 88 } });
    expect(r.tier).toBe('heat');
  });
});

describe('frostEval — tier precedence, copy split, degraded path', () => {
  it('IMMINENT outranks ADVISORY when both fire', () => {
    const r = frostEval({ tonightLow: IMM - 2, forecastLows: [30, 30, 30], forecastDates: dates, exposure });
    expect(r.tier).toBe('imminent');
    expect(r.advisory.fires).toBe(true);   // still recorded for the §3-8 log
    expect(r.message).toMatch(/FROST PROTECT TONIGHT/);
  });

  it('ADVISORY fires alone when tonight is mild but the window is cold', () => {
    const r = frostEval({ tonightLow: 55, forecastLows: [50, ADV - 3, 50], forecastDates: dates, exposure });
    expect(r.tier).toBe('advisory');
    expect(r.message).toMatch(/FROST ADVISORY/);
    expect(r.message).toMatch(/in 2 days/);
    expect(r.message).toMatch(/2026-09-16/);
  });

  it('advisory at D1 reads "tomorrow night", not "in 1 days"', () => {
    const r = frostEval({ tonightLow: 60, forecastLows: [ADV - 1, 60, 60], forecastDates: dates, exposure });
    expect(r.message).toMatch(/tomorrow night/);
  });

  it('PROTECT copy says cover / bring in; HARD FREEZE copy says harvest and that cover will not save it', () => {
    const protect = frostEval({ tonightLow: IMM, exposure });
    expect(protect.level).toBe('protect');
    expect(protect.message).toMatch(/Cover, or bring containers in\./);
    expect(protect.message).not.toMatch(/HARD FREEZE/);

    const hard = frostEval({ tonightLow: HF, exposure });
    expect(hard.level).toBe('hard_freeze');
    expect(hard.message).toMatch(/HARD FREEZE TONIGHT/);
    expect(hard.message).toMatch(/cover will not save fruiting tender crops/);
  });

  it('the message states the unknown count SEPARATELY (§3-4 mapping-gap honesty)', () => {
    const r = frostEval({ tonightLow: HF, exposure });
    expect(r.message).toMatch(/~138 tender plantings/);
    expect(r.message).toMatch(/61 in containers/);
    expect(r.message).toMatch(/3 unclassified \(treated as tender\)/);
  });

  it('omits the unclassified clause entirely when there are no unknowns', () => {
    const r = frostEval({ tonightLow: HF, exposure: { tender: 10, unknown: 0, tenderContainers: 0 } });
    expect(r.message).not.toMatch(/unclassified/);
    expect(r.message).not.toMatch(/in containers/);
  });

  it('singular/plural exposure phrasing', () => {
    expect(exposurePhrase({ tender: 1, unknown: 0 })).toMatch(/~1 tender planting\./);
    expect(exposurePhrase({ tender: 2, unknown: 0 })).toMatch(/~2 tender plantings\./);
  });

  it('a mild night with a mild window produces NO alert and NO filler message', () => {
    const r = frostEval({ tonightLow: 60, highToday: 80, forecastLows: [55, 58, 60], forecastDates: dates, exposure });
    expect(r.alert).toBe(false);
    expect(r.tier).toBeNull();
    expect(r.message).toBeNull();
    expect(r.dedupKey).toBeNull();
  });

  it('§3-7: a null tonightLow IN frost season raises degradedAlert — silence must not read as "no frost"', () => {
    const r = frostEval({ tonightLow: null, forecastLows: [50, 50, 50] }, { frostSeason: true });
    expect(r.alert).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.degradedAlert).toBe(true);
  });

  it('§3-7: the same null OUTSIDE frost season is noted but does not page', () => {
    const r = frostEval({ tonightLow: null }, { frostSeason: false });
    expect(r.degraded).toBe(true);
    expect(r.degradedAlert).toBe(false);
  });

  it('a completely empty input does not throw', () => {
    const r = frostEval();
    expect(r.alert).toBe(false);
    expect(r.degraded).toBe(true);
  });

  it('§3-8: an evaluation logs its observability record even when nothing fires', () => {
    const r = frostEval({ tonightLow: 55, highToday: 70, forecastLows: [50, 52, 54], lowSource: 'forecast', exposure });
    expect(r.observability).toMatchObject({
      tonightLowF: 55, lowSource: 'forecast', forecastMinLowF: 50, forecastCoveredDays: 3,
      tier: null, tenderCount: 138, unknownCount: 3,
    });
    expect(r.observability.thresholds.IMMINENT_LOW_F).toBe(IMM);
  });

  it('§3-8: lowSource carries the station provenance through from mergeStationWeather', () => {
    const r = frostEval({ tonightLow: 34, lowSource: 'station_floor', exposure });
    expect(r.observability.lowSource).toBe('station_floor');
  });
});

describe('dedupKey (§3-5)', () => {
  it('is stable for the same (space, date, tier, level)', () => {
    const a = { spaceId: 'sp1', eventDate: '2026-09-20', tier: 'imminent', level: 'protect' };
    expect(dedupKey(a)).toBe(dedupKey({ ...a }));
  });

  it('a PROTECT -> HARD FREEZE escalation on the SAME night is a different key (re-send allowed)', () => {
    const base = { spaceId: 'sp1', eventDate: '2026-09-20', tier: 'imminent' };
    expect(dedupKey({ ...base, level: 'protect' })).not.toBe(dedupKey({ ...base, level: 'hard_freeze' }));
  });

  it('advisory and imminent on the same night are separate keys', () => {
    const base = { spaceId: 'sp1', eventDate: '2026-09-20' };
    expect(dedupKey({ ...base, tier: 'advisory', level: 'advisory' }))
      .not.toBe(dedupKey({ ...base, tier: 'imminent', level: 'protect' }));
  });

  it('different Spaces do not collide (frost is site-level, §3-3)', () => {
    const base = { eventDate: '2026-09-20', tier: 'imminent', level: 'protect' };
    expect(dedupKey({ ...base, spaceId: 'sp1' })).not.toBe(dedupKey({ ...base, spaceId: 'sp2' }));
  });

  it('frostEval emits the key only when it actually alerts', () => {
    const fired = frostEval({ tonightLow: 30, spaceId: 'sp1', eventDate: '2026-09-20', exposure });
    expect(fired.dedupKey).toBe('sp1|2026-09-20|imminent|hard_freeze');
    expect(frostEval({ tonightLow: 60, spaceId: 'sp1', eventDate: '2026-09-20' }).dedupKey).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D6 — per-crop-type trip points, ONE coalesced alert, covered plantings excluded.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
import fclass from './frostClass.js';
const { evalImminentCrops, evalAdvisoryCrops, cropListPhrase, totalsPhrase, isFrostSeason, resolveFrostRun, cropDigest, MAX_NAMED_CROPS } = frost;
const { BAND_THRESHOLDS, summarize } = fclass;

const crop = (slug, label, band, count, containers = 0) => ({
  slug, label, band, class: 'tender', thresholds: BAND_THRESHOLDS[band], count, containers, fruiting: 0, names: [],
});
// A miniature garden spanning three bands: tropicals trip at 50, basil at 45, peppers at 38, marigold at 34.
const CROPS = [
  crop('pepper', 'peppers', 'tender', 58, 56),
  crop('tomato', 'tomatoes', 'tender', 44, 39),
  crop('basil', 'basil', 'chill_sensitive', 7, 7),
  crop('pothos', 'pothos', 'tropical', 2, 2),
  crop('marigold', 'marigolds', 'light_frost_tolerant', 3, 1),
];
const cropExposure = (rows = CROPS, extra = {}) => ({
  tender: rows.reduce((a, c) => a + c.count, 0), unknown: 0, hardy: 0,
  tenderContainers: rows.reduce((a, c) => a + c.containers, 0),
  atRisk: rows.reduce((a, c) => a + c.count, 0), byCropType: rows, coveredExcluded: 0, ...extra,
});

describe('D6 evalImminentCrops — each crop trips against ITS OWN threshold', () => {
  it('at 48°F only the tropicals have tripped — peppers and tomatoes are untouched', () => {
    const r = evalImminentCrops(48, CROPS, T);
    expect(r.fires).toBe(true);
    expect(r.tripped.map((c) => c.slug)).toEqual(['pothos']);
    expect(r.untripped.map((c) => c.slug).sort()).toEqual(['basil', 'marigold', 'pepper', 'tomato']);
  });

  it('at 44°F basil joins; the solanaceous core still has not', () => {
    expect(evalImminentCrops(44, CROPS, T).tripped.map((c) => c.slug).sort()).toEqual(['basil', 'pothos']);
  });

  it('at the tender threshold peppers and tomatoes join, marigold does not', () => {
    const r = evalImminentCrops(IMM, CROPS, T);
    expect(r.tripped.map((c) => c.slug).sort()).toEqual(['basil', 'pepper', 'pothos', 'tomato']);
  });

  it('at 30°F everything has tripped — one event, one list', () => {
    expect(evalImminentCrops(30, CROPS, T).tripped).toHaveLength(CROPS.length);
  });

  it('a crop past its OWN hard-freeze point is marked hard_freeze even when the site is only PROTECT', () => {
    const r = evalImminentCrops(IMM, CROPS, T);
    const byslug = Object.fromEntries(r.tripped.map((c) => [c.slug, c.level]));
    expect(byslug.pothos).toBe('hard_freeze');   // tropical hard-freeze is 40°F
    expect(byslug.pepper).toBe('protect');
    expect(r.siteLevel).toBe('protect');         // the D2 site call: 38 > 33
    expect(r.cropLevel).toBe('hard_freeze');
  });

  it('the SITE level follows the D2 33°F copy split, not "any crop past its own point"', () => {
    expect(evalImminentCrops(HF, CROPS, T).siteLevel).toBe('hard_freeze');
    expect(evalImminentCrops(HF + 1, CROPS, T).siteLevel).toBe('protect');
    expect(evalImminentCrops(HF, CROPS, T).level).toBe('hard_freeze');
  });

  it('an empty crop list means nothing at risk — it must NOT fire', () => {
    expect(evalImminentCrops(10, [], T)).toMatchObject({ fires: false, reason: 'no_crops_at_risk' });
  });

  it('a crop with null thresholds (hardy) is never tripped, however cold it gets', () => {
    const hardy = { slug: 'kale', label: 'kale', band: 'hardy', thresholds: null, count: 9, containers: 0 };
    const r = evalImminentCrops(-20, [hardy], T);
    expect(r.fires).toBe(false);
    expect(r.untripped.map((c) => c.slug)).toEqual(['kale']);
  });

  it('a null tonightLow never fires and is not read as 0°F', () => {
    for (const v of [null, undefined, NaN, 'cold']) {
      expect(evalImminentCrops(v, CROPS, T)).toMatchObject({ fires: false, reason: 'no_tonight_low', lowF: null });
    }
  });

  it('0°F is a real temperature and trips everything', () => {
    expect(evalImminentCrops(0, CROPS, T).tripped).toHaveLength(CROPS.length);
  });
});

describe('D6 evalAdvisoryCrops — the 48–72h tier is per-crop too', () => {
  it('only crops whose OWN advisory point is met are named', () => {
    expect(evalAdvisoryCrops(46, CROPS, T).tripped.map((c) => c.slug).sort()).toEqual(['basil', 'pothos']);
  });
  it('a null forecast minimum does not fire', () => {
    expect(evalAdvisoryCrops(null, CROPS, T)).toMatchObject({ fires: false, tripped: [] });
  });
  it('an empty crop list does not fire', () => {
    expect(evalAdvisoryCrops(10, [], T).fires).toBe(false);
  });
});

describe('D6 — ONE coalesced alert per frost event, never one per crop', () => {
  it('a frost night produces exactly ONE message naming every affected crop type', () => {
    const r = frostEval({ tonightLow: 36, exposure: cropExposure(), spaceId: 'sp1', eventDate: '2026-09-20' });
    expect(r.alert).toBe(true);
    expect(typeof r.message).toBe('string');
    expect(r.message).toMatch(/peppers \(58\)/);
    expect(r.message).toMatch(/tomatoes \(44\)/);
    expect(r.message).toMatch(/basil \(7\)/);
    // ...and it is a single message, not one per crop.
    expect(r.message.match(/FROST/g)).toHaveLength(1);
  });

  it('crops that have NOT tripped their own threshold are not named', () => {
    const r = frostEval({ tonightLow: 44, exposure: cropExposure() });
    expect(r.message).toMatch(/basil/);
    expect(r.message).not.toMatch(/peppers/);
    expect(r.message).not.toMatch(/marigolds/);
  });

  it('the headline is PROTECT above 33°F even when a tropical is past its own hard-freeze point', () => {
    const r = frostEval({ tonightLow: IMM, exposure: cropExposure() });
    expect(r.level).toBe('protect');
    expect(r.message).toMatch(/^FROST PROTECT TONIGHT/);
    expect(r.message).not.toMatch(/HARD FREEZE/);
    // the tropicals are still called out inside the body, with the correct instruction
    expect(r.message).toMatch(/Too cold to save, harvest now: pothos \(2\)/);
  });

  it('at or below 33°F the headline escalates and the protect-only crops move to "Also cover"', () => {
    const r = frostEval({ tonightLow: HF, exposure: cropExposure() });
    expect(r.level).toBe('hard_freeze');
    expect(r.message).toMatch(/HARD FREEZE TONIGHT/);
    expect(r.message).toMatch(/cover will not save: peppers \(58\)/);
    expect(r.message).toMatch(/Also cover: marigolds \(3\)/);
  });

  it('the totals line covers EVERY tripped crop, not just the branch that was named first', () => {
    const r = frostEval({ tonightLow: 30, exposure: cropExposure() });
    expect(r.message).toMatch(/114 plantings, 105 in containers/);
  });

  it('the unknown count is stated separately and never named in the crop list (§3-4)', () => {
    const unclassified = { slug: null, label: 'unclassified', band: 'tender', class: 'unknown', thresholds: BAND_THRESHOLDS.tender, count: 8, containers: 6, fruiting: 0, names: [] };
    const r = frostEval({ tonightLow: 30, exposure: cropExposure([...CROPS, unclassified], { unknown: 8 }) });
    expect(r.message).not.toMatch(/unclassified \(8\)[,.]/);       // not in the named list
    expect(r.message).toMatch(/8 unclassified \(treated as tender\)/); // stated separately
    expect(r.message).toMatch(/122 plantings/);                    // but still counted
  });

  it('a garden with nothing at risk does NOT alert, even at 10°F (the kale-only case)', () => {
    const r = frostEval({ tonightLow: 10, forecastLows: [10, 10, 10], exposure: summarize([{ id: 'k', name: 'Kale', crop_type_slug: 'kale' }]) });
    expect(r.alert).toBe(false);
    expect(r.tier).toBeNull();
  });

  it('the advisory tier also respects per-crop points — a 40°F window does not page about marigolds alone', () => {
    const only = cropExposure([crop('marigold', 'marigolds', 'light_frost_tolerant', 3, 1)]);
    expect(frostEval({ tonightLow: 60, forecastLows: [39, 39, 39], forecastDates: dates, exposure: only }).alert).toBe(false);
    expect(frostEval({ tonightLow: 60, forecastLows: [35, 39, 39], forecastDates: dates, exposure: only }).tier).toBe('advisory');
  });

  it('the advisory message names the at-risk crop types', () => {
    const r = frostEval({ tonightLow: 60, forecastLows: [50, 39, 50], forecastDates: dates, exposure: cropExposure() });
    expect(r.tier).toBe('advisory');
    expect(r.message).toMatch(/FROST ADVISORY/);
    expect(r.message).toMatch(/At risk: peppers \(58\)/);
    expect(r.message).toMatch(/in 2 days/);
  });

  it('IMMINENT still outranks ADVISORY on the crop path', () => {
    const r = frostEval({ tonightLow: 30, forecastLows: [30, 30, 30], forecastDates: dates, exposure: cropExposure() });
    expect(r.tier).toBe('imminent');
    expect(r.advisoryCrops.fires).toBe(true);   // still recorded for the §3-8 log
  });
});

describe('D6 message shaping — one SMS, not a wall of text', () => {
  it('names at most MAX_NAMED_CROPS types and makes the truncation VISIBLE', () => {
    const many = Array.from({ length: MAX_NAMED_CROPS + 4 }, (_, i) => crop(`c${i}`, `crop${i}`, 'tender', 1));
    const phrase = cropListPhrase(many);
    expect(phrase.match(/crop\d+ \(1\)/g)).toHaveLength(MAX_NAMED_CROPS);
    expect(phrase).toMatch(/\+4 more$/);
  });

  it('does not add a "+N more" clause when everything fits', () => {
    expect(cropListPhrase(CROPS.slice(0, 2))).toBe('peppers (58), tomatoes (44)');
  });

  it('the unclassified bucket is never named, whatever its position', () => {
    const unk = { slug: null, label: 'unclassified', count: 8, containers: 0 };
    expect(cropListPhrase([unk, ...CROPS.slice(0, 1)])).toBe('peppers (58)');
  });

  it('totalsPhrase reports plantings, containers and the unknown count', () => {
    expect(totalsPhrase(CROPS, { unknown: 3 })).toBe('114 plantings, 105 in containers, 3 unclassified (treated as tender).');
    expect(totalsPhrase([crop('pepper', 'peppers', 'tender', 1)], {})).toBe('1 planting.');
  });

  it('even a maximally cold night on a big garden stays inside the SMS cap', () => {
    const big = Array.from({ length: 40 }, (_, i) => crop(`c${i}`, `crop-with-a-long-name-${i}`, 'tender', 9, 9));
    const r = frostEval({ tonightLow: 5, exposure: cropExposure(big, { unknown: 12 }) });
    expect(r.message.length).toBeLessThanOrEqual(frost.MAX_MESSAGE_CHARS);
  });
});

describe('D6 dedup key — a materially different crop set is a different alert (§3-5)', () => {
  const base = { spaceId: 'sp1', eventDate: '2026-09-20', tier: 'imminent', level: 'protect' };

  it('is stable for the same tripped crop set', () => {
    expect(dedupKey({ ...base, crops: CROPS })).toBe(dedupKey({ ...base, crops: [...CROPS] }));
  });

  it('is order-independent — a reshuffled list is the SAME alert', () => {
    expect(dedupKey({ ...base, crops: CROPS })).toBe(dedupKey({ ...base, crops: [...CROPS].reverse() }));
  });

  it('changes when a new crop type joins the event', () => {
    expect(dedupKey({ ...base, crops: CROPS.slice(0, 2) })).not.toBe(dedupKey({ ...base, crops: CROPS.slice(0, 3) }));
  });

  it('changes when a crop escalates from protect to hard_freeze', () => {
    const a = [{ ...CROPS[0], level: 'protect' }];
    const b = [{ ...CROPS[0], level: 'hard_freeze' }];
    expect(dedupKey({ ...base, crops: a })).not.toBe(dedupKey({ ...base, crops: b }));
  });

  it('keeps the pre-D6 key shape when there is no crop breakdown', () => {
    expect(dedupKey(base)).toBe('sp1|2026-09-20|imminent|protect');
    expect(cropDigest([])).toBeNull();
  });

  it('frostEval emits the crop-aware key on the crop path', () => {
    const r = frostEval({ tonightLow: 30, spaceId: 'sp1', eventDate: '2026-09-20', exposure: cropExposure() });
    expect(r.dedupKey).toMatch(/^sp1\|2026-09-20\|imminent\|hard_freeze\|[0-9a-z]+$/);
  });
});

describe('§3-7 isFrostSeason — silence is only alertable inside the window', () => {
  it.each([['2026-09-01', true], ['2026-10-15', true], ['2026-11-15', true],
    ['2026-08-31', false], ['2026-11-16', false], ['2026-01-05', false]])('%s -> %s', (d, want) => {
    expect(isFrostSeason(d)).toBe(want);
  });
  it('a malformed or missing plan date is NOT frost season (never a false page)', () => {
    for (const v of [null, undefined, '', '2026-9-1', 20260901, {}]) expect(isFrostSeason(v)).toBe(false);
  });
  it('the window is injectable', () => {
    expect(isFrostSeason('2026-05-10', { start: '05-01', end: '05-31' })).toBe(true);
  });
});

describe('G3 resolveFrostRun — only the 15:30 ET run may evaluate', () => {
  it('evaluates inside the pm window, in both EDT (15:30) and EST (14:30)', () => {
    expect(resolveFrostRun({}, { etHour: 15 })).toMatchObject({ evaluate: true, slot: 'intraday-pm' });
    expect(resolveFrostRun({}, { etHour: 14 }).evaluate).toBe(true);
  });
  it('does NOT evaluate at the 02:00 nightly or 05:30 am runs — tonightLow means a different night there', () => {
    for (const h of [1, 2, 4, 5]) expect(resolveFrostRun({}, { etHour: h })).toMatchObject({ evaluate: false, slot: 'nightly-or-am' });
  });
  it('does not evaluate at any other hour', () => {
    for (const h of [0, 8, 12, 13, 18, 23]) expect(resolveFrostRun({}, { etHour: h }).evaluate).toBe(false);
  });
  it('an unknown ET hour fails CLOSED rather than guessing', () => {
    expect(resolveFrostRun({}, {})).toMatchObject({ evaluate: false, reason: 'no_et_hour' });
    expect(resolveFrostRun({}, { etHour: 'afternoon' }).evaluate).toBe(false);
  });
  it('event.frostEval forces or suppresses evaluation (the F5 rehearsal lever)', () => {
    expect(resolveFrostRun({ frostEval: true }, { etHour: 3 })).toMatchObject({ evaluate: true, slot: 'forced' });
    expect(resolveFrostRun({ frostEval: false }, { etHour: 15 })).toMatchObject({ evaluate: false, slot: 'suppressed' });
  });
  it('an EventBridge scheduled event carries none of these keys and is decided purely by the hour', () => {
    const ebEvent = { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} };
    expect(resolveFrostRun(ebEvent, { etHour: 15 }).evaluate).toBe(true);
    expect(resolveFrostRun(ebEvent, { etHour: 2 }).evaluate).toBe(false);
  });
});

describe('§3-8 observability on the crop path', () => {
  it('records the crop-type breakdown and the covered-exclusion count on every evaluation', () => {
    const r = frostEval({ tonightLow: 36, lowSource: 'forecast', exposure: cropExposure(CROPS, { unknown: 2, coveredExcluded: 19 }) });
    expect(r.observability).toMatchObject({
      tonightLowF: 36, lowSource: 'forecast', cropTypesAtRisk: 5, coveredExcluded: 19, unknownCount: 2,
    });
    expect(r.observability.cropTypesTripped.map((c) => c.slug).sort()).toEqual(['basil', 'pepper', 'pothos', 'tomato']);
  });

  it('logs the breakdown even when NOTHING fires', () => {
    const r = frostEval({ tonightLow: 60, exposure: cropExposure() });
    expect(r.alert).toBe(false);
    expect(r.observability.cropTypesAtRisk).toBe(5);
    expect(r.observability.cropTypesTripped).toBeNull();
  });
});
