// V5-SEEDMULTIPARENT-001 — static guards on the staging smoke's block U (a seed lot with two parent plantings)
// and on the three statements the L-058 sweep gained for it.
//
// WHY A FILE-READING TEST (stagingSmokeCareProfile.static.test.js's reason). Both halves run only inside
// deploy-staging.yml, against the staging Neon branch, when a promote dispatches it. Nothing in the unit or
// integration suites executes either, so what is falsifiable on a push is their SHAPE. Each assertion pins a
// property whose loss the staging run would report late, or not at all:
//   * the link-row delete or the source_plant_id clear moved after "DELETE FROM plants": the sweep reds with 23503
//     at the next promote, fifteen statements in, and every promote after it (rehearsed on a local PG 17);
//   * the link-row delete, or the statement that moves a surviving lot's pointer, run without the to_regclass
//     test: reds on any database that does not have the table, which is staging whenever
//     migrations/v5-seedmultiparent-001 is not applied or its rollback is rehearsed;
//   * that pointer move dropped, or run before the link delete: a lot a person saved on staging is left with a
//     live link row beside a NULL source_plant_id, a row of the standing gate post_nonempty_set_has_a_cache;
//   * the plants delete narrowed while the statements that clear pointers at "plantings about to be deleted" are
//     not: pointers at plantings that survive are cleared, and nothing says so;
//   * the residue term "simplified" into a join on the smoke name (reads 0 with every link row orphaned), or the
//     residue check no longer failing the step;
//   * the lot id spliced into SQL text instead of bound as a psql variable;
//   * block U skipped, rather than failed, under the ship gate; an assert deleted from it; a helper that no
//     longer compares or no longer counts; a failed create or a failed parent-planting delete downgraded to a
//     warning; a failed SQL read-back mapped to the string it is compared with;
//   * a request that needs the session token placed after the block's SQL read, or a mint call added to it:
//     the block mints no token (scripts/test_smoke_mint_log.py holds the call-site count, and its failure
//     message does not say where to look), so its database round trip has to come last.
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

// "A planting about to be deleted" and "a smoke lot" are whatever the step's OWN two deletes say they are. Read
// from those statements rather than repeated here, so narrowing either delete without the statements that lean
// on it fails this file.
const PLANTS_DELETES = SWEEP.run.match(/-c "DELETE FROM plants\s+WHERE [^"]+;"/g) ?? []
const LOTS_DELETES = SWEEP.run.match(/-c "DELETE FROM inventory_items\s+WHERE [^"]+;"/g) ?? []
const PLANTS_PREDICATE = (PLANTS_DELETES[0] ?? '').replace(/^-c "DELETE FROM plants\s+WHERE /, '').replace(/;"$/, '')
const LOTS_PREDICATE = (LOTS_DELETES[0] ?? '').replace(/^-c "DELETE FROM inventory_items\s+WHERE /, '').replace(/;"$/, '')
const SMOKE_PLANTS = `SELECT id FROM plants WHERE ${PLANTS_PREDICATE}`
const SMOKE_LOTS = `SELECT id FROM inventory_items WHERE ${LOTS_PREDICATE}`
const REPOINT =
  `UPDATE inventory_items i SET source_plant_id = (SELECT l.plant_id FROM seed_lot_parent_planting l WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL ORDER BY l.created_at, l.id LIMIT 1) WHERE i.name NOT ILIKE '%smoke%' AND i.source_plant_id IN (${SMOKE_PLANTS}) RETURNING i.id, i.name, i.source_plant_id;`

describe('the L-058 sweep takes a smoke lot\'s parent links before the plantings', () => {
  const run = SWEEP.run
  const linkDelete = run.indexOf('DELETE FROM seed_lot_parent_planting')
  const repoint = run.indexOf('UPDATE inventory_items i SET source_plant_id = (SELECT')
  const cacheClear = run.indexOf('UPDATE inventory_items SET source_plant_id = NULL')
  const plants = run.indexOf('-c "DELETE FROM plants ')
  const inventory = run.indexOf('-c "DELETE FROM inventory_items ')
  const guard = run.indexOf('if [[ "$SEED_PARENT_TABLE" == "t" ]]; then')
  // the guarded arm: from its test to the `else` that prints "not on this database"
  const arm = run.slice(guard, run.indexOf('\nelse\n', guard))

  it('has one plants delete and one inventory_items delete to take its two predicates from', () => {
    expect(PLANTS_DELETES).toHaveLength(1)
    expect(LOTS_DELETES).toHaveLength(1)
    expect(PLANTS_PREDICATE).toBe(
      "name ILIKE '%smoke%' OR project_id IN (SELECT id FROM plant_projects WHERE name ILIKE '%smoke%')",
    )
    // the pointer move below is written against this one: its `i.name NOT ILIKE '%smoke%'` is the negation
    expect(LOTS_PREDICATE).toBe("name ILIKE '%smoke%'")
  })

  it('deletes the link rows of smoke lots and of smoke plantings, and nothing wider', () => {
    const deletes = run.match(/DELETE FROM seed_lot_parent_planting\b[^"]*/g) ?? []
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toBe(
      `DELETE FROM seed_lot_parent_planting WHERE inventory_item_id IN (${SMOKE_LOTS}) OR plant_id IN (${SMOKE_PLANTS});`,
    )
  })

  it('runs the link delete under ON_ERROR_STOP', () => {
    expect(run).toContain('psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM seed_lot_parent_planting ')
  })

  it('has exactly two updates of inventory_items: the pointer move, then the clear', () => {
    const updates = run.match(/UPDATE inventory_items\b[^"]*/g) ?? []
    expect(updates).toHaveLength(2)
    expect(updates[0]).toBe(REPOINT)
    expect(updates[1]).toBe(
      `UPDATE inventory_items SET source_plant_id = NULL WHERE source_plant_id IS NOT NULL AND (${LOTS_PREDICATE} OR source_plant_id IN (${SMOKE_PLANTS}));`,
    )
  })

  it('moves a surviving lot\'s pointer to its earliest remaining live seed parent, after the link delete, inside the guarded arm', () => {
    expect(run).toContain(`psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -c "${REPOINT}"`)
    // after the link delete: before it, the earliest live row could still be the planting that is going
    expect(repoint).toBeGreaterThan(linkDelete)
    // inside the arm: outside it the statement names a table that may not exist
    expect(arm).toContain(REPOINT)
    expect(arm.indexOf(REPOINT)).toBeGreaterThan(arm.indexOf('DELETE FROM seed_lot_parent_planting'))
    expect(arm.indexOf('SEED_PARENT_LEFT="(SELECT')).toBeGreaterThan(arm.indexOf(REPOINT))
  })

  it('runs all three BEFORE the plants delete, which still runs before the inventory_items delete', () => {
    expect(linkDelete).toBeGreaterThan(-1)
    expect(repoint).toBeGreaterThan(linkDelete)
    expect(cacheClear).toBeGreaterThan(repoint)
    expect(plants).toBeGreaterThan(cacheClear)
    expect(inventory).toBeGreaterThan(plants)
  })

  it('reads the table\'s presence with to_regclass, and deletes link rows only when it is there', () => {
    const probe = run.indexOf(
      `SEED_PARENT_TABLE=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL;")`,
    )
    expect(probe).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(probe)
    expect(linkDelete).toBeGreaterThan(guard)
    // the guarded arm closes before the main sweep begins, so neither statement can have drifted out of it
    expect(arm).toContain('DELETE FROM seed_lot_parent_planting')
    expect(arm).toContain('SEED_PARENT_LEFT="(SELECT COUNT(*) FROM seed_lot_parent_planting ')
    expect(arm).not.toContain('-c "DELETE FROM plants ')
    // every psql call that names the table is the probe or sits in that arm; the main chain names it nowhere
    const calls = run.split('\n').filter((l) => l.includes('psql ') && l.includes('seed_lot_parent_planting'))
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain("to_regclass('public.seed_lot_parent_planting')")
    expect(arm).toContain(calls[1].trim())
    expect(arm).toContain(calls[2].trim())
    expect(run.split('\n').filter((l) => l.trimStart().startsWith('-c "') && l.includes('seed_lot_parent_planting'))).toHaveLength(0)
    // a cast would raise 42P01 on a database without the table
    expect(run).not.toMatch(/seed_lot_parent_planting'::regclass/)
  })

  it('counts leftover link rows by ids captured before the sweep, never by a join on the smoke name', () => {
    const capture = run.indexOf('SMOKE_PARENT_KEYS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c ')
    expect(capture).toBeGreaterThan(-1)
    expect(linkDelete).toBeGreaterThan(capture)
    expect(run).toContain(
      `SMOKE_PARENT_KEYS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT COALESCE(string_agg(id::text, ','), '') FROM (${SMOKE_LOTS} UNION ALL ${SMOKE_PLANTS}) k;")`,
    )
    expect(run).toContain('SEED_PARENT_LEFT="0"')
    expect(run).toContain(
      `SEED_PARENT_LEFT="(SELECT COUNT(*) FROM seed_lot_parent_planting WHERE inventory_item_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]) OR plant_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]))"`,
    )
    const remaining = run.split('\n').find((l) => l.startsWith('REMAINING='))
    expect(remaining.endsWith(' + $SEED_PARENT_LEFT;")')).toBe(true)
    expect(remaining).not.toContain('seed_lot_parent_planting')
  })

  it('still fails the step when residue remains', () => {
    expect(run).toMatch(/if \[\[ "\$REMAINING" != "0" \]\]; then\n\s*echo "[^\n]*\n\s*exit 1\n\s*fi/)
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

  it('runs only when block D left a variety and a planting', () => {
    expect(code).toContain('if [[ -n "${STAGING_API_INVENTORY:-}" && -n "${CREATED_VARIETY_ID:-}" && -n "${CREATED_PLANT_ID:-}" ]]; then')
  })

  it('keeps its helpers honest: sp_check compares, sp_pass and sp_fail count', () => {
    expect(code).toContain('sp_pass() { echo "✅ PASS [seed-parents:$1] $2"; PASS=$((PASS+1)); }')
    expect(code).toContain('sp_fail() { echo "❌ FAIL [seed-parents:$1] $2"; FAIL=$((FAIL+1)); }')
    expect(code).toContain(`sp_check() { if [[ "$2" == "$3" ]]; then sp_pass "$1" "$4 → '$2'"; else sp_fail "$1" "$4 → '$2' (expected '$3')"; fi; }`)
  })

  it('sends both parents on the create and names its rows so the sweep finds them', () => {
    // the create's own line: U4's PUT carries the same array, so a search of the whole block would not do
    const create = code.split('\n').find((l) => l.includes('sp_req POST "$STAGING_API_INVENTORY" ')) ?? ''
    expect(create).toContain('\\"source_plant_ids\\": [\\"$SP_P1\\", \\"$SP_P2\\"]}"')
    expect(create).toContain('\\"name\\": \\"smoke-test-seedlot-$TEST_RUN_ID\\"')
    expect(code).toContain('SP_P2_NAME="smoke-test-seedparent-$TEST_RUN_ID"')
    expect(code).toContain('sp_req POST "$STAGING_API_PLANTS" "{\\"project_id\\": \\"$CREATED_PROJECT_ID\\", \\"name\\": \\"$SP_P2_NAME\\"}"')
  })

  it('fails, never warns, when either create does not answer as expected', () => {
    expect(code).toContain('sp_fail "u1-create" "POST /api/inventory-items with source_plant_ids [P1, P2] → HTTP $SP_CODE (expected 201 and an id)')
    expect(code).toContain(`sp_fail "second-parent" "POST /api/plants → HTTP $SP_CODE, id '$SP_P2'`)
  })

  it('hands both ids to cleanup() and never lets a failed SQL read-back read as the expected string', () => {
    expect(code).toContain('CREATED_SEEDPARENT_PLANT_ID="$SP_P2"')
    expect(code).toContain('CREATED_SEEDLOT_ID="$SP_LOT"')
    expect(code).toContain('|| SP_ROWS="psql-exit-$?"')
  })

  it('tracks the second planting for cleanup() as soon as it exists, before block D\'s id is looked at', () => {
    const track = code.indexOf('if sp_id_ok "$SP_P2"; then CREATED_SEEDPARENT_PLANT_ID="$SP_P2"; fi')
    const gate = code.indexOf('if [[ "${SP_CODE:0:1}" == "2" ]] && sp_id_ok "$SP_P2" && sp_id_ok "$SP_P1"; then')
    expect(track).toBeGreaterThan(-1)
    // a P2 that exists is tracked whatever the test below it decides about block D's planting
    expect(gate).toBeGreaterThan(track)
    expect(code.match(/CREATED_SEEDPARENT_PLANT_ID="\$SP_P2"/g) ?? []).toHaveLength(1)
  })

  it('asserts the create read-back, the replace and the re-add', () => {
    expect(code).toContain('"200 $SP_BOTH|one-of-them|$SP_P2_NAME"')
    expect(code).toContain('sp_check "u3-replace-readback" "$SP_WRITE $SP_STATE" "200 200 $SP_P2|$SP_P2"')
    expect(code).toContain('sp_check "u4-readd-readback" "$SP_WRITE $SP_STATE" "200 $SP_TWO"')
  })

  it('keeps the uncached parent as the one U2 asks about', () => {
    expect(code).toContain('"$SP_P1") SP_ON="$SP_P1"; SP_OFF="$SP_P2"; SP_MEMBER="one-of-them" ;;')
    expect(code).toContain('"$SP_P2") SP_ON="$SP_P2"; SP_OFF="$SP_P1"; SP_MEMBER="one-of-them" ;;')
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

  it('expects the delete to go through with its parents linked, and mints no token of its own', () => {
    expect(code).toContain('sp_check "u6-delete-with-parents" "$SP_WRITE $SP_CODE" "200 true 404"')
    expect(code).not.toContain('mint_session_token')
  })

  it('fails the ship gate when the parent planting\'s own delete does not answer 200', () => {
    expect(code).toMatch(
      /sp_req DELETE "\$\{STAGING_API_PLANTS%\/\}\/api\/plants\/\$SP_P2"\n\s*if \[\[ "\$SP_CODE" == "200" \]\]; then\n\s*CREATED_SEEDPARENT_PLANT_ID=""\n\s*elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "second-parent-delete" "DELETE \/api\/plants\/\$SP_P2 → HTTP \$SP_CODE \(expected 200/,
    )
  })

  it('reads the link rows back through SQL, with the lot id bound and never spliced', () => {
    expect(code).toContain('-v lot="$SP_LOT"')
    expect(code).toMatch(/<<< "SELECT [^"]*:'lot'::uuid;"/)
    expect(code).not.toMatch(/'\$SP_LOT'/)
    expect(code).toContain('sp_check "u5-link-rows-readback" "$SP_ROWS" "2|1|true"')
    expect(code).toContain("l.role = 'seed_parent'")
  })

  it('runs that SQL read last, for a lot it made, with no request that needs the token after it', () => {
    const lotDelete = code.indexOf('sp_check "u6-delete-with-parents"')
    const plantingDelete = code.indexOf('sp_req DELETE "${STAGING_API_PLANTS%/}/api/plants/$SP_P2"')
    const sqlRead = code.indexOf('SP_ROWS=$(psql "$NEON_STAGING_URL" ')
    expect(lotDelete).toBeGreaterThan(-1)
    expect(plantingDelete).toBeGreaterThan(lotDelete)
    expect(sqlRead).toBeGreaterThan(plantingDelete)
    expect(code.lastIndexOf('sp_req ')).toBeLessThan(sqlRead)
    // only for a lot the block made: the flag is lowered before the create is judged and raised with the id
    expect(code).toMatch(/SP_LOT_MADE=false\n\s*if \[\[ "\$SP_CODE" == "201" \]\] && sp_id_ok "\$SP_LOT"; then\n\s*CREATED_SEEDLOT_ID="\$SP_LOT"\n\s*SP_LOT_MADE=true\n/)
    expect(code).toMatch(/if \[\[ "\$SP_LOT_MADE" == "true" \]\]; then\n\s*if \[\[ -n "\$\{NEON_STAGING_URL:-\}" \]\] && command -v psql >\/dev\/null 2>&1; then\n\s*SP_ROWS=\$\(psql /)
  })

  it('fails the ship gate, rather than skipping, when it cannot run or cannot read the rows', () => {
    const sqlBranch = code.match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "u5-link-rows-readback"/)
    expect(sqlBranch).not.toBeNull()
    const blockBranch = code.match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*echo "❌ FAIL \[seed-parents\][^\n]*\n\s*FAIL=\$\(\(FAIL\+1\)\)/)
    expect(blockBranch).not.toBeNull()
  })

  it('is cleaned up by the trap when the run dies inside it', () => {
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    expect(cleanup).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDLOT_ID}"')
    expect(cleanup).toContain('"${STAGING_API_PLANTS%/}/api/plants/${CREATED_SEEDPARENT_PLANT_ID}"')
    expect(SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))).toMatch(/^CREATED_SEEDLOT_ID=""$/m)
    expect(SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))).toMatch(/^CREATED_SEEDPARENT_PLANT_ID=""$/m)
  })
})
