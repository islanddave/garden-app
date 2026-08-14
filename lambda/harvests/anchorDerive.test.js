// Unit tests for the PURE anchor derivation (lambda/harvests/anchorDerive.js) and its integration
// as the weakest watch-list anchor tier.
//
// THESE TESTS EXECUTE BEHAVIOUR. They call the functions and assert on returned values. No
// readFileSync, no regex over source — the pattern that lets a behaviour-breaking change ship green.
//
// Every fixture is a real live-prod row shape, transcribed from a read-only query against prod Neon
// on 2026-08-12 (household = Dave; Jen has zero live plantings, so these are Dave's plantings, not a
// household sample). The 21 watch-eligible anchorless plantings were read in full; the ones below
// are the shapes that discriminate between tiers.
import { describe, it, expect } from 'vitest';
import {
  ANCHOR_DERIVE_MODEL_VERSION, ADD_DATE_OFFSET_DAYS, ADD_DATE_OFFSET_MEASURED, OFFSET_MIN_SAMPLE,
  SOW_EVENT_TYPES, TRANSPLANT_EVENT_TYPES, NURSERY_PROXY_EVENT_TYPES, DERIVATION_TIERS,
  OBSERVED_ANCHOR_FIELDS, observedAnchorOf, medianDays, resolveAddDateOffset,
  deriveAnchor, describeDerivation, summarizeDerivations,
} from './anchorDerive.js';
import {
  DERIVED_ANCHOR_ENABLED, SIBLING_ANCHOR_HABITS, TIER_RANK, resolveWatchAnchor,
  classifyWatchCandidate, projectWatchRow, describeBasis, siblingLabel, buildWatchList,
  DERIVED_ANCHOR_HABITS, DERIVED_STATUS_SUPPRESSED, DERIVED_FIRST_FALL_FROST_MMDD,
  DERIVED_FROST_WINDOW_DAYS, firstFallFrostFor, WATCHED_HABITS, addDays,
} from './watch.js';
// V4-ANCHORFLIP-001 condition 3. Imported HERE and nowhere in lambda/**: the harvests Lambda and
// src/lib are separate module graphs, so the frost constants are necessarily restated in watch.js.
// This import is the lockstep pin that stops the two copies drifting — see the frost test below.
import { FROST_ANCHORS } from '../../src/lib/sowEngine.js';

const TODAY = '2026-08-12';

// ── Live-prod fixtures ───────────────────────────────────────────────────────────────────────────

// Cantaloupe (project shared with a picked sibling), added 2026-05-30, no date columns at all, and
// a hardening_off on 2026-06-01. Tier 2b is the only tier that fires; it is one of the 7.
const CANTALOUPE = {
  plant_id: 'p-cantaloupe', planting_name: 'Cantaloupe', crop_type_slug: 'melon',
  harvest_habit: 'single', dtm_basis: 'from-sow', days_to_maturity_min: 75,
  sown_at: null, transplanted_at: null, planted_out_at: null,
  add_date: '2026-05-30',
  events: [{ event_type: 'hardening_off', event_date: '2026-06-01' }],
};

// Garlic: added 2026-05-21, no dates, NO events of any kind. Pure tier 3 — one of the 57.
const GARLIC = {
  plant_id: 'p-garlic', planting_name: 'Garlic', crop_type_slug: 'garlic',
  harvest_habit: 'single', dtm_basis: null, days_to_maturity_min: 240,
  sown_at: null, transplanted_at: null, planted_out_at: null,
  add_date: '2026-05-21', events: [],
};

// Speckled Roman Rescue: added TODAY. add-date + 7 lands on 2026-08-19, in the future.
const SPECKLED_ROMAN = {
  plant_id: 'p-speckled', planting_name: 'Speckled Roman Rescue', crop_type_slug: 'tomato',
  harvest_habit: 'repeat', dtm_basis: 'from-transplant', days_to_maturity_min: 78,
  sown_at: null, transplanted_at: null, planted_out_at: null,
  add_date: '2026-08-12', events: [],
};

// Charentais: HAS transplanted_at. Off limits to derivation entirely.
const CHARENTAIS = {
  plant_id: 'p-charentais', planting_name: 'Charentais', crop_type_slug: 'melon',
  harvest_habit: 'single', dtm_basis: 'from-sow', days_to_maturity_min: 75,
  sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
  add_date: '2026-05-30', events: [],
};

describe('constants carry their provenance', () => {
  it("keeps Dave's stated +7 baseline rather than silently substituting the measured median", () => {
    expect(ADD_DATE_OFFSET_DAYS).toBe(7);
    expect(ADD_DATE_OFFSET_MEASURED.median_days).toBe(9);
  });

  // The number this lane exists to surface. If a later edit "tidies" it away, the spread that makes
  // the baseline a guess disappears with it.
  it('carries the measured spread, not just the point estimate', () => {
    expect(ADD_DATE_OFFSET_MEASURED.sample_n).toBe(112);
    expect(ADD_DATE_OFFSET_MEASURED.within_7d_rate).toBeLessThan(0.6);
    expect(ADD_DATE_OFFSET_MEASURED.p75_days).toBeGreaterThan(ADD_DATE_OFFSET_DAYS);
  });

  it('orders the tiers exactly as BD-001a specifies: sow, then transplant, then baseline', () => {
    expect(DERIVATION_TIERS.map((t) => t.source)).toEqual([
      'sow_event', 'transplant_event', 'nursery_proxy_event', 'add_date_baseline',
    ]);
    const tiers = DERIVATION_TIERS.map((t) => t.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });

  it('never treats a nursery event as a real transplant', () => {
    for (const t of NURSERY_PROXY_EVENT_TYPES) expect(TRANSPLANT_EVENT_TYPES).not.toContain(t);
    expect(SOW_EVENT_TYPES).toContain('sowing');
  });
});

describe('observed anchors are off limits', () => {
  it('returns null for a planting that already has a date Dave entered', () => {
    expect(deriveAnchor(CHARENTAIS, { etToday: TODAY })).toBeNull();
  });

  // The marking rule's whole point: derivation must be unable to overwrite an observation. Asserted
  // per column so adding a fourth observed column and forgetting it fails here.
  it.each(OBSERVED_ANCHOR_FIELDS)('refuses to derive when %s is present', (field) => {
    const row = { ...GARLIC, [field]: '2026-06-01' };
    expect(observedAnchorOf(row)).toEqual({ field, date: '2026-06-01' });
    expect(deriveAnchor(row, { etToday: TODAY })).toBeNull();
  });

  it('derives for the same row once the observed date is removed', () => {
    expect(deriveAnchor({ ...CHARENTAIS, transplanted_at: null }, { etToday: TODAY })).not.toBeNull();
  });
});

describe('tier precedence', () => {
  const withEvents = (events) => ({ ...GARLIC, events });

  it('prefers a sow event over everything below it', () => {
    const d = deriveAnchor(withEvents([
      { event_type: 'transplant', event_date: '2026-06-20' },
      { event_type: 'sowing', event_date: '2026-04-01' },
      { event_type: 'potting_up', event_date: '2026-05-01' },
    ]), { etToday: TODAY });
    expect(d.source).toBe('sow_event');
    expect(d.date).toBe('2026-04-01');
    expect(d.field).toBe('sown_at');
    expect(d.offset_days).toBe(0);
  });

  it('prefers a transplant event over a nursery proxy and over the baseline', () => {
    const d = deriveAnchor(withEvents([
      { event_type: 'potting_up', event_date: '2026-05-01' },
      { event_type: 'transplant', event_date: '2026-06-20' },
    ]), { etToday: TODAY });
    expect(d.source).toBe('transplant_event');
    expect(d.date).toBe('2026-06-20');
    expect(d.field).toBe('transplanted_at');
  });

  it('prefers a nursery proxy over the baseline, and labels it proxy — not event', () => {
    const d = deriveAnchor(CANTALOUPE, { etToday: TODAY });
    expect(d.source).toBe('nursery_proxy_event');
    expect(d.confidence).toBe('proxy');
    expect(d.date).toBe('2026-06-01');
  });

  it('falls to the add-date baseline only when nothing else exists', () => {
    const d = deriveAnchor(GARLIC, { etToday: TODAY });
    expect(d.source).toBe('add_date_baseline');
    expect(d.confidence).toBe('baseline');
    expect(d.date).toBe('2026-05-28'); // 2026-05-21 + 7
    expect(d.evidence_date).toBe('2026-05-21');
    expect(d.offset_days).toBe(7);
  });

  it('takes the EARLIEST event when a tier has several', () => {
    const d = deriveAnchor(withEvents([
      { event_type: 'sowing', event_date: '2026-04-20' },
      { event_type: 'sowing', event_date: '2026-04-01' },
    ]), { etToday: TODAY });
    expect(d.date).toBe('2026-04-01');
  });

  it('returns null when there is no evidence and no add-date', () => {
    expect(deriveAnchor({ ...GARLIC, add_date: null }, { etToday: TODAY })).toBeNull();
  });
});

describe('every derived result is marked as derived', () => {
  const rows = [CANTALOUPE, GARLIC, SPECKLED_ROMAN,
    { ...GARLIC, events: [{ event_type: 'sowing', event_date: '2026-04-01' }] },
    { ...GARLIC, events: [{ event_type: 'transplant', event_date: '2026-06-20' }] }];

  it.each(rows.map((r, i) => [i, r]))('row %i carries derived:true and full provenance', (_i, row) => {
    const d = deriveAnchor(row, { etToday: TODAY });
    expect(d.derived).toBe(true);
    expect(d.model_version).toBe(ANCHOR_DERIVE_MODEL_VERSION);
    expect(typeof d.source).toBe('string');
    expect(['event', 'proxy', 'baseline']).toContain(d.confidence);
    expect(d.derived_on).toBe(TODAY);
  });

  it('reports a measured spread for the baseline and none for an event date', () => {
    expect(deriveAnchor(GARLIC, { etToday: TODAY }).spread_days).toEqual(ADD_DATE_OFFSET_MEASURED);
    expect(deriveAnchor(CANTALOUPE, { etToday: TODAY }).spread_days).toBeNull();
  });

  it('clamps a future baseline to today and says it clamped', () => {
    const d = deriveAnchor(SPECKLED_ROMAN, { etToday: TODAY });
    expect(d.date).toBe(TODAY);
    expect(d.clamped_to_today).toBe(true);
    expect(d.evidence_date).toBe('2026-08-12');
  });

  it('does not clamp a baseline that already sits in the past', () => {
    expect(deriveAnchor(GARLIC, { etToday: TODAY }).clamped_to_today).toBe(false);
  });
});

describe('household offset resolution', () => {
  it('uses the stated baseline below the sample floor', () => {
    const o = resolveAddDateOffset([1, 2, 3]);
    expect(o).toEqual({ days: 7, source: 'stated_baseline', sample_n: 3 });
  });

  it("uses the household's own median once there are enough samples", () => {
    const o = resolveAddDateOffset([1, 2, 5, 17, 40]);
    expect(o.days).toBe(5);
    expect(o.source).toBe('household_median');
    expect(o.sample_n).toBeGreaterThanOrEqual(OFFSET_MIN_SAMPLE);
  });

  it('applies the resolved offset and records which source produced it', () => {
    const d = deriveAnchor(GARLIC, { etToday: TODAY, offset: resolveAddDateOffset([1, 2, 5, 17, 40]) });
    expect(d.date).toBe('2026-05-26'); // 05-21 + 5
    expect(d.offset_source).toBe('household_median');
    expect(d.offset_sample_n).toBe(5);
  });

  it('reports no offset source when no offset was applied', () => {
    expect(deriveAnchor(CANTALOUPE, { etToday: TODAY }).offset_source).toBeNull();
  });

  it('medianDays takes a real observed value on an even sample, never a synthetic mean', () => {
    expect(medianDays([1, 4])).toBe(1);
    expect(medianDays([])).toBeNull();
  });
});

describe('describeDerivation — the copy always says est.', () => {
  it.each([
    [GARLIC, 'add-date'],
    [CANTALOUPE, 'nursery event'],
  ])('leads with est. and names the source', (row, phrase) => {
    const s = describeDerivation(deriveAnchor(row, { etToday: TODAY }), TODAY);
    expect(s.startsWith('est.')).toBe(true);
    expect(s).toContain(phrase);
  });

  it('returns null for anything not marked derived', () => {
    expect(describeDerivation(null, TODAY)).toBeNull();
    expect(describeDerivation({ derived: false, source: 'add_date_baseline' }, TODAY)).toBeNull();
  });
});

describe('summarizeDerivations reproduces the live-prod census shape', () => {
  // The 21 watch-eligible anchorless plantings, plus one already-anchored row so the denominator is
  // honest. Evidence transcribed from prod: 6 of the 21 carry a nursery event, none carry a sow or
  // transplant event.
  const nursery = (n) => Array.from({ length: n }, (_, i) => ({
    ...GARLIC, plant_id: `p-n${i}`, events: [{ event_type: 'potting_up', event_date: '2026-06-01' }],
  }));
  const bare = (n) => Array.from({ length: n }, (_, i) => ({ ...GARLIC, plant_id: `p-b${i}` }));
  const rows = [...nursery(6), ...bare(15), CHARENTAIS];

  it('counts each tier and states the baseline share out loud', () => {
    const s = summarizeDerivations(rows, { etToday: TODAY });
    expect(s.total).toBe(22);
    expect(s.already_anchored).toBe(1);
    expect(s.derivable).toBe(21);
    expect(s.by_source.sow_event).toBe(0);
    expect(s.by_source.transplant_event).toBe(0);
    expect(s.by_source.nursery_proxy_event).toBe(6);
    expect(s.by_source.add_date_baseline).toBe(15);
    expect(s.unrecoverable).toBe(0);
    // The headline finding: tier 3 dominates.
    expect(s.baseline_share).toBeGreaterThan(0.5);
  });

  it('counts a planting with no add-date and no events as unrecoverable, not as baseline', () => {
    const s = summarizeDerivations([{ ...GARLIC, add_date: null }], { etToday: TODAY });
    expect(s.unrecoverable).toBe(1);
    expect(s.derivable).toBe(0);
    expect(s.baseline_share).toBe(0);
  });
});

// ── Integration with the watch list ──────────────────────────────────────────────────────────────

describe('the derived tier in watch.js', () => {
  // A planting with no date of its own, carrying a persisted derived anchor. Shape matches what the
  // backfill writes into plants.derived_anchor_* (migrations/v4-anchorbase-001).
  const DERIVED_ROW = {
    plant_id: 'p-garlic', project_id: 'proj-alliums', planting_name: 'Garlic',
    crop_type_slug: 'garlic', harvest_habit: 'single', status: 'growing', prior_harvest_count: 0,
    dtm_basis: null, days_to_maturity_min: 40, days_to_maturity_max: null,
    sown_at: null, transplanted_at: null, planted_out_at: null,
    set_to_first_pick_days: null, fruit_set_date: null, sibling_first_pick_date: null,
    derived_anchor_date: '2026-05-28', derived_anchor_source: 'add_date_baseline',
    derived_anchor_confidence: 'baseline',
  };

  // V4-ANCHORFLIP-001 condition 9 (2026-08-14): the flag is now ON. This test used to pin it OFF
  // and assert the tier admitted nothing; inverting it is the point of the flip, not a weakening —
  // the OFF behaviour is still covered directly below by passing derivedEnabled:false explicitly,
  // which is the stronger form anyway (it tests the parameter rather than the module constant).
  it('is ON, so a derived anchor now admits a candidate', () => {
    expect(DERIVED_ANCHOR_ENABLED).toBe(true);
    const anchor = resolveWatchAnchor(DERIVED_ROW, { etToday: TODAY });
    expect(anchor).not.toBeNull();
    expect(anchor.kind).toBe('derived');
    expect(classifyWatchCandidate(DERIVED_ROW, TODAY).reason).not.toBe('no_anchor');
  });

  it('still admits NOTHING when the tier is disabled explicitly — the kill switch survives the flip', () => {
    expect(resolveWatchAnchor(DERIVED_ROW, { etToday: TODAY, derivedEnabled: false })).toBeNull();
  });

  // Ranking and copy are asserted directly on the anchor shape, so they hold the moment the flag is
  // flipped rather than only being verified after a prod change.
  it('ranks a derived anchor below a real one when both have fired', () => {
    const anchor = {
      kind: 'derived', anchor_date: '2026-05-28', derived_source: 'add_date_baseline',
      expected_days: 40, basis: 'derived-anchor', basis_field: 'derived_anchor_date',
    };
    const withSibling = resolveWatchAnchor({
      ...DERIVED_ROW, transplanted_at: '2026-06-11', sibling_first_pick_date: '2026-08-08',
    }, { etToday: TODAY });
    expect(withSibling.kind).toBe('sibling');
    expect(describeBasis(anchor, TODAY).startsWith('est.')).toBe(true);
  });

  it('marks the derived flag on the wire, not only in the copy', () => {
    const row = { ...DERIVED_ROW, transplanted_at: '2026-06-11' };
    const verdict = classifyWatchCandidate(row, TODAY);
    const projected = projectWatchRow(row, verdict, TODAY);
    expect(projected.anchor.derived).toBe(false);
    expect(projected.anchor.derived_source).toBeNull();
  });

  // MUTATION-DRIVEN. Swapping the derived and calendar ranks passed every other test in this file,
  // because availableAnchors refuses to build a derived anchor when a calendar one exists, so no row
  // can hold both and the ordering is unobservable through behaviour. It is asserted directly
  // because it becomes load-bearing the instant that coexistence guard is relaxed: a derived date
  // outranking a real one would make a row cite an anchor the system invented over one Dave entered.
  it('ranks derived strictly weakest among all anchor tiers', () => {
    expect(TIER_RANK.derived).toBeGreaterThan(TIER_RANK.calendar);
    expect(TIER_RANK.derived).toBeGreaterThan(TIER_RANK.sibling);
    expect(TIER_RANK.derived).toBeGreaterThan(TIER_RANK.observed);
    expect(Math.max(...Object.values(TIER_RANK))).toBe(TIER_RANK.derived);
  });

  // The flag-ON path, exercised behaviourally rather than left as untested dead code until the day
  // somebody flips it in prod.
  it('admits a derived anchor when the tier is enabled, and cites it as derived', () => {
    const v = classifyWatchCandidate(DERIVED_ROW, TODAY, { derivedEnabled: true });
    expect(v.eligible).toBe(true);
    expect(v.anchor.kind).toBe('derived');
    const projected = projectWatchRow(DERIVED_ROW, v, TODAY);
    expect(projected.anchor.derived).toBe(true);
    expect(projected.anchor.derived_source).toBe('add_date_baseline');
    expect(projected.basis.startsWith('est.')).toBe(true);
  });

  // Even enabled, a real anchor still wins the citation — the ranking, exercised end to end.
  it('cites the sibling, not the derived anchor, when both are available', () => {
    const row = {
      ...DERIVED_ROW, sibling_first_pick_date: '2026-08-10', sibling_planting_name: 'Music',
    };
    const v = classifyWatchCandidate(row, TODAY, { derivedEnabled: true });
    expect(v.anchor.kind).toBe('sibling');
    expect(v.anchor.alternates.some((a) => a.kind === 'derived')).toBe(true);
  });

  it('never lets a derived anchor coexist with a real calendar anchor', () => {
    // A planting with a real date must produce no derived anchor even if a stale derived_anchor_date
    // is still on the row.
    const row = { ...DERIVED_ROW, transplanted_at: '2026-06-11' };
    const anchor = resolveWatchAnchor(row, { etToday: TODAY });
    expect(anchor.kind).toBe('calendar');
    expect(anchor.alternates.every((a) => a.kind !== 'derived')).toBe(true);
  });
});

// ── The sibling anchor restriction (V4-ANCHORBASE-001) ───────────────────────────────────────────
//
// The sibling CTE matches on crop_type_slug, not cultivar. Verified read-only against live prod
// 2026-08-12: the Peppers project holds 56 live plantings across 49 DISTINCT varieties with DTM
// 57-100 (43-day spread); Tomatoes holds 44 across 41 varieties, DTM 52-85. So a "sibling" is
// usually a different variety with a materially different maturity, and the anchor's own
// "same genetics" justification does not hold for repeating crops.
describe('sibling anchor is restricted to single-habit crops', () => {
  const SIBLING_BASE = {
    plant_id: 'p-x', project_id: 'proj-peppers', planting_name: 'Black Olive',
    crop_type_slug: 'pepper', status: 'growing', prior_harvest_count: 0,
    dtm_basis: 'from-transplant', days_to_maturity_min: 70, days_to_maturity_max: null,
    sown_at: null, transplanted_at: null, planted_out_at: null,
    set_to_first_pick_days: null, fruit_set_date: null,
    sibling_first_pick_date: '2026-07-20', sibling_plant_id: 'p-sib',
    sibling_planting_name: 'Jalapeno',
  };

  it('admits the sibling anchor for a single-habit crop', () => {
    const a = resolveWatchAnchor({ ...SIBLING_BASE, harvest_habit: 'single' }, { etToday: TODAY });
    expect(a.kind).toBe('sibling');
    expect(a.check_from).toBe('2026-07-20');
  });

  // The measured consequence: a 56-plant pepper project stops contributing ~50 borrowed rows.
  it.each(['repeat', 'cut_and_come_again'])('refuses the sibling anchor for %s crops', (habit) => {
    const row = { ...SIBLING_BASE, harvest_habit: habit };
    expect(resolveWatchAnchor(row, { etToday: TODAY })).toBeNull();
    expect(classifyWatchCandidate(row, TODAY).reason).toBe('no_anchor');
    expect(SIBLING_ANCHOR_HABITS.has(habit)).toBe(false);
  });

  // Restricting the anchor must not evict a planting that stands on its own date — those rows stay,
  // they just stop borrowing. This is why the queue drops to ~41 rather than to 7.
  it('keeps a repeat-habit planting that has its own calendar anchor', () => {
    const row = { ...SIBLING_BASE, harvest_habit: 'repeat', transplanted_at: '2026-05-01' };
    const { candidates } = buildWatchList([row], TODAY);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('calendar');
    expect(candidates[0].basis).not.toContain('sibling');
  });

  it('names the borrowed sibling in the basis and stays inside the 40-char budget', () => {
    const { candidates } = buildWatchList([{ ...SIBLING_BASE, harvest_habit: 'single' }], TODAY);
    expect(candidates[0].basis).toBe('sibling Jalapeno picked Jul 20');
    expect(candidates[0].basis.length).toBeLessThanOrEqual(40);
  });

  it('truncates a long sibling name rather than blowing the row budget', () => {
    expect(siblingLabel('Chocolate Habanero Extra Long')).toHaveLength(18);
    expect(siblingLabel('Chocolate Habanero Extra Long').endsWith('…')).toBe(true);
    expect(siblingLabel('Sugar Baby')).toBe('Sugar Baby');
  });

  it('falls back to the unnamed form when the sibling has no name', () => {
    const anchor = { kind: 'sibling', anchor_date: '2026-07-20', source_planting_name: null };
    expect(describeBasis(anchor, TODAY, { sibling_planting_name: null })).toBe('sibling picked Jul 20');
  });

});

// ── V4-ANCHORFLIP-001 — the flip prerequisites (consult items 3-7) ────────────────────────────────
//
// project-state/anchor-consult-20260812.md refused the DERIVED_ANCHOR_ENABLED flip until these
// existed. Every test below drives the flag ON explicitly; the flag itself is still false and the
// pin above still asserts so. These are what make the flip a decision about horticulture rather
// than a decision about untested code.
describe('V4-ANCHORFLIP-001 derived-tier suppressions', () => {
  // Anchorless, watched, no contradicting status. dtm_min 40 -> lead = min(22, round(40*0.25)) = 10,
  // so check_from = anchor + 30.
  const BASE = {
    plant_id: 'p-flip', project_id: 'proj-flip', planting_name: 'Flip Fixture',
    crop_type_slug: 'garlic', harvest_habit: 'single', status: 'growing', prior_harvest_count: 0,
    dtm_basis: null, days_to_maturity_min: 40, days_to_maturity_max: null,
    sown_at: null, transplanted_at: null, planted_out_at: null,
    set_to_first_pick_days: null, fruit_set_date: null, sibling_first_pick_date: null,
    derived_anchor_date: '2026-05-28', derived_anchor_source: 'add_date_baseline',
    derived_anchor_confidence: 'baseline', derived_anchor_field: null,
  };
  const ON = { etToday: TODAY, derivedEnabled: true };

  it('the fixture itself is admitted, so every suppression below is the suppression talking', () => {
    const a = resolveWatchAnchor(BASE, ON);
    expect(a.kind).toBe('derived');
    expect(a.check_from).toBe('2026-06-27');
  });

  // ── Condition 3: the frost window (the horticulture seat's one non-negotiable) ──────────────────

  it('restates the frost anchor in lockstep with src/lib/sowEngine.js FROST_ANCHORS', () => {
    // The Lambda cannot import src/lib at runtime, so the constants are duplicated. A TEST can
    // import both, and this is the only thing standing between that duplication and a silent
    // divergence the day the frost date is retuned.
    expect(DERIVED_FIRST_FALL_FROST_MMDD).toBe(FROST_ANCHORS.firstFallFrost);
    expect(DERIVED_FROST_WINDOW_DAYS).toBe(FROST_ANCHORS.windowClosingDays);
  });

  it('resolves the frost anchor into the grow year the date sits in', () => {
    expect(firstFallFrostFor('2026-08-12')).toBe('2026-09-28');
    expect(firstFallFrostFor('2026-01-04')).toBe('2026-09-28');
    // Grow year runs Nov 1 - Oct 31, so from November the NEXT first fall frost is next year's.
    expect(firstFallFrostFor('2026-11-15')).toBe('2027-09-28');
    expect(firstFallFrostFor(null)).toBeNull();
  });

  it('suppresses a derived row whose watch would open inside the frost window', () => {
    // check_from = anchor + 30 = 2026-09-20, i.e. 8 days before first frost — inside +/-10d.
    const row = { ...BASE, derived_anchor_date: '2026-08-21' };
    expect(resolveWatchAnchor(row, ON)).toBeNull();
    expect(classifyWatchCandidate(row, TODAY, { derivedEnabled: true }).reason).toBe('no_anchor');
  });

  it('suppresses a derived row that would open AFTER first frost, not only near it', () => {
    // check_from = 2026-11-01. More wrong than a row opening 5 days early, not less — which is why
    // the cutoff is one-sided at (frost - 10) rather than a literal symmetric band.
    const row = { ...BASE, derived_anchor_date: '2026-10-02' };
    expect(resolveWatchAnchor(row, ON)).toBeNull();
  });

  it('admits a derived row that opens the day before the frost cutoff', () => {
    // cutoff = 2026-09-28 - 10 = 2026-09-18; anchor 2026-08-18 -> check_from 2026-09-17.
    expect(resolveWatchAnchor({ ...BASE, derived_anchor_date: '2026-08-18' }, ON).check_from)
      .toBe('2026-09-17');
    // ...and refuses it one day later, so the boundary is pinned from both sides.
    expect(resolveWatchAnchor({ ...BASE, derived_anchor_date: '2026-08-19' }, ON)).toBeNull();
  });

  it('never applies the frost window to a real anchor', () => {
    // Same late date, but Dave's own. A calendar row rests on his data and stays visible; only the
    // invented tier is suppressed.
    const row = { ...BASE, derived_anchor_date: null, transplanted_at: '2026-10-02' };
    expect(resolveWatchAnchor(row, ON).kind).toBe('calendar');
  });

  // ── Condition 4: the contradicting-status guard ─────────────────────────────────────────────────

  it.each(['flowering', 'fruiting'])('suppresses a derived row on a %s planting', (status) => {
    expect(resolveWatchAnchor({ ...BASE, status }, ON)).toBeNull();
    expect(DERIVED_STATUS_SUPPRESSED.has(status)).toBe(true);
  });

  it('leaves a real anchor alone on a fruiting planting', () => {
    // The guard says "a guess must not speak over a record", not "fruiting plants are uninteresting"
    // — a fruiting planting with its own date is exactly what the watch list is for.
    const row = { ...BASE, status: 'fruiting', derived_anchor_date: null, transplanted_at: '2026-06-11' };
    expect(resolveWatchAnchor(row, ON).kind).toBe('calendar');
  });

  it('admits a derived row on a status the derivation does not contradict', () => {
    expect(resolveWatchAnchor({ ...BASE, status: 'vegetative' }, ON).kind).toBe('derived');
    expect(resolveWatchAnchor({ ...BASE, status: null }, ON).kind).toBe('derived');
  });

  // ── Condition 5: cut_and_come_again leaves the derived tier ─────────────────────────────────────

  it('refuses a derived anchor for cut_and_come_again crops', () => {
    const row = { ...BASE, harvest_habit: 'cut_and_come_again' };
    expect(resolveWatchAnchor(row, ON)).toBeNull();
    expect(DERIVED_ANCHOR_HABITS.has('cut_and_come_again')).toBe(false);
    // Still a WATCHED habit — it just may not rest on an invented date.
    expect(WATCHED_HABITS.has('cut_and_come_again')).toBe(true);
  });

  it.each(['single', 'repeat'])('keeps the derived anchor for %s crops', (habit) => {
    expect(resolveWatchAnchor({ ...BASE, harvest_habit: habit }, ON).kind).toBe('derived');
  });

  it('keeps a cut_and_come_again planting that stands on its own date', () => {
    const row = {
      ...BASE, harvest_habit: 'cut_and_come_again', derived_anchor_date: null,
      transplanted_at: '2026-06-11',
    };
    const { candidates } = buildWatchList([row], TODAY, { derivedEnabled: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('calendar');
  });

  // ── Condition 6: the uncited-derived-date leak ──────────────────────────────────────────────────

  it('never lets an uncited derived anchor set watching_since', () => {
    // The consult's Cantaloupe shape: the derived anchor opens first (2026-06-27) but the row cites
    // the sibling pick (2026-08-10). Before the fix, watching_since slid to the invented date while
    // the basis still said "sibling picked Aug 10" — two numbers that cannot both be true, with
    // days_watching inflated from 2 to 46.
    const row = {
      ...BASE, sibling_first_pick_date: '2026-08-10', sibling_planting_name: 'Minnesota Mini',
    };
    const v = classifyWatchCandidate(row, TODAY, { derivedEnabled: true });
    expect(v.anchor.kind).toBe('sibling');
    expect(v.check_from).toBe('2026-08-10');
    expect(v.anchor.opened_by).toBe('sibling');
    expect(v.days_watching).toBe(2);

    const projected = projectWatchRow(row, v, TODAY);
    expect(projected.watching_since).toBe('2026-08-10');
    expect(projected.basis).toContain('sibling');
    // The derived anchor is not erased — it stays auditable as an alternate.
    expect(v.anchor.alternates.some((a) => a.kind === 'derived')).toBe(true);
  });

  it('still lets a derived anchor open the watch when it is also what the row cites', () => {
    // The rule is "the displayed date and the cited basis come from the same anchor", NOT "derived
    // anchors never open a watch" — the latter would delete the tier the flip is about.
    const v = classifyWatchCandidate(BASE, TODAY, { derivedEnabled: true });
    expect(v.anchor.kind).toBe('derived');
    expect(v.check_from).toBe('2026-06-27');
    expect(v.anchor.opened_by).toBe('derived');
  });

  it('leaves the earliest-anchor rule untouched between two REAL anchors', () => {
    // The two-question split (queue entry = earliest, citation = strongest fired) is load-bearing
    // for the real tiers and is deliberately NOT narrowed. A calendar anchor that opened in May
    // still sets watching_since even when an August sibling pick is what the row cites.
    const row = {
      ...BASE, derived_anchor_date: null, transplanted_at: '2026-05-01',
      sibling_first_pick_date: '2026-08-10', sibling_planting_name: 'Minnesota Mini',
    };
    const v = classifyWatchCandidate(row, TODAY);
    expect(v.anchor.kind).toBe('sibling');
    expect(v.anchor.opened_by).toBe('calendar');
    expect(v.check_from).toBe('2026-05-31');
  });

  // ── Condition 7: dtm_basis parity between the calendar and derived paths ────────────────────────

  it('applies the same dtm_basis correction through the derived path as the calendar path', () => {
    // ONE date, TWO paths. A from-sow DTM measured off a transplant date: the calendar path
    // subtracts the nursery offset and, before this fix, the derived path did not — so the same
    // date opened watches a month apart depending on which path carried it.
    const shared = { dtm_basis: 'from-sow', days_to_maturity_min: 85, days_to_maturity_max: null };
    const viaCalendar = resolveWatchAnchor(
      { ...BASE, ...shared, derived_anchor_date: null, transplanted_at: '2026-06-11' },
      { etToday: TODAY },
    );
    const viaDerived = resolveWatchAnchor(
      { ...BASE, ...shared, derived_anchor_date: '2026-06-11', derived_anchor_field: 'transplanted_at' },
      ON,
    );

    expect(viaCalendar.kind).toBe('calendar');
    expect(viaDerived.kind).toBe('derived');
    expect(viaDerived.check_from).toBe(viaCalendar.check_from);
    expect(viaDerived.anchor_date).toBe(viaCalendar.anchor_date);
    expect(viaDerived.nursery_offset_applied).toBe(viaCalendar.nursery_offset_applied);
    expect(viaDerived.basis_shifted).toBe(viaCalendar.basis_shifted);

    // Pinned as ABSOLUTES too, so a shared bug moving both paths together cannot pass this test:
    // 2026-06-11 - 31 (nursery offset) + 85 - 21 (lead) = 2026-07-14.
    expect(viaDerived.check_from).toBe('2026-07-14');
    expect(viaDerived.nursery_offset_applied).toBe(31);
    // And the UNcorrected answer — what the derived path used to produce — is a month LATER, which
    // is the direction that matters: uncorrected, the watch opens late and hides a ripening crop.
    expect(addDays('2026-06-11', 85 - 21)).toBe('2026-08-14');
  });

  it('honours the household nursery offset in the derived path, not just the constant', () => {
    const row = {
      ...BASE, dtm_basis: 'from-sow', days_to_maturity_min: 85,
      derived_anchor_date: '2026-06-11', derived_anchor_field: 'transplanted_at',
    };
    const a = resolveWatchAnchor(row, { ...ON, nurseryOffsetDays: 10 });
    // 2026-06-11 - 10 + 64 = 2026-08-04, i.e. 21 days later than the 31-day fallback produces.
    expect(a.nursery_offset_applied).toBe(10);
    expect(a.check_from).toBe('2026-08-04');
  });

  it('applies no correction when the derivation does not say which column it stands for', () => {
    // anchor_field is NOT NULL in plant_anchor_derivation, so this is the defensive branch: an
    // unlabelled date cannot be re-based without inventing which end of the nursery gap it sits on.
    const row = {
      ...BASE, dtm_basis: 'from-sow', days_to_maturity_min: 85,
      derived_anchor_date: '2026-06-11', derived_anchor_field: null,
    };
    const a = resolveWatchAnchor(row, ON);
    expect(a.nursery_offset_applied).toBe(0);
    expect(a.basis_shifted).toBe(false);
  });

  it('carries the correction on the wire, where the 40-char basis string has no room for it', () => {
    const row = {
      ...BASE, dtm_basis: 'from-sow', days_to_maturity_min: 85,
      derived_anchor_date: '2026-06-11', derived_anchor_field: 'transplanted_at',
    };
    const v = classifyWatchCandidate(row, TODAY, { derivedEnabled: true });
    const projected = projectWatchRow(row, v, TODAY);
    expect(projected.anchor.derived).toBe(true);
    expect(projected.anchor.derived_anchor_field).toBe('transplanted_at');
    expect(projected.anchor.basis_shifted).toBe(true);
    expect(projected.anchor.nursery_offset_applied).toBe(31);
    // observed_date is the RAW derivation, before the correction — both halves stay auditable.
    expect(projected.anchor.observed_date).toBe('2026-06-11');
    expect(projected.anchor.date).toBe('2026-05-11');
  });

  // ── The whole point: with the flag OFF none of this changes anything ────────────────────────────

  // V4-ANCHORFLIP-001 condition 9 (2026-08-14): the module flag is now ON, so this passes
  // derivedEnabled:false EXPLICITLY rather than leaning on the default. That is the stronger
  // assertion — it pins the kill switch itself, which is the thing that has to keep working after
  // the flip, whereas the old form only re-asserted the constant.
  it('is a strict no-op when the tier is disabled', () => {
    const rows = [
      BASE,
      { ...BASE, plant_id: 'p-2', harvest_habit: 'cut_and_come_again' },
      { ...BASE, plant_id: 'p-3', status: 'fruiting' },
      { ...BASE, plant_id: 'p-4', derived_anchor_date: '2026-10-02' },
      { ...BASE, plant_id: 'p-5', sibling_first_pick_date: '2026-08-10' },
    ];
    const { candidates, excluded } = buildWatchList(rows, TODAY, { derivedEnabled: false });
    // Only the sibling row survives, exactly as it did before this item — every other row is
    // anchorless the moment the derived tier is off.
    expect(candidates.map((c) => c.plant_id)).toEqual(['p-5']);
    expect(candidates[0].confidence).toBe('sibling');
    expect(candidates[0].watching_since).toBe('2026-08-10');
    expect(excluded.no_anchor).toBe(4);
  });
});
