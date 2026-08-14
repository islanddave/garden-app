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

const __dirname = dirname(fileURLToPath(import.meta.url))

// A construct NAMED IN A COMMENT is not that construct — the reparent guard learned this the hard
// way, so assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')
const RAW = readFileSync(resolve(__dirname, 'merge.js'), 'utf8')
const SRC = decomment(RAW)

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
  'FROM plants\n    WHERE id = ANY': plants,
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

  it('collapses same-day water from DIFFERENT batches — the ledger double-credit guard', () => {
    // This is the B2 regression: batch dedup alone leaves both rows, the ledger folds credit per
    // row, and the app then under-waters a real plant.
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'watering', 'B2', '2026-08-01T19:00:00Z', '2026-08-01T19:00:00Z'),
    ])
    expect(out.droppedBatch).toEqual([])
    expect(out.droppedWater).toEqual(['b'])
    expect(out.kept).toEqual(['a'])
  })

  it('keeps water on different days', () => {
    const out = planDedup([
      ev('a', 'watering', 'B1', '2026-08-01T08:00:00Z', '2026-08-01T08:00:00Z'),
      ev('b', 'watering', 'B2', '2026-08-02T08:00:00Z', '2026-08-02T08:00:00Z'),
    ])
    expect(out.dropped).toEqual([])
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

  it('performs the whole cutover in ONE transaction', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(sql.calls.filter((c) => c.transaction)).toHaveLength(1)
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
      expect(SRC, `missing repoint statement for ${s.table}.${s.column}`).toMatch(re)
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
      expect(SRC, `${s.table}.${s.column} is marked leave but has a repoint`).not.toMatch(re)
    }
  })

  it('supersedes anchors rather than repointing them', () => {
    expect(SRC).toMatch(/UPDATE plant_anchor_derivation SET superseded_at = now\(\)/)
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
