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
      if (/^\s*UPDATE (event_log|photos|preservation_log|critter_state|evidence|findings|seen_event|favorites|watch_impression|harvest_watch_dismissal)/.test(stmt)) {
        expect(stmt).toMatch(/WHERE .*= ANY\(\$\d+\)|WHERE .*= ANY/)
      }
    }
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
    expect(SNAPSHOT_VERSION).toBe(1)
    expect(SRC).toMatch(/snapshot_version/)
  })

  it('declares a disposition for every surface (no unclassified entries)', () => {
    for (const s of SURFACES) {
      expect(['repoint', 'supersede', 'delete', 'leave']).toContain(s.action)
    }
  })
})
