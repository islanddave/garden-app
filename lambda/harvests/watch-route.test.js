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
import { WATCH_MODEL_VERSION, NURSERY_OFFSET_DAYS_FALLBACK, UI_CONTRACT_FIELDS } from './watch.js';

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
    expect(res.body.candidates[0].basis).toBe('sibling picked Aug 10');
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

  // The day-grain unique index permits one active row per observation DAY, so a planting re-checked
  // across several days can carry more than one. Clearing only the newest would leave the row
  // suppressed with no control left to clear it.
  it('a retraction clears EVERY active dismissal on that planting', async () => {
    const sql = makeSql([[{ id: 'd-1' }, { id: 'd-2' }]]);
    const res = await handleDismissToggle(ctx(sql, { body: { plant_id: PLANT, dismissed: false } }));
    expect(res.body.retracted).toHaveLength(2);
    expect(sql.calls[0].text).toMatch(/undone_at IS NULL/);
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
