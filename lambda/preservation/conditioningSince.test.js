// V5-PUTUPRULINGGAPS-001 (FOODSAFETY-RULING-V101 §7) — the Going list's conditioning_since, EXECUTED.
//
// What the list handler SENDS, against the same kind of mock driver kitchenRoutes.test.js uses: the
// lateral that derives the column, its scope to dehydrator batches, the view's live-row exclusion on
// BOTH cue reads, and the two labels it binds. The mock is not Postgres, so this cannot prove the
// lateral picks the right row — it proves the statement says what the derivation needs it to say.
//
// THE PARITY HALF. The Lambda may not import from src/ (scripts/vitest/vitest-projects.test.js),
// so the two labels are copied into kitchenRoutes.js. The client writes them into cue_observed and this
// derivation matches them back; a one-character drift on either side silences the card's question for
// good with nothing red. This reads goingNow.js AS TEXT and holds the two copies together.
//
// LANE: the root `npm test` run.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleKitchenRoute, CONDITIONING_JARS_CUE, CONDITIONING_DRYER_CUE } from './kitchenRoutes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOING_NOW = readFileSync(resolve(__dirname, '../../src/components/putup/goingNow.js'), 'utf8');

const HOUSEHOLD = ['user_dave', 'user_jen'];

function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) return Promise.reject(new Error('unexpected extra query'));
    return Promise.resolve(queue.shift());
  };
  fn.calls = calls;
  return fn;
}

const list = (sql, query = {}) => handleKitchenRoute({
  sql, rawPath: '/api/kitchen-batches', method: 'GET', rawBody: null, query,
  userId: 'user_dave', householdIds: HOUSEHOLD,
});

describe('GET /api/kitchen-batches derives conditioning_since', () => {
  it('passes the column through on the row, beside the view row unchanged', async () => {
    const row = { id: 'b1', kind: 'dehydrate', label: 'Apricots', conditioning_since: '2026-10-01T12:00:00Z' };
    const sql = mockSql([[row]]);
    const res = await list(sql);
    expect(res.status).toBe(200);
    expect(res.body.batches).toEqual([row]);
    // The view row whole, plus ONE column — never a hand-picked projection that drops a view column.
    expect(sql.calls[0].norm).toContain('SELECT v.*, cond.conditioning_since FROM v_kitchen_batch_current v');
    expect(sql.calls[0].norm).toContain('LEFT JOIN LATERAL (');
    expect(sql.calls[0].norm).toContain(') cond ON true');
  });

  it('is scoped to dehydrator batches and counts from the EARLIEST jars row', async () => {
    const sql = mockSql([[]]);
    await list(sql);
    const n = sql.calls[0].norm;
    // Mutation: drop the kind gate, or swap min for max (the latest check-in would re-anchor the window).
    expect(n).toContain("WHERE v.kind = 'dehydrate' AND j.batch_id = v.id");
    expect(n).toContain('SELECT min(j.entered_at) AS conditioning_since');
    expect(n).toContain('AND j.entered_at IS NOT NULL');
  });

  it('starts over after the latest trip back to the dryer, and counts from any jars row if there was none', async () => {
    const sql = mockSql([[]]);
    await list(sql);
    const n = sql.calls[0].norm;
    // Mutation: max → min (an old trip would let a newer one be ignored), or drop the COALESCE floor
    // (a batch that never went back would get NULL and never be asked).
    expect(n).toContain('AND j.entered_at > COALESCE(( SELECT max(d.entered_at) FROM kitchen_stage_log d WHERE d.batch_id = v.id');
    expect(n).toContain('AND d.entered_at IS NOT NULL');
    expect(n).toContain("), '-infinity'::timestamptz)");
  });

  it('reads only LIVE rows on both sides — not a void, not voided — exactly as the view does', async () => {
    const sql = mockSql([[]]);
    await list(sql);
    const n = sql.calls[0].norm;
    expect(n).toContain("AND j.stage_kind <> 'void' AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log vd WHERE vd.voids_id = j.id)");
    expect(n).toContain("AND d.stage_kind <> 'void' AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log vd WHERE vd.voids_id = d.id)");
  });

  it('BINDS the two labels, jars first, against the right alias each', async () => {
    const sql = mockSql([[]]);
    await list(sql);
    const n = sql.calls[0].norm;
    expect(n).toContain('AND j.cue_observed = ? ::text');
    expect(n).toContain('AND d.cue_observed = ? ::text');
    expect(n.indexOf('j.cue_observed')).toBeLessThan(n.indexOf('d.cue_observed'));
    expect(sql.calls[0].values.slice(0, 2)).toEqual([CONDITIONING_JARS_CUE, CONDITIONING_DRYER_CUE]);
  });

  it('keeps the list predicate and order the list already had', async () => {
    const sql = mockSql([[]]);
    await list(sql, { state: 'closed' });
    const n = sql.calls[0].norm;
    expect(n).toContain('deleted_at IS NULL');
    expect(n).toContain('ORDER BY started_at DESC NULLS LAST, first_recorded_at DESC');
    expect(sql.calls[0].values.slice(2)).toEqual([HOUSEHOLD, false, false, true]);
  });
});

describe('the Lambda\'s cue labels match the client\'s, character for character', () => {
  // Green control: the file read really is the one that defines the answers.
  it('reads the file that holds CONDITIONING_ANSWERS', () => {
    expect(GOING_NOW).toContain('export const CONDITIONING_ANSWERS');
  });

  it.each([
    ['jars', CONDITIONING_JARS_CUE],
    ['back_in_dryer', CONDITIONING_DRYER_CUE],
  ])('%s → %s', (value, label) => {
    expect(GOING_NOW).toContain(`{ value: '${value}', label: '${label}' }`);
  });

  it('would red on a one-character drift', () => {
    expect(GOING_NOW).not.toContain(`{ value: 'jars', label: '${CONDITIONING_JARS_CUE} ' }`);
    expect(GOING_NOW).not.toContain(`label: '${CONDITIONING_DRYER_CUE.replace('→', '->')}'`);
  });
});
