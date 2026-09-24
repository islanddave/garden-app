// BUG-VOICEALIASHITCOUNT-001 — static guard on the staging smoke's taught-name count read-back (block L).
//
// WHY A FILE-READING TEST. The block runs only inside deploy-staging.yml, against the staging Lambda, when a
// promote dispatches it; nothing in the unit or integration suites executes run-smoke.sh. Its loss would be
// silent: a later edit that drops it, moves it out of the branch where block D's variety exists, loosens
// "exactly one more" into "any 2xx", or lets its bodies drift from what the route accepts would still leave
// a green smoke, and L-108 requires every write surface to keep a write -> read-back assert. So this pins the
// block's placement, order and condition, and it RUNS the block's own key line and body strings through bash
// and hands the results to the real handler (mock SQL): a body the route would refuse reds here on the push,
// not on staging at the next promote. Same idiom as stagingSmokeVarietyFacts / stagingSmokeDeleteGuard.
//
// WHAT IT DOES NOT CATCH: whether staging answers (every deploy-staging run checks that live), or what the
// SQL does (tests/integration/voice-alias-use.int.test.js proves that against a real Postgres).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stubState, resetStubs } from '../../lambda/_test-stubs/state.js'
import { handler } from '../../lambda/varieties/index.js'

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8')
const SMOKE = read('tests/smoke/run-smoke.sh')
const start = SMOKE.indexOf('# ── L) A taught name')
const end = SMOKE.indexOf('taught-name count assert NOT run', start)
const block = SMOKE.slice(start, end)
const at = (needle) => block.indexOf(needle)

describe('the smoke counts one use of a taught name and reads it back (block L)', () => {
  it('sits at the end of the write path: after K, inside the project branch, on block D\'s variety', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('# ── K) DELETE soft-delete read-back'))
    expect(start).toBeGreaterThan(SMOKE.indexOf('CREATED_VARIETY_ID=$(jq'))
    expect(end).toBeGreaterThan(start)
    expect(end).toBeLessThan(SMOKE.indexOf('WARNING: POST succeeded but no id in response'))
    expect(block).toContain('if [[ -n "${STAGING_API_VARIETIES:-}" && -n "${CREATED_VARIETY_ID:-}" ]]; then')
  })

  it('fails the ship gate, rather than skipping, when there is no variety to teach against', () => {
    const branch = SMOKE.slice(start).match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n([\s\S]*?)\n\s*else\n/)
    expect(branch).not.toBeNull()
    expect(branch[1]).toContain('FAIL=$((FAIL+1))')
    expect(branch[1]).not.toContain('PASS=$((PASS+1))')
  })

  it('in order: teach (POST), read (GET), one use (PATCH), read again (GET), all on the voice-aliases path', () => {
    expect(block).toContain('VA_URL="${STAGING_API_VARIETIES%/}/api/varieties/voice-aliases"')
    const teach = at('VA_TEACH_HTTP=$(curl')
    const before = at('VA_BEFORE=$(va_read)')
    const patch = at('VA_PATCH_HTTP=$(curl')
    const after = at('VA_AFTER=$(va_read)')
    expect(teach).toBeGreaterThan(at('va_read() {'))
    expect(before).toBeGreaterThan(teach)
    expect(patch).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(patch)
    expect(block.slice(teach, before)).toContain('-X POST')
    expect(block.slice(patch, after)).toContain('-X PATCH')
    const reader = block.slice(at('va_read() {'), teach)
    expect(reader).not.toContain('-X ')
    expect(reader).toContain('select(.heard_key == $k)')
  })

  it('passes only on exactly one more use than the GET read before, with a last_used_at', () => {
    expect(block).toContain('if [[ "${VA_BEFORE%% *}" =~ ^[0-9]+$ ]]; then VA_WANT="$(( ${VA_BEFORE%% *} + 1 ))"; fi')
    const cond = at('if [[ "$VA_PATCH_HTTP" == "200" && "${VA_AFTER%% *}" == "$VA_WANT" && "${VA_AFTER#* }" != "none" ]]; then')
    expect(cond).toBeGreaterThan(at('VA_AFTER=$(va_read)'))
    expect(at('✅ PASS [write:voice-alias-use-readback]')).toBeGreaterThan(cond)
    expect(at('❌ FAIL [write:voice-alias-use-readback] PATCH HTTP')).toBeGreaterThan(at('✅ PASS [write:voice-alias-use-readback]'))
  })

  // No route removes an alias, so the block's cleanup is the sweep's hard delete of block D's variety; the
  // CASCADE that carries the alias with it is proven on real Postgres by voice-alias-use.int.test.js.
  it('leaves its alias to the L-058 sweep, which hard-deletes block D\'s smoke-named variety', () => {
    expect(SMOKE).toContain('-d "{\\"name\\": \\"smoke-test-variety-$TEST_RUN_ID\\"}"')
    expect(read('.github/workflows/deploy-staging.yml')).toContain("DELETE FROM plant_varieties WHERE name ILIKE '%smoke%';")
  })
})

describe('what block L sends is what the route accepts', () => {
  const USER = 'user_stub_smoke'
  const VARIETY = '00000000-0000-4000-8000-0000000000d2'
  const keyLine = block.match(/^\s*(VA_KEY="smokealias.*")$/m)?.[1]
  const teachBody = block.match(/VA_TEACH_HTTP=\$\(curl[\s\S]*?-d ("(?:[^"\\]|\\.)*")\) \|\| VA_TEACH_HTTP="000"/)?.[1]
  const patchBody = block.match(/VA_PATCH_HTTP=\$\(curl[\s\S]*?-d ("(?:[^"\\]|\\.)*")\) \|\| VA_PATCH_HTTP="000"/)?.[1]
  // The block's own lines, expanded by bash exactly as the smoke expands them.
  const expand = (testRunId) => execFileSync('bash', ['-c',
    `set -euo pipefail; TEST_RUN_ID="$1"; CREATED_VARIETY_ID="$2"; ${keyLine}; printf '%s\\n' "$VA_KEY" ${teachBody} ${patchBody}`,
    'bash', testRunId, VARIETY], { encoding: 'utf8' }).trimEnd().split('\n')
  const call = (method, body) => handler({
    requestContext: { http: { method } },
    rawPath: '/api/varieties/voice-aliases',
    headers: { authorization: 'Bearer stub-token' },
    body,
  })

  beforeEach(() => {
    resetStubs()
    stubState.verifyTokenResult = { sub: USER }
  })

  it('finds the key line and both bodies', () => {
    expect(keyLine).toBeTruthy()
    expect(teachBody).toBeTruthy()
    expect(patchBody).toBeTruthy()
  })

  it.each([
    ['uuidgen on macOS (upper-case)', 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'],
    ['uuidgen / /proc on Linux (lower-case)', '0f8e1d2c-3b4a-4968-8776-5a4b3c2d1e0f'],
    ['the no-uuid fallback', 'ci-1727200000'],
  ])('%s: the teach and the use both pass the route\'s checks, for the key and variety the smoke means', async (_what, testRunId) => {
    const [key, teach, use] = expand(testRunId)
    expect(key).toMatch(/^smokealias[a-z0-9]{4,110}$/)

    stubState.sqlHandler = (text) => {
      if (/FROM\s+public\.cultivar/i.test(text)) return [{ id: VARIETY }]
      if (/INSERT\s+INTO\s+public\.voice_alias/i.test(text)) return [{ heard_key: key, hit_count: 0, last_used_at: null }]
      if (/UPDATE\s+public\.voice_alias/i.test(text)) return [{ heard_key: key }]
      return []
    }
    const taught = await call('POST', teach)
    expect(taught.statusCode, taught.body).toBe(200)
    const insert = stubState.sqlCalls.find((c) => /INSERT\s+INTO\s+public\.voice_alias/i.test(c.text))
    expect(insert.values).toEqual([USER, key, `smoke alias ${testRunId}`, VARIETY])

    const used = await call('PATCH', use)
    expect(used.statusCode, used.body).toBe(200)
    expect(JSON.parse(used.body)).toEqual({ counted: 1 })
    const update = stubState.sqlCalls.find((c) => /UPDATE\s+public\.voice_alias/i.test(c.text))
    expect(update.values).toEqual([[key], [VARIETY], USER])
  })
})
