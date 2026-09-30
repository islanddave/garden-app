// tests/integration/stage-date-undo.int.test.js — review I-N1, against real Postgres (lane undofix).
//
// The unit suite pins what the CLIENT sends (PutUpCheckOnIt*, and PutUpStageEdit, which also runs every
// Undo body through the Lambda's real stagePatchError). This file pins that the ROUTE and the TABLE take
// exactly those bodies — chk_ksl_entered_pairing ((entered_at IS NULL) = (entered_precision IS NOT
// DISTINCT FROM 'unknown')) and chk_ksl_entered_precision included:
//   · the F check-in and move rows carry their date and 'exact' (goingNow.checkInBody), stored as sent;
//   · a row stored with NO precision — every 1a-era row, and any body still sent without one (the route's
//     pre-1b path) — takes a date edit AND the Undo StageEditSheet.stagePatch builds for it, {old date,
//     'exact'}, and reads its old date again. The body the client used to send, {old date, null}, is
//     the 400 the review found.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import { makeHousehold, useHousehold, call, seedBatch, seedPlace } from './_kitchenF.js'

const H = makeHousehold('undo')
useHousehold(H, beforeAll, afterAll)
const stages = (batchId) => `/api/kitchen-batches/${batchId}/stages`
const readStage = async (id) => (await directSql`SELECT entered_at, entered_precision FROM kitchen_stage_log WHERE id = ${id}`)[0]

describe('stage dates — the F client\'s shapes, stored and undone (review I-N1)', () => {
  it('a check-in and a move sent with their date and "exact" are stored exactly as sent', async () => {
    const b = await seedBatch(H.DAVE, { label: 'kf undo kraut' })
    const place = await seedPlace(H.DAVE, { kind: 'fridge' })
    const at = new Date(Date.now() - 60_000).toISOString()
    const t = await call(H.DAVE, 'POST', stages(b.id), { stage_kind: 'tended', acts: ['skimmed'], note: 'film', entered_at: at, entered_precision: 'exact' })
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    const m = await call(H.DAVE, 'POST', stages(b.id), { stage_kind: 'moved', storage_location_id: place, label: 'Moved to the fridge', entered_at: at, entered_precision: 'exact' })
    expect(m.status, JSON.stringify(m.body)).toBe(201)
    for (const id of [t.body.stage.id, m.body.stage.id]) {
      const row = await readStage(id)
      expect(row.entered_precision).toBe('exact')
      expect(new Date(row.entered_at).toISOString()).toBe(at)
    }
  })

  it.each(['tended', 'moved'])('a %s row stored with NO precision: the date edit, then its Undo, both land', async (kind) => {
    const b = await seedBatch(H.DAVE, { label: `kf undo ${kind}` })
    const body = kind === 'moved'
      ? { stage_kind: 'moved', storage_location_id: await seedPlace(H.DAVE, { kind: 'fridge' }), label: 'Moved to the fridge' }
      : { stage_kind: 'tended', note: 'written the pre-1b way' }
    const s = await call(H.DAVE, 'POST', stages(b.id), body)                      // no precision: the legacy path
    expect(s.status, JSON.stringify(s.body)).toBe(201)
    const id = s.body.stage.id
    const old = (await readStage(id)).entered_at
    expect((await readStage(id)).entered_precision).toBeNull()                    // green control: really legacy-shaped
    const yesterday = new Date(Date.now() - 86_400_000); yesterday.setHours(0, 0, 0, 0)
    const fwd = await call(H.DAVE, 'PATCH', `${stages(b.id)}/${id}`, { entered_at: yesterday.toISOString(), entered_precision: 'day' })
    expect(fwd.status, JSON.stringify(fwd.body)).toBe(200)
    // The body the client used to send back is refused — the defect, kept visible.
    const broken = await call(H.DAVE, 'PATCH', `${stages(b.id)}/${id}`, { entered_at: new Date(old).toISOString(), entered_precision: null })
    expect(broken.status).toBe(400)
    // The Undo StageEditSheet.stagePatch builds for a stored date with no word: that date, 'exact'.
    const undo = await call(H.DAVE, 'PATCH', `${stages(b.id)}/${id}`, { entered_at: new Date(old).toISOString(), entered_precision: 'exact' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    const after = await readStage(id)
    expect(new Date(after.entered_at).getTime()).toBe(new Date(old).getTime())
    expect(after.entered_precision).toBe('exact')
  })
})
