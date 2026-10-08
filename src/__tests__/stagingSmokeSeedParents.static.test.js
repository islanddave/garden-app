// V5-SEEDMULTIPARENT-001 — static guards on the staging smoke's block U (seed lots and their parent plantings:
// the one-parent path every shipped client uses, then a lot with two parents; since release 2a also the parent
// rules, the named mix, a lot filed under it, its filing, its plant count and its seed_saved events) and on the
// statements the L-058 sweep gained for it (release 1: the parent links; release 2a: the mix).
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
//   * block U skipped, rather than failed, under the ship gate; an assert deleted from it or turned into a line
//     that compares nothing; a write judged without the read-back that follows it; a helper that no longer
//     compares, counts or reads; a failed create or a failed parent-planting delete downgraded to a warning; a
//     failed SQL read-back mapped to the string it is compared with;
//   * the one-parent create sent the new way (source_plant_ids) instead of the way a shipped client sends it, or
//     its lot renamed so the sweep no longer collects it;
//   * the block grown past the number of requests its own comment reasons about, or one of its two mints moved
//     or dropped, so that a stretch of it outruns a 60-second session token (scripts/test_smoke_mint_log.py holds
//     the call-site count, and its failure message does not say where to look);
//   * a request that needs the session token placed after the block's SQL reads;
//   * RELEASE 2a. A block-U parent created without a variety again: the create then answers 400
//     parent_without_variety and EVERY promote is refused, whoever dispatches it;
//   * the mix's component rows deleted after "DELETE FROM plant_varieties", or not at all: 23503 at the next
//     promote and every one after it (both of the table's keys are RESTRICT; rehearsed on a local PG 17);
//   * the component delete and the delete of the mix row split into two psql calls again, or either moved back
//     into a chain: between them, and for good when the chain stops on the way, staging holds a keyed mix with no
//     component row, which is a row of the standing gate post_blend_key_equals_live_components (review finding S1);
//   * a helper every block-U line runs through changed under it (review finding S2): sp_req sending no token or
//     no body, the uuid pattern, sp_id_ok, sp_jq and sp_jqx, sp_drop answering 0 after a failed DELETE, cleanup()'s
//     loop sending something other than DELETE; or the sweep's own skip test inverted, so that it sweeps nothing
//     and reports success;
//   * the mix found by its NAME only: a renamed mix keeps its component rows and the same 23503 follows;
//   * the mix ids captured after a delete has run, or the capture, the delete or the residue term run without
//     the to_regclass test on a database that has no variety_blend_component;
//   * a release 2a assert deleted, reordered so it reads before it writes, or its expected string loosened;
//   * RELEASE 3. A smoke lot's stage rows deleted after "DELETE FROM inventory_items", or not at all: 23503 at the
//     first run after U24 gives the gift lot a stage, and at every run after it (seed_lot_stage_log's key to
//     inventory_items has no ON DELETE action; rehearsed on a local PG 17).
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
    // 3 -> 4 with release 3: the picking delete names the table too (it selects the link rows about to go),
    // and it is the FIRST statement of the arm, ahead of the link delete (its own describe is below).
    const calls = run.split('\n').filter((l) => l.includes('psql ') && l.includes('seed_lot_parent_planting'))
    expect(calls).toHaveLength(4)
    expect(calls[0]).toContain("to_regclass('public.seed_lot_parent_planting')")
    expect(calls[1]).toContain('-c "DELETE FROM seed_lot_addition WHERE parent_link_id IN (SELECT id FROM seed_lot_parent_planting ')
    expect(calls[2]).toContain('-c "DELETE FROM seed_lot_parent_planting ')
    expect(arm).toContain(calls[1].trim())
    expect(arm).toContain(calls[2].trim())
    expect(arm).toContain(calls[3].trim())
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
    // Release 3 APPENDED two terms (the picking table's, then the stage rows', last); every term before them reads
    // as it did.
    expect(remaining).toContain(" + $SEED_PARENT_LEFT + (SELECT COUNT(*) FROM plant_varieties WHERE id = ANY('{$SMOKE_MIX_IDS}'::uuid[])) + $BLEND_LEFT + $SEED_ADDITION_LEFT + (SELECT COUNT(*) FROM seed_lot_stage_log ")
    expect(remaining.endsWith(";\")")).toBe(true)
    expect(remaining).not.toContain('seed_lot_parent_planting')
  })

  it('still fails the step when residue remains', () => {
    expect(run).toMatch(/if \[\[ "\$REMAINING" != "0" \]\]; then\n\s*echo "[^\n]*\n\s*exit 1\n\s*fi/)
  })
})

// ── release 3: a picking row goes before the link row it hangs on (V5-SEEDLOTADDITION-001) ────────────────────────
// seed_lot_addition has ONE foreign key, parent_link_id -> seed_lot_parent_planting(id), ON DELETE RESTRICT. A
// picking left under a smoke lot's link row stops the link delete with 23503; under ON_ERROR_STOP the step fails
// there, the row stays, and every later run fails the same way until staging is cleaned by hand. "A link row about
// to be deleted" is whatever the step's OWN link delete says it is — read from that statement, as the two
// predicates above are read from theirs, so narrowing or widening the link delete without the picking delete
// fails this file.
describe('the L-058 sweep takes a smoke lot\'s pickings before its parent links', () => {
  const run = SWEEP.run
  const lines = run.split('\n')
  const LINK_DELETES = run.match(/-c "DELETE FROM seed_lot_parent_planting WHERE [^"]+;"/g) ?? []
  const LINK_PREDICATE = (LINK_DELETES[0] ?? '').replace(/^-c "DELETE FROM seed_lot_parent_planting WHERE /, '').replace(/;"$/, '')
  const PICKING_DELETE = `DELETE FROM seed_lot_addition WHERE parent_link_id IN (SELECT id FROM seed_lot_parent_planting WHERE ${LINK_PREDICATE});`
  const PROBE = `SEED_ADDITION_TABLE=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT to_regclass('public.seed_lot_addition') IS NOT NULL;")`
  const LEFT = `SEED_ADDITION_LEFT="(SELECT COUNT(*) FROM seed_lot_addition WHERE parent_link_id IN (SELECT id FROM seed_lot_parent_planting WHERE inventory_item_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]) OR plant_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[])))"`
  const outer = run.indexOf('if [[ "$SEED_PARENT_TABLE" == "t" ]]; then')
  const arm = run.slice(outer, run.indexOf('\nelse\n', outer))
  const inner = arm.indexOf('if [[ "$SEED_ADDITION_TABLE" == "t" ]]; then')
  // where the inner guard's `fi` is (indented: it is nested one level inside the arm)
  const closes = inner + arm.slice(inner).search(/\n\s*fi\n/)

  it('has one link delete to take its predicate from, and it is the one the block above pins', () => {
    expect(LINK_DELETES).toHaveLength(1)
    expect(LINK_PREDICATE).toBe(`inventory_item_id IN (${SMOKE_LOTS}) OR plant_id IN (${SMOKE_PLANTS})`)
  })

  it('deletes exactly the pickings whose link row the link delete is about to remove — its predicate, character for character', () => {
    const deletes = run.match(/DELETE FROM seed_lot_addition\b[^"]*/g) ?? []
    expect(deletes).toEqual([PICKING_DELETE])
    expect(lines.filter((l) => l.trim() === `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -c "${PICKING_DELETE}"`)).toHaveLength(1)
  })

  it('runs it INSIDE the arm that knows the link table exists, under its own to_regclass guard, and BEFORE the link delete', () => {
    expect(inner).toBeGreaterThan(0)
    const picking = arm.indexOf('DELETE FROM seed_lot_addition ')
    const link = arm.indexOf('-c "DELETE FROM seed_lot_parent_planting ')
    expect(picking).toBeGreaterThan(inner)
    expect(link).toBeGreaterThan(picking)
    // the inner guard closes before the link delete, so the link delete does not depend on the picking table
    expect(closes).toBeGreaterThan(picking)
    expect(link).toBeGreaterThan(closes)
    // and it has no `else`: the block above finds the arm's end by its first one
    expect(arm.slice(inner, closes)).not.toMatch(/\belse\b/)
    expect(arm).toContain('SEED_PARENT_LEFT="(SELECT COUNT(*) FROM seed_lot_parent_planting ')
    // order in the whole step: pickings, links, the pointer move, the clear, plantings, lots
    const at = (text) => run.indexOf(text)
    const order = [
      at('DELETE FROM seed_lot_addition '), at('-c "DELETE FROM seed_lot_parent_planting '), at('UPDATE inventory_items i SET source_plant_id = (SELECT'),
      at('UPDATE inventory_items SET source_plant_id = NULL'), at('-c "DELETE FROM plants '), at('-c "DELETE FROM inventory_items '),
    ]
    for (const i of order) expect(i).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('reads the table\'s presence once with to_regclass, beside the link table\'s probe, and names it nowhere else outside the arm', () => {
    const probe = run.indexOf(PROBE)
    const linkProbe = run.indexOf(`SEED_PARENT_TABLE=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL;")`)
    expect(probe).toBeGreaterThan(linkProbe)
    expect(outer).toBeGreaterThan(probe)
    expect(lines.filter((l) => l.trim().startsWith('SEED_ADDITION_TABLE='))).toHaveLength(1)
    // every line that names the table: the probe, the delete and the residue term (both in the arm), and the
    // closing echo's list of what was counted
    const naming = lines.filter((l) => l.includes('seed_lot_addition')).map((l) => l.trim())
    expect(naming).toHaveLength(4)
    expect(naming[0]).toBe(PROBE)
    expect(arm).toContain(naming[1])
    expect(arm).toContain(naming[2])
    expect(naming[3].startsWith('echo "')).toBe(true)
    expect(lines.filter((l) => l.trimStart().startsWith('-c "') && l.includes('seed_lot_addition'))).toHaveLength(0)
    // a cast would raise 42P01 on a database without the table
    expect(run).not.toMatch(/seed_lot_addition'::regclass/)
  })

  it('counts leftover pickings by the ids captured before any delete, in the term straight after the mix\'s', () => {
    expect(run).toContain('\nSEED_ADDITION_LEFT="0"\n')
    expect(run.indexOf('\nSEED_ADDITION_LEFT="0"\n')).toBeLessThan(outer)
    expect(arm).toContain(LEFT)
    expect(arm.indexOf(LEFT)).toBeGreaterThan(arm.indexOf('DELETE FROM seed_lot_addition '))
    expect(arm.indexOf(LEFT)).toBeLessThan(closes)
    const remaining = lines.find((l) => l.startsWith('REMAINING='))
    // it was the last term until the stage rows' term was appended after it (the describe below)
    expect(remaining).toContain(' + $BLEND_LEFT + $SEED_ADDITION_LEFT + (SELECT COUNT(*) FROM seed_lot_stage_log ')
    expect(remaining.match(/\$SEED_ADDITION_LEFT/g)).toHaveLength(1)
    expect(remaining).not.toContain('seed_lot_addition')
  })
})

// ── release 3, pre-promote review (regression B2): a lot's stage rows go before the lot ──────────────────────────
// seed_lot_stage_log.inventory_item_id names inventory_items with NO ON DELETE action, and POST /seed-stage, its
// one writer, adds a row on every call. Block U's U24 is the smoke's first call of that route (the gift lot), and
// the API DELETE after it is a soft delete. A stage row left under a smoke lot stops "DELETE FROM inventory_items"
// with 23503; the step fails there, the lot and the row stay, and every later run fails on the same row. "A smoke
// lot" is whatever the step's OWN lot delete says it is, as above, so narrowing or widening that delete without
// this one fails this file.
describe('the L-058 sweep takes a smoke lot\'s stage rows before the lot', () => {
  const run = SWEEP.run
  const lines = run.split('\n')
  const STAGE_DELETE = `DELETE FROM seed_lot_stage_log WHERE inventory_item_id IN (${SMOKE_LOTS});`
  const STAGE_LEFT = "(SELECT COUNT(*) FROM seed_lot_stage_log WHERE inventory_item_id = ANY('{$SMOKE_PARENT_KEYS}'::uuid[]))"
  const at = lines.findIndex((l) => l.trim() === `-c "${STAGE_DELETE}" \\`)

  it('deletes exactly the stage rows of the lots the lot delete is about to remove: its predicate, character for character', () => {
    const deletes = run.match(/DELETE FROM seed_lot_stage_log\b[^"]*/g) ?? []
    expect(deletes).toEqual([STAGE_DELETE])
    expect(at).toBeGreaterThan(-1)
  })

  it('runs it in the first chain, under ON_ERROR_STOP, directly ahead of the lot delete', () => {
    // the very next line is the lot delete: nothing can be put between a lot's stage rows and the lot
    expect(lines[at + 1].trim()).toBe(`${LOTS_DELETES[0]} \\`)
    // a line of the first chain: after the call that opens it, before the care_profile delete that ends it
    const chain = lines.findIndex((l) => l.trim() === 'psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 \\')
    const chainEnd = lines.findIndex((l, i) => i > chain && l.trimStart().startsWith('-c "') && !l.trimEnd().endsWith('\\'))
    expect(chain).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(chain)
    expect(at).toBeLessThan(chainEnd)
    for (let i = chain + 1; i <= chainEnd; i += 1) expect(lines[i].trimStart().startsWith('-c "')).toBe(true)
    expect(lines[chainEnd].trim().startsWith('-c "DELETE FROM care_profile ')).toBe(true)
  })

  it('needs no to_regclass test: the table is named by no probe and by no cast', () => {
    expect(run).not.toContain("to_regclass('public.seed_lot_stage_log')")
    expect(run).not.toMatch(/seed_lot_stage_log'::regclass/)
    // every line that names the table: the delete, the residue sum, and the two echoes that list what was done
    const naming = lines.filter((l) => l.includes('seed_lot_stage_log')).map((l) => l.trim())
    expect(naming).toHaveLength(4)
    expect(naming[0]).toBe(`-c "${STAGE_DELETE}" \\`)
    expect(naming[1].startsWith('echo "  swept: ')).toBe(true)
    expect(naming[2].startsWith('REMAINING=')).toBe(true)
    expect(naming[3].startsWith('echo "')).toBe(true)
  })

  it('counts leftover stage rows by the lot ids captured before any delete, as the LAST term of the residue sum', () => {
    const capture = run.indexOf('SMOKE_PARENT_KEYS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c ')
    expect(capture).toBeGreaterThan(-1)
    expect(run.indexOf(STAGE_DELETE)).toBeGreaterThan(capture)
    const remaining = lines.find((l) => l.startsWith('REMAINING='))
    expect(remaining.endsWith(` + $SEED_ADDITION_LEFT + ${STAGE_LEFT};")`)).toBe(true)
    expect(remaining.match(/seed_lot_stage_log/g)).toHaveLength(1)
    // never by a join on the smoke name: after the sweep no smoke lot is left to join through
    expect(remaining).not.toMatch(/FROM seed_lot_stage_log[^)]*IN \(SELECT id FROM inventory_items/)
  })

  it('is what block U needs: the smoke stages only a lot the sweep collects by name', () => {
    const staged = SMOKE.match(/sp_req POST "[^"]*\/seed-stage"/g) ?? []
    expect(staged).toEqual(['sp_req POST "$SP_INV/$SP_GIFT/seed-stage"'])
    // SP_GIFT is the id of the create on the line above its assignment, and that create's name says smoke
    const smokeLines = SMOKE.split('\n')
    const assigned = smokeLines.findIndex((l) => l.trimStart().startsWith("SP_GIFT=$(sp_jq '.id // empty')"))
    expect(smokeLines.filter((l) => /\bSP_GIFT=/.test(l))).toHaveLength(1)
    expect(smokeLines[assigned - 1].trim()).toBe(
      'sp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-gift-$TEST_RUN_ID\\", $SP_LOT_V2}"',
    )
  })
})

// ── release 2a: the named mix (V5-VARIETYBLEND-001) ───────────────────────────────────────────────────────────────
// "A smoke variety" is whatever the step's own delete-by-name says it is, read from that statement as above.
const VARIETY_DELETES = SWEEP.run.match(/-c "DELETE FROM plant_varieties WHERE name [^"]+;"/g) ?? []
const VARIETY_PREDICATE = (VARIETY_DELETES[0] ?? '').replace(/^-c "DELETE FROM plant_varieties WHERE /, '').replace(/;"$/, '')
const SMOKE_VARIETIES = `SELECT id FROM plant_varieties WHERE ${VARIETY_PREDICATE}`
const MIX_IDS = "ANY('{$SMOKE_MIX_IDS}'::uuid[])"
const VARIETY_IDS = "ANY('{$SMOKE_VARIETY_IDS}'::uuid[])"

describe('the L-058 sweep takes a smoke mix apart in one transaction: its component rows, then the mix by id', () => {
  const run = SWEEP.run
  const lines = run.split('\n')
  const probe = run.indexOf(
    `BLEND_TABLE=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT to_regclass('public.variety_blend_component') IS NOT NULL;")`,
  )
  const guard = run.indexOf('if [[ "$BLEND_TABLE" == "t" ]]; then')
  const arm = run.slice(guard, run.indexOf('\nelse\n', guard))
  const CAPTURE =
    `SMOKE_MIX_IDS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT COALESCE(string_agg(DISTINCT blend_variety_id::text, ','), '') FROM variety_blend_component WHERE blend_variety_id IN (${SMOKE_VARIETIES}) OR component_variety_id IN (${SMOKE_VARIETIES});")`
  const APPEND = 'if [[ -n "$SMOKE_MIX_IDS" ]]; then SMOKE_VARIETY_IDS="${SMOKE_VARIETY_IDS:+$SMOKE_VARIETY_IDS,}$SMOKE_MIX_IDS"; fi'
  const COMPONENT_DELETE = `DELETE FROM variety_blend_component WHERE blend_variety_id = ${VARIETY_IDS} OR component_variety_id = ${VARIETY_IDS};`
  const LEFT = `BLEND_LEFT="(SELECT COUNT(*) FROM variety_blend_component WHERE blend_variety_id = ${VARIETY_IDS} OR component_variety_id = ${VARIETY_IDS})"`
  const chain = run.indexOf('psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 \\\n')
  // ONE -c string, two statements: psql sends it as one query, which the server runs as one transaction
  const MIX_DELETE = `DELETE FROM plant_varieties WHERE id = ${MIX_IDS} RETURNING id, name;`
  const TX = `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -c "${COMPONENT_DELETE} ${MIX_DELETE}"`
  const tx = lines.findIndex((l) => l.trim() === TX)
  const CARE = `-c "DELETE FROM care_profile   WHERE scope='cultivar' AND (scope_id IN (${SMOKE_VARIETIES}) OR scope_id = ${MIX_IDS});"`

  it('has one delete of varieties by name to take the smoke-variety predicate from', () => {
    expect(VARIETY_DELETES).toHaveLength(1)
    expect(VARIETY_PREDICATE).toBe("name ILIKE '%smoke%'")
  })

  it('reads the table\'s presence with to_regclass and starts from an empty list and a zero residue term', () => {
    expect(probe).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(probe)
    const between = run.slice(probe, guard)
    expect(between).toContain('\nSMOKE_MIX_IDS=""\n')
    expect(between).toContain('\nBLEND_LEFT="0"\n')
    // a cast would raise 42P01 on a database without the table
    expect(run).not.toMatch(/variety_blend_component'::regclass/)
  })

  it('captures the mix ids, by component rows touching a smoke variety on either side, BEFORE anything is deleted', () => {
    expect(arm).toContain(CAPTURE)
    const capture = run.indexOf(CAPTURE)
    expect(capture).toBeGreaterThan(guard)
    // the step's first DELETE of any table comes after the capture
    expect(run.indexOf('DELETE FROM')).toBeGreaterThan(capture)
    // and after the smoke variety ids themselves were read, which the append below extends
    expect(capture).toBeGreaterThan(run.indexOf('SMOKE_VARIETY_IDS=$(psql '))
  })

  it('adds the captured ids to SMOKE_VARIETY_IDS without ever writing an empty array element', () => {
    expect(arm).toContain(APPEND)
    expect(arm.indexOf(APPEND)).toBeGreaterThan(arm.indexOf(CAPTURE))
    // the only two assignments of the list: the capture by name and this append
    expect(run.match(/SMOKE_VARIETY_IDS=/g) ?? []).toHaveLength(2)
  })

  it('deletes the component rows of every captured id, once, under ON_ERROR_STOP, and not in the capture arm', () => {
    const deletes = run.match(/DELETE FROM variety_blend_component\b[^";]*;/g) ?? []
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toBe(COMPONENT_DELETE)
    expect(run).toContain(`psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -c "${COMPONENT_DELETE} `)
    // the capture arm deletes nothing: it reads the ids, extends the list, says what it found, sets the residue term
    expect(arm).not.toContain('DELETE FROM')
    expect(arm).toContain(LEFT)
    expect(arm.indexOf(LEFT)).toBeGreaterThan(arm.indexOf(APPEND))
    // after the append: before it the list holds the smoke-named varieties only
    expect(run.indexOf(COMPONENT_DELETE)).toBeGreaterThan(run.indexOf(APPEND))
  })

  it('prints the captured mix ids before any delete, and each mix row the by-id delete removes', () => {
    const SAID = 'echo "  mix ids captured, before any delete: ${SMOKE_MIX_IDS:-none}"'
    expect(arm).toContain(SAID)
    expect(arm.indexOf(SAID)).toBeGreaterThan(arm.indexOf(APPEND))
    expect(run.indexOf('DELETE FROM')).toBeGreaterThan(run.indexOf(SAID))
    // the one delete here that reaches a plant_varieties row not named smoke shows what it took
    expect(MIX_DELETE.endsWith(' RETURNING id, name;')).toBe(true)
    expect(run).toContain(MIX_DELETE)
  })

  it('names the table only in the probe and behind its two to_regclass tests, never in a chain', () => {
    const calls = lines.filter((l) => l.includes('psql ') && l.includes('variety_blend_component'))
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain("to_regclass('public.variety_blend_component')")
    expect(arm).toContain(calls[1].trim())
    expect(calls[2].trim()).toBe(TX)
    expect(run.match(/if \[\[ "\$BLEND_TABLE" == "t" \]\]; then\n/g) ?? []).toHaveLength(2)
    expect(lines.filter((l) => l.trimStart().startsWith('-c "') && l.includes('variety_blend_component'))).toHaveLength(0)
    expect(arm).not.toContain('-c "DELETE FROM plants ')
    expect(lines.find((l) => l.startsWith('REMAINING='))).not.toContain('variety_blend_component')
  })

  // Review finding S1. Apart, the two deletes leave a keyed mix with no component row between them, and for good
  // when the chain stops on the way: a row of the standing gate post_blend_key_equals_live_components.
  it('deletes a mix\'s component rows and the mix row in ONE psql -c string, behind the to_regclass test', () => {
    expect(tx).toBeGreaterThan(-1)
    expect(lines.filter((l) => l.trim() === TX)).toHaveLength(1)
    expect(lines[tx - 1].trim()).toBe('if [[ "$BLEND_TABLE" == "t" ]]; then')
    expect(lines[tx + 1].trim()).toBe('fi')
    // each statement appears once in the step, and neither as a call or a chain line of its own
    expect(run.split(COMPONENT_DELETE)).toHaveLength(2)
    expect(run.match(/DELETE FROM plant_varieties WHERE id\b/g) ?? []).toHaveLength(1)
    expect(run).not.toContain('-c "DELETE FROM plant_varieties WHERE id')
    expect(run).not.toContain(`-c "${COMPONENT_DELETE}"`)
    // nothing in the step opens or closes a transaction by hand: inside a -c string that would split it
    expect(run).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\s*;/i)
  })

  it('runs that transaction where the mix delete sat: after the first chain, which ends at care_profile, and straight ahead of the delete by name', () => {
    // the first chain's last line: the care_profile delete, with no continuation
    expect(lines[tx - 2].trim()).toBe(CARE)
    // then a second chain, opening with the delete by name
    expect(lines[tx + 2].trim()).toBe('psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 \\')
    expect(lines[tx + 3].trim()).toBe(`${VARIETY_DELETES[0]} \\`)
    expect(run.match(/psql "\$NEON_STAGING_URL" -v ON_ERROR_STOP=1 \\\n/g) ?? []).toHaveLength(2)
    expect(run.match(/-c "DELETE FROM plant_varieties /g) ?? []).toHaveLength(1)
    // plants.variety_id and inventory_items.variety_id are RESTRICT, and the smoke's lot is filed under its mix
    const txAt = run.indexOf(TX)
    expect(txAt).toBeGreaterThan(chain)
    expect(txAt).toBeGreaterThan(run.indexOf('-c "DELETE FROM inventory_items '))
    expect(run.indexOf('-c "DELETE FROM inventory_items ')).toBeGreaterThan(run.indexOf('-c "DELETE FROM plants '))
    // the second chain is as fatal as the first: its last line ends the call, and nothing in the step swallows a failure
    expect(lines[lines.findIndex((l) => l.trim().startsWith('echo "  swept: ')) - 1].trim()).toBe(`-c "DELETE FROM plant_projects  WHERE name ILIKE '%smoke%';"`)
    expect(run).not.toMatch(/\|\|\s*(true|:)/)
  })

  it('takes the mix by id in the cultivar entity, entity_tag and care_profile deletes, each before the variety deletes', () => {
    const entity = `-c "DELETE FROM entity         WHERE entity_type='cultivar' AND (cultivar_ref_id IN (${SMOKE_VARIETIES}) OR cultivar_ref_id = ${MIX_IDS});"`
    const care = `-c "DELETE FROM care_profile   WHERE scope='cultivar' AND (scope_id IN (${SMOKE_VARIETIES}) OR scope_id = ${MIX_IDS});"`
    const tag = `OR entity_id IN (${SMOKE_VARIETIES}) OR entity_id = ${MIX_IDS} OR entity_id IN (SELECT id FROM locations `
    const firstVarietyDelete = run.indexOf(TX)
    expect(care).toBe(CARE)
    for (const statement of [entity, care, tag]) {
      expect(run).toContain(statement)
      expect(run.indexOf(statement)).toBeGreaterThan(chain)
      expect(firstVarietyDelete).toBeGreaterThan(run.indexOf(statement))
    }
    expect(run.match(/DELETE FROM care_profile\b/g) ?? []).toHaveLength(1)
  })

  it('splices the captured mix ids only as a quoted uuid[] literal, which is empty when nothing was captured', () => {
    // every use but the two assignments, the emptiness test and the append
    const uses = run.match(/\$SMOKE_MIX_IDS/g) ?? []
    const asArray = run.split(MIX_IDS).length - 1
    expect(asArray).toBe(5)
    expect(uses).toHaveLength(asArray + 2)
  })

  it('counts leftover component rows and mix rows by the captured ids', () => {
    expect(run).toContain(LEFT)
    const remaining = lines.find((l) => l.startsWith('REMAINING='))
    expect(remaining).toContain(`(SELECT COUNT(*) FROM plant_varieties WHERE id = ${MIX_IDS})`)
    expect(remaining).toContain(`(SELECT COUNT(*) FROM care_profile WHERE scope='cultivar' AND scope_id = ${VARIETY_IDS})`)
  })

  it('says why the lot-keyed xp_events rows are left, and why the two deletes are one transaction', () => {
    const text = readFileSync(resolve(process.cwd(), '.github/workflows/deploy-staging.yml'), 'utf8')
    expect(text).toContain('# NOT SWEPT, on purpose: xp_events.')
    expect(run).not.toContain('xp_events')
    expect(text).toContain('# WHY ONE TRANSACTION (2026-10-06, gate-file review finding S1).')
  })

  // Review finding S2: inverted, this test makes the step a no-op that reports success on every run.
  it('skips itself only when the DSN is NOT set, runs after a red smoke, and says so before anything else', () => {
    expect(SWEEP.if).toBe('always()')
    expect(run.startsWith(
      'if [[ -z "$NEON_STAGING_URL" ]]; then\n'
      + '  echo "⚠ NEON_STAGING_URL secret not set — skipping L-058 cleanup"\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'echo "🧹 L-058 cleanup sweep starting against staging Neon (FK-safe order)..."\n',
    )).toBe(true)
    // the only two exits: that skip, and the residue check's failure
    expect(run.match(/^\s*exit \d+$/gm) ?? []).toEqual(['  exit 0', '  exit 1'])
    expect(run.match(/\$NEON_STAGING_URL" \]\]/g) ?? []).toHaveLength(1)
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

  // Review finding S2: every request, every id test and every jq read of the block runs through these five. A
  // change to any of them is green on every line pinned below and refuses, or quietly weakens, every promote.
  it('keeps the five helpers under every line: the uuid pattern, sp_req with its token and its body, sp_jq, sp_jqx, sp_id_ok', () => {
    expect(code).toContain(`SP_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`)
    expect(code.match(/SP_UUID_RE=/g) ?? []).toHaveLength(1)
    expect(flat).toContain(
      [
        'sp_req() {',
        '[[ -n "$SP_OUT" ]] && rm -f "$SP_OUT"',
        'SP_OUT=$(mktemp)',
        'if [[ -n "${3:-}" ]]; then',
        'SP_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \\',
        '-H "Content-Type: application/json" -o "$SP_OUT" -w "%{http_code}" "$2" -d "$3") || SP_CODE="000"',
        'else',
        'SP_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \\',
        '-H "Content-Type: application/json" -o "$SP_OUT" -w "%{http_code}" "$2") || SP_CODE="000"',
        'fi',
        '}',
      ].join('\n'),
    )
    const defined = (name) => code.split('\n').filter((l) => l.trim().startsWith(name + '() {')).map((l) => l.trim())
    expect(defined('sp_req')).toEqual(['sp_req() {'])
    expect(defined('sp_jq')).toEqual(['sp_jq() { jq -rc "$1" "$SP_OUT" 2>/dev/null || echo "unparseable"; }'])
    expect(defined('sp_jqx')).toHaveLength(1)
    expect(defined('sp_jqx')[0].startsWith('sp_jqx() { jq -rc --arg x "$1" "$2" "$SP_OUT" 2>/dev/null || echo "unparseable"; }   # ')).toBe(true)
    expect(defined('sp_id_ok')).toEqual(['sp_id_ok() { [[ "${1:-}" =~ $SP_UUID_RE ]]; }'])
    // defined before the block's first request
    expect(code.indexOf('sp_req POST ')).toBeGreaterThan(code.indexOf('sp_id_ok() {'))
  })

  it('sends both parents on the create and names its rows so the sweep finds them', () => {
    // the create's own line: U4's PUT carries the same array, and U0's create is a POST to the same URL
    const create = code.split('\n').find((l) => l.includes('sp_req POST "$STAGING_API_INVENTORY" ') && l.includes('smoke-test-seedlot-$TEST_RUN_ID')) ?? ''
    expect(create).toContain('\\"source_plant_ids\\": [\\"$SP_P1\\", \\"$SP_P2\\"]}"')
    expect(create).toContain('\\"name\\": \\"smoke-test-seedlot-$TEST_RUN_ID\\"')
    expect(code).toContain('SP_P2_NAME="smoke-test-seedparent-$TEST_RUN_ID"')
  })

  // RELEASE 2a, the blocking one: a planting ADDED to a set of two or more must carry a variety, or the create
  // answers 400 parent_without_variety and every promote is refused.
  it('gives both parents block D\'s variety before the two-parent create: P2 at its own create, P1 by a PUT read back', () => {
    expect(code).toContain('sp_req POST "$STAGING_API_PLANTS" "{\\"project_id\\": \\"$CREATED_PROJECT_ID\\", \\"name\\": \\"$SP_P2_NAME\\", \\"variety_id\\": \\"$CREATED_VARIETY_ID\\"}"')
    expect(code).toContain('SP_P1="$CREATED_PLANT_ID"')
    expect(flat).toContain(
      [
        'sp_req PUT "${STAGING_API_PLANTS%/}/api/plants/$SP_P1" "{\\"variety_id\\": \\"$CREATED_VARIETY_ID\\"}"',
        'SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P1"',
        `sp_check "first-parent-variety" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 $CREATED_VARIETY_ID" `,
      ].join('\n'),
    )
    const given = code.indexOf('sp_check "first-parent-variety" ')
    expect(given).toBeGreaterThan(code.indexOf('sp_pass "second-parent"'))
    // before every request that names P1 beside another planting: U1's create, U4's re-add, U7's refusal
    expect(code.indexOf('smoke-test-seedlot-$TEST_RUN_ID')).toBeGreaterThan(given)
    expect(code.indexOf('sp_check "u4-readd-readback"')).toBeGreaterThan(given)
    expect(code.indexOf('sp_check "u7-mixed-crop-refused"')).toBeGreaterThan(given)
  })

  it('clears P1\'s variety again after the last request that needs it, and reads that back', () => {
    expect(flat).toContain(
      [
        `sp_req PUT "\${STAGING_API_PLANTS%/}/api/plants/$SP_P1" '{"variety_id": null}'`,
        'SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P1"',
        `sp_check "first-parent-variety-restored" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 null" `,
      ].join('\n'),
    )
    const restored = code.indexOf('sp_check "first-parent-variety-restored" ')
    expect(restored).toBeGreaterThan(code.indexOf('sp_check "u22-mix-lot-delete"'))
    expect(restored).toBeGreaterThan(code.indexOf('sp_check "u7-mixed-crop-refused"'))
    expect(code.indexOf('SP_ROWS=$(psql "$NEON_STAGING_URL" ')).toBeGreaterThan(restored)
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

  it('reads a cache that is neither parent as a failure, never as "one of them"', () => {
    expect(code).toMatch(/\*\)\s+SP_ON="\$SP_P1"; SP_OFF="\$SP_P2"; SP_MEMBER="neither:\$SP_CACHE" ;;/)
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

  it('expects the delete to go through with its parents linked', () => {
    expect(code).toContain('sp_check "u6-delete-with-parents" "$SP_WRITE $SP_CODE" "200 true 404"')
  })

  it('mints three times: between U0 and U1, before U7, and before U24', () => {
    const mints = [...code.matchAll(/^\s*CLERK_JWT=\$\(mint_session_token\)$/gm)].map((m) => m.index)
    expect(mints).toHaveLength(3)
    expect(code.match(/mint_session_token/g) ?? []).toHaveLength(3)
    // the third (release 3): after U21, straight ahead of the first release 3 line, and before U22
    expect(mints[2]).toBeGreaterThan(code.indexOf('u21-season-stats-parent-count] STAGING_API_HARVESTS unset/placeholder — parent_count NOT read'))
    expect(mints[2]).toBeLessThan(code.indexOf('smoke-test-seedparent5-$TEST_RUN_ID'))
    expect(mints[2]).toBeLessThan(code.indexOf('sp_check "u22-mix-lot-delete"'))
    expect(flat).toContain('CLERK_JWT=$(mint_session_token)\nsp_uuid() {')
    // the first: after U0's last line, straight ahead of the two-parent create
    expect(mints[0]).toBeGreaterThan(code.indexOf('sp_fail "u0a-legacy-create"'))
    expect(flat).toContain('CLERK_JWT=$(mint_session_token)\nsp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-$TEST_RUN_ID\\"')
    // the second: after P2's delete, ahead of the first release 2a request
    expect(mints[1]).toBeGreaterThan(code.indexOf('sp_fail "second-parent-delete"'))
    expect(flat).toContain('CLERK_JWT=$(mint_session_token)\nSP_VAR="${STAGING_API_VARIETIES%/}/api/varieties"')
    expect(code.indexOf('smoke-test-variety2-$TEST_RUN_ID')).toBeGreaterThan(mints[1])
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

  // ── every assert, U0 included ───────────────────────────────────────────────────────────────────────────────
  // trimmed lines, so a sequence of statements can be pinned as a sequence whatever its indentation
  const flat = code.split('\n').map((l) => l.trim()).join('\n')
  const LABELS = [
    'first-parent-variety',
    'u0a-legacy-create-readback', 'u0b-legacy-move-readback', 'u0c-legacy-clear-readback',
    'u0d-source-kind-readback', 'u0d-parent-refused-on-a-gift-lot', 'u0e-legacy-lot-delete',
    'u1-create-readback', 'u2-seed-lots-of-the-uncached-parent', 'u3-replace-readback', 'u4-readd-readback',
    'u4-legacy-set-refused', 'u4-legacy-clear-refused', 'u6-delete-with-parents',
    // release 2a
    'u7-mixed-crop-refused', 'u8-parent-without-variety-refused', 'u9-fourth-parent-variety',
    'u10-blend-required-refused', 'u11-blend-create', 'u11-blend-swapped-same-row', 'u11-blend-readback',
    'u12-mix-lot-readback', 'u13-list-row', 'u14-plant-count-readback', 'u15-filing-to-component',
    'u16-stale-list-row-put-keeps-filing', 'u17-filing-back-from-previous', 'u18-plant-count-cleared',
    'u19-stale-set-refused', 'u20-seed-saved-first-parent', 'u20-seed-saved-second-parent',
    'u21-season-stats-parent-count',
    // release 3: between U21 and U22, while the mix lot and its parents are live
    'u24-counted-lot', 'u24-open-lots', 'u25-same-plant-addition', 'u25-replay', 'u25-key-on-another-lot',
    'u25-stale-set', 'u26-other-plant-addition', 'u27-refiling-addition-uncounted', 'u28-used-up-lot',
    'u29-stale-measure', 'u30-addition-event',
    'u22-mix-lot-delete', 'first-parent-variety-restored',
    // the three SQL reads, last
    'u5-link-rows-readback', 'u23-mix-rows-readback', 'u31-addition-rows-readback',
  ]

  it('still compares at every assert: each label is an sp_check call, in this order, and there are no others', () => {
    for (const label of LABELS) {
      expect(code).toMatch(new RegExp('^\\s*sp_check "' + label + '" ', 'm'))
    }
    const calls = (code.match(/^\s*sp_check "[^"]+"/gm) ?? []).map((l) => l.trim().slice('sp_check "'.length, -1))
    expect(calls).toEqual(LABELS)
  })

  it('keeps sp_state a real read of the lot, and tells an unreadable parent list from an empty one', () => {
    expect(flat).toContain(
      [
        'sp_state() {',
        'sp_req GET "$SP_INV/${1:-$SP_LOT}"',
        `SP_STATE="$SP_CODE $(sp_jq "$SP_IDS_JQ")|$(sp_jq '.source_plant_id // "null"')"`,
        '}',
      ].join('\n'),
    )
    expect(code).toContain(
      `SP_IDS_JQ='if (.source_plants | type) == "array" then ([.source_plants[].id] | sort | join(",")) else "no-source_plants:" + (.source_plants | type) end'`,
    )
  })

  it('U0: makes the one-parent create the way a shipped client does, on a lot the sweep collects', () => {
    const create = code.split('\n').find((l) => l.includes('smoke-test-seedlot-legacy-')) ?? ''
    expect(create.trim().startsWith('sp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-legacy-$TEST_RUN_ID\\", ')).toBe(true)
    expect(create).toContain('\\"category\\": \\"seeds\\"')
    expect(create).toContain('\\"variety_id\\": \\"$CREATED_VARIETY_ID\\", \\"source_plant_id\\": \\"$SP_P1\\"}"')
    // the legacy shape: one id under the old key, and neither the new array nor a source_kind beside it
    expect(create).not.toContain('source_plant_ids')
    expect(create).not.toContain('source_kind')
  })

  it('U0: fails, never warns, when the one-parent create does not answer 201 with an id', () => {
    expect(flat).toContain(
      [
        `SP_OLD=$(sp_jq '.id // empty')`,
        'if [[ "$SP_CODE" == "201" ]] && sp_id_ok "$SP_OLD"; then',
        'CREATED_SEEDLOT_LEGACY_ID="$SP_OLD"',
        'sp_state "$SP_OLD"',
        'sp_check "u0a-legacy-create-readback" "$SP_STATE" "200 $SP_P1|$SP_P1" ',
      ].join('\n'),
    )
    expect(code).toContain('sp_fail "u0a-legacy-create" "POST /api/inventory-items with source_plant_id P1 → HTTP $SP_CODE (expected 201 and an id)')
  })

  it('U0: moves the parent with the legacy PATCH and reads it back, in the PATCH body and on the lot', () => {
    expect(flat).toContain(
      [
        'sp_req PATCH "$SP_INV/$SP_OLD/source-plant" "{\\"source_plant_id\\": \\"$SP_P2\\"}"',
        `SP_WRITE="$SP_CODE $(sp_jq '.source_plant_id // "null"')"; sp_state "$SP_OLD"`,
        'sp_check "u0b-legacy-move-readback" "$SP_WRITE $SP_STATE" "200 $SP_P2 200 $SP_P2|$SP_P2" ',
      ].join('\n'),
    )
  })

  it('U0: clears the parent with the legacy PATCH and reads back no parent and a null column', () => {
    expect(flat).toContain(
      [
        `sp_req PATCH "$SP_INV/$SP_OLD/source-plant" '{"source_plant_id": null}'`,
        'SP_WRITE="$SP_CODE"; sp_state "$SP_OLD"',
        'sp_check "u0c-legacy-clear-readback" "$SP_WRITE $SP_STATE" "200 200 |null" ',
      ].join('\n'),
    )
  })

  it('U0: sets source_kind on the parentless lot and reads it back, then expects a parent refused with 400 and nothing changed', () => {
    expect(flat).toContain(
      [
        `sp_req PATCH "$SP_INV/$SP_OLD/source-kind" '{"source_kind": "gift"}'`,
        'SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_OLD"',
        `sp_check "u0d-source-kind-readback" "$SP_WRITE $SP_CODE $(sp_jq '.source_kind // "null"')" "200 200 gift" `,
      ].join('\n'),
    )
    expect(flat).toContain(
      [
        'sp_req PATCH "$SP_INV/$SP_OLD/source-plant" "{\\"source_plant_id\\": \\"$SP_P1\\"}"',
        'SP_WRITE="$SP_CODE"; sp_state "$SP_OLD"',
        `sp_check "u0d-parent-refused-on-a-gift-lot" "$SP_WRITE $SP_STATE|$(sp_jq '.source_kind // "null"')" "400 200 |null|gift" `,
      ].join('\n'),
    )
  })

  it('U0: deletes its lot, tracks it for the trap until then, and comes before the two-parent lot is made', () => {
    expect(flat).toContain(
      [
        'sp_req DELETE "$SP_INV/$SP_OLD"',
        `SP_WRITE="$SP_CODE $(sp_jq '. == {"ok": true}')"`,
        'if [[ "$SP_CODE" == "200" ]]; then CREATED_SEEDLOT_LEGACY_ID=""; fi',
        'sp_check "u0e-legacy-lot-delete" "$SP_WRITE" "200 true" ',
      ].join('\n'),
    )
    const second = code.indexOf('sp_pass "second-parent"')
    const legacy = code.indexOf('smoke-test-seedlot-legacy-$TEST_RUN_ID')
    const legacyDelete = code.indexOf('sp_check "u0e-legacy-lot-delete"')
    const twoParent = code.indexOf('smoke-test-seedlot-$TEST_RUN_ID')
    // after P2 exists (u0b needs it), and wholly before the two-parent create
    expect(legacy).toBeGreaterThan(second)
    expect(legacyDelete).toBeGreaterThan(legacy)
    expect(twoParent).toBeGreaterThan(legacyDelete)
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    expect(cleanup).toContain('"${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDLOT_LEGACY_ID}"')
    expect(SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))).toMatch(/^CREATED_SEEDLOT_LEGACY_ID=""$/m)
  })

  // ── release 2a: U7 to U23 ───────────────────────────────────────────────────────────────────────────────────
  // Each assert is pinned as the sequence it is: the write, what is kept of its reply, the read, and the sp_check
  // with the string it expects. A read moved ahead of its write, or an expected string loosened, fails here.
  const seq = (...linesOf) => linesOf.join('\n')

  it('2a: keeps its three helpers honest: the lot body, the refused-lot read, the delete that fails the ship gate', () => {
    expect(flat).toContain(seq(
      'sp_lot() {',
      'echo "{\\"name\\": \\"$1\\", \\"type\\": \\"consumable\\", \\"category\\": \\"seeds\\", \\"unit\\": \\"packet\\", \\"quantity_on_hand\\": 1, \\"variety_id\\": \\"$2\\", \\"source_plant_ids\\": [\\"$3\\", \\"$4\\"]${5:+, \\"source_plant_id\\": \\"$5\\"}}"',
      '}',
    ))
    expect(code).toContain('SP_REFUSED_NAME="smoke-test-seedlot-refused-$TEST_RUN_ID"')
    expect(flat).toContain(seq(
      'sp_refused() {',
      'sp_req GET "$SP_INV?category=seeds"',
      `SP_NONE="$SP_CODE $(sp_jqx "$SP_REFUSED_NAME" 'if type == "array" then ([.[] | select(.name == $x)] | length) else "not-an-array" end')"`,
      '}',
    ))
    expect(flat).toContain(seq(
      'sp_drop() {',
      'sp_req DELETE "$2"',
      'if [[ "$SP_CODE" == "200" ]]; then return 0; fi',
      'if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then',
      'sp_fail "$1" "DELETE $2 → HTTP $SP_CODE (expected 200; cleanup() retries, the L-058 sweep removes the row either way)"',
      'else',
      'echo "⚠️  WARN [seed-parents:$1] DELETE $2 → HTTP $SP_CODE (cleanup() retries; the L-058 sweep removes the row either way)"',
      'fi',
      'return 1',
      '}',
    ))
  })

  it('2a: makes two varieties of ONE crop and two plantings, P4 with no variety, and tracks all four for cleanup()', () => {
    expect(flat).toContain(seq(
      'sp_req POST "$STAGING_API_VARIETIES" "{\\"name\\": \\"smoke-test-variety2-$TEST_RUN_ID\\", \\"crop_type_slug\\": \\"tomato\\"}"',
      `SP_V2=$(sp_jq '.id // empty')`,
      'SP_MADE="V2 $SP_CODE"',
      'if sp_id_ok "$SP_V2"; then CREATED_SEEDVARIETY2_ID="$SP_V2"; fi',
      'sp_req POST "$STAGING_API_VARIETIES" "{\\"name\\": \\"smoke-test-variety3-$TEST_RUN_ID\\", \\"crop_type_slug\\": \\"tomato\\"}"',
      `SP_V3=$(sp_jq '.id // empty')`,
      'SP_MADE="$SP_MADE, V3 $SP_CODE"',
      'if sp_id_ok "$SP_V3"; then CREATED_SEEDVARIETY3_ID="$SP_V3"; fi',
      'sp_req POST "$STAGING_API_PLANTS" "{\\"project_id\\": \\"$CREATED_PROJECT_ID\\", \\"name\\": \\"smoke-test-seedparent3-$TEST_RUN_ID\\", \\"variety_id\\": \\"$SP_V2\\"}"',
      `SP_P3=$(sp_jq '.id // empty')`,
      'SP_MADE="$SP_MADE, P3 $SP_CODE"',
      'if sp_id_ok "$SP_P3"; then CREATED_SEEDPARENT3_PLANT_ID="$SP_P3"; fi',
      'sp_req POST "$STAGING_API_PLANTS" "{\\"project_id\\": \\"$CREATED_PROJECT_ID\\", \\"name\\": \\"smoke-test-seedparent4-$TEST_RUN_ID\\"}"',
      `SP_P4=$(sp_jq '.id // empty')`,
      'SP_MADE="$SP_MADE, P4 $SP_CODE"',
      'if sp_id_ok "$SP_P4"; then CREATED_SEEDPARENT4_PLANT_ID="$SP_P4"; fi',
      'if sp_id_ok "$SP_V2" && sp_id_ok "$SP_V3" && sp_id_ok "$SP_P3" && sp_id_ok "$SP_P4"; then',
    ))
    // the FAIL line shows the status of EACH create: by then SP_CODE is P4's, and a 429 on V2 would read as 201
    expect(code).toContain('sp_fail "u7-rows" "the release 2a rows were not all made (HTTP of each create: $SP_MADE;')
    expect(code.match(/SP_MADE=/g) ?? []).toHaveLength(4)
    expect(code).not.toContain('(last HTTP $SP_CODE)')
    // the key a mix of the two is found by: both ids, sorted, comma-joined
    expect(code).toContain(`SP_VKEY=$(jq -rn --arg a "$SP_V2" --arg b "$SP_V3" '[$a, $b] | sort | join(",")' 2>/dev/null || echo "unsortable")`)
    expect(code).toContain(`SP_MIXBOTH=$(jq -rn --arg a "$SP_P3" --arg b "$SP_P4" '[$a, $b] | sort | join(",")' 2>/dev/null || echo "unsortable")`)
  })

  it('2a: expects the three refusals by code, each followed by a read of the seeds list that finds no such lot', () => {
    expect(flat).toContain(seq(
      'sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$CREATED_VARIETY_ID" "$SP_P1" "$SP_P3")"',
      `SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_refused`,
      'sp_check "u7-mixed-crop-refused" "$SP_WRITE $SP_NONE" "400 mixed_crop_parents 200 0" ',
    ))
    expect(flat).toContain(seq(
      'sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$SP_V2" "$SP_P3" "$SP_P4")"',
      `SP_WRITE="$SP_CODE $(sp_jq '.code // "-"') $(sp_jq '.plant_id // "-"')"; sp_refused`,
      'sp_check "u8-parent-without-variety-refused" "$SP_WRITE $SP_NONE" "400 parent_without_variety $SP_P4 200 0" ',
    ))
    expect(flat).toContain(seq(
      'sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$SP_V2" "$SP_P3" "$SP_P4")"',
      `SP_WRITE="$SP_CODE $(sp_jq '.code // "-"') $(sp_jq '(.component_variety_ids // []) | sort | join(",")')"; sp_refused`,
      'sp_check "u10-blend-required-refused" "$SP_WRITE $SP_NONE" "400 blend_required $SP_VKEY 200 0" ',
    ))
    // between the last two, P4 gets its variety: the same body is refused for a different reason after it
    expect(flat).toContain(seq(
      'sp_req PUT "${STAGING_API_PLANTS%/}/api/plants/$SP_P4" "{\\"variety_id\\": \\"$SP_V3\\"}"',
      'SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P4"',
      `sp_check "u9-fourth-parent-variety" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 $SP_V3" `,
    ))
  })

  it('2a: makes the mix, finds it again with the ids swapped, and reads it back by id', () => {
    expect(flat).toContain(seq(
      'sp_req POST "$SP_VAR/blend" "{\\"component_variety_ids\\": [\\"$SP_V2\\", \\"$SP_V3\\"], \\"create\\": true}"',
      `SP_MIX=$(sp_jq '.id // empty')`,
      'if sp_id_ok "$SP_MIX"; then',
      'CREATED_SEEDMIX_VARIETY_ID="$SP_MIX"',
      'SP_MIX_MADE=true',
      `sp_check "u11-blend-create" "$SP_CODE $(sp_jq '.created')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '.blend_key // "null"')|$(sp_jq '[.components[]?.id] | sort | join(",")')" "201 true|blend|$SP_VKEY|$SP_VKEY" `,
    ))
    expect(flat).toContain(seq(
      'sp_req POST "$SP_VAR/blend" "{\\"component_variety_ids\\": [\\"$SP_V3\\", \\"$SP_V2\\"], \\"create\\": true}"',
      `sp_check "u11-blend-swapped-same-row" "$SP_CODE $(sp_jq '.created')|$(sp_jq '.id // "null"')|$(sp_jq '.variety_rank // "null"')" "200 false|$SP_MIX|blend" `,
    ))
    expect(flat).toContain(seq(
      'sp_req GET "$SP_VAR/$SP_MIX"',
      `sp_check "u11-blend-readback" "$SP_CODE $(sp_jq '.id // "null"')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '.blend_key // "null"')" "200 $SP_MIX|blend|$SP_VKEY" `,
    ))
    expect(code).toContain('SP_VAR="${STAGING_API_VARIETIES%/}/api/varieties"')
    expect(code).toContain('sp_fail "u11-blend-create" "POST /api/varieties/blend → HTTP $SP_CODE (expected 201 and an id)')
    // the flag U23 runs on is lowered before the create
    expect(code.indexOf('SP_MIX_MADE=false')).toBeGreaterThan(-1)
    expect(code.indexOf('SP_MIX_MADE=true')).toBeGreaterThan(code.indexOf('SP_MIX_MADE=false'))
  })

  it('2a: files a lot under the mix with both parents and the single key, and reads all of it back', () => {
    expect(flat).toContain(seq(
      'sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "smoke-test-seedlot-mix-$TEST_RUN_ID" "$SP_MIX" "$SP_P3" "$SP_P4" "$SP_P4")"',
      `SP_MIXLOT=$(sp_jq '.id // empty')`,
      'if [[ "$SP_CODE" == "201" ]] && sp_id_ok "$SP_MIXLOT"; then',
      'CREATED_SEEDMIX_LOT_ID="$SP_MIXLOT"',
    ))
    // what the lot's GET reads while it is filed under the mix (U12, U13, U17 compare with it): variety_id|variety_rank
    expect(code).toMatch(/^\s*SP_FILED_MIX="\$SP_MIX\|blend"(?:\s+#[^\n]*)?$/m)
    expect(flat).toContain(seq(
      'sp_req GET "$SP_INV/$SP_MIXLOT"',
      `sp_check "u12-mix-lot-readback" "$SP_CODE $(sp_jq "$SP_IDS_JQ")|$(sp_jq '.source_plant_id // "null"')|$(sp_jq '.variety_id // "null"')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '[.source_plants[]? | .crop_slug // "null"] | join(",")')" "200 $SP_MIXBOTH|$SP_P4|$SP_FILED_MIX|tomato,tomato" `,
    ))
    expect(code).toContain('sp_fail "u12-mix-lot" "POST /api/inventory-items under the mix with source_plant_ids [P3, P4] → HTTP $SP_CODE (expected 201 and an id)')
  })

  it('2a: keeps the lot\'s list row from BEFORE the re-file, and puts it back whole AFTER it', () => {
    expect(flat).toContain(seq(
      'sp_req GET "$SP_INV?category=seeds"',
      `SP_ROW=$(sp_jqx "$SP_MIXLOT" '[.[]? | select(.id == $x)][0] // empty')`,
      `sp_check "u13-list-row" "$SP_CODE $(jq -rn --argjson r "\${SP_ROW:-null}" '($r.variety_id // "null") + "|" + ($r.variety_rank // "null")' 2>/dev/null || echo "unparseable")" "200 $SP_FILED_MIX" `,
    ))
    expect(flat).toContain(seq(
      'sp_req PUT "$SP_INV/$SP_MIXLOT/filing" "{\\"variety_id\\": \\"$SP_V2\\", \\"expect_variety_id\\": \\"$SP_MIX\\"}"',
      `SP_WRITE="$SP_CODE $(sp_jq '.changed')|$(sp_jq '.previous.variety_id // "null"')"`,
      `SP_PREVIOUS=$(sp_jq '.previous.variety_id // empty')`,
      'sp_req GET "$SP_INV/$SP_MIXLOT"',
      `sp_check "u15-filing-to-component" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')" "200 true|$SP_MIX 200 $SP_V2" `,
    ))
    expect(flat).toContain(seq(
      'sp_req PUT "$SP_INV/$SP_MIXLOT" "$SP_ROW"',
      'SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_MIXLOT"',
      `sp_check "u16-stale-list-row-put-keeps-filing" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')|$(sp_jq '.seed_parent_plant_count // "null"')" "200 200 $SP_V2|3" `,
    ))
    expect(flat).toContain(seq(
      'sp_req PUT "$SP_INV/$SP_MIXLOT/filing" "{\\"variety_id\\": \\"$SP_PREVIOUS\\", \\"expect_variety_id\\": \\"$SP_V2\\"}"',
      `SP_WRITE="$SP_CODE $(sp_jq '.changed')"; sp_req GET "$SP_INV/$SP_MIXLOT"`,
      `sp_check "u17-filing-back-from-previous" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')|$(sp_jq '.variety_rank // "null"')" "200 true 200 $SP_FILED_MIX" `,
    ))
    // the row is read once, before the first /filing call, and written once, between the two
    expect(code.match(/SP_ROW=/g) ?? []).toHaveLength(1)
    const rowRead = code.indexOf('SP_ROW=$(')
    const refile = code.indexOf('sp_check "u15-filing-to-component"')
    const rowPut = code.indexOf('sp_req PUT "$SP_INV/$SP_MIXLOT" "$SP_ROW"')
    const back = code.indexOf('sp_check "u17-filing-back-from-previous"')
    expect(code.indexOf('/filing"')).toBeGreaterThan(rowRead)
    expect(rowPut).toBeGreaterThan(refile)
    expect(back).toBeGreaterThan(rowPut)
  })

  it('2a: sets the plant count through /seed-measure before the stale row is put back, and clears it after', () => {
    expect(flat).toContain(seq(
      `sp_req PUT "$SP_INV/$SP_MIXLOT/seed-measure" '{"seed_parent_plant_count": 3}'`,
      `SP_WRITE="$SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')"; sp_req GET "$SP_INV/$SP_MIXLOT"`,
      `sp_check "u14-plant-count-readback" "$SP_WRITE $SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')" "200 3 200 3" `,
    ))
    expect(flat).toContain(seq(
      `sp_req PUT "$SP_INV/$SP_MIXLOT/seed-measure" '{"seed_parent_plant_count": null}'`,
      'SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_MIXLOT"',
      `sp_check "u18-plant-count-cleared" "$SP_WRITE $SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')" "200 200 null" `,
    ))
    const set = code.indexOf('sp_check "u14-plant-count-readback"')
    const rowPut = code.indexOf('sp_check "u16-stale-list-row-put-keeps-filing"')
    expect(set).toBeGreaterThan(code.indexOf('SP_ROW=$('))
    expect(rowPut).toBeGreaterThan(set)
    expect(code.indexOf('sp_check "u18-plant-count-cleared"')).toBeGreaterThan(rowPut)
  })

  it('2a: expects a set sent against a stale reading refused with 409 lot_changed, and the lot unchanged', () => {
    expect(flat).toContain(seq(
      'sp_req PUT "$SP_INV/$SP_MIXLOT/source-plants" "{\\"source_plant_ids\\": [\\"$SP_P3\\"], \\"expected_source_plant_ids\\": [\\"$SP_P3\\"]}"',
      `SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_state "$SP_MIXLOT"`,
      'sp_check "u19-stale-set-refused" "$SP_WRITE $SP_STATE" "409 lot_changed 200 $SP_MIXBOTH|$SP_P4" ',
    ))
  })

  it('2a: posts one seed_saved event per parent, in turn, in the sheet\'s shape, and finds each on its planting', () => {
    const post = (plant) =>
      `sp_req POST "$STAGING_API_EVENTS" "{\\"plant_id\\": \\"$SP_${plant}\\", \\"event_type\\": \\"seed_saved\\", \\"event_date\\": \\"$SP_DAY\\", \\"notes\\": \\"CI smoke — safe to delete\\", \\"metadata\\": {\\"seed_lot_id\\": \\"$SP_MIXLOT\\", \\"_skip_critter_award\\": true}}"`
    expect(flat).toContain(seq(
      post('P3'),
      `SP_WRITE="$SP_CODE"; SP_EVENT=$(sp_jq '.id // empty')`,
      'if sp_id_ok "$SP_EVENT"; then SP_E1="$SP_EVENT"; fi',
      'sp_req GET "${STAGING_API_EVENTS%/}/api/events?plant_id=$SP_P3&limit=50"',
      'sp_check "u20-seed-saved-first-parent" "$SP_WRITE $SP_CODE $(sp_jqx "$SP_MIXLOT" "$SP_EV_JQ")" "201 200 1" ',
    ))
    expect(flat).toContain(seq(
      post('P4'),
      `SP_WRITE="$SP_CODE"; SP_EVENT=$(sp_jq '.id // empty')`,
      'if sp_id_ok "$SP_EVENT"; then SP_E2="$SP_EVENT"; fi',
      'sp_req GET "${STAGING_API_EVENTS%/}/api/events?plant_id=$SP_P4&limit=50"',
      'sp_check "u20-seed-saved-second-parent" "$SP_WRITE $SP_CODE $(sp_jqx "$SP_MIXLOT" "$SP_EV_JQ")" "201 200 1" ',
    ))
    expect(code).toContain(
      `SP_EV_JQ='if type == "array" then ([.[] | select(.event_type == "seed_saved" and .metadata.seed_lot_id == $x)] | length) else "not-an-array:" + type end'`,
    )
    // a bare date is stored at noon UTC: today's can be ahead of now, a day back cannot
    expect(code).toContain('SP_DAY=$(utc_days_ago 1)')
    // in turn: the second POST comes after the first event's read-back
    expect(code.indexOf(post('P4'))).toBeGreaterThan(code.indexOf('sp_check "u20-seed-saved-first-parent"'))
    // the events are never asked what XP they paid: the daily cap can hide it (U23 reads what it cannot)
    expect(code).not.toMatch(/xp_gained|daily_xp/)
  })

  it('2a: reads parent_count from season-stats while the lot is live, and fails the ship gate rather than skip', () => {
    expect(flat).toContain(seq(
      'sp_req GET "${STAGING_API_HARVESTS%/}/api/harvests/season-stats?season=$SP_SEASON&sections=seed_lots"',
      `sp_check "u21-season-stats-parent-count" "$SP_CODE $(sp_jqx "$SP_MIXLOT" '.sections.seed_lots.series.rows as $r | if ($r | type) != "array" then "no-rows:" + ($r | type) else "every-row-counted:" + ([$r[] | (.parent_count | type) == "number"] | all | tostring) + "|this-lot:" + ([$r[] | select(.lot_id == $x) | .parent_count | tostring] | join(",")) end')" "200 every-row-counted:true|this-lot:2" `,
    ))
    expect(code).toMatch(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "u21-season-stats-parent-count" "STAGING_API_HARVESTS unset\/placeholder/)
    expect(code.indexOf('sp_check "u22-mix-lot-delete"')).toBeGreaterThan(code.indexOf('sp_check "u21-season-stats-parent-count"'))
  })

  it('2a: deletes the lot and its two plantings through their routes, and clears each id for cleanup() only on 200', () => {
    expect(flat).toContain(seq(
      'sp_req DELETE "$SP_INV/$SP_MIXLOT"',
      `SP_WRITE="$SP_CODE $(sp_jq '. == {"ok": true}')"`,
      'if [[ "$SP_CODE" == "200" ]]; then CREATED_SEEDMIX_LOT_ID=""; fi',
      'sp_check "u22-mix-lot-delete" "$SP_WRITE" "200 true" ',
    ))
    expect(flat).toContain(seq(
      'if sp_id_ok "$SP_P3"; then',
      'if sp_drop "third-parent-delete" "${STAGING_API_PLANTS%/}/api/plants/$SP_P3"; then CREATED_SEEDPARENT3_PLANT_ID=""; fi',
      'fi',
      'if sp_id_ok "$SP_P4"; then',
      'if sp_drop "fourth-parent-delete" "${STAGING_API_PLANTS%/}/api/plants/$SP_P4"; then CREATED_SEEDPARENT4_PLANT_ID=""; fi',
      'fi',
    ))
  })

  it('2a: reads the mix\'s rows and the events\' XP keys through SQL, every id bound, after U5 and after every request', () => {
    expect(code).toContain('-v mix="$SP_MIX" -v va="$SP_V2" -v vb="$SP_V3" -v ea="$SP_E1" -v eb="$SP_E2" \\')
    const sql = (code.match(/SP_MIXROWS=\$\(psql [^\n]*\n\s*<<< "([^"]*)"\) \\\n\s*\|\| SP_MIXROWS="psql-exit-\$\?"/) ?? [])[1] ?? ''
    expect(sql).toBe(
      "SELECT (SELECT COUNT(*) FROM plant_varieties WHERE id = :'mix'::uuid AND variety_rank = 'blend' AND blend_key IS NOT NULL)"
      + " || '|' || (SELECT COUNT(*) FROM variety_blend_component WHERE blend_variety_id = :'mix'::uuid AND deleted_at IS NULL AND component_variety_id IN (:'va'::uuid, :'vb'::uuid))"
      + " || '|' || (SELECT COUNT(*) FROM care_profile WHERE scope = 'cultivar' AND scope_id = :'mix'::uuid)"
      + " || '|' || (SELECT COUNT(*) FROM xp_events WHERE reason = 'event_logged' AND source_id IN (:'ea'::uuid, :'eb'::uuid));",
    )
    expect(code).not.toMatch(/'\$SP_(MIX|V2|V3|E1|E2|MIXLOT)'/)
    expect(code).toContain('sp_check "u23-mix-rows-readback" "$SP_MIXROWS" "1|2|1|0" ')
    // an event that was never made is the nil uuid, set before either POST: it keys no row and casts cleanly
    expect(code).toContain('SP_NIL="00000000-0000-0000-0000-000000000000"')
    expect(code).toContain('SP_E1="$SP_NIL"; SP_E2="$SP_NIL"')
    const mixRead = code.indexOf('SP_MIXROWS=$(psql "$NEON_STAGING_URL" ')
    expect(mixRead).toBeGreaterThan(code.indexOf('sp_check "u5-link-rows-readback"'))
    expect(code.lastIndexOf('sp_req ')).toBeLessThan(code.indexOf('SP_ROWS=$(psql "$NEON_STAGING_URL" '))
    expect(code).toMatch(/if \[\[ "\$SP_MIX_MADE" == "true" \]\]; then\n\s*if \[\[ -n "\$\{NEON_STAGING_URL:-\}" \]\] && command -v psql >\/dev\/null 2>&1; then\n\s*SP_MIXROWS=\$\(psql /)
    expect(code).toMatch(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "u23-mix-rows-readback"/)
  })

  it('2a: hands its six rows to cleanup(), which deletes the lot and the plantings before the varieties', () => {
    const head = SMOKE.slice(0, SMOKE.indexOf('cleanup() {'))
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    const ENTRIES = [
      '"mix seed lot|${STAGING_API_INVENTORY:-}|/api/inventory-items/|$CREATED_SEEDMIX_LOT_ID"',
      '"third seed-parent planting|${STAGING_API_PLANTS:-}|/api/plants/|$CREATED_SEEDPARENT3_PLANT_ID"',
      '"fourth seed-parent planting|${STAGING_API_PLANTS:-}|/api/plants/|$CREATED_SEEDPARENT4_PLANT_ID"',
      '"seed mix variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDMIX_VARIETY_ID"',
      '"second smoke variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDVARIETY2_ID"',
      '"third smoke variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDVARIETY3_ID"',
    ]
    let last = -1
    for (const entry of ENTRIES) {
      const at = cleanup.indexOf(entry)
      expect(at).toBeGreaterThan(last)
      last = at
      const name = entry.slice(entry.lastIndexOf('$') + 1, -1)
      expect(head).toMatch(new RegExp('^' + name + '=""$', 'm'))
    }
    expect(cleanup).toContain('if [[ -z "$sp_left_id" ]]; then continue; fi')
    // the loop's one request is a DELETE with the token (review finding S2: a GET prints "deleted" for a row it read)
    expect(cleanup).toContain(
      [
        '      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \\',
        '        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \\',
        '        "${sp_left_url%/}${sp_left##*|}${sp_left_id}" -o /dev/null 2>&1 \\',
        '        && echo "✅ Cleanup: test ${sp_left%%|*} deleted" \\',
        '        || echo "WARNING: ${sp_left%%|*} cleanup failed (id: $sp_left_id)"',
        '    done',
      ].join('\n'),
    )
  })

  it('says so when cleanup() has rows to delete and no token to delete them with', () => {
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    const withToken = cleanup.indexOf('if [[ "$DATA_CREATED" == "true" && -n "$CLERK_JWT" ]]; then')
    const without = cleanup.indexOf('\n  elif [[ "$DATA_CREATED" == "true" ]]; then\n')
    expect(withToken).toBeGreaterThan(-1)
    expect(without).toBeGreaterThan(withToken)
    expect(cleanup.slice(without)).toMatch(/^\n  elif \[\[ "\$DATA_CREATED" == "true" \]\]; then\n(?:\s*#[^\n]*\n)*\s*echo "Cleanup: no session token in hand, so the API soft-deletes were skipped; the workflow's L-058 sweep removes the rows"\n  fi\n/)
  })

  it('makes 100 requests, 14 then 14 then 35 then 37 between its mints, the numbers its own comment reasons from', () => {
    // A request is an sp_req call, or a call of one of the four helpers that make exactly one each. Counted per
    // stretch: before the first mint, between each two, after the third (release 3 added the third mint and
    // 32 requests: U24 to U30 and their three DELETEs).
    const HELPERS = ['sp_state() {', 'sp_drop() {', 'sp_refused() {']
    for (const helper of HELPERS) {
      const body = flat.slice(flat.indexOf(helper), flat.indexOf('\n}', flat.indexOf(helper)))
      expect(body.match(/\bsp_req (?:GET|POST|PUT|PATCH|DELETE) /g) ?? []).toHaveLength(1)
    }
    const requests = (text) =>
      (text.match(/\bsp_req (?:GET|POST|PUT|PATCH|DELETE) /g) ?? []).length
      + (text.match(/(?:^|; )sp_state(?: "\$SP_(?:OLD|MIXLOT)")?$/gm) ?? []).length
      + (text.match(/; sp_refused$/gm) ?? []).length
      + (text.match(/^if sp_drop "/gm) ?? []).length
    // the helper definitions sit ahead of the first request, and are not requests
    const body = flat.slice(flat.indexOf('sp_req POST "$STAGING_API_PLANTS" '))
    expect(requests(flat.slice(0, flat.indexOf('sp_req POST "$STAGING_API_PLANTS" ')))).toBe(HELPERS.length)
    const stretches = body.split('CLERK_JWT=$(mint_session_token)\n')
    expect(stretches).toHaveLength(4)
    expect(stretches.map(requests)).toEqual([14, 14, 35, 37])
    // no stretch is longer than the one the block ran with before release 3 (40), which was measured
    expect(Math.max(...stretches.map(requests))).toBeLessThanOrEqual(40)
    // a larger block needs its token paragraph re-read: these are the sentences that carry the numbers
    expect(block).toContain("block's first 14 (P2, P1's variety and its read, U0's 11): at most 21;")
    expect(block).toContain('the mint between U0 and U1: 14 (U1 to U6, then P2\'s DELETE);')
    expect(block).toContain('the mint before U7: 35 (U7 to U21);')
    expect(block).toContain("the mint before U24: 37 (U24 to U30 and their three DELETEs, then U22, P3's and P4's DELETEs, and P1's variety cleared and read).")
    expect(block).toContain('# 100 requests in all.')
    expect(block).toContain('# THREE MINTS OF ITS OWN')
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

// ── release 3: seed put INTO a lot that already exists (V5-SEEDLOTADDITION-001; R3-CONTRACT 6.1) ───────────────────
// U24 to U31. Block U cannot run until its commit is on dev (staging only), so what holds it until then is this:
// that every additions request is the contract's body and nothing else, that each body is built from a REAL reply
// (the smoke proves the client's own flow, not a hand-written one), and that no picking row is ever written to
// staging by a script whose workflow does not also sweep it.
describe('staging smoke block U, release 3: additions to an existing seed lot', () => {
  const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/contracts/seed-mix.json'), 'utf8'))
  const spec = FIXTURE.seed_additions_post
  const u = SMOKE.slice(SMOKE.indexOf('# ── U24 to U30) release 3'), SMOKE.indexOf('# ── U22) the lot goes, its parents still linked'))
  const flatU = u.split('\n').map((l) => l.trim()).join('\n')
  const keysOf = (objectText) => [...objectText.matchAll(/(?:^|[{,]\s*)"?([a-z_]+)"?\s*:/g)].map((m) => m[1])

  it('finds the stretch, between U21 and U22', () => {
    expect(u.length).toBeGreaterThan(2000)
    expect(SMOKE.indexOf('# ── U24 to U30) release 3')).toBeGreaterThan(SMOKE.indexOf('sp_check "u21-season-stats-parent-count"'))
    expect(SMOKE.indexOf('# ── U24 to U30) release 3')).toBeLessThan(SMOKE.indexOf('sp_check "u22-mix-lot-delete"'))
  })

  it('builds EVERY additions body with sp_add_body: the contract\'s four required keys, and nothing else at the top', () => {
    const helper = flatU.slice(flatU.indexOf('sp_add_body() {'), flatU.indexOf('\n}', flatU.indexOf('sp_add_body() {')))
    const base = helper.match(/'(\{addition_key: [^}]*\}) \+ \$x'/)
    expect(base, 'sp_add_body no longer lays its extras over one object literal').not.toBeNull()
    expect(keysOf(base[1])).toEqual(spec.request_required)
    // every request to the route sends what that helper built: directly, or the one body kept to send twice
    const sends = [...flatU.matchAll(/sp_req POST "(?:\$SP_ADD|\$SP_INV\/\$SP_L2\/seed-additions)" (.*)$/gm)].map((m) => m[1])
    expect(sends).toHaveLength(7)
    for (const body of sends) expect(body === '"$SP_BODY1"' || body.startsWith('"$(sp_add_body '), body).toBe(true)
    expect(flatU).toContain(`SP_BODY1=$(sp_add_body "$(sp_uuid)" "$SP_P3" "$SP_SET" '{"add_seed_count": 30, "add_estimated": false}')`)
    // and there is no other way to the route in the whole script
    // (the route is spelled four times: SP_ADD's own assignment, and the three sends to the one-parent lot)
    expect(SMOKE.match(/seed-additions"/g)).toHaveLength(4)
    expect(SMOKE).toContain('SP_ADD="$SP_INV/$SP_MIXLOT/seed-additions"')
    expect([...SMOKE.matchAll(/sp_req POST "[^"]*seed-additions[^"]*"/g)]).toHaveLength(3)
    expect(SMOKE.match(/sp_req POST "\$SP_ADD" /g)).toHaveLength(4)
  })

  it('lays only the contract\'s optional keys over them — never a name, a type or a category', () => {
    // the literal extras at the call sites, and the one built by jq for the re-filing addition
    const literals = [...flatU.matchAll(/sp_add_body [^\n]*? '(\{[^']*\})'\)/g)].map((m) => m[1])
    expect(literals).toHaveLength(3)
    const refile = flatU.match(/SP_REFILE=\$\(jq -nc [^\n]*'(\{add_seed_count: 12, add_estimated: true, filing: \{variety_id: \$v, expect_variety_id: \$e\}\})'/)
    expect(refile, 'the re-filing addition\'s extras are no longer one jq object').not.toBeNull()
    const used = new Set()
    for (const text of [...literals, refile[1].replace(/filing: \{[^}]*\}/, 'filing: 0')]) {
      for (const key of keysOf(text)) {
        used.add(key)
        expect(spec.request_optional, `an additions body carries "${key}"`).toContain(key)
        expect(spec.request_never).not.toContain(key)
      }
    }
    // all four optional keys but the weight are sent by some step; a count never goes without its basis
    expect([...used].sort()).toEqual(['add_estimated', 'add_seed_count', 'filing'])
    for (const text of literals) expect(keysOf(text)).toEqual(['add_seed_count', 'add_estimated'])
    // the filing is the filing route's own two keys
    expect(keysOf(refile[1].match(/filing: (\{[^}]*\})/)[1])).toEqual(['variety_id', 'expect_variety_id'])
    for (const never of spec.request_never) expect(base(never)).toBe(false)
    function base(key) { return new RegExp(`\\{addition_key:[^}]*\\b${key}\\b`).test(flatU) }
  })

  it('builds each body from a REAL reply: the plant\'s own lots, the open-lots row, the blend route', () => {
    // same plant: [plant] + the lot's other_parents, out of GET /api/plants/:id/seed-lots
    expect(flatU).toContain('sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P3/seed-lots"\nSP_SET=$(jq -c --arg p "$SP_P3" --arg x "$SP_MIXLOT" \'[$p] + ([.seed_lots[]? | select(.id == $x)][0].other_parents // [] | map(.id))\' "$SP_OUT"')
    // another plant: the row's own source_plants, out of GET /seed-lots-open
    expect(flatU).toContain('sp_req GET "$SP_INV/seed-lots-open?plant_id=$SP_P5"')
    expect(flatU).toContain(`SP_OPEN_SET=$(sp_jqx "$SP_MIXLOT" '[.open_lots[]? | select(.id == $x)][0].source_plants // [] | map(.id)')`)
    expect(flatU).toContain('sp_req POST "$SP_ADD" "$(sp_add_body "$(sp_uuid)" "$SP_P5" "$SP_OPEN_SET")"')
    // re-filing: the target from a real blend POST, the set and the expectation from the row
    const blend = flatU.indexOf('sp_req POST "$SP_VAR/blend" "{\\"component_variety_ids\\": [\\"$SP_V2\\", \\"$SP_V3\\"], \\"create\\": true}"\nSP_BLEND=$(sp_jq \'.id // empty\')')
    const row = flatU.indexOf('sp_req GET "$SP_INV/seed-lots-open?plant_id=$SP_P4"')
    const post = flatU.indexOf('sp_req POST "$SP_INV/$SP_L2/seed-additions" "$(sp_add_body "$(sp_uuid)" "$SP_P4" "$SP_ROW2_SET" "$SP_REFILE")"')
    expect(blend).toBeGreaterThan(-1)
    expect(row).toBeGreaterThan(blend)
    expect(post).toBeGreaterThan(row)
    expect(flatU).toContain(`SP_ROW2_SET=$(sp_jqx "$SP_L2" '[.open_lots[]? | select(.id == $x)][0].source_plants // [] | map(.id)')`)
    expect(flatU).toContain(`--arg v "$SP_BLEND" --arg e "$(sp_jqx "$SP_L2" '[.open_lots[]? | select(.id == $x)][0].variety_id // empty')"`)
    // five keys for seven sends: one body goes out three times on purpose (the replay, and the other lot)
    expect(flatU.match(/\$\(sp_uuid\)/g)).toHaveLength(5)
  })

  it('expects each answer the contract gives: the count up once, the replay, the two 409s, the uncounted lot, the used-up lot, the stale measure, both in the client\'s own body', () => {
    for (const [label, expected] of [
      ['u24-counted-lot', '"200 200 201 200 200 100|false"'],
      ['u24-open-lots', '"200 true,true,false,false|false,true"'],
      ['u25-same-plant-addition', '"200 false|false|true 200 130|false|$SP_BEFORE"'],
      ['u25-replay', '"200 true|130|$SP_ADDITION"'],
      ['u25-key-on-another-lot', '"409 addition_key_conflict"'],
      ['u25-stale-set', '"409 lot_changed 200 130"'],
      ['u26-other-plant-addition', '"200 true|false 200 $SP_THREE|130|true"'],
      ['u27-refiling-addition-uncounted', '"false 200 false|true 200 $SP_MIX|blend|null|null|$SP_MIXBOTH"'],
      ['u28-used-up-lot', '"200 409 lot_used_up"'],
      ['u29-stale-measure', '"409 lot_changed|130 200 130"'],
      ['u30-addition-event', '"201 200 2"'],
    ]) {
      const line = flatU.split('\n').find((l) => l.startsWith(`sp_check "${label}" `))
      expect(line, label).toBeDefined()
      expect(line, label).toContain(`" ${expected} "`)
    }
    // the codes it compares are codes the contract file names
    expect(Object.keys(spec.refusals)).toEqual(expect.arrayContaining(['addition_key_conflict', 'lot_used_up']))
    expect(FIXTURE.refusals.lot_changed.routes).toEqual(expect.arrayContaining([spec.route, FIXTURE.seed_measure_put.route]))
    // what a picking must not move is read BEFORE the first addition and compared after it
    expect(flatU.indexOf('SP_BEFORE="$(sp_jq "$SP_IDS_JQ")|$(sp_jq \'.source_plant_id // "null"\')|$(sp_jq \'.created_at // "null"\')|$(sp_jq \'.year_harvested | tostring\')"'))
      .toBeGreaterThan(-1)
    expect(flatU.indexOf('SP_BEFORE=')).toBeLessThan(flatU.indexOf('sp_req POST "$SP_ADD" "$SP_BODY1"'))
    // Both count writes go out in the CLIENT'S OWN BODY (pre-promote QA review, I2). Since this release every count
    // save from the lot page and the stage sheet carries what the page loaded in all three expected keys (contract
    // 2.9.6), flag on or off, so that is the shape staging must see written and read back. U24's lot was never
    // counted or weighed: all three null, and the write must land (its read-back is the u24-counted-lot assert
    // above). U29's page loaded the lot at U24 (100, counted, no weight) and the lot has moved on: 409, nothing
    // written.
    const measures = (flatU.match(/sp_req PUT "\$SP_INV\/\$SP_MIXLOT\/seed-measure" '\{[^']*\}'/g) ?? [])
      .map((call) => JSON.parse(call.slice(call.indexOf("'") + 1, -1)))
      .filter((body) => 'seed_count' in body)
    expect(measures).toEqual([
      { seed_count: 100, seed_count_estimated: false, expected_seed_count: null, expected_seed_count_estimated: null, expected_seed_weight_g: null },
      { seed_count: 5, seed_count_estimated: false, expected_seed_count: 100, expected_seed_count_estimated: false, expected_seed_weight_g: null },
    ])
    for (const body of measures) {
      // toEqual reads a missing key and an undefined one alike, so the three are asserted present by name
      expect(Object.keys(body)).toEqual(['seed_count', 'seed_count_estimated', 'expected_seed_count', 'expected_seed_count_estimated', 'expected_seed_weight_g'])
      for (const key of Object.keys(body)) expect(FIXTURE.seed_measure_put.request_optional).toContain(key)
    }
    // no count write in the block goes out the old way, with no expected key
    expect(flatU).not.toMatch(/seed-measure" '\{"seed_count": \d+, "seed_count_estimated": (true|false)\}'/)
  })

  it('the two lots that must NOT be offered differ from the one that is by one thing each', () => {
    // all three are V2 lots made by one body; the gift is stored (so it reads as a saved lot) and says gift,
    // the other is deleted, and both would be listed otherwise
    expect(flatU.match(/\$SP_LOT_V2/g)).toHaveLength(3)
    expect(flatU).toContain('sp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-gift-$TEST_RUN_ID\\", $SP_LOT_V2}"')
    expect(flatU).toContain('sp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-add-$TEST_RUN_ID\\", $SP_LOT_V2, \\"source_plant_id\\": \\"$SP_P3\\"}"')
    expect(flatU).toContain('sp_req POST "$STAGING_API_INVENTORY" "{\\"name\\": \\"smoke-test-seedlot-gone-$TEST_RUN_ID\\", $SP_LOT_V2, \\"source_plant_id\\": \\"$SP_P3\\"}"')
    expect(flatU).toContain(`sp_req PATCH "$SP_INV/$SP_GIFT/source-kind" '{"source_kind": "gift"}'`)
    expect(flatU).toContain(`sp_req POST "$SP_INV/$SP_GIFT/seed-stage" '{"stage": "stored"}'`)
    expect(flatU).toContain('sp_req DELETE "$SP_INV/$SP_GONE"')
    expect(flatU.indexOf('sp_req DELETE "$SP_INV/$SP_GONE"')).toBeLessThan(flatU.indexOf('sp_req GET "$SP_INV/seed-lots-open?plant_id=$SP_P5"'))
    // every row the stretch makes is named so the workflow's sweep matches it
    for (const name of [...flatU.matchAll(/\\"name\\": \\"([^"\\]+)\\"/g)].map((m) => m[1])) expect(name.startsWith('smoke-test-'), name).toBe(true)
  })

  it('sends the addition\'s event with the sheet\'s metadata keys and the smoke switch, and then counts two for one planting and lot', () => {
    const post = flatU.split('\n').find((l) => l.startsWith('sp_req POST "$STAGING_API_EVENTS" ') && l.includes('seed_addition_id'))
    expect(post).toBeDefined()
    const metadata = post.match(/\\"metadata\\": \{([^}]*)\}/)[1]
    expect([...metadata.matchAll(/\\"([a-z_]+)\\":/g)].map((m) => m[1]))
      .toEqual(['seed_lot_id', 'addition', 'seed_addition_id', 'added_seed_count', 'added_estimated', '_skip_critter_award'])
    expect(post).toContain('\\"plant_id\\": \\"$SP_P3\\", \\"event_type\\": \\"seed_saved\\", \\"event_date\\": \\"$SP_DAY\\"')
    expect(post).toContain('\\"seed_lot_id\\": \\"$SP_MIXLOT\\", \\"addition\\": true, \\"seed_addition_id\\": \\"$SP_ADDITION\\", \\"added_seed_count\\": 30, \\"added_estimated\\": false')
    // the amounts are those of the body that was POSTed in U25
    expect(flatU).toContain(`'{"add_seed_count": 30, "add_estimated": false}'`)
    expect(flatU.indexOf('if sp_id_ok "$SP_EVENT"; then SP_E3="$SP_EVENT"; fi')).toBeGreaterThan(flatU.indexOf(post))
  })

  it('reads the picking rows back through SQL LAST, with every id bound and none spliced, for rows it made', () => {
    const block = SMOKE.slice(SMOKE.indexOf('# ── U) A saved-seed lot'), SMOKE.indexOf('# ── H) Bulk Quick-Log'))
    const read = block.indexOf('SP_ADDROWS=$(psql "$NEON_STAGING_URL" ')
    expect(read).toBeGreaterThan(block.indexOf('SP_MIXROWS=$(psql "$NEON_STAGING_URL" '))
    expect(block.lastIndexOf('sp_req ')).toBeLessThan(block.indexOf('SP_ROWS=$(psql "$NEON_STAGING_URL" '))
    expect(block.lastIndexOf('sp_drop ')).toBeLessThan(block.indexOf('SP_ROWS=$(psql "$NEON_STAGING_URL" '))
    expect(block).toContain('-v lot="$SP_MIXLOT" -v second="$SP_L2" -v ev="$SP_E3"')
    const sql = block.slice(read, block.indexOf('|| SP_ADDROWS="psql-exit-$?"'))
    expect(sql.match(/:'(lot|second|ev)'::uuid/g)).toEqual([":'lot'::uuid", ":'second'::uuid", ":'ev'::uuid"])
    expect(sql).not.toMatch(/'\$SP_/)
    expect(sql.match(/FROM seed_lot_addition a JOIN seed_lot_parent_planting l ON l\.id = a\.parent_link_id WHERE l\.inventory_item_id = /g)).toHaveLength(2)
    expect(sql).toContain("FROM xp_events WHERE reason = 'event_logged' AND source_id = :'ev'::uuid")
    expect(block).toContain('sp_check "u31-addition-rows-readback" "$SP_ADDROWS" "2|1|0"')
    // only when the stretch made its rows; and an id that was never made is the nil uuid, which keys nothing
    expect(block).toMatch(/if \[\[ "\$SP_ADDED" == "true" \]\]; then\n\s*if \[\[ -n "\$\{NEON_STAGING_URL:-\}" \]\] && command -v psql >\/dev\/null 2>&1; then\n\s*SP_ADDROWS=\$\(psql /)
    expect(block).toContain('SP_ADDED=false; SP_L2="$SP_NIL"; SP_E3="$SP_NIL"')
    expect(block).toMatch(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n\s*sp_fail "u31-addition-rows-readback"/)
  })

  it('writes picking rows only in a tree whose workflow sweeps them first: the smoke and the sweep are one commit', () => {
    // The smoke's lots carry 'smoke-test-' in their names, the sweep's link delete takes a lot's link rows by
    // that name, and the picking delete takes exactly the pickings under those link rows, ahead of it.
    const run = SWEEP.run
    expect(SMOKE).toContain('/seed-additions')
    expect(run).toContain('DELETE FROM seed_lot_addition WHERE parent_link_id IN (SELECT id FROM seed_lot_parent_planting WHERE ')
    expect(run.indexOf('DELETE FROM seed_lot_addition ')).toBeLessThan(run.indexOf('-c "DELETE FROM seed_lot_parent_planting '))
    expect(LOTS_PREDICATE).toBe("name ILIKE '%smoke%'")
  })
})
