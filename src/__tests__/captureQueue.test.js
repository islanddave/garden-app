import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import {
  enqueueRecording,
  enqueueText,
  list,
  get,
  update,
  markTranscribed,
  markHandedOff,
  getUnprocessedDepth,
  getTotalCount,
  getOldestUnprocessedAgeMs,
  STATUS,
  KIND,
} from '../lib/captureQueue.js'

// fake-indexeddb persists across tests within a single process; reset by
// deleting the database before each test.
async function resetDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('gardenAppFieldCapture')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

describe('captureQueue (Inc 2 Bite 4)', () => {
  beforeEach(async () => { await resetDb() })

  it('enqueues a text record with status=queued + stable id', async () => {
    const rec = await enqueueText({ text: 'tomatoes flowering' })
    expect(rec.id).toBeTruthy()
    expect(rec.kind).toBe(KIND.TEXT)
    expect(rec.text).toBe('tomatoes flowering')
    expect(rec.status).toBe(STATUS.QUEUED)
    expect(rec.blob).toBe(null)
    expect(rec.mime).toBe(null)
    expect(rec.mode).toBe('field')
  })

  it('enqueues an audio record with status=recorded + carries blob/mime/duration', async () => {
    const blob = new Blob(['fake-audio-bytes'], { type: 'audio/webm' })
    const rec = await enqueueRecording({ blob, mime: 'audio/webm', durationMs: 4200 })
    expect(rec.id).toBeTruthy()
    expect(rec.kind).toBe(KIND.AUDIO)
    expect(rec.status).toBe(STATUS.RECORDED)
    expect(rec.mime).toBe('audio/webm')
    expect(rec.durationMs).toBe(4200)
    expect(rec.blob).toBeTruthy()
  })

  it('list() returns records ordered by capturedAt ascending', async () => {
    const a = await enqueueText({ text: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await enqueueText({ text: 'second' })
    await new Promise((r) => setTimeout(r, 5))
    const c = await enqueueText({ text: 'third' })
    const all = await list()
    expect(all.length).toBe(3)
    expect(all[0].id).toBe(a.id)
    expect(all[1].id).toBe(b.id)
    expect(all[2].id).toBe(c.id)
  })

  it('get() returns a record by id, null when absent', async () => {
    const r = await enqueueText({ text: 'x' })
    const found = await get(r.id)
    expect(found.id).toBe(r.id)
    const missing = await get('no-such-id')
    expect(missing).toBe(null)
  })

  it('update() merges patch and protects id', async () => {
    const r = await enqueueText({ text: 'x' })
    const updated = await update(r.id, { status: STATUS.TRANSCRIBED, text: 'x-edited', id: 'ATTACKER' })
    expect(updated.id).toBe(r.id)              // id protected
    expect(updated.text).toBe('x-edited')
    expect(updated.status).toBe(STATUS.TRANSCRIBED)
    const fetched = await get(r.id)
    expect(fetched.status).toBe(STATUS.TRANSCRIBED)
  })

  it('markTranscribed sets text + status', async () => {
    const blob = new Blob(['x'], { type: 'audio/webm' })
    const r = await enqueueRecording({ blob, mime: 'audio/webm', durationMs: 1000 })
    await markTranscribed(r.id, 'tomatoes are yellowing')
    const fetched = await get(r.id)
    expect(fetched.status).toBe(STATUS.TRANSCRIBED)
    expect(fetched.text).toBe('tomatoes are yellowing')
  })

  it('markHandedOff sets status only', async () => {
    const r = await enqueueText({ text: 'x' })
    await markHandedOff(r.id)
    const fetched = await get(r.id)
    expect(fetched.status).toBe(STATUS.HANDED_OFF)
  })

  it('getUnprocessedDepth excludes handed_off records', async () => {
    const a = await enqueueText({ text: 'a' })
    const b = await enqueueText({ text: 'b' })
    await enqueueText({ text: 'c' })
    await markHandedOff(b.id)
    expect(await getUnprocessedDepth()).toBe(2)
    await markHandedOff(a.id)
    expect(await getUnprocessedDepth()).toBe(1)
  })

  it('getTotalCount counts all statuses', async () => {
    const a = await enqueueText({ text: 'a' })
    await enqueueText({ text: 'b' })
    await markHandedOff(a.id)
    expect(await getTotalCount()).toBe(2)
  })

  it('getOldestUnprocessedAgeMs returns null when empty', async () => {
    expect(await getOldestUnprocessedAgeMs()).toBe(null)
  })

  it('getOldestUnprocessedAgeMs ignores handed_off records', async () => {
    const old = await enqueueText({ text: 'old' })
    await new Promise((r) => setTimeout(r, 30))
    await enqueueText({ text: 'newer' })
    await markHandedOff(old.id)
    const age = await getOldestUnprocessedAgeMs()
    expect(age).toBeLessThan(30)              // newer is now the oldest unprocessed
  })

  it('enqueueRecording requires blob (throws if absent)', async () => {
    await expect(enqueueRecording({})).rejects.toThrow()
  })

  it('enqueueText requires text (throws if absent)', async () => {
    await expect(enqueueText({})).rejects.toThrow()
    await expect(enqueueText({ text: '' })).rejects.toThrow()
  })

  it('L-108 durability: enqueued audio blob survives a connection close + re-open cycle', async () => {
    const blob = new Blob(['durability-check'], { type: 'audio/webm' })
    const rec = await enqueueRecording({ blob, mime: 'audio/webm', durationMs: 1234 })
    // Each captureQueue function opens + closes its own connection; the second
    // call is the re-open. Reading back the record proves the write committed.
    const fetched = await get(rec.id)
    expect(fetched).toBeTruthy()
    expect(fetched.kind).toBe(KIND.AUDIO)
    expect(fetched.durationMs).toBe(1234)
    expect(fetched.mime).toBe('audio/webm')
  })
})
