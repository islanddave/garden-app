// V5-VARIETYFACTSHARDEN-001 — static guard on the staging smoke's variety write -> read-back ("D-facts").
//
// WHY A FILE-READING TEST. The block runs only inside deploy-staging.yml, against the staging Lambda, when
// a promote dispatches it; nothing in the unit or integration suites executes run-smoke.sh. Its loss would
// be silent: a later edit that drops the block, moves it outside the branch where the throwaway variety
// exists, or makes the PUT touch a breeding column (which brings in the preflight and the rank fill) would
// still leave a green smoke. L-108 requires every write surface to keep a write -> read-back assert, and
// until this block the smoke called neither PUT nor GET /api/varieties/:id. Same idiom as
// stagingSmokeCareProfile.static.test.js, which guards the D-profile block beside it.
//
// WHAT IT DOES NOT CATCH: whether the staging Lambda answers. Every deploy-staging run checks that live.
// Note that auth_request prints PASS for a 4xx (its contract is "the route is reachable and authed"), so a
// refused PUT logs PASS on its own line — the read-back after it is what fails. That is why the read-back
// is the assertion pinned here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')

describe('the smoke writes a variety fact and reads it back (D-facts)', () => {
  const start = SMOKE.indexOf('# D-facts)')
  const end = SMOKE.indexOf('❌ FAIL [crud:POST /varieties]')
  const block = SMOKE.slice(start, end)

  it('sits in the variety-created branch, after the create passed and after D-profile', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('✅ PASS [crud:POST /varieties]'))
    expect(start).toBeGreaterThan(SMOKE.indexOf('# D-profile)'))
    expect(end).toBeGreaterThan(start)
  })

  it('PUTs a run-unique origin_country on the throwaway variety, and nothing else', () => {
    expect(block).toContain('VAR_ORIGIN="smoke-origin-$TEST_RUN_ID"')
    expect(block).toContain('"${STAGING_API_VARIETIES%/}/api/varieties/${CREATED_VARIETY_ID}" "PUT"')
    const body = block.match(/"PUT" \\\n\s*"(\{[^\n]*\})"/)
    expect(body).not.toBeNull()
    expect(body[1]).toBe('{\\"origin_country\\": \\"$VAR_ORIGIN\\"}')
    expect(block).not.toMatch(/breeding_(system|source)/)
  })

  it('reads the value back through GET /api/varieties/:id and asserts it', () => {
    expect(block).toMatch(
      /assert_readback "write:variety-origin-readback" \\\n\s*"\$\{STAGING_API_VARIETIES%\/\}\/api\/varieties\/\$\{CREATED_VARIETY_ID\}" "\.origin_country" "\$VAR_ORIGIN"/,
    )
  })

  it('writes before it reads', () => {
    expect(block.indexOf('"PUT"')).toBeGreaterThan(-1)
    expect(block.indexOf('assert_readback "write:variety-origin-readback"')).toBeGreaterThan(block.indexOf('"PUT"'))
  })
})
