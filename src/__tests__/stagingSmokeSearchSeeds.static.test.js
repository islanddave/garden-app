// BUG-SEARCHSEEDCAP20-001 (v4.148.0 regression-impact review, I2) — static guard on the staging smoke's
// search assert, F3-search: the F3 seed packet must come back from GET /api/search as a seeds row.
//
// WHY THE ASSERT EXISTS. /api/search runs its seven section queries under Promise.allSettled, so the
// rewritten inventory query can fail on real Postgres and still answer 200, with the Seeds and Inventory
// groups empty. Nothing else in run-smoke.sh called the route, so the staging gate could not see that.
//
// WHY A FILE-READING TEST. Same reason as stagingSmokeDeleteGuard.static.test.js: the block runs only
// inside deploy-staging.yml, against the staging Lambdas. Ways it could rot silently: it drifts past F3d,
// which deletes the packet (then the packet is rightly absent, and the assert either reds a healthy stack
// or gets loosened until it proves nothing); the query stops naming this run's packet (a broad word passes
// on any leftover seed row); or the pass condition shrinks to the 200 that a failed section still answers.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyRoute, normalizeSearchQuery, SEARCH_SECTIONS } from '../../lambda/dashboard/handlers.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const start = SMOKE.indexOf('# ── F3-search)')
const end = SMOKE.indexOf('❌ FAIL [read:search-seed-packet]')
const block = SMOKE.slice(start, end)

describe('the staging smoke finds the F3 seed packet through GET /api/search (F3-search)', () => {
  it('sits inside the packet POST\'s pass branch, before anything deletes the packet', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('✅ PASS [crud:POST /inventory-items (seed packet)]'))
    expect(start).toBeLessThan(SMOKE.indexOf('❌ FAIL [crud:POST /inventory-items (seed packet)]'))
    expect(start).toBeLessThan(SMOKE.indexOf('# ── F3c)'))
    expect(start).toBeLessThan(SMOKE.indexOf('# ── F3d)'))
    expect(end).toBeGreaterThan(start)
    // A read, nothing else: it must not be the thing that changes the packet it looks for.
    expect(block).not.toMatch(/-X (DELETE|PATCH|PUT|POST)/)
  })

  it('asks the dashboard Lambda\'s search route, by a word only this run\'s packet carries', () => {
    expect(block).toContain('"${STAGING_API_DASHBOARD%/}/api/search?q=')
    expect(classifyRoute('GET', '/api/search')).toEqual({ kind: 'search' })
    const q = block.match(/SRCH_Q="([^"]+)"/)?.[1]
    expect(q).toBe('seedpkt-$TEST_RUN_ID')
    // The name F3 POSTed for the packet carries that word.
    const posted = SMOKE.match(/\\"name\\": \\"(smoke-test-seedpkt-\$TEST_RUN_ID)\\"/)?.[1]
    expect(posted).toBe('smoke-test-seedpkt-$TEST_RUN_ID')
    expect(posted).toContain(q)
    // The Lambda 400s a query outside 2..64 characters; with a uuid run id this one is 44.
    expect(normalizeSearchQuery(q.replace('$TEST_RUN_ID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'))).not.toBeNull()
  })

  it('passes only on 200 AND >=1 seeds row in results.inventory AND this packet among them', () => {
    expect(SEARCH_SECTIONS).toContain('inventory')
    expect(block).toContain('select(.category == "seeds")')
    expect(block).toContain('select(.id == $id and .category == "seeds")')
    expect(block).toContain('--arg id "$CREATED_SEEDPKT_ID"')
    expect(block).toContain('[[ "$SRCH_HTTP" == "200" && "$SRCH_N" =~ ^[0-9]+$ && "$SRCH_N" -ge 1 && "$SRCH_HAS" == "true" ]]')
    expect(block).toContain('PASS=$((PASS+1))')
    // The FAIL branch counts, so a red search fails the gate rather than printing and moving on.
    expect(SMOKE.slice(end, SMOKE.indexOf('fi', end))).toContain('FAIL=$((FAIL+1))')
  })
})
