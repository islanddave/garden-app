// V5-VOICECARE-001 — the network half: R1 dry run, R8 write, R9 undo, with an injected apiFetch.
//
// The stub below honours src/lib/api.js's contract exactly — resolve with the parsed body, throw an
// Error carrying .status and .body on a non-2xx, throw with .status 0 on a timeout — so what passes
// here is what the app's own fetch wrapper would hand this module.
import { describe, it, expect, vi } from 'vitest'
import { classifyCareCommand } from '../lib/voiceCareGrammar.js'
import {
  prepareCarePlan, fetchCareScopeSet, writeCarePlan, undoCareBatch, careWriteBody, mintIdempotencyKey,
  loggedSpoken, CARE_INPUT_SOURCE, SCOPE_CHANGED_SPOKEN, NOT_CONFIRMED_SPOKEN, REJECTED_SPOKEN,
  UNDONE_SPOKEN, UNDO_FAILED_SPOKEN, careAliasUses,
} from '../lib/voiceCareBatch.js'
import { indexAliases, recordAliasUse, MAX_ALIAS_USES } from '../lib/voiceAliases.js'
import { looseKey } from '../lib/comboboxInput.js'
import { validateBatchBody, buildBatchMetadataPlan } from '../../lambda/events/validators.js'
import { LOCATIONS, U, byName, dryRunResponse, locationByPath } from './voiceCare.fixture.js'

const IN_GROUND = locationByPath('Pasture > In-Ground')

function httpError(status, body) {
  const e = new Error(body?.error ?? `HTTP ${status}`)
  e.status = status
  e.body = body
  return e
}

// A fake server over the fixture: dry runs answer from the snapshot, writes answer from `onWrite`.
function fakeApi({ onWrite, onDelete, dryRunFails = false } = {}) {
  const calls = []
  const apiFetch = vi.fn(async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ path, method: opts.method, body })
    if (opts.method === 'DELETE') return onDelete ? onDelete(path) : { undone: true }
    if (body?.dry_run) {
      if (dryRunFails) throw httpError(0, null)
      return dryRunResponse(body.scope.location_id)
    }
    return onWrite ? onWrite(body, calls) : { batch_id: 'b-1', count: body.scope.plant_ids.length, event_ids: [] }
  })
  return { apiFetch, calls }
}

const DAVE = 'fed all pasture in ground except zephyr, crimson sweet, king richard'
const prepare = (transcript, apiFetch, extra = {}) => prepareCarePlan(apiFetch, {
  care: classifyCareCommand(transcript), plantings: U, locations: LOCATIONS, mintKey: () => 'key-1', ...extra,
})

describe('R1 — fetchCareScopeSet', () => {
  it('asks for a dry run of the whole area as scope space, and returns S', async () => {
    const { apiFetch, calls } = fakeApi()
    const set = await fetchCareScopeSet(apiFetch, { eventType: 'fertilizing', locationId: IN_GROUND.id })
    expect(calls[0]).toEqual({
      path: '/api/events/batch', method: 'POST',
      body: { dry_run: true, event_type: 'fertilizing', scope: { type: 'space', location_id: IN_GROUND.id } },
    })
    expect(set).toMatchObject({ locationId: IN_GROUND.id, count: 24, capped: false })
    expect(set.plantings).toHaveLength(24)
  })

  it('throws on a body with no plant list — an unreadable preview is not an empty area', async () => {
    await expect(fetchCareScopeSet(async () => ({ count: 0 }), { eventType: 'watering', locationId: 'x' }))
      .rejects.toThrow(/plant list/)
    await expect(fetchCareScopeSet(async () => null, { eventType: 'watering', locationId: 'x' })).rejects.toThrow()
  })

  it('carries the server cap through', async () => {
    const set = await fetchCareScopeSet(async () => ({ count: 500, capped: true, plantings: [] }), { eventType: 'watering', locationId: 'x' })
    expect(set.capped).toBe(true)
  })
})

describe('prepareCarePlan — R0–R6 end to end, nothing written', () => {
  it("Dave's example: one dry run, a plan of 21, the key minted with it", async () => {
    const { apiFetch, calls } = fakeApi()
    const mintKey = vi.fn(() => 'key-1')
    const plan = await prepare(DAVE, apiFetch, { mintKey })
    expect(plan.kind).toBe('care_plan')
    expect(plan.keepIds).toHaveLength(21)
    expect(plan.idempotencyKey).toBe('key-1')
    expect(mintKey).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.dry_run).toBe(true)
    expect(plan.readBackText).toBe('Feed 21 in Pasture > In-Ground, skipping 3: Zephyr Squash, Crimson Sweet, King Richard.')
  })

  it('does not fetch anything for a non-command, a grammar refusal or an unknown area', async () => {
    const { apiFetch } = fakeApi()
    expect(await prepare('suyo long', apiFetch)).toBeNull()
    expect(await prepare('water all bag area except', apiFetch)).toMatchObject({ kind: 'care_refusal', rule: 'R0' })
    expect(await prepare('water all bag aria', apiFetch)).toMatchObject({ kind: 'care_refusal', rule: 'R1' })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('a failed dry run refuses — it is never read as an empty area', async () => {
    const { apiFetch } = fakeApi({ dryRunFails: true })
    const r = await prepare(DAVE, apiFetch)
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R1', reason: 'scope-unavailable' })
    expect(r.spokenReason).toBe('I couldn’t load Pasture > In-Ground to check it. Nothing was logged.')
  })

  it('passes a resolver refusal through without minting a key', async () => {
    const { apiFetch } = fakeApi()
    const mintKey = vi.fn(() => 'key-1')
    const r = await prepare('fed all pasture in ground except blorp', apiFetch, { mintKey })
    expect(r).toMatchObject({ kind: 'care_refusal', rule: 'R3' })
    expect(mintKey).not.toHaveBeenCalled()
  })

  it('threads the rain inputs into the plan', async () => {
    const { apiFetch } = fakeApi()
    const plan = await prepare('water all pasture in ground', apiFetch, { rainTomorrow: true })
    expect(plan.needsRainNote).toBe(true)
  })
})

describe('R8 — the write body', () => {
  it('names the ids, carries the plan key and the voice marker, and never an exclusion list', async () => {
    const plan = await prepare(DAVE, fakeApi().apiFetch)
    const body = careWriteBody(plan)
    expect(body).toEqual({
      idempotency_key: 'key-1',
      event_type: 'fertilizing',
      scope: { type: 'ids', plant_ids: plan.keepIds },
      metadata: { care_input_source: 'voice' },
    })
    expect(body).not.toHaveProperty('exclude_plant_ids')
    expect(body.scope.plant_ids).not.toContain(byName('Zephyr Squash').id)
    expect(CARE_INPUT_SOURCE).toBe('voice')
  })

  it('passes the SHIPPED server validator, and the marker survives the server metadata merge', async () => {
    // lambda/events/validators.js — the functions the events Lambda runs on this exact body. Nothing
    // in the app has ever sent care_input_source, so this is the only evidence the server keeps it.
    const plan = await prepare(DAVE, fakeApi().apiFetch)
    const body = { ...careWriteBody(plan), idempotency_key: '9b2d1c4e-0000-4000-8000-000000000001' }
    expect(validateBatchBody(body)).toBeNull()
    const { defaultMetadata } = buildBatchMetadataPlan({
      batchId: 'batch-x', metadata: body.metadata, plantMetadata: undefined, plantIds: body.scope.plant_ids,
    })
    expect(defaultMetadata).toEqual({ care_input_source: 'voice', batch_id: 'batch-x', batch_v: 1 })
    // Non-vacuity: the validator does reject a malformed body of the same shape.
    expect(validateBatchBody({ ...body, scope: { type: 'ids', plant_ids: [] } })).not.toBeNull()
  })
})

describe('R8 — writeCarePlan', () => {
  it('writes once and says "Logged <n>." from the server count', async () => {
    const { apiFetch, calls } = fakeApi()
    const plan = await prepare(DAVE, apiFetch)
    const res = await writeCarePlan(apiFetch, plan)
    expect(res).toEqual({
      ok: true, batchId: 'b-1', count: 21, requested: 21, idempotent: false, warning: null, spoken: 'Logged 21.',
    })
    const write = calls.filter((c) => !c.body?.dry_run)
    expect(write).toHaveLength(1)
    expect(write[0].body.scope.type).toBe('ids')
  })

  it('a retry sends the SAME key, and the server answers with the batch it already wrote', async () => {
    let n = 0
    const keys = []
    const { apiFetch } = fakeApi({
      onWrite: (body) => {
        keys.push(body.idempotency_key)
        n += 1
        if (n === 1) throw httpError(0, null)            // the response was lost
        return { batch_id: 'b-1', count: 21, idempotent: true }
      },
    })
    const plan = await prepare(DAVE, apiFetch)
    const first = await writeCarePlan(apiFetch, plan)
    expect(first).toMatchObject({ ok: false, code: 'NOT_CONFIRMED', retryable: true, spoken: NOT_CONFIRMED_SPOKEN })
    const second = await writeCarePlan(apiFetch, plan)
    expect(second).toMatchObject({ ok: true, idempotent: true, spoken: 'Logged 21.' })
    expect(keys).toEqual(['key-1', 'key-1'])
  })

  it('409 SCOPE_IDS_UNRESOLVED -> "Nothing was logged — something changed. Say it again."', async () => {
    const gone = byName('Atomic Red Carrot').id
    const { apiFetch } = fakeApi({
      onWrite: () => {
        throw httpError(409, {
          error: '1 of 21 picked plantings are no longer available to log — nothing was logged. Re-check your picks.',
          code: 'SCOPE_IDS_UNRESOLVED', requested_count: 21, resolved_count: 20, unresolved_plant_ids: [gone],
        })
      },
    })
    const res = await writeCarePlan(apiFetch, await prepare(DAVE, apiFetch))
    expect(res).toEqual({
      ok: false, code: 'SCOPE_IDS_UNRESOLVED', retryable: false, unresolvedIds: [gone], spoken: SCOPE_CHANGED_SPOKEN,
    })
    expect(SCOPE_CHANGED_SPOKEN).toBe('Nothing was logged — something changed. Say it again.')
  })

  it('a 409 without that code, and a missing unresolved list, are handled', async () => {
    const other = fakeApi({ onWrite: () => { throw httpError(409, { error: 'conflict' }) } })
    expect(await writeCarePlan(other.apiFetch, await prepare(DAVE, other.apiFetch)))
      .toMatchObject({ ok: false, code: 'REJECTED' })
    const bare = fakeApi({ onWrite: () => { throw httpError(409, { code: 'SCOPE_IDS_UNRESOLVED' }) } })
    expect((await writeCarePlan(bare.apiFetch, await prepare(DAVE, bare.apiFetch))).unresolvedIds).toEqual([])
  })

  it('any other 4xx was refused before the transaction: nothing written, not retryable', async () => {
    const { apiFetch } = fakeApi({ onWrite: () => { throw httpError(400, { error: 'event_type invalid' }) } })
    const res = await writeCarePlan(apiFetch, await prepare(DAVE, apiFetch))
    expect(res).toEqual({
      ok: false, code: 'REJECTED', retryable: false, status: 400, detail: 'event_type invalid', spoken: REJECTED_SPOKEN,
    })
  })

  it('a 5xx or a timeout is "not confirmed", retryable', async () => {
    for (const status of [500, 502, 0]) {
      const { apiFetch } = fakeApi({ onWrite: () => { throw httpError(status, null) } })
      expect(await writeCarePlan(apiFetch, await prepare(DAVE, apiFetch)), String(status))
        .toMatchObject({ ok: false, code: 'NOT_CONFIRMED', retryable: true, status })
    }
    const thrown = fakeApi({ onWrite: () => { throw new TypeError('Failed to fetch') } })
    expect(await writeCarePlan(thrown.apiFetch, await prepare(DAVE, thrown.apiFetch)))
      .toMatchObject({ code: 'NOT_CONFIRMED', status: 0 })
  })

  it('an unreadable success body is "not confirmed", never a made-up count', async () => {
    const { apiFetch } = fakeApi({ onWrite: () => ({ ok: true }) })
    expect(await writeCarePlan(apiFetch, await prepare(DAVE, apiFetch))).toMatchObject({ code: 'NOT_CONFIRMED' })
  })

  it('a server-side shortfall is said as "Logged n of m"', async () => {
    const { apiFetch } = fakeApi({
      onWrite: () => ({ batch_id: 'b-2', count: 20, requested_count: 21, warning: '1 of 21 selected plantings could not be logged' }),
    })
    const res = await writeCarePlan(apiFetch, await prepare(DAVE, apiFetch))
    expect(res).toMatchObject({ ok: true, count: 20, requested: 21, spoken: 'Logged 20 of 21.' })
    expect(res.warning).toMatch(/could not be logged/)
    expect(loggedSpoken(3, 3)).toBe('Logged 3.')
  })

  it('refuses to write a plan that was never armed at the read-back, or names nothing', async () => {
    const { apiFetch } = fakeApi()
    const plan = await prepare(DAVE, apiFetch)
    await expect(writeCarePlan(apiFetch, { ...plan, idempotencyKey: undefined })).rejects.toThrow(/idempotency key/)
    await expect(writeCarePlan(apiFetch, { ...plan, keepIds: [] })).rejects.toThrow(/at least one/)
    await expect(writeCarePlan(apiFetch, null)).rejects.toThrow()
  })
})

describe('R9 — undo', () => {
  it('is one DELETE on the batch', async () => {
    const { apiFetch, calls } = fakeApi()
    expect(await undoCareBatch(apiFetch, 'b-1')).toEqual({ ok: true, alreadyUndone: false, spoken: UNDONE_SPOKEN })
    expect(calls).toEqual([{ path: '/api/events/batch/b-1', method: 'DELETE', body: null }])
  })

  it('a 404 on our own batch means it is already undone, and is reported as undone', async () => {
    const { apiFetch } = fakeApi({ onDelete: () => { throw httpError(404, { error: 'Not found' }) } })
    expect(await undoCareBatch(apiFetch, 'b-1')).toEqual({ ok: true, alreadyUndone: true, spoken: UNDONE_SPOKEN })
  })

  it('any other failure says the batch is still logged', async () => {
    const { apiFetch } = fakeApi({ onDelete: () => { throw httpError(500, null) } })
    expect(await undoCareBatch(apiFetch, 'b-1')).toEqual({ ok: false, status: 500, spoken: UNDO_FAILED_SPOKEN })
    const offline = fakeApi({ onDelete: () => { throw new Error('offline') } })
    expect(await undoCareBatch(offline.apiFetch, 'b-1')).toMatchObject({ ok: false, status: 0 })
  })
})

describe('mintIdempotencyKey', () => {
  it('uses randomUUID where the platform has it', () => {
    expect(mintIdempotencyKey({ randomUUID: () => 'uuid-1' })).toBe('uuid-1')
  })

  it('falls back to a timestamp key without it, or when it throws', () => {
    expect(mintIdempotencyKey({})).toMatch(/^k-\d+-[0-9a-f]+$/)
    expect(mintIdempotencyKey({ randomUUID: () => { throw new Error('insecure context') } })).toMatch(/^k-/)
    expect(mintIdempotencyKey(null)).toMatch(/^k-/)
  })

  it('mints a fresh key per plan by default', async () => {
    const { apiFetch } = fakeApi()
    const care = classifyCareCommand(DAVE)
    const a = await prepareCarePlan(apiFetch, { care, plantings: U, locations: LOCATIONS })
    const b = await prepareCarePlan(apiFetch, { care, plantings: U, locations: LOCATIONS })
    expect(a.idempotencyKey).toBeTruthy()
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
  })
})

// BUG-VOICEALIASHITCOUNT-001 — which of his taught names a plan's skips used, carried on the plan for the
// host to count once the batch is logged. Never part of what is written.
describe('careAliasUses — the taught names a plan used', () => {
  const SUYO_VARIETY = byName('Suyo Long').variety_ref.id
  const idx = indexAliases([
    { heard_key: looseKey('studio long'), variety_id: SUYO_VARIETY },
    { heard_key: looseKey("damn i'll see you"), variety_id: byName('Cucamelon').variety_ref.id },
  ])

  it('a skip the learned layer answered is a use; strict skips are not', async () => {
    const plan = await prepare('water all bag area except studio long', fakeApi().apiFetch, { aliasIndex: idx })
    expect(plan.exclusions.map((e) => e.how)).toEqual(['alias'])
    expect(plan.aliasUses).toEqual([{ heard_key: 'studiolong', variety_id: SUYO_VARIETY }])
    const strict = await prepare(DAVE, fakeApi().apiFetch, { aliasIndex: idx })
    expect(strict.exclusions.map((e) => e.how)).not.toContain('alias')
    expect(strict.aliasUses).toEqual([])
  })

  it('rides on the plan, never in the write body', async () => {
    const plan = await prepare('water all bag area except studio long', fakeApi().apiFetch, { aliasIndex: idx })
    expect(JSON.stringify(careWriteBody(plan))).not.toContain('studio')
  })

  it('once per phrase, only for alias answers, and nothing without a list', () => {
    const exclusions = [
      { how: 'alias', heard: 'studio long' }, { how: 'alias', heard: 'Studio Long' },
      { how: 'fuzzy', heard: "damn i'll see you" }, { how: 'strict', heard: 'zephyr' },
      { how: 'alias', heard: 'never taught' },
    ]
    expect(careAliasUses({ exclusions }, idx)).toEqual([{ heard_key: 'studiolong', variety_id: SUYO_VARIETY }])
    expect(careAliasUses({ exclusions }, null)).toEqual([])
    expect(careAliasUses({ exclusions }, new Map())).toEqual([])
    expect(careAliasUses(null, idx)).toEqual([])
  })

  // Review v4.147 MINOR — Log many is the one caller that can name more than 20 taught skips in a single
  // command, and the server refuses such a count outright. What the host hands the transport
  // (LogManyVoice: recordAliasUse(apiFetch, plan.aliasUses)) is capped there: the first 20, once each.
  it('a plan with more taught skips than one count carries sends the first 20, once each', () => {
    const WORDS = ['apple', 'banana', 'cherry', 'damson', 'elder', 'fennel', 'grape', 'hazel', 'iris', 'juniper',
      'kale', 'lemon', 'mango', 'nectar', 'olive', 'peach', 'quince', 'radish', 'sage', 'thyme', 'ugli', 'vetch',
      'walnut', 'yarrow', 'zinnia']
    const heards = WORDS.map((w) => `taught ${w}`)
    expect(new Set(heards.map(looseKey)).size).toBe(25)   // 25 distinct taught names
    const index = indexAliases(heards.map((h, i) => ({ heard_key: looseKey(h), variety_id: `v-${i}` })))
    const exclusions = [...heards, heards[0], heards[1]].map((heard) => ({ how: 'alias', heard }))
    const uses = careAliasUses({ exclusions }, index)
    expect(uses).toHaveLength(25)
    const api = vi.fn().mockResolvedValue({ counted: MAX_ALIAS_USES })
    recordAliasUse(api, uses)
    const sent = JSON.parse(api.mock.calls[0][1].body).used
    expect(sent).toHaveLength(20)
    expect(sent).toEqual(uses.slice(0, 20))
  })
})
