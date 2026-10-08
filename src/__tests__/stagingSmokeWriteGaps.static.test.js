// OPS-SMOKEWRITEGAPS-002 — static guard on the write → read-back asserts the staging smoke gained for the paths a
// blast-radius review found unheld: a watering POSTed with its depth (block C2), a batch POSTed with metadata
// (block H), the Put it up sitting's replay (block P, P1), the plain batch create's replay and its merge PUT (P11b),
// and the two stamps a replay's answer carries, before and after a write (P11b, S10, S18).
//
// WHY A FILE-READING TEST. tests/smoke/run-smoke.sh runs only against staging, and it is the gate every promote
// waits on: a body the route refuses, or a read-back of a field the route does not answer, is found at ship time and
// blocks everyone. So each JSON body these steps send is cut out of the shell text and handed to the Lambda's OWN
// validator, and each read-back is held to the literal it compares against. MUTATION: give P11b's PUT a kind outside
// KITCHEN_BATCH_KINDS → "the merge PUT's body" reds; drop a key from block H's metadata → "block H" reds; make S10's
// stamp check demand a non-null updated_at → "accepts a NULL updated_at" reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validatePostBody, validateBatchBody } from '../../lambda/events/validators.js'
import { validateBatchCreate, validateBatchUpdate, KITCHEN_BATCH_KINDS } from '../../lambda/preservation/kitchenBatch.js'
import { validatePutUp } from '../../lambda/preservation/putUp.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const UUID = '11111111-1111-4111-8111-111111111111'
// A week back, as the script's BARE_DATE is: the events validator refuses a date outside its window.
const WEEK_AGO = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
const fill = (text) => text
  .replace(/\$(CREATED_PROJECT_ID|FE_SB_KEY|FE_PU_KEY|FE_PLACE)\b/g, UUID)
  .replace(/\$(BARE_DATE|FE_DAY|FE_LATER)\b/g, WEEK_AGO)
  .replace(/\$TEST_RUN_ID\b/g, 'RUN')
  .replace(/\$FE_TAG\b/g, 'smoke-test-ferment-RUN')
// The one line of the script that contains `needle`, and the JSON body ("{\"k\": …}") on a line.
const lineOf = (needle) => {
  const hits = SMOKE.split('\n').filter((l) => l.includes(needle))
  expect(hits, `expected exactly one line with: ${needle}`).toHaveLength(1)
  return hits[0]
}
const bodyOf = (line) => {
  const at = line.indexOf('"{\\"')
  expect(at, `no JSON body on: ${line.trim().slice(0, 80)}`).toBeGreaterThan(-1)
  return JSON.parse(fill(line.slice(at + 1, line.lastIndexOf('}"') + 1).replace(/\\"/g, '"')))
}
const DEPTH = { water_depth: 'normal', water_depth_source: 'default' }

describe('block C2: a watering POSTed with its default depth', () => {
  const body = bodyOf(lineOf('\\"event_type\\": \\"watering\\", \\"event_date\\": \\"$BARE_DATE\\"'))

  it('is a body the events POST takes, anchored on the smoke project so the L-058 sweep takes its row', () => {
    expect(validatePostBody(body)).toBeNull()
    expect(body).toEqual({ project_id: UUID, event_type: 'watering', event_date: WEEK_AGO, notes: 'CI smoke — safe to delete', metadata: DEPTH })
  })

  it('reads the stored bag back through GET /api/events/:id, sits between C and E, and mints nothing', () => {
    const at = SMOKE.indexOf('# ── C2)')
    const C2 = SMOKE.slice(at, SMOKE.indexOf('# ── E) Events PUT metadata'))
    expect(at).toBeGreaterThan(SMOKE.indexOf('assert_readback "write:event-date-noon-anchor"'))
    expect(C2).toContain('assert_readback "write:event-create-default-depth"')
    expect(C2).toContain('"${STAGING_API_EVENTS%/}/api/events/${DEPTH_EV_ID}"')
    expect(C2).toContain(`'("\\(.event_type)|\\(.metadata.water_depth)|\\(.metadata.water_depth_source)")' "watering|normal|default"`)
    expect(C2.split('\n').filter((l) => l.includes('mint_session_token') && !l.trim().startsWith('#'))).toEqual([])
  })
})

describe('block H: the batch carries the metadata voice and Log Many send', () => {
  const at = SMOKE.indexOf('# ── H) Bulk Quick-Log batch')
  const H = SMOKE.slice(at, SMOKE.indexOf('# ── I) ux-events'))
  const body = bodyOf(H.split('\n').find((l) => l.includes('smoke-batch-$TEST_RUN_ID')) ?? '')

  it('is a body the batch route takes, with the three keys', () => {
    expect(validateBatchBody(body)).toBeNull()
    expect(body).toEqual({
      idempotency_key: 'smoke-batch-RUN', event_type: 'watering', scope: { type: 'project', project_id: UUID },
      metadata: { care_input_source: 'voice', ...DEPTH },
    })
  })

  it('reads one created row back by id, with the server\'s batch_id, BEFORE the undo soft-deletes it', () => {
    expect(H).toContain(`BATCH_EVENT_ID=$(jq -r '.event_ids[0] // empty' "$BATCH_BODY" 2>/dev/null || echo "")`)
    expect(H).toContain('"${STAGING_API_EVENTS%/}/api/events/${BATCH_EVENT_ID}"')
    expect(H).toContain(`'("\\(.metadata.care_input_source)|\\(.metadata.water_depth)|\\(.metadata.water_depth_source)|\\(.metadata.batch_id)")' "voice|normal|default|$BATCH_ID"`)
    expect(H.indexOf('assert_readback "write:batch-row-metadata"')).toBeLessThan(H.indexOf('-X DELETE'))
    // No id to read is a FAIL, never a silent pass.
    expect(H).toMatch(/else\n\s+echo "❌ FAIL \[write:batch-row-metadata\][^\n]+\n\s+FAIL=\$\(\(FAIL\+1\)\)/)
  })
})

describe('block P, P1: the sitting\'s replay', () => {
  const at = SMOKE.indexOf('# ── P1) put-up (1b)')
  const P1 = SMOKE.slice(at, SMOKE.indexOf('# ── P1b)'))

  it('sends the very body twice, and it is one Put it up takes', () => {
    expect(P1.split('\n').filter((l) => l.includes('fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B1/put-up" "$FE_PU_BODY"'))).toHaveLength(2)
    const body = bodyOf(lineOf('FE_PU_BODY="{'))
    expect(validatePutUp(body)).toBeNull()
    expect(body.rows).toEqual([{ count: 2, container_label: 'pint', size_value: 450, size_unit: 'g', place: { id: UUID }, name: 'smoke-test-ferment-RUN P1', discard_by: WEEK_AGO }])
  })

  it('holds the answer to the one jar P1 made and its four fields as stored, after P1\'s own checks', () => {
    const check = P1.split('\n').find((l) => l.includes('fe_check "p1-putup-replay"')) ?? ''
    expect(check).toContain(`$(fe_jq '.jars[0] | "\\(.id)|\\(.label)|\\(.package_count)|\\(.container_label)|\\(.storage_label)"')`)
    expect(check).toContain('"200 true 1 $FE_J1|$FE_TAG P1|2|pint|$FE_TAG place 1"')
    expect(P1.indexOf('fe_check "p1-putup-replay"')).toBeGreaterThan(P1.indexOf('fe_check "p1-legacy-echo-noop"'))
    // The place's name is the one the block gave its place.
    expect(SMOKE).toContain('"{\\"label\\": \\"$FE_TAG place\\", \\"kind\\": \\"fridge\\"}"')
  })
})

describe('block P, P11b: the plain create\'s replay, its stamps, and the merge PUT', () => {
  const at = SMOKE.indexOf('# ── P11b)')
  const P11B = SMOKE.slice(at, SMOKE.indexOf('# ── P12)'))
  const tags = ['p11b-start-replay', 'p11b-start-merge', 'p11b-start-replay-touched']

  it('sits after P11 and before the mint P12 runs on, and mints nothing of its own', () => {
    expect(at).toBeGreaterThan(SMOKE.indexOf('fe_check "p11-replay"'))
    expect(P11B.split('\n').filter((l) => l.includes('mint_session_token') && !l.trim().startsWith('#')).map((l) => l.trim()))
      .toEqual(['CLERK_JWT=$(mint_session_token)'])
    expect(P11B.indexOf('CLERK_JWT=$(mint_session_token)')).toBeGreaterThan(P11B.indexOf('fe_check "p11b-start-replay-touched"'))
  })

  it.each(tags)('has exactly one check that can pass: %s', (tag) => {
    expect(P11B.split(`fe_check "${tag}"`).length - 1).toBe(1)
  })

  it('the create\'s body is one the route takes, sent three times, and keeps the block\'s tag for ferm_sweep', () => {
    const body = bodyOf(lineOf('FE_SB_BODY="{'))
    expect(validateBatchCreate(body)).toBeNull()
    expect(body).toEqual({ idempotency_key: UUID, label: 'smoke-test-ferment-RUN start', kind: 'ferment' })
    expect(P11B.split('\n').filter((l) => l.includes('fe_req POST "$FE_BASE/api/kitchen-batches" "$FE_SB_BODY"'))).toHaveLength(3)
  })

  it('the merge PUT\'s body is one the route takes: a new name still under the tag, a real kind, two nulls', () => {
    const body = bodyOf(lineOf('fe_req PUT "$FE_BASE/api/kitchen-batches/$FE_SB"'))
    expect(validateBatchUpdate(body)).toBeNull()
    expect(body).toEqual({ label: 'smoke-test-ferment-RUN start renamed', kind: 'dehydrate', kind_other: null, recipe_ref: null })
    expect(KITCHEN_BATCH_KINDS).toContain(body.kind)
    expect(body.kind).not.toBe('ferment')
  })

  it('reads the stamps equal before the PUT and moved after it, in the answer AND in the row', () => {
    const first = lineOf('fe_check "p11b-start-replay"')
    expect(first).toContain(`$(fe_jq '.created_at != null and .created_at == .updated_at')`)
    expect(first).toContain(`"SELECT count(*)::text||'|'||bool_and(updated_at = created_at)::text FROM kitchen_batch WHERE idempotency_key = '$FE_SB_KEY'"`)
    expect(first).toContain('"200 true $FE_SB true 1|true"')
    expect(lineOf('fe_check "p11b-start-merge"')).toContain('"200 $FE_TAG start renamed|dehydrate|null|null"')
    const after = lineOf('fe_check "p11b-start-replay-touched"')
    expect(after).toContain(`"SELECT (updated_at > created_at)::text FROM kitchen_batch WHERE id = '$FE_SB'"`)
    expect(after).toContain('"200 true $FE_SB $FE_TAG start renamed false true"')
  })
})

describe('block S, S10 and S18: the door jar\'s stamps on its replay', () => {
  it('S10 accepts a NULL updated_at (the column has no default) or one equal to created_at, never demands either', () => {
    const check = lineOf('pn_check "s10-door-replay-untouched"')
    expect(check).toContain(`$(pn_jq '.created_at != null and (.updated_at == null or .updated_at == .created_at)')`)
    expect(check).toContain(`"SELECT (updated_at IS NULL OR updated_at = created_at)::text FROM preservation_log WHERE id = '$PN_DOOR'"`)
    expect(check).toContain('"true true"')
    // On the replay's own answer: no request between the two checks.
    const lines = SMOKE.split('\n')
    expect(lines[lines.indexOf(check) - 4]).toContain('pn_check "s10-door-replay"')
  })

  it('S18 replays the door\'s body after its PATCHes and holds updated_at set and past created_at', () => {
    const at = SMOKE.indexOf('      pn_s18_source() {\n')
    const s18 = SMOKE.slice(at, SMOKE.indexOf('\n      }\n', at))
    expect(s18.indexOf('pn_req POST "$PN_BASE/api/preservation" "$PN_DOOR_BODY"')).toBeGreaterThan(s18.indexOf('pn_check "s18-jar-source-pair"'))
    const check = lineOf('pn_check "s18-door-replay-touched"')
    expect(check).toContain(`$(pn_jq '.updated_at != null and .updated_at != .created_at')`)
    expect(check).toContain(`"SELECT (updated_at > created_at)::text FROM preservation_log WHERE id = '$PN_DOOR'"`)
    expect(check).toContain('"200 true $PN_DOOR true true"')
  })
})
