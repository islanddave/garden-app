// PROPOSED by lane T2, NOT in the worktree (a third file is not this lane's to add).
// Destination if adopted: src/__tests__/stagingSmokeSeedParents.static.test.js, in the same commit as the two
// gate files. It was run green against the lane's two files, and each `it` was seen to fail on a mutated copy
// (lane-T2-report.md, section 5).
//
// V5-SEEDMULTIPARENT-001 — static guards on the staging smoke's block U (a seed lot with two parent plantings)
// and on the two statements the L-058 sweep gained for it.
//
// WHY A FILE-READING TEST (stagingSmokeCareProfile.static.test.js's reason). Both halves run only inside
// deploy-staging.yml, against the staging Neon branch, when a promote dispatches it. Nothing in the unit or
// integration suites executes either, so what is falsifiable on a push is their SHAPE. Each assertion pins a
// property whose loss the staging run would report late, or not at all:
//   * the link-row delete or the source_plant_id clear moved after "DELETE FROM plants": the sweep reds with 23503
//     at the next promote, fifteen statements in, and every promote after it (rehearsed on a local PG 17);
//   * the link-row delete run without its to_regclass test: reds on any database that does not have the table,
//     which is staging whenever migrations/v5-seedmultiparent-001 is not applied or its rollback is rehearsed;
//   * the residue term "simplified" into a join on the smoke name: reads 0 with every link row orphaned;
//   * the lot id spliced into SQL text instead of bound as a psql variable;
//   * block U skipped, rather than failed, under the ship gate;
//   * a mint call added to block U: scripts/test_smoke_mint_log.py holds the call-site count, and its failure
//     message does not say where to look.
//
// WHAT IT DOES NOT CATCH: whether the SQL is right for the live schema, or whether the Lambdas answer as block U
// expects. Every deploy-staging run executes both for real.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'

const WF = yaml.load(readFileSync(resolve(process.cwd(), '.github/workflows/deploy-staging.yml'), 'utf8'))
const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')

const SWEEP = WF.jobs['smoke-tests'].steps.find((s) => s.name === 'L-058 smoke-test row hygiene cleanup')
const SMOKE_PLANTS =
  "SELECT id FROM plants WHERE name ILIKE '%smoke%' OR project_id IN (SELECT id FROM plant_projects WHERE name ILIKE '%smoke%')"

describe('the L-058 sweep takes a smoke lot\'s parent links before the plantings', () => {
  const run = SWEEP.run
  const linkDelete = run.indexOf('DELETE FROM seed_lot_parent_planting')
  const cacheClear = run.indexOf('UPDATE inventory_items SET source_plant_id = NULL')
  const plants = run.indexOf('-c "DELETE FROM plants ')
  const inventory = run.indexOf('-c "DELETE FROM inventory_items ')

  it('deletes the link rows of smoke lots and of smoke plantings, and nothing wider', () => {
    const deletes = run.match(/DELETE FROM seed_lot_parent_planting\b[^"]*/g) ?? []
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toBe(
      `DELETE FROM seed_lot_parent_planting WHERE inventory_item_id IN (SELECT id FROM inventory_items WHERE name ILIKE '%smoke%') OR plant_id IN (${SMOKE_PLANTS});`,
    )
  })

  it('clears source_plant_id only where it is set, on smoke lots and on lots pointing at a planting about to go', () => {
    const updates = run.match(/UPDATE inventory_items\b[^"]*/g) ?? []
    expect(updates).toHaveLength(1)
    expect(updates[0]).toBe(
      `UPDATE inventory_items SET source_plant_id = NULL WHERE source_plant_id IS NOT NULL AND (name ILIKE '%smoke%' OR source_plant_id IN (${SMOKE_PLANTS}));`,
    )
  })

  it('runs both BEFORE the plants delete, which still runs before the inventory_items delete', () => {
    expect(linkDelete).toBeGreaterThan(-1)
    expect(cacheClear).toBeGreaterThan(linkDelete)
    expect(plants).toBeGreaterThan(cacheClear)
    expect(inventory).toBeGreaterThan(plants)
  })

  it('reads the table\'s presence with to_regclass, and deletes link rows only when it is there', () => {
    const probe = run.indexOf(
      `SEED_PARENT_TABLE=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL;")`,
    )
    const guard = run.indexOf('if [[ "$SEED_PARENT_TABLE" == "t" ]]; then')
    expect(probe).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(probe)
    expect(linkDelete).toBeGreaterThan(guard)
    // the guarded arm closes before the main sweep begins, so the delete cannot have drifted out of it
    const arm = run.slice(guard, run.indexOf('\nfi\n', guard))
    expect(arm).toContain('DELETE FROM seed_lot_parent_planting')
    expect(arm).toContain('SEED_PARENT_LEFT="(SELECT COUNT(*) FROM seed_lot_parent_planting ')
    // a cast would raise 42P01 on a database without the table
    expect(run).not.toMatch(/seed_lot_parent_planting'::regclass/)
  })

  it('counts leftover link rows by ids captured before the sweep, never by a join on the smoke name', () => {
    const capture = run.indexOf('SMOKE_PARENT_KEYS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c ')
    expect(capture).toBeGreaterThan(-1)
    expect(linkDelete).toBeGreaterThan(capture)
    expect(run).toContain('SEED_PARENT_LEFT="0"')
    expect(run).toContain(
      `SEED_PARENT_LEFT="(SELECT COUNT(*) FROM seed_lot_parent_planting WHERE inventory_item_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]) OR plant_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]))"`,
    )
    const remaining = run.split('\n').find((l) => l.startsWith('REMAINING='))
    expect(remaining.endsWith(' + $SEED_PARENT_LEFT;")')).toBe(true)
    expect(remaining).not.toContain('seed_lot_parent_planting')
  })
})

describe('block U of the smoke: a seed lot with two parent plantings', () => {
  const start = SMOKE.indexOf('# ── U) A saved-seed lot with TWO parent plantings')
  const end = SMOKE.indexOf('# ── H) Bulk Quick-Log batch')
  const block = SMOKE.slice(start, end)
  const code = block.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')

  it('sits inside the project arm, after F3 and before H', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('# ── F3)'))
    expect(end).toBeGreaterThan(start)
    expect(end).toBeLessThan(SMOKE.indexOf('WARNING: POST succeeded but no id in response'))
  })

  it('sends both parents on the create and names its rows so the sweep finds them', () => {
    // the create's own line: U4's PUT carries the same array, so a search of the whole block would not do
    const create = code.split('\n').find((l) => l.includes('sp_req POST "$STAGING_API_INVENTORY" ')) ?? ''
    expect(create).toContain('\\"source_plant_ids\\": [\\"$SP_P1\\", \\"$SP_P2\\"]}"')
    expect(create).toContain('\\"name\\": \\"smoke-test-seedlot-$TEST_RUN_ID\\"')
    expect(code).toContain('SP_P2_NAME="smoke-test-seedparent-$TEST_RUN_ID"')
    expect(code).toContain('sp_req POST "$STAGING_API_PLANTS" "{\\"project_id\\": \\"$CREATED_PROJECT_ID\\", \\"name\\": \\"$SP_P2_NAME\\"}"')
  })

  it('reads the lot from the planting\'s side under the parent the column does not hold', () => {
    expect(code).toContain('sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_OFF/seed-lots"')
    expect(code).toContain('"200 listed|other_parents:$SP_ON"')
  })

  it('expects the legacy PATCH refused, with an id and with null, and the lot unchanged after each', () => {
    const refused = code.match(/sp_check "u4-legacy-(set|clear)-refused" "\$SP_WRITE \$SP_STATE" "409 multi_parent_lot \$SP_TWO"/g) ?? []
    expect(refused).toHaveLength(2)
    expect(code).toContain('SP_TWO="200 $SP_BOTH|$SP_P2"')
    expect(code).toContain(`sp_req PATCH "$SP_INV/$SP_LOT/source-plant" '{"source_plant_id": null}'`)
  })

  it('reads the link rows back through SQL, with the lot id bound and never spliced', () => {
    expect(code).toContain('-v lot="$SP_LOT"')
    expect(code).toMatch(/<<< "SELECT [^"]*:'lot'::uuid;"/)
    expect(code).not.toMatch(/'\$SP_LOT'/)
    expect(code).toContain('sp_check "u5-link-rows-readback" "$SP_ROWS" "2|1|true"')
    expect(code).toContain("l.role = 'seed_parent'")
  })

  it('fails the ship gate, rather than skipping, when it cannot run or cannot read the rows', () => {
    const sqlBranch = code.match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "u5-link-rows-readback"/)
    expect(sqlBranch).not.toBeNull()
    const blockBranch = code.match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*echo "❌ FAIL \[seed-parents\][^\n]*\n\s*FAIL=\$\(\(FAIL\+1\)\)/)
    expect(blockBranch).not.toBeNull()
  })

  it('expects the delete to go through with its parents linked, and mints no token of its own', () => {
    expect(code).toContain('sp_check "u6-delete-with-parents" "$SP_WRITE $SP_CODE" "200 true 404"')
    expect(code).not.toContain('mint_session_token')
  })

  it('is cleaned up by the trap when the run dies inside it', () => {
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    expect(cleanup).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDLOT_ID}"')
    expect(cleanup).toContain('"${STAGING_API_PLANTS%/}/api/plants/${CREATED_SEEDPARENT_PLANT_ID}"')
    expect(SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))).toMatch(/^CREATED_SEEDLOT_ID=""$/m)
    expect(SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))).toMatch(/^CREATED_SEEDPARENT_PLANT_ID=""$/m)
  })
})
