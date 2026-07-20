// V4-OVERLAY-001 Slice 2 — draftStash lib unit tests (§4 overlay draft preservation).
import { describe, it, expect, beforeEach } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import { readDraft, writeDraft, clearDraft, draftKey } from '../lib/draftStash.js'

describe('draftStash', () => {
  beforeEach(() => { sessionStorage.clear() })

  it('round-trips a draft object', () => {
    writeDraft('logmany', { eventType: 'flowering', scope: { type: 'all' } })
    expect(readDraft('logmany')).toEqual({ eventType: 'flowering', scope: { type: 'all' } })
  })

  it('returns null when no draft is stored', () => {
    expect(readDraft('logone')).toBeNull()
  })

  it('clears a draft', () => {
    writeDraft('logone', { form: { notes: 'hi' } })
    clearDraft('logone')
    expect(readDraft('logone')).toBeNull()
  })

  it('namespaces keys per route so /log and /log/many drafts do not collide', () => {
    writeDraft('logone', { a: 1 })
    writeDraft('logmany', { b: 2 })
    expect(readDraft('logone')).toEqual({ a: 1 })
    expect(readDraft('logmany')).toEqual({ b: 2 })
    expect(draftKey('logone')).not.toBe(draftKey('logmany'))
  })

  it('rejects a record written under a different schema version (forward-safe)', () => {
    sessionStorage.setItem(draftKey('logone'), JSON.stringify({ v: 99, data: { notes: 'stale' } }))
    expect(readDraft('logone')).toBeNull()
  })

  it('tolerates corrupt JSON without throwing', () => {
    sessionStorage.setItem(draftKey('logone'), '{not json')
    expect(() => readDraft('logone')).not.toThrow()
    expect(readDraft('logone')).toBeNull()
  })
})
