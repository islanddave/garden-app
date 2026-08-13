// Unit tests for the watch/dismissal REQUEST CONTRACT (lambda/harvests/watch-route.js).
//
// These EXECUTE the handlers against a recording tagged-template `sql` stub. They assert on status
// codes, response bodies and the actual parameters bound into each statement. They do NOT
// readFileSync the module and regex its source: that pattern (lambda/events/harvest-ready.test.js)
// passes a behaviour-breaking change and fails a behaviour-preserving refactor, which is exactly
// backwards.
//
// WHAT THIS FILE CANNOT COVER: Postgres semantics — the CTE joins, the partial unique index, the
// grow-year boundary. A tagged-template stub proves the code calls SQL with the right values, never
// that the SQL means what it should. That half was verified by running the real query READ-ONLY
// against live prod Neon on 2026-08-12 (247 live plantings scanned, sibling/nursery CTEs resolving
// correctly). Real-Postgres coverage belongs in tests/integration/ once the migration is applied —
// see the report; it is NOT written yet because the relation does not exist in any environment.
import { describe, it, expect } from 'vitest';
import {
  WATCH_PATH, DISMISS_PATH, DISMISSALS_PATH, matchWatchRoute, isUuid, parseLimit,
  DEFAULT_LIMIT, MAX_LIMIT, DISMISSAL_REASONS, CALIBRATION_REASON,
  resolveNurseryOffset, NURSERY_MIN_SAMPLE,
  handleWatchGet, handleDismissToggle, handleDismissalPost, handleDismissalUndo,
} from './watch-route.js';
import {
  WATCH_MODEL_VERSION, WATCH_SUPPRESS_DAYS, NURSERY_OFFSET_DAYS_FALLBACK, UI_CONTRACT_FIELDS, addDays,
} from './watch.js';

const USER = 'user_dave';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const TZ = 'America/New_York';
const TODAY = '2026-08-12';
const PLANT = '11111111-2222-4333-8444-555555555555';

// One live-prod-shaped candidate row, as queryWatchRows returns it (Tender Sweet Orange).
function row(over = {}) {
  return {
    plant_id: PLANT, project_id: '99999999-2222-4333-8444-555555555555',
    planting_name: 'Tender Sweet Orange', status: 'fruiting', location_id: null,
    location_name: 'Hilltop Bed 2',
    sown_at: null, transplanted_at: '2026-06-11', planted_out_at: null,
    variety_id: '77777777-2222-4333-8444-555555555555', variety_name: 'Tender Sweet Orange',
    crop_type_slug: 'watermelon', days_to_maturity_min: 85, days_to_maturity_max: null,
    crop_display_name: 'Watermelon', harvest_habit: 'single', dtm_basis: 'from-sow',
    set_to_first_pick_days: 45, prior_harvest_count: 0, fruit_set_date: null,
    sibling_plant_id: 'sib-1', sibling_planting_name: 'Sugar Baby', sibling_first_pick_date: '2026-08-10',
    dismissed_active: false, et_today: TODAY, season_start: '2025-11-01',
    nursery_sample_n: 39, nursery_median_gap: 31,
    ...over,
  };
}

// Recording tagged-template stub. Records the assembled statement text and every bound parameter,
// and replies with a queued result per call so a handler making two statements can be driven.
function makeSql(results) {
  const calls = [];
  const queue = [...results];
  const sql = (strings, ...params) => {
    const text = strings.join('?');
    calls.push({ text, params });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  sql.calls = calls;
  return sql;
}

const ctx = (sql, over = {}) => ({ sql, householdIds: HOUSEHOLD, userId: USER, tz: TZ, ...over });

describe('route matching', () => {
  it('maps each verb+path to its handler kind', () => {
    expect(matchWatchRoute('GET', WATCH_PATH)).toEqual({ kind: 'watch_get' });
    expect(matchWatchRoute('POST', DISMISS_PATH)).toEqual({ kind: 'dismiss_toggle' });
    expect(matchWatchRoute('POST', DISMISSALS_PATH)).toEqual({ kind: 'dismissal_post' });
    expect(matchWatchRoute('DELETE', `${DISMISSALS_PATH}/abc`)).toEqual({ kind: 'dismissal_undo', id: 'abc' });
  });

  // DISMISS_PATH is a prefix of nothing but shares its stem with DISMISSALS_PATH; order is
  // load-bearing exactly as it is in api.js's first-match prefix table.
  it('does not let /dismiss and /dismissals shadow each other', () => {
    expect(matchWatchRoute('POST', DISMISS_PATH).kind).toBe('dismiss_toggle');
    expect(matchWatchRoute('POST', DISMISSALS_PATH).kind).toBe('dismissal_post');
  });

  it('a watch path with the wrong verb is 405, not a silent fall-through', () => {
    expect(matchWatchRoute('DELETE', WATCH_PATH)).toEqual({ kind: 'method_not_allowed' });
    expect(matchWatchRoute('GET', DISMISS_PATH)).toEqual({ kind: 'method_not_allowed' });
  });

  // Returning null is what lets index.js fall through to the untouched /api/harvests read model.
  it('non-watch paths return null so the existing read model is unaffected', () => {
    expect(matchWatchRoute('GET', '/api/harvests')).toBeNull();
    expect(matchWatchRoute('GET', '/api/harvests/anything-else')).toBeNull();
  });
});

describe('input validation', () => {
  it('parseLimit defaults to the design cap of 5 and clamps at MAX_LIMIT', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBe(5);
    expect(parseLimit('3')).toBe(3);
    expect(parseLimit('999')).toBe(MAX_LIMIT);
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('-1')).toBeNull();
    expect(parseLimit('abc')).toBeNull();
  });

  it('isUuid rejects malformed ids so a bad id and a foreign id answer alike', () => {
    expect(isUuid(PLANT)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it('only not_yet is the calibration-bearing reason', () => {
    expect(CALIBRATION_REASON).toBe('not_yet');
    expect([...DISMISSAL_REASONS].sort()).toEqual(['not_mine', 'not_yet', 'wrong_target']);
  });
});

describe('nursery offset provenance', () => {
  it("uses the household's own median once the sample is deep enough", () => {
    expect(resolveNurseryOffset([{ nursery_sample_n: 39, nursery_median_gap: 31 }]))
      .toEqual({ days: 31, source: 'household_median', sample_n: 39 });
  });

  // A thin sample must not let one atypical pair set the offset for every crop in the garden.
  it('falls back to the documented constant on a thin sample', () => {
    const r = resolveNurseryOffset([{ nursery_sample_n: NURSERY_MIN_SAMPLE - 1, nursery_median_gap: 3 }]);
    expect(r).toEqual({ days: NURSERY_OFFSET_DAYS_FALLBACK, source: 'fallback_constant', sample_n: 4 });
  });

  it('falls back on an empty result set without throwing', () => {
    expect(resolveNurseryOffset([]).source).toBe('fallback_constant');
    expect(resolveNurseryOffset(undefined).source).toBe('fallback_constant');
  });
});

describe('GET /api/harvests/watch', () => {
  it('returns the candidate, its provenance and the offset that shaped it', async () => {
    const sql = makeSql([[row()]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.statusCode).toBe(200);
    expect(res.body.et_today).toBe(TODAY);
    expect(res.body.model_version).toBe(WATCH_MODEL_VERSION);
    expect(res.body.nursery_offset).toEqual({ days: 31, source: 'household_median', sample_n: 39 });
    expect(res.body.total_watching).toBe(1);
    expect(res.body.candidates).toHaveLength(1);
  });

  // CROSS-LANE CONTRACT. MUTATION TARGET: rename any of these on the wire -> red here rather than
  // as a blank row in the client after integration.
  it('emits exactly the field names the UI lane committed against', async () => {
    const sql = makeSql([[row()]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    const c = res.body.candidates[0];
    for (const f of UI_CONTRACT_FIELDS) expect(c, `UI contract field ${f}`).toHaveProperty(f);
    expect(c.name).toBe('Tender Sweet Orange');
    expect(c.location_name).toBe('Hilltop Bed 2');
    expect(c.variety_ref).toEqual({ name: 'Tender Sweet Orange', crop_type_slug: 'watermelon' });
    expect(c.watching_since).toBe('2026-07-14');
  });

  // The canon rule that a derivation must be LABELLED still binds, but the row is compact.
  it('basis is a SHORT provenance string, and cites the completed pick when one exists', async () => {
    const sql = makeSql([[row()]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    // Names the sibling (V4-ANCHORBASE-001) and still fits the design's ~40-char basis budget.
    expect(res.body.candidates[0].basis).toBe('sibling Sugar Baby picked Aug 10');
    expect(res.body.candidates[0].basis.length).toBeLessThanOrEqual(40);
    expect(res.body.candidates[0].basis.length).toBeLessThanOrEqual(32);
  });

  it('a calendar row states its age and catalogue figure, and flags an inferred sow date', async () => {
    const sql = makeSql([[row({ sibling_first_pick_date: null, sibling_plant_id: null })]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    // from-sow DTM measured off a transplant date -> the sow date was reconstructed, and the row
    // must say so rather than launder an estimate into a record.
    expect(res.body.candidates[0].basis).toBe('sown 93d · catalogue 85d (est. sow)');
    expect(res.body.candidates[0].basis.length).toBeLessThanOrEqual(40);
  });

  it('caps the visible group at 5 by default but reports the TRUE queue depth', async () => {
    const many = Array.from({ length: 9 }, (_, i) => row({
      plant_id: `${i}1111111-2222-4333-8444-555555555555`, planting_name: `P${i}`,
    }));
    const sql = makeSql([many]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toHaveLength(5);
    // The shipped band's "Showing 3 of 28 ready" is arithmetically false because it counted a
    // different population than it showed. This denominator counts the same one.
    expect(res.body.total_watching).toBe(9);
  });

  it('explains an EMPTY list instead of returning an unreadable silence', async () => {
    const sql = makeSql([[row({ harvest_habit: null }), row({ prior_harvest_count: 4 })]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toEqual([]);
    expect(res.body.excluded).toEqual({ habit_not_watched: 1, already_harvested: 1 });
  });

  it('an active dismissal removes the row from the queue', async () => {
    const sql = makeSql([[row({ dismissed_active: true })]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toEqual([]);
    expect(res.body.excluded).toEqual({ dismissed: 1 });
  });

  // PANEL Q3/Q4: the GET payload carries the suppressed rows themselves, each with its return date,
  // so the tail's "Snoozed" subgroup can print "back {date}" without a second endpoint.
  it('returns snoozed rows with their return dates in the GET payload', async () => {
    const sql = makeSql([[
      row(),
      row({
        plant_id: '22222222-2222-4333-8444-555555555555', planting_name: 'Charentais',
        dismissed_active: true, dismissal_suppressed_until: '2026-08-20',
      }),
    ]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.snoozed).toEqual([{
      plant_id: '22222222-2222-4333-8444-555555555555',
      project_id: '99999999-2222-4333-8444-555555555555',
      name: 'Charentais',
      location_name: 'Hilltop Bed 2',
      crop_display_name: 'Watermelon',
      suppressed_until: '2026-08-20',
      reason: 'dismissed',
    }]);
  });

  // Snoozing more plantings must never HIDE them: the snoozed list is not subject to `limit`.
  it('snoozed rows are not subject to the visible limit', async () => {
    const many = Array.from({ length: 8 }, (_, i) => row({
      plant_id: `${i}1111111-2222-4333-8444-555555555555`, planting_name: `S${i}`,
      dismissed_active: true, dismissal_suppressed_until: '2026-08-20',
    }));
    const sql = makeSql([many]);
    const res = await handleWatchGet(ctx(sql, { query: { limit: '5' } }));
    expect(res.body.snoozed).toHaveLength(8);
  });

  it('rejects a bad limit rather than silently substituting one', async () => {
    const res = await handleWatchGet(ctx(makeSql([[]]), { query: { limit: '0' } }));
    expect(res.statusCode).toBe(400);
  });

  it('scopes the query to the household and the calling user', async () => {
    const sql = makeSql([[row()]]);
    await handleWatchGet(ctx(sql, { query: {} }));
    expect(sql.calls[0].params).toContain(USER);
    expect(sql.calls[0].params).toContainEqual(HOUSEHOLD);
  });
});

describe('POST /api/harvests/watch/dismissals — the calibration write', () => {
  it('freezes the model snapshot SERVER-side and writes it with the row', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1', plant_id: PLANT, observed_on: TODAY }]]);
    const res = await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT } }));
    expect(res.statusCode).toBe(201);
    expect(res.body.created).toBe(true);

    const insert = sql.calls[1];
    expect(insert.text).toMatch(/INSERT INTO public\.harvest_watch_dismissal/);
    // The frozen claim: anchor kind/date, the catalogue figure, the lead, and the queue-entry date.
    expect(insert.params).toContain(WATCH_MODEL_VERSION);
    expect(insert.params).toContain('sibling');
    expect(insert.params).toContain('2026-08-10');   // anchor_date
    expect(insert.params).toContain('2026-07-14');   // check_from
    expect(insert.params).toContain(TODAY);          // observed_on
    expect(insert.params).toContain('watermelon');
    expect(insert.params).toContain(CALIBRATION_REASON);
  });

  // PANEL Q3 — bounded suppression rides the INSERT. suppressed_until = observed_on + 10 days,
  // bound with an explicit ::date cast in the column list (it was absent before this change; the
  // read path already honoured it). MUTATION TARGET: drop the column from the INSERT -> red here.
  it('writes suppressed_until = observed_on + WATCH_SUPPRESS_DAYS with a ::date cast', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1', plant_id: PLANT, observed_on: TODAY }]]);
    await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT } }));
    const insert = sql.calls[1];
    expect(insert.text).toMatch(/suppressed_until/);
    expect(insert.text).toMatch(/\?::date/);
    expect(WATCH_SUPPRESS_DAYS).toBe(10);
    expect(insert.params).toContain(addDays(TODAY, WATCH_SUPPRESS_DAYS)); // 2026-08-22
  });

  // A backdated observation returns from the OBSERVATION day, not the write day — same event_date
  // convention the rest of the row follows.
  it('a backdated dismissal suppresses from the observation date', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1' }]]);
    await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT, observed_on: '2026-08-10' } }));
    expect(sql.calls[1].params).toContain(addDays('2026-08-10', WATCH_SUPPRESS_DAYS)); // 2026-08-20
  });

  // A client that could post its own snapshot could poison the calibration set, and a stale PWA
  // bundle would post an old model's numbers stamped with the current version string.
  // MUTATION TARGET: read any anchor field from `body` instead of the server candidate -> red.
  it('IGNORES client-supplied model fields entirely', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1' }]]);
    await handleDismissalPost(ctx(sql, {
      body: {
        plant_id: PLANT, anchor_kind: 'observed', anchor_date: '1999-01-01',
        expected_days: 1, check_from: '1999-01-01', model_version: 'attacker-v9',
      },
    }));
    const insert = sql.calls[1];
    expect(insert.params).not.toContain('1999-01-01');
    expect(insert.params).not.toContain('attacker-v9');
    expect(insert.params).toContain(WATCH_MODEL_VERSION);
  });

  it('accepts a BACKDATED observation — Dave logs after the walk, not at the plant', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1' }]]);
    const res = await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT, observed_on: '2026-08-10' } }));
    expect(res.statusCode).toBe(201);
    expect(sql.calls[1].params).toContain('2026-08-10');
  });

  // A future observation would silently corrupt every calibration interval derived from it.
  it('refuses a FUTURE observation date', async () => {
    const sql = makeSql([[row()]]);
    const res = await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT, observed_on: '2026-09-01' } }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/future/);
  });

  it('a double-tap is a 200 with the existing row, not a duplicate sample or a 409', async () => {
    // INSERT ... ON CONFLICT DO NOTHING returns nothing -> the handler reads the existing row back.
    const sql = makeSql([[row()], [], [{ id: 'd-existing', plant_id: PLANT, observed_on: TODAY }]]);
    const res = await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT } }));
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.dismissal.id).toBe('d-existing');
    expect(sql.calls[1].text).toMatch(/ON CONFLICT .* DO NOTHING/s);
  });

  it('rejects an unknown reason rather than writing an unfittable sample', async () => {
    const res = await handleDismissalPost(ctx(makeSql([]), { body: { plant_id: PLANT, reason: 'meh' } }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed plant_id', async () => {
    const res = await handleDismissalPost(ctx(makeSql([]), { body: { plant_id: 'nope' } }));
    expect(res.statusCode).toBe(400);
  });

  // No existence oracle: out-of-household, soft-deleted and simply-not-a-candidate all answer alike,
  // because the candidate query is already household-scoped.
  it('a planting that is not an active candidate answers 404 with no detail', async () => {
    const sql = makeSql([[row({ plant_id: '22222222-2222-4333-8444-555555555555' })]]);
    const res = await handleDismissalPost(ctx(sql, { body: { plant_id: PLANT } }));
    expect(res.statusCode).toBe(404);
    expect(sql.calls).toHaveLength(1); // never reached the INSERT
  });
});

describe('POST /api/harvests/watch/dismiss — the boolean the UI lane committed against', () => {
  it('dismissed:true creates the calibration sample', async () => {
    const sql = makeSql([[row()], [{ id: 'd-1', plant_id: PLANT }]]);
    const res = await handleDismissToggle(ctx(sql, { body: { plant_id: PLANT, dismissed: true } }));
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ plant_id: PLANT, dismissed: true });
    expect(sql.calls[1].text).toMatch(/INSERT INTO public\.harvest_watch_dismissal/);
  });

  // THE INVARIANT THE BOOLEAN MUST NEVER ACQUIRE. A retraction sets undone_at; it does not DELETE.
  // The row, its frozen snapshot and its observed_on all survive, so a retracted observation stays
  // available as labelled data and a reflexive mis-tap does not become a permanent unmarked false
  // negative. MUTATION TARGET: change the UPDATE to a DELETE -> red.
  it('dismissed:false RETRACTS (soft undo) and never deletes the sample', async () => {
    const sql = makeSql([[{ id: 'd-1', plant_id: PLANT, observed_on: TODAY, undone_at: 'now' }]]);
    const res = await handleDismissToggle(ctx(sql, { body: { plant_id: PLANT, dismissed: false } }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ plant_id: PLANT, dismissed: false });
    expect(sql.calls[0].text).toMatch(/UPDATE public\.harvest_watch_dismissal/);
    expect(sql.calls[0].text).toMatch(/SET undone_at = now\(\)/);
    expect(sql.calls[0].text).not.toMatch(/DELETE/i);
    expect(sql.calls[0].params).toContain(USER);
  });

  // PANEL Q3, BLOCKING PREREQUISITE — retraction is scoped to the SINGLE most recent active
  // dismissal. This reverses the original clear-them-all behaviour: under bounded 10-day suppression
  // rows ACCUMULATE across the season, and one Undo tap that cleared them all would retract every
  // accumulated calibration sample for the planting. MUTATION TARGET: remove the LIMIT 1 subquery
  // (revert to the plural WHERE user_id AND plant_id) -> red here.
  it('a retraction hits ONLY the most recent active dismissal, never the accumulated samples', async () => {
    const sql = makeSql([[{ id: 'd-newest' }]]);
    const res = await handleDismissToggle(ctx(sql, { body: { plant_id: PLANT, dismissed: false } }));
    expect(res.body.retracted).toHaveLength(1);
    const q = sql.calls[0].text;
    // The UPDATE targets one id selected as the newest active row — not the whole planting.
    expect(q).toMatch(/WHERE id = \(/s);
    expect(q).toMatch(/ORDER BY observed_on DESC, dismissed_at DESC/);
    expect(q).toMatch(/LIMIT 1/);
    expect(q).toMatch(/undone_at IS NULL/);
    // Ownership is enforced on the UPDATE itself, not only inside the subquery.
    expect((q.match(/user_id/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('requires a real boolean — an absent or stringy flag is a 400', async () => {
    for (const body of [{ plant_id: PLANT }, { plant_id: PLANT, dismissed: 'true' }]) {
      const res = await handleDismissToggle(ctx(makeSql([]), { body }));
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('DELETE /api/harvests/watch/dismissals/:id', () => {
  it('soft-undoes one dismissal, scoped to its owner', async () => {
    const sql = makeSql([[{ id: PLANT, plant_id: PLANT, undone_at: 'now' }]]);
    const res = await handleDismissalUndo(ctx(sql), PLANT);
    expect(res.statusCode).toBe(200);
    expect(res.body.undone).toBe(true);
    expect(sql.calls[0].text).toMatch(/SET undone_at = now\(\)/);
    expect(sql.calls[0].text).not.toMatch(/DELETE/i);
    expect(sql.calls[0].params).toContain(USER);
  });

  it('an already-undone or foreign row is a 404, not a mutation', async () => {
    const res = await handleDismissalUndo(ctx(makeSql([[]])), PLANT);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed id', async () => {
    const res = await handleDismissalUndo(ctx(makeSql([])), 'nope');
    expect(res.statusCode).toBe(400);
  });
});

// ── V4-ANCHORFLIP-001 condition 1 — the derived join, tested AT THE ROUTE ─────────────────────────
//
// WHY THIS BLOCK EXISTS AND WHY IT IS NOT A FIXTURE TEST. The expert consult
// (project-state/anchor-consult-20260812.md) refused the DERIVED_ANCHOR_ENABLED flip on the ground
// that it was a RUNTIME NO-OP: queryWatchRows never joined plant_anchor_derivation, so
// availableAnchors() read `undefined` for every derived_anchor_* field and the tier could not fire
// however the flag was set. The pure resolver's flag-on path was already covered
// (anchorDerive.test.js), and that coverage is exactly what made the no-op invisible — the one
// thing nobody was testing was the COMPOSITION: query aliases -> row shape -> resolver.
//
// So these tests drive handleWatchGet / handleDismissalPost end to end with the flag on. A column
// aliased `anchor_date` instead of `derived_anchor_date`, or a predicate that let a superseded row
// through, would pass every fixture test in the repo and fail here.
describe('V4-ANCHORFLIP-001 derived anchor, at the route', () => {
  // The join's output shape: an anchorless planting carrying the four aliased columns.
  const derivedRow = (over = {}) => row({
    plant_id: '33333333-2222-4333-8444-555555555555',
    planting_name: 'Fingerling Potatoes', crop_display_name: 'Potato',
    variety_name: 'Russian Banana', crop_type_slug: 'potato',
    status: 'growing', harvest_habit: 'single', dtm_basis: null,
    days_to_maturity_min: 90, days_to_maturity_max: null,
    sown_at: null, transplanted_at: null, planted_out_at: null,
    set_to_first_pick_days: null, fruit_set_date: null,
    sibling_plant_id: null, sibling_planting_name: null, sibling_first_pick_date: null,
    derived_anchor_date: '2026-05-10', derived_anchor_field: 'planted_out_at',
    derived_anchor_source: 'add_date_baseline', derived_anchor_confidence: 'baseline',
    ...over,
  });

  it('selects the derivation with both live predicates and joins it per planting', async () => {
    const sql = makeSql([[derivedRow()]]);
    await handleWatchGet(ctx(sql, { query: {} }));
    const q = sql.calls[0].text;
    expect(q).toMatch(/FROM public\.plant_anchor_derivation/);
    // superseded_at IS NULL — a derivation a real date has already contradicted is retired
    // evidence, never a citable anchor. uq_plant_anchor_derivation_live is partial on this
    // predicate, so it is also what keeps the LEFT JOIN one-to-one.
    expect(q).toMatch(/d\.superseded_at IS NULL/);
    // plausibility IS NULL — 0a2's rescue_suspect / post_frost_impossible marks. 26 of prod's 66
    // rows are marked, and the backfill flagged them precisely so no consumer would trust them.
    expect(q).toMatch(/d\.plausibility IS NULL/);
    expect(q).toMatch(/LEFT JOIN derived dv\s+ON dv\.plant_id = l\.plant_id/);
    // Aliased to the names watch.js reads. A mismatch here is the whole no-op, restored.
    for (const alias of [
      'AS derived_anchor_date', 'AS derived_anchor_field',
      'AS derived_anchor_source', 'AS derived_anchor_confidence',
    ]) expect(q).toContain(alias);
  });

  // THE FLAG IS STILL FALSE. This asserts the shipped behaviour: the join runs, the columns arrive,
  // and the tier stays shut — which is what makes applying the migration and deploying the Lambda
  // ahead of Dave's decision a safe, observable no-op rather than a leap.
  it('serves nothing from the derived tier while the flag is off', async () => {
    const sql = makeSql([[derivedRow()]]);
    const res = await handleWatchGet(ctx(sql, { query: {} }));
    expect(res.body.candidates).toEqual([]);
    expect(res.body.excluded).toEqual({ no_anchor: 1 });
  });

  it('serves the derived row, correctly anchored, when the tier is enabled', async () => {
    const sql = makeSql([[derivedRow()]]);
    const res = await handleWatchGet(ctx(sql, { query: {}, derivedEnabled: true }));
    expect(res.body.total_watching).toBe(1);
    const c = res.body.candidates[0];
    expect(c.confidence).toBe('derived');
    expect(c.anchor.derived).toBe(true);
    expect(c.anchor.derived_source).toBe('add_date_baseline');
    expect(c.anchor.derived_confidence).toBe('baseline');
    expect(c.anchor.derived_anchor_field).toBe('planted_out_at');
    // 2026-05-10 + 90 - min(22, round(90*0.25)=23) = 2026-05-10 + 68.
    expect(c.watching_since).toBe('2026-07-17');
    // The marking rule survives the round trip: the copy leads with `est.`, never a bare date.
    expect(c.basis.startsWith('est.')).toBe(true);
    expect(c.basis.length).toBeLessThanOrEqual(40);
  });

  // Condition 6, proven where it actually bites — through the route, on the consult's own shape.
  it('does not let the derived date set watching_since when the row cites a sibling', async () => {
    const sql = makeSql([[derivedRow({
      sibling_plant_id: 'sib-1', sibling_planting_name: 'Minnesota Mini',
      sibling_first_pick_date: '2026-08-08',
    })]]);
    const res = await handleWatchGet(ctx(sql, { query: {}, derivedEnabled: true }));
    const c = res.body.candidates[0];
    expect(c.confidence).toBe('sibling');
    expect(c.watching_since).toBe('2026-08-08');
    expect(c.basis).toContain('sibling Minnesota Mini');
    expect(c.days_watching).toBe(4);
  });

  // Conditions 3/4/5 at the route. Each row would be served but for its one suppression, so a
  // regression in any of them shows up as a row appearing rather than as a silent internal change.
  it.each([
    ['cut_and_come_again habit (condition 5)', { harvest_habit: 'cut_and_come_again' }],
    ['a fruiting planting (condition 4)', { status: 'fruiting' }],
    ['a watch opening inside the frost window (condition 3)', { derived_anchor_date: '2026-07-25' }],
  ])('suppresses %s even with the tier enabled', async (_label, over) => {
    const sql = makeSql([[derivedRow(over)]]);
    const res = await handleWatchGet(ctx(sql, { query: {}, derivedEnabled: true }));
    expect(res.body.candidates).toEqual([]);
    expect(res.body.excluded.no_anchor).toBe(1);
  });

  // Condition 2's other half. The migration widens the CHECK; this proves the value that would hit
  // it is in fact 'derived', so the two halves of the fix are about the same string.
  it('binds anchor_kind = derived on a dismissal, which is what the CHECK must admit', async () => {
    const sql = makeSql([[derivedRow()], [{ id: PLANT, plant_id: PLANT }]]);
    const res = await handleDismissalPost(ctx(sql, {
      derivedEnabled: true,
      body: { plant_id: '33333333-2222-4333-8444-555555555555' },
    }));
    expect(res.statusCode).toBe(201);
    const insert = sql.calls[1];
    expect(insert.text).toMatch(/INSERT INTO public\.harvest_watch_dismissal/);
    expect(insert.params).toContain('derived');
    // Pre-migration this INSERT violates harvest_watch_dismissal_anchor_chk and 500s. That is the
    // whole reason migrations/v4-anchorkind-derived-001 must land before the flag flips.
  });

  // The GET and the dismissal POST must resolve the queue identically, or a row the user can SEE is
  // a row they cannot dismiss — a 404 on the tap, on the only action the calibration table records.
  it('the dismissal path sees the same queue the GET served', async () => {
    const body = { plant_id: '33333333-2222-4333-8444-555555555555' };
    const off = await handleDismissalPost(ctx(makeSql([[derivedRow()]]), { body }));
    expect(off.statusCode).toBe(404);
    const on = await handleDismissalPost(ctx(
      makeSql([[derivedRow()], [{ id: PLANT }]]), { body, derivedEnabled: true },
    ));
    expect(on.statusCode).toBe(201);
  });
});
