// BUG-INVREFSTRAND-001 — static guard on the staging smoke's two delete asserts: the refusal (F3c) and
// the allowed half of the same DELETE (F3d, pre-promote review M-3).
//
// WHY A FILE-READING TEST. The blocks run only inside deploy-staging.yml, against the staging Lambda;
// nothing in the unit or integration suites executes run-smoke.sh. Ways they could rot silently: a
// block is dropped or moved out of the branch where an ARCHIVED planting of the packet exists (then
// "archived plantings still block" is asserted by nothing on the deployed stack); the Lambda's sentence
// or success body changes and the smoke goes red on staging at the next promote instead of here; or F3d
// stops clearing the ids it deleted, and the trap repeats its deletes against rows that are gone. So the
// expected sentence is compared with the Lambda's own blockingMessage for the exact shape F3 builds — one
// planting sown from the packet, archived by F3b — and F3d's expected body with the one the DELETE arm
// returns. Same idiom as stagingSmokeVarietyFacts.static.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blockingMessage } from '../../lambda/inventory-items/delete-guard.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const F3C_FAIL = '❌ FAIL [write:inventory-delete-refused-when-sown]'
const F3B_FAIL = '❌ FAIL [write:seed-detail-sown-from-archived-hidden]'

describe('the smoke refuses the packet delete while an archived planting was sown from it (F3c)', () => {
  const start = SMOKE.indexOf('# ── F3c)')
  const end = SMOKE.indexOf('❌ FAIL [write:inventory-delete-refused-when-sown]')
  const block = SMOKE.slice(start, end)

  it('sits inside F3b\'s pass branch — after the planting was archived and shown hidden', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('✅ PASS [write:seed-detail-sown-from-archived-hidden]'))
    expect(start).toBeLessThan(SMOKE.indexOf('❌ FAIL [write:seed-detail-sown-from-archived-hidden]'))
    expect(end).toBeGreaterThan(start)
  })

  it('DELETEs the smoke packet and asserts 409, the sentence, and that the packet still reads back 200', () => {
    expect(block).toContain('-X DELETE')
    expect(block).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}"')
    expect(block).toContain('[[ "$DEL_HTTP" == "409" && "$DEL_ERROR" == "$DEL_EXPECTED" && "$KEPT_HTTP" == "200" ]]')
    // The read-back comes AFTER the delete attempt, so it proves the refusal wrote nothing.
    expect(block.indexOf('KEPT_HTTP=$(curl')).toBeGreaterThan(block.indexOf('-X DELETE'))
  })

  it('expects exactly the sentence the Lambda builds for one archived planting', () => {
    const m = block.match(/DEL_EXPECTED="((?:[^"\\]|\\.)*)"/)
    expect(m).not.toBeNull()
    const expected = m[1].replace(/\\"/g, '"')
    expect(expected).toBe(blockingMessage([{ table: 'plants', count: 1, archived: 1 }], 'seeds'))
  })
})

describe('then the ALLOWED half: planting deleted → the packet deletes and is gone (F3d)', () => {
  const start = SMOKE.indexOf('# ── F3d)')
  const end = SMOKE.indexOf('❌ FAIL [write:inventory-delete-allowed-once-unsown]')
  const block = SMOKE.slice(start, end)
  const at = (needle) => block.indexOf(needle)

  it('comes right after F3c — nothing runs between them — still inside F3b\'s pass branch', () => {
    const f3cEnd = SMOKE.indexOf(F3C_FAIL)
    expect(f3cEnd).toBeGreaterThan(SMOKE.indexOf('# ── F3c)'))
    expect(start).toBeGreaterThan(f3cEnd)
    expect(start).toBeLessThan(SMOKE.indexOf(F3B_FAIL))
    expect(end).toBeGreaterThan(start)
    // Between F3c's FAIL line and F3d only F3c's own closing lines: no request, no other block.
    expect(SMOKE.slice(f3cEnd, start)).not.toMatch(/curl|# ── /)
  })

  it('in order: DELETE the sown planting, then DELETE the packet, then GET the packet', () => {
    const unsow = at('UNSOW_HTTP=$(curl')
    const pktDel = at('PKTDEL_HTTP=$(curl')
    const gone = at('GONE_HTTP=$(curl')
    expect(unsow).toBeGreaterThan(-1)
    expect(pktDel).toBeGreaterThan(unsow)
    expect(gone).toBeGreaterThan(pktDel)
    const unsowCall = block.slice(unsow, pktDel)
    expect(unsowCall).toContain('-X DELETE')
    expect(unsowCall).toContain('"${STAGING_API_PLANTS%/}/api/plants/${CREATED_SOWN_PLANT_ID}"')
    const pktDelCall = block.slice(pktDel, gone)
    expect(pktDelCall).toContain('-X DELETE')
    expect(pktDelCall).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}"')
    const goneCall = block.slice(gone, block.indexOf('\n', block.indexOf('|| GONE_HTTP="000"', gone)))
    expect(goneCall).not.toContain('-X ')
    expect(goneCall).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}"')
  })

  it('asserts 200; 200 with {"ok":true}; then 404', () => {
    expect(block).toContain('[[ "$UNSOW_HTTP" == "200" && "$PKTDEL_HTTP" == "200" && "$PKTDEL_OK" == "yes" && "$GONE_HTTP" == "404" ]]')
    expect(block).toContain('if jq -e \'. == {"ok": true}\' "$PKTDEL_BODY"')
  })

  it('{"ok":true} is what the inventory DELETE arm really answers on success', () => {
    const src = readFileSync(resolve(process.cwd(), 'lambda/inventory-items/index.js'), 'utf8')
    const arm = src.slice(src.indexOf("if (method === 'DELETE') {"), src.indexOf("return resp(405, { error: 'Method not allowed' });", src.indexOf("if (method === 'DELETE') {")))
    expect(arm).toContain('SET deleted_at = NOW()')
    // The arm's LAST answer — the one after the soft-delete — is the success body the smoke expects.
    expect(arm.lastIndexOf('return resp(')).toBe(arm.indexOf('return resp(200, { ok: true });'))
  })

  it('clears each id only once its own DELETE is confirmed, and the packet id only after the GET that uses it', () => {
    const clearPlant = at('if [[ "$UNSOW_HTTP" == "200" ]]; then CREATED_SOWN_PLANT_ID=""; fi')
    const clearPkt = at('if [[ "$PKTDEL_HTTP" == "200" ]]; then CREATED_SEEDPKT_ID=""; fi')
    expect(clearPlant).toBeGreaterThan(at('UNSOW_HTTP=$(curl'))
    expect(clearPkt).toBeGreaterThan(at('GONE_HTTP=$(curl'))
    // The trap tests exactly these two variables before it repeats either delete.
    expect(SMOKE).toContain('if [[ -n "$CREATED_SOWN_PLANT_ID" ]]; then')
    expect(SMOKE).toContain('if [[ -n "$CREATED_SEEDPKT_ID" ]]; then')
  })
})
