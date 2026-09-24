// BUG-INVREFSTRAND-001 — static guard on the staging smoke's refused-delete assert (F3c).
//
// WHY A FILE-READING TEST. The block runs only inside deploy-staging.yml, against the staging Lambda;
// nothing in the unit or integration suites executes run-smoke.sh. Two ways it could rot silently:
// the block is dropped or moved out of the branch where an ARCHIVED planting of the packet exists (then
// "archived plantings still block" is asserted by nothing on the deployed stack), or the Lambda's
// sentence changes and the smoke goes red on staging at the next promote instead of here. So the
// expected sentence is compared with the Lambda's own blockingMessage for the exact shape F3 builds —
// one planting sown from the packet, archived by F3b. Same idiom as stagingSmokeVarietyFacts.static.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blockingMessage } from '../../lambda/inventory-items/delete-guard.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')

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
