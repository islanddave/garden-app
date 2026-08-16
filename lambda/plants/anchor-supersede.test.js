// anchor-supersede.test.js — V4-ANCHORSUPERSEDE-001, the write-path half of the supersede maintainer.
//
// THE DEFECT. public.plant_anchor_derivation (migrations/v4-anchorbase-001) holds an INVENTED anchor
// for a planting that had no sown_at / transplanted_at / planted_out_at. When a real date arrives
// the guess has been contradicted and the derivation must be RETIRED — never deleted, because the
// (guess, later truth) pair is the only accuracy measurement the add-date baseline tier will ever
// produce. The retiring UPDATE existed only in 0b-backfill.sql's second transaction and nothing ran
// it after 2026-08-12, so a planting could hold both a real date and a live derivation — precisely
// what lambda/harvests/anchorDerive.js's marking rule forbids, and what watch-route.js's `derived`
// CTE would then cite.
//
// TWO LAYERS, per this Lambda's convention (L-072). merge.js takes its sql handle as an argument, so
// its cutover is EXECUTED here against a recording mock and the real statement list is inspected.
// index.js imports neon/clerk/aws at module load and has no runtime seam, so its PUT is pinned by
// source assertions — the same shape project-less-write.test.js and event-source-status.test.js use.
// Row-level truth against real Postgres is proven by gates.yml's post_no_derived_beside_observed,
// re-armed continuous in this change and swept against live prod and staging.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeCore } from './merge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// A construct NAMED IN A COMMENT is not that construct — assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'))
const MERGE_SRC = decomment(readFileSync(resolve(__dirname, 'merge.js'), 'utf8'))

// Slice the PUT branch so an assertion cannot be satisfied by a match elsewhere in the file.
function branch(startNeedle, endNeedle) {
  const start = SRC.indexOf(startNeedle)
  expect(start, `branch start not found: ${startNeedle}`).toBeGreaterThan(-1)
  const end = SRC.indexOf(endNeedle, start + startNeedle.length)
  return SRC.slice(start, end > -1 ? end : SRC.length)
}
const PUT = branch("if (method === 'PUT') {", "if (method === 'DELETE') {")

describe('plants PUT retires a contradicted derivation in the same transaction', () => {
  it('the retire is IN the PUT transaction, not a separate best-effort call', () => {
    // In-transaction because a retire that can fail independently of the date write reintroduces
    // exactly the state this row exists to prevent: a real date beside a live guess.
    expect(PUT).toMatch(/_stmts\.push\(sql`\s*UPDATE public\.plant_anchor_derivation d/)
  })

  it('runs AFTER the plants UPDATE, so it sees the date this request just wrote', () => {
    const write = PUT.indexOf('UPDATE public.garden_node p')
    const retire = PUT.indexOf('UPDATE public.plant_anchor_derivation d')
    const exec = PUT.indexOf('sql.transaction(_stmts)')
    expect(write).toBeGreaterThan(-1)
    expect(retire).toBeGreaterThan(write)
    expect(exec).toBeGreaterThan(retire)
  })

  it('leaves the response row at _txr[1] — the retire is pushed, never spliced in front', () => {
    // The handler reads the updated planting positionally. A statement inserted ahead of the
    // garden_node UPDATE would return the retire's (empty) result as the planting and 404 every
    // successful edit.
    expect(PUT).toMatch(/const _txr = await sql\.transaction\(_stmts\);\s*const rows = _txr\[1\];/)
  })

  it('retires only for a planting that now holds an observed anchor — all three columns', () => {
    const stmt = PUT.slice(PUT.indexOf('UPDATE public.plant_anchor_derivation d'))
    expect(stmt).toMatch(/gp\.sown_at IS NOT NULL/)
    expect(stmt).toMatch(/gp\.transplanted_at IS NOT NULL/)
    expect(stmt).toMatch(/gp\.planted_out_at IS NOT NULL/)
    // Scoped to the planting this request wrote. A retire without the plant_id predicate would
    // sweep the whole table on every edit — correct rows, catastrophic blast radius.
    expect(stmt).toMatch(/WHERE d\.plant_id = \$\{plantId\}/)
  })

  it('a PUT that sets no date leaves the derivation live', () => {
    // The predicate is evaluated in SQL against the post-update row rather than mirrored in JS from
    // body + clear + cur. That is deliberate: a JS mirror is one edit to the SET-list away from
    // disagreeing with it, and a disagreement here means a live derivation nobody retires. So the
    // guarantee is the EXISTS gate, and the property to hold is that the gate is ANDed, not ORed.
    const stmt = PUT.slice(PUT.indexOf('UPDATE public.plant_anchor_derivation d'))
    expect(stmt).toMatch(/AND EXISTS \(/)
    expect(stmt).not.toMatch(/OR EXISTS \(/)
  })

  it('is idempotent — superseded_at IS NULL guards a second write', () => {
    const stmt = PUT.slice(PUT.indexOf('UPDATE public.plant_anchor_derivation d'))
    expect(stmt).toMatch(/AND d\.superseded_at IS NULL/)
  })

  it('RETIRES, never deletes, and says why', () => {
    const stmt = PUT.slice(PUT.indexOf('UPDATE public.plant_anchor_derivation d'))
    expect(stmt).toMatch(/superseded_by = 'observed_anchor'/)
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+(public\.)?plant_anchor_derivation/i)
  })

  it('aliases the EXISTS subquery gp, not p — a p here would enter the SELECT-block census', () => {
    // select-columns.test.js counts SELECT ... FROM public.garden_node p blocks and asserts every
    // one carries the full client-facing column set. An alias collision would add a fifth block
    // holding `1` and fail 24 unrelated assertions.
    const stmt = PUT.slice(PUT.indexOf('UPDATE public.plant_anchor_derivation d'))
    expect(stmt).toMatch(/SELECT 1 FROM public\.garden_node gp/)
  })
})

// ── merge cutover — executed ──────────────────────────────────────────────────────────────────────
// Tagged-template recorder, same shape as merge.test.js's: substring-matched canned responses,
// `.transaction()` records the batch and answers per statement.
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

const plantRow = (id, over = {}) => ({
  id, name: `p-${id.slice(0, 4)}`, status: 'vegetative', quantity: 1, qty_initial: 1,
  qty_current: null, qty_harvested: 0, qty_lost: 0, loss_cause: null,
  sown_at: null, germinated_at: null, transplanted_at: null, planted_out_at: null,
  variety_id: null, project_id: null, location_id: null, notes: null, featured_photo_id: null,
  container_type: null, container_size: null, archived_at: null, version: 1,
  workspace_id: '00000000-0000-0000-0000-000000000001', created_by: 'user_a', ...over,
})

const baseResponses = (plants, extra = {}) => ({
  'FROM merge_event WHERE op_id': [],
  'FROM plants p\n    LEFT JOIN plant_projects pp': plants,
  'FROM event_log\n    WHERE plant_id = ANY': [],
  'FROM event_log WHERE plant_id = ANY': [{ rows: 0, max_updated_at: null }],
  'FROM photos WHERE plant_id = ANY': [{ rows: 0, max_updated_at: null }],
  'FROM harvest_log h JOIN event_log e': [{ rows: 0, max_updated_at: null }],
  'FROM plants WHERE id = ANY': [{ rows: plants.length, max_updated_at: null }],
  'INSERT INTO merge_event': [{ id: 'merge-evt-1', merged_at: '2026-08-15T00:00:00Z' }],
  ...extra,
})

const ok = { opId: 'op1', userId: 'user_a', householdIds: ['user_a'] }
const retireStmt = (sql) => sql.lastTransaction()
  .filter((t) => /UPDATE plant_anchor_derivation/.test(t) && /d\.plant_id = \$/.test(t))

describe('merge cutover retires the WINNER derivation when the merge hands it a real date', () => {
  it('emits the winner retire, ordered after the phenology write it depends on', async () => {
    // The ghost-group shape: the winner has no anchor, a loser does, and resolvePhenology gives the
    // survivor the loser's date. Before this change the losers' derivations were superseded and the
    // winner's — now contradicted by a date it did not previously have — stayed live.
    const plants = [plantRow(WINNER), plantRow(LOSER1, { transplanted_at: '2026-07-23' })]
    const sql = mockSql(baseResponses(plants))
    const r = await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(r.status).toBe(200)
    const txn = sql.lastTransaction()
    const winnerWrite = txn.findIndex((t) => /UPDATE plants SET\n/.test(t) && /transplanted_at =/.test(t))
    const retire = txn.findIndex((t) => /UPDATE plant_anchor_derivation/.test(t) && /d\.plant_id = \$/.test(t))
    expect(winnerWrite).toBeGreaterThan(-1)
    expect(retire).toBeGreaterThan(winnerWrite)
    const stmt = txn[retire]
    expect(stmt).toMatch(/wp\.sown_at IS NOT NULL/)
    expect(stmt).toMatch(/wp\.transplanted_at IS NOT NULL/)
    expect(stmt).toMatch(/wp\.planted_out_at IS NOT NULL/)
    expect(stmt).toMatch(/AND d\.superseded_at IS NULL/)     // idempotent
    expect(stmt).toMatch(/superseded_by = 'observed_anchor'/)
    expect(stmt).not.toMatch(/DELETE/i)                      // retire, never erase
  })

  it('records the winner row in the snapshot so a restore can put it back', async () => {
    const plants = [plantRow(WINNER), plantRow(LOSER1, { sown_at: '2026-05-04' })]
    const sql = mockSql(baseResponses(plants, {
      'FROM plant_anchor_derivation WHERE plant_id = ANY': [{ id: 'anchor-w' }],
    }))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    const probe = sql.calls.find((c) => c.text && /FROM plant_anchor_derivation WHERE plant_id = ANY/.test(c.text))
    expect(probe.values[0]).toContain(WINNER)
    expect(probe.values[0]).toContain(LOSER1)
    const evt = sql.lastTransaction().find((t) => /INSERT INTO merge_event/.test(t))
    expect(evt).toBeTruthy()
  })

  it('does NOT claim the winner as a supersede target when no sibling has any date', async () => {
    // resolvePhenology returns null when nothing is set, so the winner gains nothing and its
    // derivation — still uncontradicted — must stay live. Snapshotting it as retired would make a
    // restore resurrect a row that was never touched.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    const probe = sql.calls.find((c) => c.text && /FROM plant_anchor_derivation WHERE plant_id = ANY/.test(c.text))
    expect(probe.values[0]).toEqual([LOSER1])
    expect(probe.values[0]).not.toContain(WINNER)
  })

  it('still emits the predicated retire on that merge — SQL decides, not JS', async () => {
    // The statement goes out either way and the EXISTS gate answers. A JS-side `if` would be a
    // second copy of the rule, and the copy that drifts is the one that silently stops retiring.
    const plants = [plantRow(WINNER), plantRow(LOSER1)]
    const sql = mockSql(baseResponses(plants))
    await mergeCore(sql, { winnerId: WINNER, loserIds: [LOSER1], ...ok })
    expect(retireStmt(sql)).toHaveLength(1)
  })

  it('never deletes from the derivation table anywhere in merge.js', () => {
    expect(MERGE_SRC).not.toMatch(/DELETE\s+FROM\s+plant_anchor_derivation/i)
  })
})
