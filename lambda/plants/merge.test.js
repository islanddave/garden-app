// V4-PLANTMERGE-001 — merge core tests.
//
// Two layers, per the repo's lambda convention (L-072): pure-logic tests run for real, and the
// SQL wiring is pinned by static-source guards rather than a live DB. Runtime correctness against
// real Postgres is proven separately on a Neon branch (see migrations/v4-plantmerge-001/gates.yml).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mergeCore, planDedup, resolveStatus, resolvePhenology, sumQty, diffFingerprint,
  SURFACES, REPOINT_SURFACES, SNAPSHOT_VERSION,
} from './merge.js'
import { PLANT_MEMORY_COLUMNS } from './plantMemoryRepoint.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// A construct NAMED IN A COMMENT is not that construct — the reparent guard learned this the hard
// way, so assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')
const RAW = readFileSync(resolve(__dirname, 'merge.js'), 'utf8')
const SRC = decomment(RAW)
// BUG-ENTITYMEMSTALE-001: the event_log repoint now lives in plantMemoryRepoint.js, paired with the
// cache rebuild it owes. The surface guards below assert "the policy map has an implementation",
// which is still true — just one module away — so they scan the union. Every other guard stays on
// merge.js alone, where a positive match must not be satisfiable by the helper.
const REPOINT_SRC = SRC + '\n' + decomment(readFileSync(resolve(__dirname, 'plantMemoryRepoint.js'), 'utf8'))

// ── mock sql ─────────────────────────────────────────────────────────────────────────────────
// Tagged-template recorder. Queries are matched by substring against a script of canned responses;
// anything unmatched returns []. `.transaction()` records the batch and returns per-statement rows.
function mockSql(responses = {}) {
  const calls = []
  const render = (strings, values) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ''), '')
  const answer = (text) => {
    for (const [needle, rows] of Object.entries(responses)) {
      if (text.includes(needle)) return rows
    }
    return []
  }
  const sql = (strings, ...values) => {
    const text = render(strings, values)
    calls.push({ text, values })
    const p = Promise.resolve(answer(text))
    p.__text = text
    return p
  }
  sql.transaction = async (stmts) => {
    const texts = await Promise.all(stmts.map((s) => s.__text ?? ''))
    calls.push({ transaction: texts })
    return stmts.map((s) => answer(s.__text ?? ''))
  }
  sql.calls = calls
  sql.lastTransaction = () => calls.filter((c) => c.transaction).at(-1)?.transaction ?? []
  return sql
}

const WINNER = '11111111-1111-1111-1111-111111111111'
const LOSER1 = '22222222-2222-2222-2222-222222222222'
const LOSER2 = '33333333-3333-3333-3333-333333333333'

const plantRow = (id, over = {}) => ({
  id, name: `p-${id.slice(0, 4)}`, status: 'vegetative', quantity: 1, qty_initial: 1,
  qty_current: null, qty_harvested: 0, qty_lost: 0, loss_cause: null,
  sown_at: null, germinated_at: null, transplanted_at: null, planted_out_at: null,
  variety_id: null, project_id: null, location_id: null, notes: null, featured_photo_id: null,
  container_type: null, container_size: null, archived_at: null, version: 1,
  workspace_id: '00000000-0000-0000-0000-000000000001', created_by: 'user_a', ...over,
})

const baseResponses = (plants, events = []) => ({
  'FROM merge_event WHERE op_id': [],
  // Group load. Keyed on the JOIN so it stays distinct from the readFingerprint probe below, which
  // is still a bare `FROM plants WHERE id = ANY` — substring matching would otherwise collide.
  'FROM plants p\n    LEFT JOIN plant_projects pp': plants,
  'FROM event_log\n    WHERE plant_id = ANY': events,
  'FROM event_log WHERE plant_id = ANY': [{ rows: events.length, max_updated_at: null }],
  'FROM photos WHERE plant_id = ANY': [{ rows: 0, max_updated_at: null }],
  'FROM harvest_log h JOIN event_log e': [{ rows: 0, max_updated_at: null }],
  'FROM plants WHERE id = ANY': [{ rows: plants.length, max_updated_at: null }],
  'INSERT INTO merge_event': [{ id: 'merge-evt-1', merged_at: '2026-08-14T00:00:00Z' }],
})

// ── pure logic ───────────────────────────────────────────────────────────────────────────────

describe('resolveStatus', () => {
  it('takes the most advanced live stage, not the winner\'s', () => {
    expect(resolveStatus(['vegetative', 'fruiting'])).toBe('fruiting')
    // `harvested` is a milestone on an indeterminate crop, not an end state: a sibling still
    // fruiting means the merged row is still producing. This asserted 'harvested' until a branch
    // rehearsal showed it producing the group 6 regression §4.1 forbids (V4-MERGESTATUS-001).
    expect(resolveStatus(['harvested', 'fruiting'])).toBe('fruiting')
    // Order-independent: the reducer must not depend on which sibling it sees first.
    expect(resolveStatus(['fruiting', 'harvested'])).toBe('fruiting')
    // …and `harvested` still outranks every earlier live stage.
    expect(resolveStatus(['harvested', 'vegetative'])).toBe('harvested')
    expect(resolveStatus(['harvested', 'fruit_set'])).toBe('harvested')
  })
  it('never lets a terminal state outrank a living cohort', () => {
    // The regression this exists for: a merged row with any living sibling is alive.
    expect(resolveStatus(['failed', 'fruiting'])).toBe('fruiting')
    expect(resolveStatus(['ended', 'vegetative'])).toBe('vegetative')
  })
  it('falls back to terminal when every sibling is terminal', () => {
    expect(resolveStatus(['failed', 'ended'])).toBe('failed')
  })
  it('ignores null/empty and returns null when nothing is set', () => {
    expect(resolveStatus([null, '', 'seedling'])).toBe('seedling')
    expect(resolveStatus([null, null])).toBeNull()
  })
})

describe('resolvePhenology', () => {
  it('takes the LATEST anchor so the surviving window stays conservative', () => {
    // Ghost group shape: winner has no transplant date, the late cohort does.
    expect(resolvePhenology([null, '2026-07-23', '2026-06-16'])).toBe('2026-07-23')
  })
  it('returns null when no sibling has an anchor (window stays suppressed)', () => {
    expect(resolvePhenology([null, null])).toBeNull()
  })
})

describe('sumQty', () => {
  it('sums present values and preserves all-null as null', () => {
    expect(sumQty([54, 6, 1])).toBe(61)
    expect(sumQty([null, 2])).toBe(2)
    expect(sumQty([null, null])).toBeNull()
  })
})

describe('planDedup', () => {
  const ev = (id, type, batch, date, created) => ({
    id, event_type: type, event_date: date, created_at: created,
    metadata: batch ? { batch_id: batch } : {},
  })

  it('collapses same (event_type, batch_id) to the earliest row', () => {
    const out = planDedup([
      ev('c', 'watering', 'B1', '2026-08-01T12:00:00Z', '2026-08-01T12:00:02Z'),
      ev('a', 'watering', 'B1', '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z'),
      ev('b', 'watering', 'B1', '2026-08-01T12:00:00Z', '2026-08-01T12:00:01Z'),
    ])
    expect(out.droppedBatch.sort()).toEqual(['b', 'c'])
    expect(out.kept).toEqual(['a'])
  })

  it('does not collapse across event types sharing a batch id', () => {
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z'),
      ev('b', 'fertilizing', 'B1', '2026-08-01T12:00:00Z', '2026-08-01T12:00:01Z'),
    ])
    expect(out.dropped).toEqual([])
  })

  it('never collapses unbatched events', () => {
    const out = planDedup([
      ev('a', 'observation', null, '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z'),
      ev('b', 'observation', null, '2026-08-01T11:00:00Z', '2026-08-01T11:00:00Z'),
    ])
    expect(out.dropped).toEqual([])
    expect(out.kept.sort()).toEqual(['a', 'b'])
  })

  it('KEEPS same-day water from different batches — there is no water collapse, by decision', () => {
    // Inverted 2026-08-14. This asserted droppedWater === ['b'] on the B2 "ledger double-credit"
    // premise. Measured against prod, that premise is false: the ledger's per-row accumulating
    // branches need water_depth light/deep, and prod has ZERO such rows in 10,114 water/rain rows —
    // every one is null or 'normal', both of which ASSIGN rather than accumulate. Meanwhile 25.24%
    // of plant-day water buckets garden-wide already hold multiple rows, 1,996 on plantings in no
    // merge group, so the collapse enforced on 34 plants an invariant 278 others never had.
    // It was also wrong mechanically: UTC day buckets against an America/New_York ledger.
    // Re-measure water_depth on prod before ever re-adding this.
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'watering', 'B2', '2026-08-01T19:00:00Z', '2026-08-01T19:00:00Z'),
    ])
    expect(out.dropped).toEqual([])
    expect(out.kept).toEqual(['a', 'b'])
  })

  it('keeps a 21:37 and a next-afternoon watering apart — the UTC-vs-ET bucket that misfired', () => {
    // 2026-08-01T21:37 and 2026-08-02T14:11 ET are 2026-08-02T01:37Z and 2026-08-02T18:11Z — the
    // SAME UTC day, different ET days. The old collapse dropped the second. Both must survive.
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-02T01:37:00Z', '2026-08-02T01:37:00Z'),
      ev('b', 'watering', 'B2', '2026-08-02T18:11:00Z', '2026-08-02T18:11:00Z'),
    ])
    expect(out.dropped).toEqual([])
    expect(out.kept).toEqual(['a', 'b'])
  })

  it('still collapses a real batch fan-out — collapse (a) is untouched', () => {
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:01Z'),
    ])
    expect(out.droppedBatch).toEqual(['b'])
    expect(out.kept).toEqual(['a'])
  })

  it('never touches harvests even if one somehow carried a batch id', () => {
    const out = planDedup([
      ev('a', 'harvest', null, '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'harvest', null, '2026-08-01T09:00:00Z', '2026-08-01T09:00:00Z'),
    ])
    expect(out.dropped).toEqual([])
  })

  it('is deterministic under input reordering', () => {
    const rows = [
      ev('a', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:01Z'),
      ev('c', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:02Z'),
    ]
    const a = planDedup(rows)
    const b = planDedup([...rows].reverse())
    expect(a.kept).toEqual(b.kept)
    expect(a.dropped.sort()).toEqual(b.dropped.sort())
  })
})

describe('diffFingerprint', () => {
  it('flags row-count drift', () => {
    const d = diffFingerprint({ event_log: { rows: 10, max_updated_at: null } },
                              { event_log: { rows: 11, max_updated_at: null } })
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ table: 'event_log', reason: 'rows' })
  })
  it('flags updated_at drift even when the count is unchanged', () => {
    // The concurrent-edit case a row-count check alone cannot see.
    const d = diffFingerprint({ photos: { rows: 3, max_updated_at: '2026-08-01T00:00:00Z' } },
                              { photos: { rows: 3, max_updated_at: '2026-08-02T00:00:00Z' } })
    expect(d[0]).toMatchObject({ table: 'photos', reason: 'max_updated_at' })
  })
  it('is clean when nothing moved', () => {
    const fpv = { plants: { rows: 3, max_updated_at: '2026-08-01T00:00:00Z' } }
    expect(diffFingerprint(fpv, fpv)).toEqual([])
  })
})

// ── mergeCore behaviour ──────────────────────────────────────────────────────────────────────

describe('mergeCore validation', () => {
  const ok = { opId: 'op1', userId: 'user_a', householdIds: ['user_a'] }

  it('rejects a winner listed among the losers', async () => {
    const r = await mergeCore(mockSql(), { winnerId: WINNER, loserIds: [WINNER], ...ok })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/into itself/)
  })
  it('rejects duplicate loser ids', async () => {
    const r = await mergeCore(mockSql(), { winnerId: WINNER, loserIds: [LOSER1, LOSER1], ...ok })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/duplicates/)
  })
  it('rejects an empty loser set', async () => {
    const r = await mergeCore(mockSql(), { winnerId: WINNER, loserIds: [], ...ok })
    expect(r.status).toBe(400)
  })
  it('requires an opId', async () => {
    const r = await mergeCore(mockSql(), { winnerId: WINNER, loserIds: [LOSER1], opId: null,
                                           userId: 'u', householdIds: ['u'] })
    expect(r.status).toBe(400)
  })
})

describe('mergeCore', () => {
  const ok = { opId: 'op1', userId: 'user_a', householdIds: ['user_a'] }

  it('replays a known op_id without merging again', async () => {
    const sql = mockSql({ 'FROM merge_event WHERE op_id': [{
      winner_plant_id: WINNER, loser_plant_ids: [LOSER1], events_dropped: 5,
      rows_repointed: 9, merged_at: '2026-08-14T00:00:00Z',
    }] })
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    expect(r.body.replayed).toBe(true)
    expect(sql.calls.some((c) => c.transaction)).toBe(false)
  })

  it('404s when a member is missing or outside the household', async () => {
    const sql = mockSql(baseResponses([plantRow(WINNER)]))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(404)
    expect(r.body.missing).toContain(LOSER1)
  })

  it('422s when siblings disagree on a column with no reconciliation rule', async () => {
    // The silent wrong-verdict this prevents: container_type/container_size feed vesselProfile and
    // therefore the water verdict. Group 3 Habanero really does span a whiskey_barrel 15gal, a
    // fabric_bag 5gal and an unsized plastic_pot — opposite ends of VESSEL_CLASS_FACTOR. Without
    // this guard the merged row silently inherits whichever sibling won on import order.
    const plants = [
      plantRow(WINNER, { container_type: 'whiskey_barrel', container_size: '15 gall' }),
      plantRow(LOSER1, { container_type: 'fabric_bag', container_size: '5 gal' }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(422)
    expect(r.body.divergences.map((d) => d.column).sort()).toEqual(['container_size', 'container_type'])
    expect(sql.calls.some((c) => c.transaction)).toBe(false)   // refuses BEFORE any write
  })

  // ── BUG-EVENTPROJPLANTPAIR-001 — siblings only ────────────────────────────────────────────
  // The repoint moves a loser's whole event history onto the winner by rewriting plant_id ALONE.
  // Across projects that turns every previously-correct row into a disagreeing one: L's events are
  // anchored (X, L), and after the repoint they are (X, W) while W lives in Y. This is one of the
  // three live writers in the ticket, and the only one that mints mismatches in bulk.
  const PROJ_X = '9d2f9f6e-0000-4000-8000-00000000000a'
  const PROJ_Y = '9d2f9f6e-0000-4000-8000-00000000000b'

  it('400s a merge whose loser sits in a DIFFERENT project from the winner', async () => {
    const plants = [
      plantRow(WINNER, { project_id: PROJ_Y }),
      plantRow(LOSER1, { project_id: PROJ_X }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/same project as the winner/)
    expect(r.body.offenders.map((o) => o.id)).toEqual([LOSER1])
    expect(r.body.winner_project_id).toBe(PROJ_Y)
    expect(sql.calls.some((c) => c.transaction)).toBe(false)   // refuses BEFORE any write
  })

  it('400s when the winner has a project and the loser has none', async () => {
    // The Bucket B shape, arriving through merge: NULL !== PROJ_Y, so every repointed event would
    // land on a planting in PROJ_Y while still claiming nothing. Not a special case — same rule.
    const plants = [
      plantRow(WINNER, { project_id: PROJ_Y }),
      plantRow(LOSER1, { project_id: null }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(400)
    expect(r.body.offenders.map((o) => o.id)).toEqual([LOSER1])
  })

  it('lets a genuine sibling merge THROUGH — the guard is not a blanket refusal', async () => {
    // Non-vacuity: same fixture shape, same non-null project on both, and the run must get past
    // step 2b. If this ever starts returning the sibling-scope 400, the guard has over-fired.
    const plants = [
      plantRow(WINNER, { project_id: PROJ_Y }),
      plantRow(LOSER1, { project_id: PROJ_Y }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.body?.error ?? '').not.toMatch(/same project as the winner/)
  })

  it('the repoint still leaves project_id alone — the refusal is what keeps that sound', () => {
    // Carrying project_id forward instead would silently invalidate plantMemoryRepoint's stated
    // scope (plant-keyed rebuild only, justified by no project's event set changing). If a future
    // edit adds `SET project_id` here, it owes a project-keyed rebuild for BOTH projects.
    expect(REPOINT_SRC).toMatch(/UPDATE event_log SET plant_id = \$\{toPlantId\} WHERE plant_id = ANY/)
    expect(REPOINT_SRC).not.toMatch(/UPDATE event_log SET plant_id = \$\{toPlantId\},\s*project_id/)
  })

  it('proceeds once the human supplies an override for the divergent column', async () => {
    const plants = [
      plantRow(WINNER, { container_type: 'whiskey_barrel' }),
      plantRow(LOSER1, { container_type: 'fabric_bag' }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, {
      winnerId: WINNER, loserIds: [LOSER1], ...ok,
      overrides: { container_type: 'whiskey_barrel' },
    })
    expect(r.status).toBe(200)
  })

  it('WRITES the override it accepted — taking a ruling and discarding it is the worst outcome', async () => {
    // Regression: the guarded columns were absent from `resolved` and from the UPDATE, so an
    // override cleared the 422 and was then silently dropped — the winner kept its own value and the
    // caller believed the ruling had landed. Found on a branch rehearsal where g12 Cilantro's
    // archived_at override was taken and discarded. Strictly worse than refusing outright.
    const plants = [
      plantRow(WINNER, { archived_at: '2026-06-18T10:54:53Z', container_type: 'fabric_bag' }),
      plantRow(LOSER1, { archived_at: '2026-07-31T03:12:01Z', container_type: 'fabric_bag' }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, {
      winnerId: WINNER, loserIds: [LOSER1], ...ok,
      overrides: { archived_at: '2026-07-31T03:12:01Z' },
    })
    expect(r.status).toBe(200)
    expect(r.body.resolved.archived_at).toBe('2026-07-31T03:12:01Z')
    // …and it must reach the actual UPDATE, not just the response body. The mock binds values as
    // $N placeholders, so the literal never appears in the rendered text — assert the column is in
    // the UPDATE, and pin in source that it is bound to resolved.archived_at rather than to some
    // other expression that would happen to satisfy the runtime check above.
    const update = sql.lastTransaction().find((t) => t.includes('UPDATE plants SET'))
    expect(update).toMatch(/archived_at = \$\d+/)
    expect(SRC.replace(/\s+/g, ' ')).toContain('archived_at = ${resolved.archived_at}')
    for (const col of ['container_type', 'container_size', 'location_id', 'variety_id']) {
      expect(update).toMatch(new RegExp(`${col} = \\$\\d+`))
      expect(SRC.replace(/\s+/g, ' ')).toContain(`${col} = \${resolved.${col}}`)
    }
  })

  it('keeps the winner value on a guarded column when no override is given', async () => {
    const plants = [
      plantRow(WINNER, { container_type: 'fabric_bag' }),
      plantRow(LOSER1, { container_type: 'fabric_bag' }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    expect(r.body.resolved.container_type).toBe('fabric_bag')
  })

  it('takes a losers non-null guarded value when the winner has none', async () => {
    const plants = [
      plantRow(WINNER, { location_id: null }),
      plantRow(LOSER1, { location_id: 'loc-1' }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    expect(r.body.resolved.location_id).toBe('loc-1')
  })

  it('does not refuse when only one sibling carries a value — null is absent, not disagreement', async () => {
    const plants = [
      plantRow(WINNER, { container_type: 'fabric_bag' }),
      plantRow(LOSER1, { container_type: null }),
    ]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
  })

  it('409s on fingerprint drift instead of silently sweeping a concurrent write', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, {
      winnerId: WINNER, loserIds: [LOSER1], ...ok,
      fingerprint: { event_log: { rows: 999, max_updated_at: null } },
    })
    expect(r.status).toBe(409)
    expect(r.body.drift[0]).toMatchObject({ table: 'event_log', reason: 'rows' })
    expect(sql.calls.some((c) => c.transaction)).toBe(false)
  })

  it('dry run computes the plan and writes nothing', async () => {
    const plants = [plantRow(WINNER, { status: 'vegetative' }),
                    plantRow(LOSER1, { status: 'fruiting', transplanted_at: '2026-07-23' })]
    const events = [
      { id: 'e1', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
        created_at: '2026-08-01T08:00:00Z', metadata: { batch_id: 'B1' } },
      { id: 'e2', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
        created_at: '2026-08-01T08:00:01Z', metadata: { batch_id: 'B1' } },
    ]
    const sql = mockSql(baseResponses(plants, events))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok, dryRun: true })
    expect(r.status).toBe(200)
    expect(r.body.dry_run).toBe(true)
    expect(r.body.events_dropped).toBe(1)
    expect(r.body.resolved.status).toBe('fruiting')          // most advanced, not the winner's
    expect(r.body.resolved.transplanted_at).toBe('2026-07-23') // latest anchor
    expect(sql.calls.some((c) => c.transaction)).toBe(false)
  })

  it('soft-deletes losers LAST so the entity trigger fires after the repoints', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    const tx = sql.lastTransaction()
    const softDelete = tx.findIndex((t) => t.includes('SET deleted_at = now()') && t.includes('FROM plants') === false && t.includes('UPDATE plants'))
    const repoint = tx.findIndex((t) => t.includes('UPDATE event_log'))
    expect(repoint).toBeGreaterThanOrEqual(0)
    expect(softDelete).toBeGreaterThan(repoint)
  })

  // ── BUG-ENTITYMEMSTALE-001 ─────────────────────────────────────────────────────────────────
  // The repoint moves the losers' history onto the winner without inserting anything, so every
  // forward GREATEST(...) writer is bypassed and the winner's cache is left describing only its
  // own events. Five prod winners from the 2026-08-14 run sat permanently BEHIND their event log.

  const findRecompute = (tx) => tx.findIndex((t) =>
    t.includes('INSERT INTO entity_memory') && t.includes('ON CONFLICT (plant_id)'))

  it('rebuilds the WINNER entity_memory row after repointing events onto it', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    const tx = sql.lastTransaction()
    const rebuild = findRecompute(tx)
    expect(rebuild, 'no winner cache rebuild in the merge transaction').toBeGreaterThanOrEqual(0)
    // Keyed on the WINNER, and rebuilt from event_log rather than carried over from the losers.
    expect(tx[rebuild]).toMatch(/FROM event_log e WHERE e\.plant_id = \$\d+ AND e\.deleted_at IS NULL/)
  })

  it('rebuilds all seven recency columns, not just the one an event type would touch', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    const stmt = sql.lastTransaction()[findRecompute(sql.lastTransaction())]
    for (const col of PLANT_MEMORY_COLUMNS) {
      expect(stmt, `rebuild omits ${col}`).toMatch(new RegExp(`${col}\\s+= EXCLUDED\\.${col}`))
    }
    // The three prod rows with last_harvested_at NULL were merge winners whose only harvests came
    // from a loser: first_harvest must be in the mapping or they stay NULL after a heal.
    expect(stmt).toMatch(/event_type IN \('harvest','first_harvest'\)/)
    expect(stmt).toMatch(/flagged_as_issue = true/)
  })

  it('rebuilds AFTER the repoint and AFTER the drop-set archive, never before', async () => {
    // Ordering is the whole contract: earlier than archive_events_subset and the cache caches a
    // dropped event, trading this bug for post_no_cache_ahead_of_event_log.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const dupes = [
      { id: 'e1', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
        created_at: '2026-08-01T08:00:00Z', metadata: { batch_id: 'B1' } },
      { id: 'e2', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
        created_at: '2026-08-01T08:00:01Z', metadata: { batch_id: 'B1' } },
    ]
    const sql = mockSql(baseResponses(plants, dupes))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.body.events_dropped).toBeGreaterThan(0)
    const tx = sql.lastTransaction()
    const repoint = tx.findIndex((t) => t.includes('UPDATE event_log'))
    const archive = tx.findIndex((t) => t.includes('archive_events_subset'))
    const rebuild = findRecompute(tx)
    expect(repoint).toBeGreaterThanOrEqual(0)
    expect(archive).toBeGreaterThan(repoint)
    expect(rebuild, 'rebuild must follow the repoint').toBeGreaterThan(repoint)
    expect(rebuild, 'rebuild must follow the drop-set archive').toBeGreaterThan(archive)
  })

  it('performs the whole cutover in ONE transaction', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(sql.calls.filter((c) => c.transaction)).toHaveLength(1)
  })

  it('attributes the losers anchor retirement instead of stamping a bare timestamp', async () => {
    // OPS-MERGERETIREPROV-001. Retiring on superseded_at alone is unattributable after the fact: the
    // calibration extract reads superseded_by to tell a merge artefact apart from a (guess, later
    // truth) pair, and six of the eight rows retired on prod carry NULL because this statement wrote
    // none. Asserted against the statement the batch actually issues, not against source text — the
    // sibling winner retire (predicated on EXISTS, scoped to a single id) would satisfy a text match.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    const retire = sql.lastTransaction()
      .filter((t) => /UPDATE plant_anchor_derivation/.test(t))
      .find((t) => /ANY\(\$\d+\)/.test(t))
    expect(retire, 'the losers anchor retire is not in the cutover batch').toBeTruthy()
    expect(retire).toMatch(/superseded_by\s*=\s*'merge_loser'/)
    expect(retire).toMatch(/updated_at\s*=\s*now\(\)/)
    // The re-run guard and the merge/observation distinction both survive the added columns.
    expect(retire).toMatch(/superseded_at IS NULL/)
    expect(retire).not.toMatch(/'observed_anchor'/)
  })

  it('scopes every repoint to the loser set', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1), plantRow(LOSER2)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1, LOSER2], ...ok })
    for (const stmt of sql.lastTransaction()) {
      if (/^\s*UPDATE (event_log|photos|preservation_log|critter_state|evidence|findings|seen_event|favorites|watch_impression|harvest_watch_dismissal|seed_lot_parent_planting)/.test(stmt)) {
        expect(stmt).toMatch(/WHERE .*= ANY\(\$\d+\)|WHERE .*= ANY/)
      }
    }
  })

  it('issues every conflict prune ahead of the repoint it clears the way for', async () => {
    // "Conflict-prune before repoint" is the ordering rule the cutover states and nothing held it:
    // a prune moved below its repoint still passes every source guard, and the repoint then trips
    // the unique index the prune exists to clear. Read off the batch as issued, per surface.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    const tx = sql.lastTransaction()
    const pruned = REPOINT_SURFACES.filter((s) => s.conflict)
    expect(pruned.length).toBeGreaterThan(0)
    for (const s of pruned) {
      const prune = tx.findIndex((t) => new RegExp(`^\\s*(DELETE FROM|UPDATE) ${s.table} l\\b`).test(t))
      const repoint = tx.findIndex((t) => new RegExp(`^\\s*UPDATE ${s.table}\\s+SET ${s.column} =`).test(t))
      expect(prune, `no conflict prune issued for ${s.table}.${s.column}`).toBeGreaterThanOrEqual(0)
      expect(repoint, `${s.table}.${s.column} is repointed before its prune`).toBeGreaterThan(prune)
    }
  })
})

// ── a deadlock is "run it again", not a broken merge ─────────────────────────────────────────
// The cutover takes its seed lots first and the losers' photos later; a photo delete takes the photo
// first and the lot that features it later. A loser's photo on a seed jar is in both, and on real
// Postgres the merge was the victim: `NeonDbError: deadlock detected`, code 40P01, and a 500. The
// lock order stays (it is what stops a gardener's parents edit being the victim instead), so the
// answer is what gets fixed.
describe('mergeCore — a deadlocked cutover', () => {
  const ok = { opId: 'op1', userId: 'user_a', householdIds: ['user_a'] }
  const failing = (err) => {
    const sql = mockSql(baseResponses([plantRow(WINNER), plantRow(LOSER1)]))
    sql.transaction = async () => { throw err }
    return sql
  }
  // As the driver threw it on real Postgres, detail and all.
  const deadlock = (message = 'deadlock detected') => Object.assign(new Error(message), {
    code: '40P01',
    detail: 'Process 6256 waits for ShareLock on transaction 1866057; blocked by process 5086.',
    where: 'while locking tuple (0,37) in relation "photos"',
  })

  it('answers 409 and says nothing was merged and it can be run again', async () => {
    const sql = failing(deadlock())
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    // The status the other "try again" outcomes use (fingerprint drift, a unique collision), so a
    // caller that already treats a merge 409 as retryable needs nothing new.
    expect(r.status).toBe(409)
    // Both halves, because each is what the operator needs to hear: a deadlock victim's transaction
    // wrote nothing, and the same request is safe to send again.
    expect(r.body.error).toMatch(/nothing was merged/)
    expect(r.body.error).toMatch(/run it again/)
    expect(r.body.detail).toBe('deadlock detected')
    // Postgres's detail names backend pids and transaction ids. Not the caller's business.
    expect(JSON.stringify(r.body)).not.toMatch(/Process \d+|ShareLock/)
  })

  it('is keyed on the SQLSTATE, not on the wording', async () => {
    // The message is locale text and the code is not: a server answering in another language is
    // deadlocked all the same.
    const r = await mergeCore(failing(deadlock('Verklemmung entdeckt')),
      { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/nothing was merged/)
  })

  it('goes looking for nothing afterwards — there is no outcome to replay', async () => {
    // The duplicate-op arm re-reads merge_event because a concurrent identical op may have LANDED.
    // A deadlock victim's own transaction rolled back whole; the one read of merge_event is the
    // idempotency check at the top, and nothing is issued after the cutover fails.
    const sql = failing(deadlock())
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(sql.calls.filter((c) => c.text?.includes('FROM merge_event WHERE op_id'))).toHaveLength(1)
    const last = sql.calls.at(-1)
    expect(last.text ?? '').toMatch(/INSERT INTO merge_event/)   // the last statement BUILT for the batch
  })

  it('still throws every other failure — a different SQLSTATE is not "run it again"', async () => {
    // 40001 is a serialization failure, 57014 a cancelled statement, and an error with no code at all
    // is anything. None is known to have written nothing for a reason a blind retry fixes, so each
    // reaches the handler's generic arm exactly as before, as the same error object.
    for (const err of [
      Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' }),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      new Error('socket hang up'),
    ]) {
      await expect(mergeCore(failing(err), { winnerId: WINNER, loserIds: [LOSER1], ...ok })).rejects.toBe(err)
    }
  })

  it('leaves the unique-collision answer as it was', async () => {
    // Same status, different sentence, and the difference matters: a collision means rows are in the
    // way and a retry may meet them again; a deadlock means nothing is.
    const r = await mergeCore(
      failing(Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), { code: '23505' })),
      { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('Merge collided with existing rows')
  })
})

// ── seed_lot_parent_planting — the parent links of a saved-seed lot ──────────────────────────
// Mock SQL, so these pin WHAT is sent, with which ids, and in what order. Whether the statements do
// what merge.js says of them — which row survives a collision, that no 23505 can follow, that
// inventory_items.source_plant_id still names a live parent afterwards — is a question only a real
// engine answers (tests/integration/plant-merge-surfaces.int.test.js).
describe('mergeCore — seed_lot_parent_planting', () => {
  const ok = { opId: 'op1', userId: 'user_a', householdIds: ['user_a'] }
  const run = async (responses = {}, losers = [LOSER1]) => {
    const plants = [plantRow(WINNER), ...losers.map((id) => plantRow(id))]
    const sql = mockSql({ ...responses, ...baseResponses(plants) })
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: losers, ...ok })
    return { sql, r, tx: sql.lastTransaction() }
  }
  const isPrune = (t) => /^\s*UPDATE seed_lot_parent_planting l\b/.test(t)
  const isRepoint = (t) => /^\s*UPDATE seed_lot_parent_planting SET plant_id =/.test(t)
  const snapshotOf = (sql) => {
    const insert = sql.calls.find((c) => c.text?.includes('INSERT INTO merge_event'))
    return { insert, snap: JSON.parse(insert.values.find((v) => typeof v === 'string' && v.startsWith('{'))) }
  }

  // ── lot locks ──────────────────────────────────────────────────────────────────────────────
  // A parents edit on a lot (lambda/inventory-items replaceSourcePlants) locks the LOT with FOR
  // UPDATE, then writes its link rows. A merge that writes a link row first and reaches the lot later
  // holds the two in the opposite order, and the pair deadlocks (40P01). The order is the whole
  // property, so it is read off the batch as issued, the way every other ordering rule here is.
  // Recognised by its head and by ANY row-lock clause at its end, so a lock of the wrong strength is
  // still found as "the lot lock" and fails the strength test below by name, not as a missing one.
  const LOCK_CLAUSE = /\bFOR\s+(NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)\s*$/
  const isLotLock = (t) => /^\s*SELECT i\.id FROM inventory_items i\b/.test(t) && LOCK_CLAUSE.test(t)
  const writesLinkOrLot = (t) =>
    /\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.)?(seed_lot_parent_planting|inventory_items)\b/.test(t)

  it('locks the lots BEFORE any statement that writes a parent link or a lot', async () => {
    const { tx } = await run({}, [LOSER1, LOSER2])
    const locks = tx.map((t, i) => (isLotLock(t) ? i : -1)).filter((i) => i >= 0)
    expect(locks, 'the cutover issues exactly one lot lock').toHaveLength(1)
    const [lock] = locks
    // Behind the actor GUC, which keeps element 0 (BUG-EVENTAUDITACTOR-001) — and behind nothing that
    // writes. When the merge has to WAIT for a lot it must be holding no row lock but lower-id lots,
    // or the "one order" argument stops being about lots: a prune moved ahead of this is a lock the
    // merge holds while it waits.
    expect(tx[0]).toMatch(/set_config\('app\.actor_clerk_sub'/)
    expect(lock).toBeGreaterThan(0)
    expect(tx.slice(0, lock).filter((t) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(t))).toEqual([])
    // Not vacuous: the prune, the cache repoint and the link repoint, and nothing else.
    const writes = tx.map((t, i) => (writesLinkOrLot(t) ? i : -1)).filter((i) => i >= 0)
    expect(writes).toHaveLength(3)
    for (const w of writes) {
      expect(w, `issued before the lot lock: ${tx[w].trim().slice(0, 70)}`).toBeGreaterThan(lock)
    }
    // By name, the first link-row write: locking after it is the deadlock, however early that is.
    expect(tx.findIndex(isPrune)).toBeGreaterThan(lock)
    expect(tx.findIndex(isRepoint)).toBeGreaterThan(lock)
  })

  it('locks every lot the merge can touch, through EITHER representation, in id order', async () => {
    const { sql, tx } = await run({}, [LOSER1, LOSER2])
    // Whole, because each clause is one way to leave a lot unlocked or the locks in the wrong order:
    //   · the cache arm — a lot whose source_plant_id names a loser (the cache repoint writes it);
    //   · the link arm — a lot with a link row on a loser OR on the winner. The cache repoint alone
    //     never covered this: where a loser is a parent and the cache names another parent, that
    //     UPDATE matches nothing, and the prune and the repoint still write the lot's rows;
    //   · no role and no deleted_at in the link arm — the repoint moves every role, retired rows too;
    //   · ORDER BY i.id — two merges take their locks in one order;
    //   · FOR NO KEY UPDATE — the strength, which has a test of its own below.
    expect(tx.find(isLotLock).replace(/\s+/g, ' ').trim()).toBe(
      'SELECT i.id FROM inventory_items i WHERE i.source_plant_id = ANY($0) '
      + 'OR EXISTS (SELECT 1 FROM seed_lot_parent_planting sl WHERE sl.inventory_item_id = i.id '
      + 'AND (sl.plant_id = ANY($1) OR sl.plant_id = $2)) ORDER BY i.id FOR NO KEY UPDATE')
    // The placeholders do not say which id went where: losers, losers, then the winner.
    expect(sql.calls.find((c) => c.text && isLotLock(c.text)).values)
      .toEqual([[LOSER1, LOSER2], [LOSER1, LOSER2], WINNER])
  })

  it('takes the lots FOR NO KEY UPDATE — neither stronger nor weaker', async () => {
    // Every other spelling is a different bug, and each one still "locks the lots first":
    //   · FOR UPDATE also conflicts with the FOR KEY SHARE the reconcile holds on its lots, which it
    //     takes in scan order. Two lots, two orders: the reconcile holds B and wants A, the merge
    //     holds A and wants B, and Postgres kills one (40P01). With NO KEY UPDATE the two never wait
    //     on each other's lots and meet at the link table's lock instead.
    //   · FOR SHARE and FOR KEY SHARE do not conflict with themselves. Two merges, or a merge and
    //     anything else sharing the lot, both get it, and the deadlock moves to the first UPDATE.
    //     FOR KEY SHARE does not even conflict with an ordinary UPDATE of the lot.
    // NO KEY UPDATE conflicts with the FOR UPDATE a parents edit opens with, which is all the lock is
    // for, and it is what the source_plant_id repoint further down takes on the same rows anyway.
    const { tx } = await run()
    expect(tx.find(isLotLock).match(LOCK_CLAUSE)[1]).toBe('NO KEY UPDATE')
    // And no other row-lock strength is spelled anywhere in the file's SQL: two locks, the lots and
    // the plantings, one strength.
    expect(SRC.match(/\bFOR\s+(?:NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)\b/g))
      .toEqual(['FOR NO KEY UPDATE', 'FOR NO KEY UPDATE'])
  })

  it('takes the lock INSIDE the cutover, once, so it is held until the commit', async () => {
    // The driver auto-commits a bare statement: a lock awaited on its own ahead of the batch is
    // released before the batch starts, and reads in source as though it were protecting it.
    const { sql, tx } = await run()
    expect(tx.filter(isLotLock)).toHaveLength(1)
    expect(sql.calls.filter((c) => c.text && isLotLock(c.text))).toHaveLength(1)
    // Every row lock the merge asks for anywhere is in the batch: the lots and the plantings.
    const asked = sql.calls.filter((c) => c.text && /\bFOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/.test(c.text))
    expect(asked).toHaveLength(2)
    for (const c of asked) expect(tx).toContain(c.text)
  })

  // ── planting locks ─────────────────────────────────────────────────────────────────────────
  // A parents write can name a LOSER as a new parent of a lot the merge never locked (the lot had no
  // link to the group when the lot lock ran). It share-locks the plantings it names. Until the merge
  // locked its own plantings too, that write could commit its link after the link repoint had run:
  // a live link to a planting about to be soft-deleted, the lot gone from the winner's seed page,
  // and no error anywhere. The lock and the three seed-lot statements behind it are one unit.
  const isPlantingLock = (t) => /^\s*SELECT id FROM plants WHERE id = ANY\(\$\d+\)/.test(t) && LOCK_CLAUSE.test(t)
  const isCacheRepoint = (t) => /^\s*UPDATE inventory_items SET source_plant_id =/.test(t)
  const isWinnerUpdate = (t) => /^\s*UPDATE plants SET\s+name = /.test(t)
  // Two events sharing a batch id: a drop set, so the batch carries archive_events_subset as well.
  const DUPES = [
    { id: 'e1', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
      created_at: '2026-08-01T08:00:00Z', metadata: { batch_id: 'B1' } },
    { id: 'e2', event_type: 'watering', event_date: '2026-08-01T08:00:00Z',
      created_at: '2026-08-01T08:00:01Z', metadata: { batch_id: 'B1' } },
  ]
  const runBatch = async ({ losers = [LOSER1], events = [] } = {}) => {
    const plants = [plantRow(WINNER), ...losers.map((id) => plantRow(id))]
    const sql = mockSql(baseResponses(plants, events))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: losers, ...ok })
    return { sql, r, tx: sql.lastTransaction() }
  }
  const label = (t) => {
    if (isLotLock(t)) return 'LOCK lots'
    if (isPlantingLock(t)) return 'LOCK plantings'
    const s = t.trim().replace(/\s+/g, ' ')
    if (s.startsWith('SELECT set_config')) return 'set_config'
    if (s.startsWith('SELECT archive_events_subset')) return 'archive_events_subset'
    const m = s.match(/^(UPDATE|DELETE FROM|INSERT INTO) (\w+)/)
    return m ? `${m[1].split(' ')[0]} ${m[2]}` : s.slice(0, 40)
  }

  it('locks the winner and every loser, by id, FOR NO KEY UPDATE', async () => {
    const { sql, tx } = await runBatch({ losers: [LOSER1, LOSER2] })
    expect(tx.filter(isPlantingLock)).toHaveLength(1)
    // Whole, clause by clause:
    //   · every id in the group — a loser left out is the row a parents write can still share-lock
    //     and link behind the merge's back, and the winner left out lets one add the winner to a lot
    //     between the prune and the repoint;
    //   · ORDER BY id — a parents write naming two of these plantings locks them by id;
    //   · FOR NO KEY UPDATE — conflicts with that write's FOR SHARE, is what the winner UPDATE and
    //     the losers' soft-delete take anyway, and lets through the key-share lock a link INSERT's
    //     foreign-key check takes (FOR UPDATE would not, and the reconcile inserts under it).
    expect(tx.find(isPlantingLock).replace(/\s+/g, ' ').trim())
      .toBe('SELECT id FROM plants WHERE id = ANY($0) ORDER BY id FOR NO KEY UPDATE')
    expect(tx.find(isPlantingLock).match(LOCK_CLAUSE)[1]).toBe('NO KEY UPDATE')
    const issued = sql.calls.filter((c) => c.text && isPlantingLock(c.text))
    expect(issued).toHaveLength(1)          // in the batch, and not also awaited on its own
    expect(issued[0].values).toHaveLength(1)
    expect([...issued[0].values[0]].sort()).toEqual([WINNER, LOSER1, LOSER2].sort())
  })

  for (const [name, events] of [['no drop set', []], ['a drop set', DUPES]]) {
    it(`takes them directly ahead of the three seed-lot statements and the winner UPDATE (${name})`, async () => {
      // Five consecutive statements, in this order. The prune, the cache repoint and the link
      // repoint each have to START after the lock is held: handler-first, they then run after the
      // parents write has committed and see its link and its cache value; one left above the lock
      // has already run by then, and that row or that column is the one left on a deleted planting.
      // And nothing else sits between the lock and the winner UPDATE, which is where the cutover
      // has always first locked a planting — so no other relation is locked any later than it was.
      const { tx } = await runBatch({ events })
      const k = tx.findIndex(isPlantingLock)
      expect(k).toBeGreaterThan(0)
      expect(tx.slice(k, k + 5).map((t) => (
        isPlantingLock(t) ? 'planting locks'
          : isPrune(t) ? 'link prune'
            : isCacheRepoint(t) ? 'cache repoint'
              : isRepoint(t) ? 'link repoint'
                : isWinnerUpdate(t) ? 'winner UPDATE' : label(t)
      ))).toEqual(['planting locks', 'link prune', 'cache repoint', 'link repoint', 'winner UPDATE'])
    })
  }

  it('writes no parent link, no lot and no planting between the lot lock and the planting locks', async () => {
    const { tx } = await runBatch({ losers: [LOSER1, LOSER2], events: DUPES })
    const lots = tx.findIndex(isLotLock)
    const plantings = tx.findIndex(isPlantingLock)
    expect(plantings).toBeGreaterThan(lots)        // lots, then plantings: the parents write's order
    const between = tx.slice(lots + 1, plantings)
    expect(between.length).toBeGreaterThan(20)     // not vacuous: the whole body of the cutover
    expect(between.filter(writesLinkOrLot)).toEqual([])
    expect(between.filter((t) => /\b(UPDATE|DELETE FROM|INSERT INTO)\s+(public\.)?plants\b/.test(t))).toEqual([])
  })

  it('leaves every other statement in the order the cutover has always had', async () => {
    // WHY THE LOCK IS NOT TAKEN EARLIER, pinned as an order. Three other writers take a row of one
    // of these relations and THEN a planting row: a photo delete (photos, then the planting that
    // features the photo), an event create (entity_memory, then the planting's status) and a
    // loss-event delete (event_log, then the planting's count). They queue behind a merge because
    // the merge takes those rows in the same order. Plantings locked above any of them is a
    // deadlock in which the gardener's request can be the one Postgres aborts.
    // This is the batch with the planting lock and the three seed-lot statements taken out: the
    // sequence the cutover had before either existed. A new surface goes ABOVE the planting lock;
    // only a statement that writes a seed lot or a parent link belongs under it.
    const { tx } = await runBatch({ losers: [LOSER1, LOSER2], events: DUPES })
    const seq = tx.map(label)
    const k = seq.indexOf('LOCK plantings')
    expect(seq.slice(0, k)).toEqual([
      'set_config', 'LOCK lots',
      'DELETE favorites', 'DELETE watch_impression', 'DELETE harvest_watch_dismissal',
      'DELETE ready_impression', 'DELETE watch_exclusion', 'DELETE findings',
      'UPDATE event_log', 'UPDATE photos', 'UPDATE preservation_log',
      'UPDATE critter_state', 'UPDATE critter_state', 'UPDATE evidence', 'UPDATE findings',
      'UPDATE treatment_association', 'UPDATE seen_event', 'UPDATE favorites',
      'UPDATE watch_impression', 'UPDATE harvest_watch_dismissal', 'UPDATE kitchen_batch_input',
      'UPDATE pantry_item', 'UPDATE preservation_source', 'UPDATE ready_impression',
      'UPDATE watch_exclusion', 'UPDATE plant_anchor_derivation', 'DELETE entity_memory',
      'archive_events_subset',
    ])
    expect(seq.slice(k)).toEqual([
      'LOCK plantings', 'UPDATE seed_lot_parent_planting', 'UPDATE inventory_items',
      'UPDATE seed_lot_parent_planting',
      'UPDATE plants', 'UPDATE plant_anchor_derivation', 'UPDATE plants',
      'INSERT entity_memory', 'INSERT merge_event',
    ])
  })

  it('declares the surface as a repoint whose collisions are soft-deleted', () => {
    expect(SURFACES.filter((s) => s.table === 'seed_lot_parent_planting')).toEqual([
      { table: 'seed_lot_parent_planting', column: 'plant_id', action: 'repoint', conflict: 'soft_delete' },
    ])
    // The cache it has to stay in step with is still a plain repoint, and still declared.
    expect(SURFACES).toContainEqual({ table: 'inventory_items', column: 'source_plant_id', action: 'repoint' })
  })

  it('retires the colliding links, then moves the links, then retires the losers — one transaction', async () => {
    const { sql, r, tx } = await run()
    expect(r.status).toBe(200)
    const prune = tx.findIndex(isPrune)
    const repoint = tx.findIndex(isRepoint)
    const cache = tx.findIndex((t) => /^\s*UPDATE inventory_items SET source_plant_id =/.test(t))
    const losersGone = tx.findIndex((t) => t.includes('UPDATE plants SET deleted_at = now()'))
    expect(prune).toBeGreaterThanOrEqual(0)
    expect(repoint).toBeGreaterThan(prune)
    // The member cache and the rows it summarises commit together or not at all.
    expect(cache).toBeGreaterThanOrEqual(0)
    expect(losersGone).toBeGreaterThan(repoint)
    expect(losersGone).toBeGreaterThan(cache)
    expect(sql.calls.filter((c) => c.transaction)).toHaveLength(1)
  })

  it('prunes with both arms, over live rows only, on lot AND role — and binds each arm to the right ids', async () => {
    const { sql, tx } = await run({}, [LOSER1, LOSER2])
    const prune = tx.find(isPrune)
    expect(prune).toMatch(/SET deleted_at = now\(\), updated_at = now\(\)/)
    expect(prune).toMatch(/WHERE l\.plant_id = ANY\(\$\d+\) AND l\.deleted_at IS NULL/)
    // w: the winner already has a live row for this lot in this role.
    expect(prune).toMatch(/FROM seed_lot_parent_planting w\s+WHERE w\.plant_id = \$\d+ AND w\.deleted_at IS NULL\s+AND w\.inventory_item_id = l\.inventory_item_id AND w\.role = l\.role/)
    // o: another loser's row of a lower id does. Without `o.id < l.id` two colliding losers retire
    // each other and the lot is left with no parent at all.
    expect(prune).toMatch(/FROM seed_lot_parent_planting o\s+WHERE o\.plant_id = ANY\(\$\d+\) AND o\.deleted_at IS NULL AND o\.id < l\.id\s+AND o\.inventory_item_id = l\.inventory_item_id AND o\.role = l\.role/)
    // The placeholders above say nothing about WHICH id went where, and a winner id bound to the
    // loser arm reads identically. In template order: l = the losers, w = the winner, o = the losers.
    const issued = sql.calls.find((c) => c.text && isPrune(c.text))
    expect(issued.values).toEqual([[LOSER1, LOSER2], WINNER, [LOSER1, LOSER2]])
  })

  it('never hard-deletes a parent link', async () => {
    // The other five prunes in the cutover are DELETEs over derived state. This one is provenance a
    // person recorded; a copy of ready_impression's statement with the table name changed would
    // destroy it and still satisfy an "is there a prune" check.
    const { tx } = await run({}, [LOSER1, LOSER2])
    expect(tx.some((t) => /DELETE FROM seed_lot_parent_planting/.test(t))).toBe(false)
    expect(SRC).not.toMatch(/DELETE FROM seed_lot_parent_planting/)
  })

  it('moves EVERY link row on a loser, retired ones included, and leaves the cache repoint as it was', async () => {
    const { sql, tx } = await run({}, [LOSER1, LOSER2])
    const repoint = tx.find(isRepoint)
    expect(repoint.replace(/\s+/g, ' ').trim())
      .toBe('UPDATE seed_lot_parent_planting SET plant_id = $0, updated_at = now() WHERE plant_id = ANY($1)')
    // A deleted_at filter here would strand the retired rows on a soft-deleted planting.
    expect(repoint).not.toMatch(/deleted_at/)
    expect(sql.calls.find((c) => c.text && isRepoint(c.text)).values).toEqual([WINNER, [LOSER1, LOSER2]])
    expect(tx).toContain('UPDATE inventory_items SET source_plant_id = $0 WHERE source_plant_id = ANY($1)')
  })

  it('reads the rows it is about to retire with the prune\'s own predicate', () => {
    // Two copies of one predicate, because the snapshot is serialised before the transaction it
    // describes and the driver takes no shared fragment. If they drift the snapshot names rows the
    // cutover did not retire, or misses ones it did, and a restore follows the snapshot.
    const norm = (s) => s.replace(/\s+/g, ' ').trim()
    const templates = [...SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => norm(m[1]))
    const read = templates.filter((t) => t.startsWith('SELECT l.id FROM seed_lot_parent_planting l'))
    const prune = templates.filter((t) => t.startsWith('UPDATE seed_lot_parent_planting l'))
    expect(read).toHaveLength(1)
    expect(prune).toHaveLength(1)
    const predicate = (t) => t.slice(t.indexOf(' WHERE l.plant_id'))
    expect(predicate(read[0])).toMatch(/^ WHERE l\.plant_id = ANY\(\$\{loserIds\}\) AND l\.deleted_at IS NULL AND \(EXISTS/)
    expect(predicate(read[0])).toBe(predicate(prune[0]))
  })

  it('snapshots every link row on a loser in repoints, and the retired ones by id', async () => {
    const { sql, r } = await run({
      'AS old_value FROM seed_lot_parent_planting': [
        { id: 'link-moved', old_value: LOSER1 }, { id: 'link-retired', old_value: LOSER1 },
      ],
      'SELECT l.id FROM seed_lot_parent_planting l': [{ id: 'link-retired' }],
    })
    expect(r.status).toBe(200)
    const { insert, snap } = snapshotOf(sql)
    // The house shape, a retired row included: where each row pointed before the cutover.
    expect(snap.repoints.filter((x) => x.table === 'seed_lot_parent_planting')).toEqual([
      { table: 'seed_lot_parent_planting', column: 'plant_id', row_id: 'link-moved', old_value: LOSER1 },
      { table: 'seed_lot_parent_planting', column: 'plant_id', row_id: 'link-retired', old_value: LOSER1 },
    ])
    // …and which of them the merge soft-deleted, which repoints alone cannot say.
    expect(snap.seed_lot_parents_pruned).toEqual(['link-retired'])
    expect(snap.schema_version).toBe(SNAPSHOT_VERSION)
    expect(insert.values).toContain(SNAPSHOT_VERSION)
    // Both rows count as repointed, the retired one too: it moves with the rest. Measured against a
    // run with no link rows, because this mock answers by substring and the two fingerprint needles
    // also answer the event_log and photos snapshot reads.
    const { r: bare } = await run()
    expect(r.body.rows_repointed).toBe(bare.body.rows_repointed + 2)
  })

  it('writes the retired list as an empty array, never an absent key, when nothing collided', async () => {
    // Absent would read the same as a version 1 snapshot, which never looked at this table.
    const { sql } = await run()
    expect(snapshotOf(sql).snap.seed_lot_parents_pruned).toEqual([])
  })

  it('takes both snapshot reads on their own, before any cutover statement is built', async () => {
    // A pre-state read issued inside the batch would run after the prune and record nothing.
    const { sql, tx } = await run()
    const at = (needle) => sql.calls.findIndex((c) => c.text?.includes(needle))
    const firstOfCutover = at("set_config('app.actor_clerk_sub'")
    expect(firstOfCutover).toBeGreaterThanOrEqual(0)
    for (const read of ['AS old_value FROM seed_lot_parent_planting', 'SELECT l.id FROM seed_lot_parent_planting l']) {
      expect(at(read), read).toBeGreaterThanOrEqual(0)
      expect(at(read), read).toBeLessThan(firstOfCutover)
      expect(tx.some((t) => t.includes(read)), read).toBe(false)
    }
  })

  it('names no role — each role is pruned against itself and moved as it stands', () => {
    // Release 1 writes and reads 'seed_parent' only, and the merge does neither: it compares
    // w.role = l.role and never supplies a value, so it is already right for a second role and can
    // never write one.
    expect(SRC).not.toMatch(/'seed_parent'|'pollen_parent'/)
  })

  it('does nothing to the table on a dry run', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok, dryRun: true })
    expect(r.body.dry_run).toBe(true)
    expect(sql.calls.some((c) => c.text?.includes('seed_lot_parent_planting'))).toBe(false)
  })

  it('answers 409, not 500, if the link index is tripped after all', async () => {
    // It cannot be on a quiet database: the prune leaves nothing to collide. A parent added to the
    // winner by another request between the prune and the repoint still can, the whole cutover rolls
    // back, and the caller is told so instead of being handed a 500.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    sql.transaction = async () => {
      throw new Error('duplicate key value violates unique constraint "uq_slpp_item_plant_role_live"')
    }
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/collided/)
    expect(r.body.detail).toMatch(/uq_slpp_item_plant_role_live/)
  })
})

// ── static-source guards ─────────────────────────────────────────────────────────────────────

describe('source guards', () => {
  it('never uses sql.unsafe or sql.query (neon 0.10.x has neither)', () => {
    expect(SRC).not.toMatch(/sql\.unsafe/)
    expect(SRC).not.toMatch(/sql\.query\(/)
  })

  it('has a literal UPDATE for every repoint surface in the policy map', () => {
    // Binds the declarative spec to the implementation: adding a surface to SURFACES without
    // wiring it fails here rather than silently no-op'ing against prod.
    for (const s of REPOINT_SURFACES) {
      const re = new RegExp(`UPDATE ${s.table}\\s+SET ${s.column} =`)
      expect(REPOINT_SRC, `missing repoint statement for ${s.table}.${s.column}`).toMatch(re)
    }
  })

  it('has a snapshot read for every repoint surface', () => {
    for (const s of REPOINT_SURFACES) {
      const re = new RegExp(`${s.column} AS old_value FROM ${s.table}`)
      expect(SRC, `missing snapshot read for ${s.table}.${s.column}`).toMatch(re)
    }
  })

  it('never repoints a surface marked leave', () => {
    for (const s of SURFACES.filter((x) => x.action === 'leave')) {
      const re = new RegExp(`UPDATE ${s.table}\\s+SET ${s.column} =`)
      expect(REPOINT_SRC, `${s.table}.${s.column} is marked leave but has a repoint`).not.toMatch(re)
    }
  })

  it('supersedes anchors rather than repointing them', () => {
    expect(SRC).toMatch(/UPDATE plant_anchor_derivation d\s+SET superseded_at = now\(\)/)
    expect(SRC).not.toMatch(/UPDATE plant_anchor_derivation\s+SET plant_id =/)
  })

  it('deletes loser entity_memory rather than merging it', () => {
    expect(SRC).toMatch(/DELETE FROM entity_memory WHERE plant_id = ANY/)
    expect(SRC).not.toMatch(/UPDATE entity_memory\s+SET plant_id =/)
  })

  it('routes the drop set through archive_events_subset, never a bare delete', () => {
    expect(SRC).toMatch(/archive_events_subset\(/)
    expect(SRC).not.toMatch(/DELETE FROM event_log/)
  })

  it('pins the snapshot version so a shape change is detectable', () => {
    // 1 -> 2: the snapshot gained a top-level key, seed_lot_parents_pruned (the parent links the
    // merge soft-deleted). The six repoint surfaces added before it only put new `table` values
    // inside `repoints`, which is not a shape change and did not move this.
    expect(SNAPSHOT_VERSION).toBe(2)
    expect(SRC).toMatch(/snapshot_version/)
  })

  it('declares a disposition for every surface (no unclassified entries)', () => {
    for (const s of SURFACES) {
      expect(['repoint', 'supersede', 'delete', 'leave']).toContain(s.action)
    }
  })

  it('gives every declared conflict the prune it names, and no other surface a prune', () => {
    // `conflict` was prose: six surfaces said 'skip' and nothing checked that a statement stood
    // behind any of them, or that one did not stand behind a surface that says nothing. Bound both
    // ways and by KIND, because the kind is the decision — 'skip' drops the loser's colliding row
    // (derived state), 'soft_delete' retires it (seed_lot_parent_planting: recorded provenance).
    // A surface that declared one and shipped the other would otherwise pass every guard here.
    const declared = REPOINT_SURFACES.filter((s) => s.conflict)
    expect(declared.map((s) => s.conflict).sort()).toEqual(
      ['skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'soft_delete'])
    for (const s of REPOINT_SURFACES) {
      expect([undefined, 'skip', 'soft_delete'], `${s.table}.${s.column}`).toContain(s.conflict)
      const drops = new RegExp(
        `DELETE FROM ${s.table} l\\s+WHERE l\\.${s.column} = ANY\\(\\$\\{loserIds\\}\\)`).test(SRC)
      const retires = new RegExp(
        `UPDATE ${s.table} l\\s+SET deleted_at = now\\(\\), updated_at = now\\(\\)\\s+`
        + `WHERE l\\.${s.column} = ANY\\(\\$\\{loserIds\\}\\) AND l\\.deleted_at IS NULL`).test(SRC)
      expect(drops, `${s.table}.${s.column}: a DELETE prune`).toBe(s.conflict === 'skip')
      expect(retires, `${s.table}.${s.column}: a soft-delete prune`).toBe(s.conflict === 'soft_delete')
    }
  })
})
