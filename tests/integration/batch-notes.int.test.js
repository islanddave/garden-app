// batch-notes.int.test.js — V4-EVENTSEL-005, ONE batch-level note, against a real database.
//
// WRITTEN-BUT-UNRUN as of 2026-08-14: the integration suite needs its own vitest config plus a
// FRESH ephemeral Neon branch per full run, neither of which is available in a lane worktree. It
// has never been executed. Do not read a green unit suite as evidence for anything in this file.
//
// Why it has to be integration. The unit-side coverage
// (lambda/events/batch-notes.test.js) proves the validator's behaviour and proves, by source, that
// `notes` is in the INSERT column list and that `${batchNotes}::text` is bound in the SELECT. It
// cannot prove the only claim that actually matters to the user: that the note LANDS, on EVERY row
// of the batch, with the right value and the right NULL-vs-empty-string distinction. That is
// database-shaped. Counting rows after a real POST is the only honest proof.
//
// Three things are asserted that source text cannot reach:
//   1. COUNT PARITY — the number of rows carrying the note equals the batch's item_count. A test
//      that only checked "row 1 has the note" would pass an INSERT that somehow bound per-row.
//   2. NULL, NOT '' — a blank note must produce SQL NULL. Every read surface in the app tests
//      `notes` for truthiness or renders it raw, so an empty string is an "event with a note" that
//      displays blank. Prod held zero such rows on 2026-08-14 and this 500x fan-out path must not
//      introduce the first batch of them.
//   3. THE 42P18 — a batch with no note binds a NULL parameter. Without the ::text cast that is
//      "could not determine data type of parameter" and every note-less batch 500s. Source can see
//      the cast; only a real Postgres can prove the statement executes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'
import { MAX_NOTES_LEN } from '../../lambda/events/validators.js'

const RUN = testRunId()
const USER = `user_int_bnote_${RUN}`

let projectId
let plantA
let plantB
let plantC

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-bnote-' + RUN, createdBy: USER })).id
  const mk = async (n) =>
    (await directSql`INSERT INTO plants (project_id, name, created_by)
       VALUES (${projectId}, ${n + '-' + RUN}, ${USER}) RETURNING id`)[0].id
  plantA = await mk('bnote-A')
  plantB = await mk('bnote-B')
  plantC = await mk('bnote-C')
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM event_batches WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

let seq = 0
const postBatch = (over = {}) =>
  callHandler(handler, {
    method: 'POST', path: '/api/events/batch', userId: USER,
    body: {
      idempotency_key: `bnote-${RUN}-${++seq}`,
      event_type: 'fertilizing',
      scope: { type: 'project', project_id: projectId },
      ...over,
    },
  })

// notes IS NULL and notes = '' are DIFFERENT rows and the difference is the whole point of (2), so
// they are counted separately rather than folded into a truthiness test.
const noteCensus = async (batchId) =>
  (await directSql`
    SELECT count(*)::int                                        AS total,
           count(*) FILTER (WHERE notes IS NULL)::int           AS nulls,
           count(*) FILTER (WHERE notes = '')::int              AS empties,
           count(DISTINCT notes)::int                           AS distinct_notes,
           min(notes)                                           AS any_note
      FROM event_log
     WHERE metadata->>'batch_id' = ${batchId} AND deleted_at IS NULL`)[0]

describe('V4-EVENTSEL-005 — one note, every row', () => {
  it('writes the note to EVERY row of the batch, and to exactly as many rows as the batch counted', async () => {
    const NOTE = 'side-dressed the whole bed with blood meal'
    const res = await postBatch({ notes: NOTE })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(3)

    const c = await noteCensus(res.body.batch_id)
    // Count parity is the assertion. Not "a row has it" — ALL of them, and no more than all.
    expect(c.total).toBe(res.body.count)
    expect(c.nulls).toBe(0)
    expect(c.distinct_notes).toBe(1)
    expect(c.any_note).toBe(NOTE)

    // And the batch row agrees with the event rows, so a partial write cannot hide behind a count
    // the client was told.
    const [batchRow] = await directSql`
      SELECT item_count FROM event_batches WHERE id = ${res.body.batch_id}`
    expect(batchRow.item_count).toBe(c.total)
  })

  it('trims the stored note (the client trims too; the server is the one that must)', async () => {
    const res = await postBatch({ notes: '   frost cloth on overnight  \n ' })
    expect(res.status).toBe(200)
    const c = await noteCensus(res.body.batch_id)
    expect(c.any_note).toBe('frost cloth on overnight')
    expect(c.nulls).toBe(0)
  })

  it('a WHITESPACE-ONLY note stores SQL NULL, not an empty string', async () => {
    const res = await postBatch({ notes: '   \n\t ' })
    expect(res.status).toBe(200)
    const c = await noteCensus(res.body.batch_id)
    expect(c.total).toBe(3)
    expect(c.empties).toBe(0)   // the defect class, stated as a number
    expect(c.nulls).toBe(3)
  })

  it('a batch with NO note at all still succeeds — the untyped-NULL parameter does not 42P18', async () => {
    // Without the ::text cast on ${batchNotes} this is a 500 on every note-less batch, which is
    // ~all of them. Source can see the cast; only a real Postgres proves the statement runs.
    const res = await postBatch()
    expect(res.status).toBe(200)
    const c = await noteCensus(res.body.batch_id)
    expect(c.total).toBe(3)
    expect(c.nulls).toBe(3)
    expect(c.empties).toBe(0)
  })

  it('rejects an over-length note BEFORE any row is written', async () => {
    const before = (await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE created_by = ${USER}`)[0].n
    const res = await postBatch({ notes: 'x'.repeat(MAX_NOTES_LEN + 1) })
    expect(res.status).toBe(400)
    const after = (await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE created_by = ${USER}`)[0].n
    expect(after).toBe(before)
  })

  it('rejects a non-string note BEFORE any row is written', async () => {
    const before = (await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE created_by = ${USER}`)[0].n
    const res = await postBatch({ notes: { text: 'nope' } })
    expect(res.status).toBe(400)
    const after = (await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE created_by = ${USER}`)[0].n
    expect(after).toBe(before)
  })

  it('there is no partial-batch state for a note to survive in: the INSERT is one statement in one tx', async () => {
    // The brief asks what happens to the note when "some rows fail". The answer is that the batch
    // has no per-row failure mode: all N rows come from a single INSERT ... SELECT inside
    // sql.transaction([...]), so the batch either commits whole (every row carries the note) or
    // aborts whole (no rows, no batch row, no note). Demonstrated by excluding a planting: the
    // survivors all carry the note and the excluded one contributes no row at all — a partial
    // SCOPE, which is the only partiality this endpoint has, still yields a total write.
    const res = await postBatch({ notes: 'weeded, mulched', exclude_plant_ids: [plantC] })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    const c = await noteCensus(res.body.batch_id)
    expect(c.total).toBe(2)
    expect(c.nulls).toBe(0)
    expect(c.distinct_notes).toBe(1)
    const [excluded] = await directSql`
      SELECT count(*)::int AS n FROM event_log
       WHERE metadata->>'batch_id' = ${res.body.batch_id} AND plant_id = ${plantC}`
    expect(excluded.n).toBe(0)
  })

  it('an idempotent re-hit returns the ORIGINAL note — a replayed key does not rewrite stored prose', async () => {
    // Idempotency means the second call is a no-op, including for notes. A re-hit that UPDATEd the
    // note would let a retry with different text silently rewrite an already-committed batch.
    const key = `bnote-${RUN}-idem`
    const first = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: { idempotency_key: key, event_type: 'pruning',
              scope: { type: 'project', project_id: projectId }, notes: 'first note' },
    })
    expect(first.status).toBe(200)
    const second = await callHandler(handler, {
      method: 'POST', path: '/api/events/batch', userId: USER,
      body: { idempotency_key: key, event_type: 'pruning',
              scope: { type: 'project', project_id: projectId }, notes: 'SECOND note' },
    })
    expect(second.status).toBe(200)
    expect(second.body.batch_id).toBe(first.body.batch_id)
    expect(second.body.idempotent).toBe(true)

    const c = await noteCensus(first.body.batch_id)
    expect(c.distinct_notes).toBe(1)
    expect(c.any_note).toBe('first note')
  })

  it('the note is readable back through the feed, which is where the user will look for it', async () => {
    // e.notes is already in the feed SELECT list. Asserting it end-to-end is what distinguishes
    // "the column was written" from "the note is visible", and the second is the actual ticket.
    const NOTE = 'netting over the whole row'
    const res = await postBatch({ notes: NOTE })
    expect(res.status).toBe(200)
    const feed = await callHandler(handler, { method: 'GET', path: '/api/events/feed', userId: USER })
    expect(feed.status).toBe(200)
    const mine = feed.body.events.filter((e) => e.batch_id === res.body.batch_id)
    expect(mine.length).toBeGreaterThan(0)
    for (const e of mine) expect(e.notes).toBe(NOTE)
  })
})
