// Unit tests for the PURE watch-list candidate logic (lambda/harvests/watch.js).
//
// THESE TESTS EXECUTE BEHAVIOUR. They call the functions and assert on returned values. They do NOT
// readFileSync this module and regex its source — the pattern lambda/events/harvest-ready.test.js
// uses, which lets a behaviour-BREAKING change ship green while failing on a behaviour-preserving
// refactor. Every fixture below is a real live-prod row shape, transcribed from a read-only query
// against prod Neon on 2026-08-12 (household = Dave; Jen has zero live plantings, so these are
// Dave's plantings, not a household sample).
import { describe, it, expect } from 'vitest';
import {
  WATCH_MODEL_VERSION, WATCH_LEAD_DAYS, WATCH_LEAD_MAX_FRACTION, NURSERY_OFFSET_DAYS_FALLBACK,
  WATCHED_HABITS, toYmd, addDays, daysBetween, leadDaysFor, expectedDaysFor, calendarAnchor,
  resolveWatchAnchor, classifyWatchCandidate, projectWatchRow, rankWatchCandidates, buildWatchList,
  buildDismissalSnapshot,
} from './watch.js';

// The ET day every assertion below is evaluated on. Passed in explicitly — this module never calls
// `new Date()`, so the suite cannot flake across a midnight boundary.
const TODAY = '2026-08-12';

// ── Live-prod fixtures ───────────────────────────────────────────────────────────────────────────
// Verified 2026-08-12 via scripts/psql-ro.sh. Each is one of the plantings the shipped harvest
// surface structurally cannot show.

// Charentais melon: dtm_basis='from-sow' but sown_at IS NULL — only a transplant date exists. Sits
// in project ef1e5ca1 alongside Minnesota Mini, which first picked 2026-08-08. 0 prior picks.
const CHARENTAIS = {
  plant_id: 'p-charentais', project_id: 'proj-melon', planting_name: 'Charentais',
  crop_type_slug: 'melon', crop_display_name: 'Melon', variety_id: 'v-charentais',
  harvest_habit: 'single', status: 'fruiting', prior_harvest_count: 0,
  dtm_basis: 'from-sow', days_to_maturity_min: 75, days_to_maturity_max: null,
  sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
  set_to_first_pick_days: 42, fruit_set_date: null,
  sibling_first_pick_date: '2026-08-08', sibling_plant_id: 'p-minnesota', sibling_planting_name: 'Minnesota Mini',
};

// Green Flesh melon: same basis shift, but ALONE in its project (412cd8a1) — no sibling anchor. This
// is the row that only the measured nursery offset can surface.
const GREEN_FLESH = {
  plant_id: 'p-greenflesh', project_id: 'proj-greenflesh', planting_name: 'Green Flesh',
  crop_type_slug: 'melon', crop_display_name: 'Melon', variety_id: 'v-greenflesh',
  harvest_habit: 'single', status: 'fruiting', prior_harvest_count: 0,
  dtm_basis: 'from-sow', days_to_maturity_min: 85, days_to_maturity_max: null,
  sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
  set_to_first_pick_days: 42, fruit_set_date: null,
  sibling_first_pick_date: null, sibling_plant_id: null, sibling_planting_name: null,
};

// Tender Sweet Orange watermelon: project 88513b10, siblings Crimson Sweet + Sugar Baby both first
// picked 2026-08-10.
const TENDER_SWEET = {
  plant_id: 'p-tendersweet', project_id: 'proj-watermelon', planting_name: 'Tender Sweet Orange',
  crop_type_slug: 'watermelon', crop_display_name: 'Watermelon', variety_id: 'v-tendersweet',
  harvest_habit: 'single', status: 'fruiting', prior_harvest_count: 0,
  dtm_basis: 'from-sow', days_to_maturity_min: 85, days_to_maturity_max: null,
  sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
  set_to_first_pick_days: 45, fruit_set_date: null,
  sibling_first_pick_date: '2026-08-10', sibling_plant_id: 'p-sugarbaby', sibling_planting_name: 'Sugar Baby',
};

// Yukon Gold potato: a clean from-sow row with its own sown_at. No basis shift, no sibling.
const YUKON_GOLD = {
  plant_id: 'p-yukon', project_id: 'proj-potato', planting_name: 'Yukon Gold',
  crop_type_slug: 'potato', crop_display_name: 'Potato', variety_id: 'v-yukon',
  harvest_habit: 'single', status: 'fruiting', prior_harvest_count: 0,
  dtm_basis: 'from-sow', days_to_maturity_min: 65, days_to_maturity_max: null,
  sown_at: '2026-05-30', transplanted_at: null, planted_out_at: null,
  set_to_first_pick_days: null, fruit_set_date: null,
  sibling_first_pick_date: null, sibling_plant_id: null, sibling_planting_name: null,
};

// Cabbage: from-transplant with its transplant date present — the basis-matched happy path.
const CABBAGE = {
  plant_id: 'p-cabbage', project_id: 'proj-brassica', planting_name: 'Cabbage',
  crop_type_slug: 'cabbage', crop_display_name: 'Cabbage', variety_id: 'v-cabbage',
  harvest_habit: 'single', status: 'fruiting', prior_harvest_count: 0,
  dtm_basis: 'from-transplant', days_to_maturity_min: 60, days_to_maturity_max: null,
  sown_at: '2026-06-10', transplanted_at: '2026-06-24', planted_out_at: null,
  set_to_first_pick_days: null, fruit_set_date: null,
  sibling_first_pick_date: null, sibling_plant_id: null, sibling_planting_name: null,
};

// A geranium: harvest_habit IS NULL. On live prod all 51 NULL-habit live plantings are ornamentals.
const GERANIUM = {
  plant_id: 'p-geranium', project_id: 'proj-porch', planting_name: 'Geranium',
  crop_type_slug: 'geranium', harvest_habit: null, status: 'vegetative', prior_harvest_count: 0,
  dtm_basis: null, days_to_maturity_min: null, days_to_maturity_max: null,
  sown_at: null, transplanted_at: '2026-05-01', planted_out_at: null,
  set_to_first_pick_days: null, fruit_set_date: null, sibling_first_pick_date: null,
};

// ── PART A — the categorical gate fix ────────────────────────────────────────────────────────────

describe('PART A: the gate the shipped surface can never pass', () => {
  // MUTATION TARGET: delete 'single' from WATCHED_HABITS in watch.js -> this test goes red. That set
  // membership is the entire fix for gate (b) (src/lib/harvestReadiness.js REPEATING_HABITS).
  it("admits harvest_habit='single' — the habit isReadyToPick() rejects outright", () => {
    expect(WATCHED_HABITS.has('single')).toBe(true);
    for (const row of [CHARENTAIS, GREEN_FLESH, TENDER_SWEET, YUKON_GOLD, CABBAGE]) {
      const v = classifyWatchCandidate(row, TODAY);
      expect(v.reason).not.toBe('habit_not_watched');
      expect(v.eligible, `${row.planting_name} must be admitted`).toBe(true);
    }
  });

  // MUTATION TARGET: re-add a `prior_harvest_count < 1 -> ineligible` requirement (gate (a), the
  // INNER JOIN to last_pick in lambda/events/index.js) -> this test goes red.
  it('requires NO prior harvest — a zero-pick planting is still a candidate', () => {
    for (const row of [CHARENTAIS, GREEN_FLESH, TENDER_SWEET, YUKON_GOLD, CABBAGE]) {
      expect(row.prior_harvest_count).toBe(0);
      expect(classifyWatchCandidate(row, TODAY).eligible).toBe(true);
    }
  });

  it('all five named live-prod plantings become candidates on the measured date', () => {
    const { candidates } = buildWatchList([CHARENTAIS, GREEN_FLESH, TENDER_SWEET, YUKON_GOLD, CABBAGE], TODAY);
    expect(candidates.map((c) => c.planting_name).sort()).toEqual(
      ['Cabbage', 'Charentais', 'Green Flesh', 'Tender Sweet Orange', 'Yukon Gold'],
    );
  });

  // The NULL-habit cohort is NOT part of the blind spot and must stay out. 51 live NULL-habit
  // plantings on prod, every one an ornamental.
  it('still excludes NULL-habit ornamentals', () => {
    const v = classifyWatchCandidate(GERANIUM, TODAY);
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('habit_not_watched');
  });

  // Queue exit 1 (design §3.5). A planting graduates out once a first harvest is recorded.
  it('drops out of the queue once a harvest is logged', () => {
    const picked = { ...CHARENTAIS, prior_harvest_count: 1 };
    const v = classifyWatchCandidate(picked, TODAY);
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('already_harvested');
  });
});

// ── PART B — anchors ─────────────────────────────────────────────────────────────────────────────

describe('anchor hierarchy (design §3.4)', () => {
  it('tier 2 sibling beats tier 3 calendar, and takes NO lead — check_from IS the sibling pick date', () => {
    const a = resolveWatchAnchor(CHARENTAIS);
    expect(a.kind).toBe('sibling');
    expect(a.lead_days).toBe(0);
    expect(a.check_from).toBe('2026-08-08');
    expect(a.source_plant_id).toBe('p-minnesota');
  });

  it('tier 1 observed fruit_set beats a sibling', () => {
    const a = resolveWatchAnchor({ ...CHARENTAIS, fruit_set_date: '2026-07-01' });
    expect(a.kind).toBe('observed');
    expect(a.expected_days).toBe(42);
    // lead = min(22, round(42 * 0.25) = 11) = 11 -> 2026-07-01 + (42 - 11) = +31d
    expect(a.lead_days).toBe(11);
    expect(a.check_from).toBe('2026-08-01');
  });

  it('a fruit_set with no set_to_first_pick_days does NOT become a tier-1 anchor', () => {
    // Only melon (42) and watermelon (45) carry the column on live prod; every other crop is NULL,
    // and a fruit_set date with no interval predicts nothing.
    const a = resolveWatchAnchor({ ...YUKON_GOLD, fruit_set_date: '2026-07-01', set_to_first_pick_days: null });
    expect(a.kind).toBe('calendar');
  });

  it('tier 3 calendar carries its basis on the wire so the row can state it', () => {
    const a = resolveWatchAnchor(YUKON_GOLD);
    expect(a).toMatchObject({ kind: 'calendar', basis: 'from-sow', basis_field: 'sown_at', basis_shifted: false });
    // lead = min(22, round(65 * 0.25) = 16) = 16 -> 2026-05-30 + (65 - 16) = +49d
    expect(a.lead_days).toBe(16);
    expect(a.check_from).toBe('2026-07-18');
  });

  it('no anchor at all -> not shown, rather than shown with a shrug', () => {
    const orphan = { ...YUKON_GOLD, sown_at: null, transplanted_at: null, planted_out_at: null };
    const v = classifyWatchCandidate(orphan, TODAY);
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('no_anchor');
  });

  it('a planting whose watch has not opened yet is held, not shown', () => {
    const early = { ...YUKON_GOLD, sown_at: '2026-08-01' };
    const v = classifyWatchCandidate(early, TODAY);
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('not_yet_open');
    expect(v.check_from).toBe('2026-09-19');
  });
});

describe('basis shift — the defect that hides a fruiting melon', () => {
  // MUTATION TARGET: set the from-sow nursery offset to 0 in calendarAnchor() -> Green Flesh's
  // check_from moves to 2026-08-14, two days in the FUTURE, and the row vanishes on 2026-08-12.
  it('from-sow basis measured off a transplant date is corrected by the measured nursery offset', () => {
    const a = resolveWatchAnchor(GREEN_FLESH);
    expect(a.basis_shifted).toBe(true);
    expect(a.basis_field).toBe('transplanted_at');
    expect(a.nursery_offset_applied).toBe(NURSERY_OFFSET_DAYS_FALLBACK); // 31, median of Dave's 39 dual-dated plantings
    // 2026-06-11 - 31d = 2026-05-11; lead = min(22, round(85 * .25) = 21) = 21; +(85 - 21) = +64d
    expect(a.anchor_date).toBe('2026-05-11');
    expect(a.check_from).toBe('2026-07-14');
    expect(classifyWatchCandidate(GREEN_FLESH, TODAY).eligible).toBe(true);
  });

  it('WITHOUT the offset the same planting is invisible — this is the whole bug', () => {
    const a = resolveWatchAnchor(GREEN_FLESH, { nurseryOffsetDays: 0 });
    expect(a.check_from).toBe('2026-08-14');
    const v = classifyWatchCandidate(GREEN_FLESH, TODAY, { nurseryOffsetDays: 0 });
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('not_yet_open');
  });

  it('the opposite shift (from-transplant read off sown_at) is deliberately NOT corrected', () => {
    // Sowing precedes transplant, so elapsed time is OVERSTATED and the watch opens EARLY. Early is
    // the safe error for a "go look" surface; inventing a second offset would be false precision.
    const a = calendarAnchor({ dtm_basis: 'from-transplant', sown_at: '2026-06-10', transplanted_at: null }, 31);
    expect(a.basis_shifted).toBe(true);
    expect(a.nursery_offset_applied).toBe(0);
    expect(a.date).toBe('2026-06-10');
  });

  it('honours a per-household offset passed in by the route', () => {
    const a = resolveWatchAnchor(GREEN_FLESH, { nurseryOffsetDays: 10 });
    expect(a.anchor_date).toBe('2026-06-01');
  });
});

describe('lead days', () => {
  it('is the MEASURED 22-day calibration error, capped at a quarter of the interval', () => {
    expect(WATCH_LEAD_DAYS).toBe(22);
    expect(WATCH_LEAD_MAX_FRACTION).toBe(0.25);
    expect(leadDaysFor(200)).toBe(22);   // flat cap binds
    expect(leadDaysFor(88)).toBe(22);    // exactly at the crossover
    expect(leadDaysFor(42)).toBe(11);    // fraction binds
    expect(leadDaysFor(0)).toBe(0);
    expect(leadDaysFor(null)).toBe(0);
  });

  it('never opens a watch before a quarter of the crop interval has been shaved', () => {
    for (const d of [10, 30, 60, 90, 240]) expect(leadDaysFor(d)).toBeLessThanOrEqual(d * WATCH_LEAD_MAX_FRACTION + 0.5);
  });
});

describe('expectedDaysFor', () => {
  it('prefers days_to_maturity_min — the earliest defensible figure', () => {
    expect(expectedDaysFor({ days_to_maturity_min: 60, days_to_maturity_max: 80 })).toBe(60);
  });
  it('falls back to max, then null', () => {
    expect(expectedDaysFor({ days_to_maturity_min: null, days_to_maturity_max: 80 })).toBe(80);
    expect(expectedDaysFor({})).toBeNull();
    expect(expectedDaysFor({ days_to_maturity_min: 0 })).toBeNull();
  });
});

describe('ranking and payload', () => {
  it('ranks newest watch first (design §3.5)', () => {
    const { candidates } = buildWatchList([YUKON_GOLD, GREEN_FLESH, TENDER_SWEET, CABBAGE, CHARENTAIS], TODAY);
    expect(candidates.map((c) => c.days_watching)).toEqual([2, 4, 4, 25, 29]);
    expect(candidates[0].planting_name).toBe('Tender Sweet Orange');
    expect(candidates[candidates.length - 1].planting_name).toBe('Green Flesh');
  });

  it('ties break on plant_id so identical requests return identical order', () => {
    const a = buildWatchList([CHARENTAIS, CABBAGE], TODAY).candidates.map((c) => c.plant_id);
    const b = buildWatchList([CABBAGE, CHARENTAIS], TODAY).candidates.map((c) => c.plant_id);
    expect(a).toEqual(b);
  });

  it('a sibling row names the sibling it rests on', () => {
    const [row] = buildWatchList([TENDER_SWEET], TODAY).candidates;
    expect(row.confidence).toBe('sibling');
    expect(row.anchor.source_planting_name).toBe('Sugar Baby');
    expect(row.check_from).toBe('2026-08-10');
    expect(row.days_watching).toBe(2);
  });

  it('reports WHY each excluded planting is absent instead of one silent empty list', () => {
    const { candidates, excluded } = buildWatchList(
      [GERANIUM, { ...CHARENTAIS, prior_harvest_count: 3 }, { ...YUKON_GOLD, dismissed_active: true }, CABBAGE],
      TODAY,
    );
    expect(candidates).toHaveLength(1);
    expect(excluded).toEqual({ habit_not_watched: 1, already_harvested: 1, dismissed: 1 });
  });

  it('never emits verdict grammar — no ready/overdue field on the wire', () => {
    const [row] = buildWatchList([CABBAGE], TODAY).candidates;
    const keys = JSON.stringify(row);
    expect(keys).not.toMatch(/ready|overdue|window_open/i);
    expect(row).toHaveProperty('check_from');
    expect(row).toHaveProperty('days_watching');
  });

  it('empty / null input is an empty list, never a throw', () => {
    expect(buildWatchList(null, TODAY)).toEqual({ candidates: [], excluded: {} });
    expect(buildWatchList([], TODAY)).toEqual({ candidates: [], excluded: {} });
  });
});

describe('date math is pure and UTC-anchored', () => {
  it('toYmd accepts Date, ISO string and YYYY-MM-DD; rejects junk', () => {
    expect(toYmd(new Date('2026-08-12T23:59:00.000Z'))).toBe('2026-08-12');
    expect(toYmd('2026-08-12T04:00:00.000Z')).toBe('2026-08-12');
    expect(toYmd('2026-08-12')).toBe('2026-08-12');
    expect(toYmd('nonsense')).toBeNull();
    expect(toYmd(null)).toBeNull();
  });
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('daysBetween is signed and symmetric', () => {
    expect(daysBetween('2026-08-01', '2026-08-12')).toBe(11);
    expect(daysBetween('2026-08-12', '2026-08-01')).toBe(-11);
    expect(daysBetween(null, '2026-08-01')).toBeNull();
  });
});

// ── The dismissal snapshot — the first negative-class sample the dataset has ever held ───────────

describe('dismissal snapshot (calibration sample)', () => {
  it('freezes the model claim as it stood at the observation, not as it stands later', () => {
    const [candidate] = buildWatchList([GREEN_FLESH], TODAY).candidates;
    const snap = buildDismissalSnapshot(candidate, TODAY);
    expect(snap).toMatchObject({
      plant_id: 'p-greenflesh',
      observed_on: '2026-08-12',
      model_version: WATCH_MODEL_VERSION,
      crop_type_slug: 'melon',
      anchor_kind: 'calendar',
      anchor_date: '2026-05-11',
      anchor_basis: 'from-sow',
      anchor_basis_shifted: true,
      expected_days: 85,
      lead_days: 21,
      check_from: '2026-07-14',
      days_watching: 29,
    });
  });

  it('carries every field needed to pair with a later first-harvest date as a supervised sample', () => {
    const [candidate] = buildWatchList([TENDER_SWEET], TODAY).candidates;
    const snap = buildDismissalSnapshot(candidate, TODAY);
    // features (frozen here) + the label supplied later by event_log's first harvest date.
    for (const k of ['plant_id', 'observed_on', 'model_version', 'anchor_kind', 'anchor_date',
      'expected_days', 'check_from', 'days_watching']) {
      expect(snap[k], `snapshot must carry ${k}`).not.toBeUndefined();
    }
    expect(snap.anchor_kind).toBe('sibling');
    expect(snap.observed_on).toBe(TODAY);
  });

  it('supports a backdated observation, following the event_date convention', () => {
    const [candidate] = buildWatchList([CABBAGE], TODAY).candidates;
    const snap = buildDismissalSnapshot(candidate, '2026-08-10');
    expect(snap.observed_on).toBe('2026-08-10');
  });

  it('null candidate -> null, never a throw', () => {
    expect(buildDismissalSnapshot(null, TODAY)).toBeNull();
  });
});
