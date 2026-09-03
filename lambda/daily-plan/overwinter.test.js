// V4-OVERWINTER-001 — guards on the overwintering care ATTRIBUTE.
//
// Every assertion here is written to be mutation-provable: each one names, in a comment, the source
// edit that turns it red. This repo has shipped guards that passed while structurally unable to fail
// (a margin assertion computed from two date literals is the standing example), so a guard whose
// failure mode is not stated is not counted.
import { describe, it, expect } from 'vitest';
import ow from './overwinter.js';

const {
  OVERWINTER_REGIMES, DEFAULT_REGIME, SITE_LAT, PERSEPHONE_HOURS, EXIT_NOTICE_DAYS,
  daylengthHours, persephoneDates, overwinterProfile, overwinterState, checkIntervalFor, lastTouch,
  fieldHardyActionable, inWrappedWindow,
} = ow;

describe('daylength model', () => {
  // Fails if the declination model, the refraction constant, or SITE_LAT changes. Reference values are
  // published sunrise-to-sunset day lengths for 42.51N: ~9h05m at the winter solstice, ~15h18m at the
  // summer one, and just over 12h at the equinox (the >12 excess is the refraction/semidiameter term,
  // and its SIGN is the part a bad refraction constant flips).
  it('reproduces published solstice and equinox day lengths at the site latitude', () => {
    expect(daylengthHours(SITE_LAT, '2026-12-21')).toBeCloseTo(9.06, 1);
    expect(daylengthHours(SITE_LAT, '2026-06-21')).toBeCloseTo(15.30, 1);
    const eq = daylengthHours(SITE_LAT, '2026-09-22');
    expect(eq).toBeGreaterThan(12);
    expect(eq).toBeLessThan(12.2);
  });

  // The whole exit path rests on these two dates, so they are pinned. The return date 02-03 is the one
  // the crucible independently derived. Mutation: change PERSEPHONE_HOURS to 11 and both dates move by
  // weeks; change SITE_LAT to 30 and the window vanishes entirely (verified by the next test).
  it('puts the 10-hour wall in early November and the return on 02-03', () => {
    const { closes, opens } = persephoneDates(SITE_LAT, 2026);
    expect(opens).toBe('2026-02-03');
    expect(closes.slice(0, 7)).toBe('2026-11');
    expect(Number(closes.slice(8))).toBeGreaterThanOrEqual(5);
    expect(Number(closes.slice(8))).toBeLessThanOrEqual(11);
  });

  // A latitude below the 10-hour circle has NO Persephone period at all. This is the test that proves
  // the scan is reading real geometry rather than returning constants: at 20N the day never drops
  // below 10 hours, so both edges must be null.
  it('finds no window at a latitude that never drops below the threshold', () => {
    expect(daylengthHours(20, '2026-12-21')).toBeGreaterThan(PERSEPHONE_HOURS);
    const { closes, opens } = persephoneDates(20, 2026);
    expect(closes).toBeNull();
    expect(opens).toBeNull();
  });
});

describe('attribute resolution', () => {
  const c = (extra) => ({ crop: 'Kale', water_interval_days_container: 3, ...extra });

  // The inert case, and the reason this whole feature is byte-identical on today's prod: zero
  // leaf-scope care_profile rows exist, so no planting carries the key. Mutation: make readAttr
  // default to an object instead of null and this goes red immediately.
  it('returns null when no profile carries the attribute', () => {
    expect(overwinterProfile({}, c())).toBeNull();
    expect(overwinterProfile({ db_cadence: { water_interval_days: 3 } }, c())).toBeNull();
  });

  // `overwintering: false` must be indistinguishable from absent — otherwise switching the attribute
  // off by setting it false would hold the planting in the winter track all summer.
  it('treats an explicit false as absent', () => {
    expect(overwinterProfile({}, c({ overwintering: false }))).toBeNull();
  });

  // THE ADOPTION-GATE GUARD, and the single most load-bearing test in this file. v_resolved_care
  // populates cadence_scopes ONLY from water_interval_days{,_container,_inground}, and resolveCadence
  // adopts db_cadence only when cadence_scopes is non-empty. So a leaf profile carrying ONLY an
  // overwintering key never reaches `c` at all. Mutation: delete `p && p.db_cadence` from readAttr's
  // source list and this test goes red while every other test in the file stays green — which is
  // exactly the silent failure the crucible flagged as the trap in the recommended design.
  it('reads the raw db profile, not only the resolved cadence', () => {
    const p = { db_cadence: { overwintering: { regime: 'field_hardy' } }, cadence_scopes: [] };
    const resolved = c();   // bundled fallback — carries no overwintering key
    expect(overwinterProfile(p, resolved).regime).toBe('field_hardy');
  });

  // The resolved cadence wins when BOTH carry the key: `c` is the merged system||cultivar||leaf view,
  // so it is the more specific answer. Mutation: swap the order of the sources in readAttr -> red.
  it('prefers the resolved cadence over the raw profile when both carry it', () => {
    const p = { db_cadence: { overwintering: { regime: 'field_hardy' } } };
    expect(overwinterProfile(p, c({ overwintering: { regime: 'tender_indoors' } })).regime).toBe('tender_indoors');
  });

  // Shorthand. `overwintering: true` is what a human hand-editing jsonb will write.
  it('accepts the boolean shorthand and resolves the default regime', () => {
    const prof = overwinterProfile({}, c({ overwintering: true }));
    expect(prof.regime).toBe(DEFAULT_REGIME);
    expect(prof.check_interval_days).toBe(OVERWINTER_REGIMES[DEFAULT_REGIME].check_interval_days);
  });

  // An unknown regime must fail SAFE — to the shortest-interval outdoor regime — and must say so, so a
  // typo is visible rather than silently disabling the attribute. Mutation: return null for an unknown
  // regime (the "obvious" strict handling) and this goes red, which is the point: silence is the harm.
  it('falls back to the most conservative regime and reports the unknown value', () => {
    const prof = overwinterProfile({}, c({ overwintering: { regime: 'garage_ish' } }));
    expect(prof.regime).toBe(DEFAULT_REGIME);
    expect(prof.unknown_regime).toBe('garage_ish');
    const shortest = Math.min(...Object.values(OVERWINTER_REGIMES).map((r) => r.check_interval_days));
    // Not the global shortest (tender_indoors is 7 and indoor-only) — the shortest that is safe to
    // apply to an unknown, possibly-outdoor planting.
    expect(prof.check_interval_days).toBeGreaterThanOrEqual(shortest);
    expect(prof.check_interval_days).toBeLessThanOrEqual(21);
  });
});

describe('regime cadences', () => {
  // THE CENTRAL AGRONOMIC GUARD: overwintering must never become "skip watering". Mutation: set any
  // regime's check_interval_days to 0, null, or Infinity and this goes red.
  it('no regime skips checking, and none exceeds a month', () => {
    for (const [name, r] of Object.entries(OVERWINTER_REGIMES)) {
      expect(Number.isFinite(r.check_interval_days), name).toBe(true);
      expect(r.check_interval_days, name).toBeGreaterThan(0);
      expect(r.check_interval_days, name).toBeLessThanOrEqual(31);
    }
  });

  // The ordering IS the agronomy, and it is the counter-intuitive part: the LEAST active regime
  // (a fig in a cold garage) gets the LONGEST interval because wet+cold rots it, while the plant that
  // is also barely growing but sits in heated indoor air with no rain at all gets the SHORTEST.
  // Mutation: make tender_indoors longer than protected_quiescent and this goes red.
  it('orders the intervals by drying rate, not by growth rate', () => {
    const R = OVERWINTER_REGIMES;
    expect(R.tender_indoors.check_interval_days).toBeLessThan(R.protected_productive.check_interval_days);
    expect(R.protected_productive.check_interval_days).toBeLessThan(R.field_hardy.check_interval_days);
    expect(R.field_hardy.check_interval_days).toBeLessThan(R.protected_quiescent.check_interval_days);
  });

  // THE VALUES THEMSELVES, not just their rank. The ordering test above stays green for ANY
  // tender_indoors value below 14, so it cannot catch a silent revert to the 10d this regime shipped
  // with in v4.34.0 — which is the one number a panel moved. 7d is the adjudicated value
  // (2026-08-18): heated indoor air is roughly 1.43x the vapour-pressure deficit of a Conway summer,
  // on the plant class whose failure is the fastest and least reversible. The other three are pinned
  // alongside it because the same panel defended each of them explicitly, so a drift in any of the
  // four is a decision being reversed rather than a tuning. Mutation: set tender_indoors back to 10
  // — or nudge any of the other three — and this goes red naming the regime.
  it('pins each regime interval to its adjudicated value', () => {
    const R = OVERWINTER_REGIMES;
    expect(R.tender_indoors.check_interval_days, 'tender_indoors').toBe(7);
    expect(R.protected_productive.check_interval_days, 'protected_productive').toBe(14);
    expect(R.field_hardy.check_interval_days, 'field_hardy').toBe(21);
    expect(R.protected_quiescent.check_interval_days, 'protected_quiescent').toBe(30);
  });

  // The engine holds every overwintering planting out of the feed cadence, so no guidance string may
  // tell Dave to feed it — the text and the code must not contradict each other on the same screen.
  // Every `feed` in the corpus must be negated. Mutation: drop the "do not " from any guidance string
  // and this goes red.
  it('never recommends feeding in the guidance text', () => {
    for (const [name, r] of Object.entries(OVERWINTER_REGIMES)) {
      const positive = r.guidance.replace(/\b(do not|never|not) feed\b/gi, '').replace(/\bfeed until spring\b/gi, '');
      expect(/\bfeed/i.test(positive), `${name}: ${r.guidance}`).toBe(false);
    }
  });
});

describe('reduced cadence is monotone', () => {
  const st = (regime) => ({ ...OVERWINTER_REGIMES[regime], check_interval_days: OVERWINTER_REGIMES[regime].check_interval_days });

  // "Reduced" must be a GUARANTEE, not a hope. max() means overwintering can only ever lengthen the
  // interval. Mutation: change checkIntervalFor to return state.check_interval_days outright (the
  // naive implementation) and the 45-day case goes red — a drought-tolerant plant on a 45-day summer
  // cadence would be pulled forward to 14 by being put under a tunnel.
  it('never shortens an interval that is already longer', () => {
    expect(checkIntervalFor(st('protected_productive'), 3)).toBe(14);
    expect(checkIntervalFor(st('protected_productive'), 45)).toBe(45);
    expect(checkIntervalFor(st('protected_quiescent'), 45)).toBe(45);
    expect(checkIntervalFor(st('tender_indoors'), 3)).toBe(7);
  });

  // A missing/garbage base interval must not produce NaN and silently mark everything due forever.
  it('degrades to the regime interval on a missing base', () => {
    expect(checkIntervalFor(st('field_hardy'), null)).toBe(21);
    expect(checkIntervalFor(st('field_hardy'), undefined)).toBe(21);
  });
});

describe('lastTouch', () => {
  // A moisture_check MUST count. Mutation: drop last_moisture_check from lastTouch and this goes red —
  // and the live consequence is the nightly re-card that V4-TROPICALCOLD-001 already had to fix once.
  it('takes the later of a watering and a soil check', () => {
    expect(lastTouch({ last_water: '2026-12-01', last_moisture_check: '2026-12-20' })).toBe('2026-12-20');
    expect(lastTouch({ last_water: '2026-12-20', last_moisture_check: '2026-12-01' })).toBe('2026-12-20');
    expect(lastTouch({ last_moisture_check: '2026-12-01' })).toBe('2026-12-01');
    expect(lastTouch({ last_water: '2026-12-01' })).toBe('2026-12-01');
    expect(lastTouch({})).toBeNull();
  });

  // V4-OVERWINTERCARDNOISE-001 (1). handler's last_water unions 'watering' WITH 'rain', so under a
  // cover it answers a question nobody asked. The two fixtures differ ONLY in which column carries the
  // date, and they must resolve differently. Mutation: make lastTouch ignore its `state` argument and
  // the first two assertions go red — i.e. a rained-on cold frame reads as watered again.
  it('ignores rain-bearing last_water for a regime rain cannot reach', () => {
    const rainedOn = { last_water: '2026-12-20', last_hand_water: '2026-12-01' };
    expect(lastTouch(rainedOn, { rain_counts: false })).toBe('2026-12-01');
    expect(lastTouch({ last_water: '2026-12-20' }, { rain_counts: false })).toBeNull();
    expect(lastTouch(rainedOn, { rain_counts: true })).toBe('2026-12-20');
    expect(lastTouch(rainedOn)).toBe('2026-12-20');            // no state at all = unchanged behaviour
  });

  // A soil check still clears a protected regime — the honest "I felt it, still damp" answer must not
  // become unusable as a side effect of distrusting rain. Mutation: drop last_moisture_check from the
  // protected branch and this goes red.
  it('still accepts a soil check under a cover', () => {
    expect(lastTouch({ last_water: '2026-12-20', last_moisture_check: '2027-01-04' }, { rain_counts: false }))
      .toBe('2027-01-04');
  });

  // The four regimes must partition into "rain reaches it" and "rain does not", and the derivation is
  // from `protected` — three of four are protected. Mutation: set rain_counts: true unconditionally and
  // the three protected cases go red; set it false unconditionally and field_hardy goes red.
  it('derives rain_counts from the regime, protected=false only for field_hardy', () => {
    const of = (regime) => overwinterProfile({}, { overwintering: { regime } }).rain_counts;
    expect(of('protected_productive'), 'protected_productive').toBe(false);
    expect(of('protected_quiescent'), 'protected_quiescent').toBe(false);
    expect(of('tender_indoors'), 'tender_indoors').toBe(false);
    expect(of('field_hardy'), 'field_hardy').toBe(true);
  });
});

describe('the field_hardy trigger gate', () => {
  const DRY = { recent_precip_in: 0, today_precip_in: 0 };

  // The card exists for a snowless dry cold snap, so a day that is frozen from end to end is one you
  // cannot act on — there is no watering frozen ground. Mutation: delete the FREEZE_F branch and the
  // first two go red; raise FREEZE_F to 40 and the 33F case goes red instead.
  it('blocks on a day that never gets above freezing', () => {
    expect(fieldHardyActionable({ tonightLow: 10, highToday: 28 }, DRY))
      .toEqual({ actionable: false, blocked_by: 'frozen' });
    expect(fieldHardyActionable({ tonightLow: 10, highToday: 31 }, DRY).actionable).toBe(false);
    expect(fieldHardyActionable({ tonightLow: 10, highToday: 33 }, DRY).actionable).toBe(true);
  });

  // field_hardy is the ONE regime rain reaches, so measured precipitation is a real answer to the
  // check. Mutation: delete the wet branch and the 0.5" case goes red; drop the `>=` to `>` and the
  // exactly-at-threshold case goes red.
  it('blocks on measured recent precipitation, at or over the bar', () => {
    expect(fieldHardyActionable({ highToday: 44 }, { recent_precip_in: 0.5, today_precip_in: 0 }))
      .toEqual({ actionable: false, blocked_by: 'recent_precip' });
    expect(fieldHardyActionable({ highToday: 44 }, { recent_precip_in: 0.4, today_precip_in: 0 }).actionable).toBe(false);
    expect(fieldHardyActionable({ highToday: 44 }, { recent_precip_in: 0.39, today_precip_in: 0 }).actionable).toBe(true);
    // Today's own gauge counts toward the bar; 0.2 + 0.25 clears it while neither term does alone.
    expect(fieldHardyActionable({ highToday: 44 }, { recent_precip_in: 0.2, today_observed_in: 0.25 }).actionable).toBe(false);
  });

  // "It is supposed to rain" is not water in the ground. Mutation: add tomorrow_precip_in to the `wet`
  // sum and this goes red — and the live consequence is a check silently skipped on a forecast that
  // then misses, which is the exact failure the F0 rain-credit work already had to unwind once.
  it('does not let a forecast answer the check', () => {
    const forecastOnly = { recent_precip_in: 0, today_precip_in: 0, tomorrow_precip_in: 2.0, tomorrow_pop: 95, upcoming_precip_in: 2.0 };
    expect(fieldHardyActionable({ highToday: 44 }, forecastOnly).actionable).toBe(true);
  });

  // FAIL OPEN. Missing weather or missing hydrology must fire the card, never suppress it: an
  // unchecked crown in a dry January is a dead crown, and one surplus card is not. Mutation: default
  // either missing signal to "blocked" and these go red.
  it('fires when it cannot tell', () => {
    expect(fieldHardyActionable(null, null).actionable).toBe(true);
    expect(fieldHardyActionable({ tonightLow: 10, highToday: null }, DRY).actionable).toBe(true);
    expect(fieldHardyActionable({ highToday: 44 }, { recent_precip_in: null }).actionable).toBe(true);
  });
});

describe('protected_quiescent states exactly one moisture rule', () => {
  // V4-OVERWINTERCARDNOISE-001 (2). The guidance used to carry BOTH "keep the medium BARELY damp" and
  // "water only if the medium is dry well below the surface" — two different moisture states on one
  // card, and a gardener cannot act on both. Mutation: restore either phrase and this goes red.
  it('names the weight test and no competing set-point', () => {
    const g = OVERWINTER_REGIMES.protected_quiescent.guidance;
    expect(g).toMatch(/lift the pot/i);
    expect(g).toMatch(/feels light/i);
    expect(g).not.toMatch(/barely damp/i);
    expect(g).not.toMatch(/below the surface/i);
  });

  // The rot warning is the REASON the rule is "light, not dry", so collapsing the set-points must not
  // drop it. Mutation: delete the wet-plus-cold clause and this goes red.
  it('keeps the reason the rule is a floor and not a target', () => {
    expect(OVERWINTER_REGIMES.protected_quiescent.guidance).toMatch(/wet plus cold/i);
  });

  // V4-DRYDOWNCHANNELLING-001. Weight is the trigger AND the stop condition. Without a stop condition a
  // re-water on a hydrophobic peat mix runs down the shrinkage gap at the pot wall, drains in seconds and
  // reads as watered while the core stays dry. Mutation: drop the "until it feels heavier" clause — the
  // pre-change wording ("only enough to take the lightness off") states a volume, not a measurement, and
  // a channelled watering satisfies it. This goes red.
  it('makes weight the stop condition, not just the trigger', () => {
    expect(OVERWINTER_REGIMES.protected_quiescent.guidance).toMatch(/until it feels heavier/i);
  });

  // Both kill modes, or the gardener is warned off the wrong failure: someone who has been told only
  // about rot reads a fast drain as "plenty" and stops. Mutation: delete either the drainage tell or the
  // dry-root-ball clause and this goes red.
  it('names desiccation alongside rot, and gives the tell that separates them', () => {
    const g = OVERWINTER_REGIMES.protected_quiescent.guidance;
    expect(g).toMatch(/drains in seconds/i);       // the observation that lies
    expect(g).toMatch(/down the pot wall/i);       // why it lies
    expect(g).toMatch(/dry root ball kills/i);     // the kill mode the old copy never named
  });

  // The remedy has to be bounded in the ROT direction too — "stand it in water" with no end is how a fix
  // for desiccation becomes a fix that rots the plant instead. Mutation: drop "then drain" and this goes red.
  it('bounds the rewetting remedy so it does not become the rot path', () => {
    const g = OVERWINTER_REGIMES.protected_quiescent.guidance;
    expect(g).toMatch(/small doses/i);
    expect(g).toMatch(/stand it in water briefly, then drain/i);
  });
});

describe('the window and the exit', () => {
  const c = { crop: 'Kale', water_interval_days_container: 3 };
  const withRegime = (regime) => ({ ...c, overwintering: { regime } });

  // The window WRAPS the new year. A plain string compare on 'MM-DD' is wrong for every date in
  // January, which is the middle of the season this feature exists for. Mutation: replace
  // inWrappedWindow's body with `md >= from && md < until` and the January cases go red.
  it('spans the new year', () => {
    expect(inWrappedWindow('12-25', '11-07', '02-03')).toBe(true);
    expect(inWrappedWindow('01-15', '11-07', '02-03')).toBe(true);
    expect(inWrappedWindow('02-03', '11-07', '02-03')).toBe(false);   // half-open: `until` is OUT
    expect(inWrappedWindow('07-04', '11-07', '02-03')).toBe(false);
  });

  it('is active in midwinter and inert in July', () => {
    expect(overwinterState({}, withRegime('protected_productive'), '2027-01-15').active).toBe(true);
    expect(overwinterState({}, withRegime('protected_productive'), '2026-07-04').active).toBe(false);
  });

  // THE EXIT, and the defect this whole design exists to avoid. `dormant` is a one-way trap because
  // the only writer of plants.status is a human tapping a form. Here the exit is the passage of time:
  // nothing writes anything, and on the day the light returns the planting is simply no longer
  // overwintering. Mutation: make overwinterState ignore `until` (return active:true whenever the
  // attribute is present) and this goes red — which is precisely the trap, reproduced.
  it('exits by itself when the light returns, with no writer', () => {
    const st = withRegime('protected_productive');
    expect(overwinterState({}, st, '2027-02-02').active).toBe(true);
    expect(overwinterState({}, st, '2027-02-03').active).toBe(false);
    expect(overwinterState({}, st, '2027-02-03').exitDue).toBe(false);  // auto regime: no reminder needed
  });

  // The two regimes where Dave physically moves the plant hold LONGER (resuming summer cadence on a
  // pot still sitting in a cold garage is the rot direction) and then get a BOUNDED reminder.
  // Mutation: set MANUAL_EXIT_LAG_DAYS to 0 and the first assertion goes red.
  it('holds the manual regimes past the light return, then reminds — and stops', () => {
    const fig = withRegime('protected_quiescent');
    expect(overwinterState({}, fig, '2027-02-10').active).toBe(true);   // still held, lag has not run out
    const until = overwinterState({}, fig, '2027-02-10').until;
    expect(until).toBe('03-03');
    expect(overwinterState({}, fig, '2027-03-03').active).toBe(false);
    expect(overwinterState({}, fig, '2027-03-03').exitDue).toBe(true);
    // ...and the reminder is BOUNDED. An unbounded one is the one-way trap in different clothing.
    expect(overwinterState({}, fig, '2027-03-16').exitDue).toBe(true);
    expect(overwinterState({}, fig, '2027-03-18').exitDue).toBe(false);
    expect(EXIT_NOTICE_DAYS).toBeLessThanOrEqual(31);
  });

  // An explicit per-planting override beats the computed default in both directions.
  it('honours explicit from/until overrides', () => {
    const st = { ...c, overwintering: { regime: 'field_hardy', from: '10-01', until: '04-15' } };
    expect(overwinterState({}, st, '2026-10-15').active).toBe(true);    // earlier than the computed wall
    expect(overwinterState({}, st, '2027-03-01').active).toBe(true);    // later than the computed return
    expect(overwinterState({}, st, '2027-04-20').active).toBe(false);
  });

  // A planting with no attribute must produce null, not a shape that downstream code has to guard.
  it('returns null for a planting that is not overwintering', () => {
    expect(overwinterState({}, c, '2027-01-15')).toBeNull();
  });
});
