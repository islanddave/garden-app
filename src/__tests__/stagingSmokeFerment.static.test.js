// V5-FERMENTPATH-001 — static guard on the staging smoke's block P (06-ferment-path §5.6; report-1a-smoke.md's
// "a text-reading static test pinning the block").
//
// WHY A FILE-READING TEST. Block P runs only inside deploy-staging.yml, against the staging Lambda, and until F's
// sitting it WARNs rather than runs. Nothing else executes it, so the ways it can rot are silent: its sweep
// reordered into a 23503 (a jar names its put_up row, so stage rows must go AFTER jars — the order 06 §5.6 wrote
// would fail), its scope widened to a pattern that reaches real rows, the dirty-run retry dropped from cleanup(),
// a sub-block dropped, the F-deployed gate turned into a silent skip, or the RowEditor edit quietly sent the
// remaining_count key again (which F refuses on a drawn jar, so the assert would test the 1a bundle instead).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const start = SMOKE.indexOf('# ── P) Put-Up 1b + Ferment')
const end = SMOKE.indexOf('# ── DRG-WATERRECON-002')
const BLOCK = SMOKE.slice(start, end)
const sweepStart = BLOCK.indexOf('ferm_sweep() {')
const SWEEP = BLOCK.slice(sweepStart, BLOCK.indexOf('\nSQL\n}', sweepStart))

describe('block P is present, after block N and before the water recon', () => {
  it('sits between N and DRG-WATERRECON-002', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('# ── N) Put-Up: a place and a jar'))
    expect(end).toBeGreaterThan(start)
    expect(sweepStart).toBeGreaterThan(0)
  })

  it.each(['p1-putup-readback', 'p1-legacy-date-refused', 'p1-legacy-echo-noop', 'p2-salt-readback', 'p3-draw',
    'p3-mark-used', 'p3-note-edit', 'p4-weighed-draw', 'p4-draw-to-zero', 'p5-take-out', 'p5-restore',
    'p6-stage-edit', 'p7-shu-save', 'p8-putup-row', 'p8-undo', 'p9-batch-remove', 'l058-sweep'])('asserts %s', (tag) => {
    expect(BLOCK).toContain(`"${tag}"`)
  })
})

describe('ferm_sweep — its own L-058 hard delete, FK order, one transaction, narrow scope', () => {
  const ORDER = [
    'DELETE FROM pantry_use WHERE reverses_use_id IS NOT NULL',
    'DELETE FROM pantry_use WHERE preservation_log_id',
    'DELETE FROM kitchen_batch_input WHERE',
    'DELETE FROM preservation_source',
    'DELETE FROM preservation_log',
    'DELETE FROM kitchen_stage_log',
    'DELETE FROM kitchen_batch WHERE',
    'DELETE FROM storage_location',
  ]
  it('deletes reversing uses → uses → lines → sources → jars → stage rows → batches → place', () => {
    const at = ORDER.map((s) => SWEEP.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('runs as ONE psql transaction that stops on the first error', () => {
    expect(SWEEP).toMatch(/psql "\$NEON_STAGING_URL" -X -q -1 -v ON_ERROR_STOP=1 <<'SQL'/)
  })

  it('every scope is the smoke-test-ferment- prefix (or hangs off a row that has it), never a bare %smoke%', () => {
    const likes = SWEEP.match(/LIKE '[^']*'/g)
    expect(likes.length).toBeGreaterThan(0)
    expect(new Set(likes)).toEqual(new Set(["LIKE 'smoke-test-ferment-%'"]))
    expect(BLOCK).toContain('FE_TAG="smoke-test-ferment-$TEST_RUN_ID"')
  })

  it('cleanup() retries the sweep when the run died mid-block', () => {
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    expect(cleanup).toMatch(/if \[\[ "\$\{FERM_DIRTY:-false\}" == "true" \]\]; then\s+ferm_sweep/)
    expect(BLOCK).toContain('FERM_DIRTY=true')
    expect(BLOCK.indexOf('FERM_DIRTY=false\n      FE_LEFT=')).toBeGreaterThan(BLOCK.indexOf('if ferm_sweep; then'))
  })
})

describe('gating and read-back discipline', () => {
  it('without F on staging it WARNs, and SMOKE_REQUIRE_FERMENT=1 turns that into a FAIL', () => {
    expect(BLOCK).toContain('fe_req GET "$FE_BASE/api/kitchen-batches/line-search?q=smoke"')
    expect(BLOCK).toMatch(/if \[\[ "\$\{SMOKE_REQUIRE_FERMENT:-\}" == "1" \]\]; then\s+fe_fail "deployed"/)
  })

  it('a missing SQL read-back path is a FAIL, not a skip', () => {
    expect(BLOCK).toMatch(/fe_fail "readback-sql"/)
  })

  it('an id reaches SQL only after matching the uuid shape', () => {
    expect(BLOCK).toContain("FE_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'")
    expect(BLOCK).toMatch(/fe_jar\(\) \{ fe_id_ok "\$1" && fe_row/)
  })

  // The legacy PUT refuses a CHANGED note from any bundle (1b §5.4, contract-F §2.6): the F bundle's note edit is
  // PATCH /api/preservation/:id. A PUT here would read 409 client_stale on staging.
  it("P3's note edit is the F bundle's: PATCH /api/preservation/:id, never the legacy PUT", () => {
    const p3 = BLOCK.slice(BLOCK.indexOf('# ── P3)'), BLOCK.indexOf('# ── P4)'))
    expect(p3).toContain('fe_req PATCH "$FE_BASE/api/preservation/$FE_J3" "{\\"notes\\": \\"$FE_TAG edited\\"}"')
    expect(p3).not.toMatch(/fe_req PUT /)
    expect(p3).toContain('"200 2|null|false $FE_TAG edited"')
  })

  // A drawn-jar-free 1a PUT, so the refusal is the 1b echo rule's: the "date" there is use_by_target (V4 §5.4;
  // a differing preserved_at is written, not refused).
  it("P1's refused PUT is the 1a payload with a different discard-by (use_by_target), and the stored one survives", () => {
    const p1 = BLOCK.slice(BLOCK.indexOf('# ── P1)'), BLOCK.indexOf('# ── P2)'))
    expect(p1.match(/FE_ROW=\$\(fe_jq '([^']*)'\)/)[1]).toContain('remaining_count')
    expect(p1).toContain(`jq -c --arg d "$FE_OTHER_DAY" '.use_by_target = $d'`)
    expect(p1).not.toContain('.preserved_at = $d')
    expect(p1).toContain('"409 client_stale $FE_LATER"')
  })
})
