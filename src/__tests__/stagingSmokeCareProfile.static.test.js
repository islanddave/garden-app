// OPS-SMOKECAREPROFILE-001 — static guards on the staging smoke's care_profile read-back, and on the
// L-058 sweep step that removes the row afterwards.
//
// WHY A FILE-READING TEST. Both halves run only inside deploy-staging.yml, against the staging Neon
// branch, when a promote dispatches it: the SQL read-back in tests/smoke/run-smoke.sh block D, and the
// hard-delete sweep step after it. Nothing in the unit or integration suites executes either one, so what
// is falsifiable here is their SHAPE (the idiom harvestWeightRatchet.test.js uses for a script that needs
// a live Neon). Each assertion pins a property whose loss the staging run would report late or not at all:
//   * the care_profile delete dropped, mis-scoped or moved after the plant_varieties delete — the sweep's
//     own residue check reds, but only at the next promote; this reds on the push.
//   * the residue term "simplified" into a join on the smoke name. After the sweep no smoke variety is
//     left, so that term reads 0 with every profile orphaned and the staging run stays GREEN. Rehearsed on
//     a local PG 17 when this landed: base sweep green with 2 orphans; name-joined term green with 2.
//   * a care_profile delete that loses the smoke-variety subquery wipes every cultivar profile on staging.
//   * the variety id spliced into SQL text instead of bound as a psql variable.
//
// WHAT IT DOES NOT CATCH: whether the SQL is right for the live schema. When this landed, the delete
// (EXPLAIN only), the capture and the residue SELECT were run read-only against staging. Every
// deploy-staging run then executes them for real.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'

const WF = yaml.load(readFileSync(resolve(process.cwd(), '.github/workflows/deploy-staging.yml'), 'utf8'))
const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')

function smokeJobStep(name) {
  const step = WF.jobs['smoke-tests'].steps.find((s) => s.name === name)
  if (!step) throw new Error(`deploy-staging.yml smoke-tests has no step named "${name}"`)
  return step
}
const SWEEP = smokeJobStep('L-058 smoke-test row hygiene cleanup')
const RUN_SMOKE = smokeJobStep('Run smoke tests')

describe('the L-058 sweep removes the smoke variety\'s care_profile', () => {
  const run = SWEEP.run

  it('deletes cultivar-scope profiles keyed to smoke varieties, and nothing wider', () => {
    const deletes = run.match(/DELETE FROM care_profile\b[^"]*/g) ?? []
    expect(deletes).toHaveLength(1)
    expect(deletes[0].replace(/\s+/g, ' ')).toBe(
      "DELETE FROM care_profile WHERE scope='cultivar' AND scope_id IN (SELECT id FROM plant_varieties WHERE name ILIKE '%smoke%');",
    )
  })

  it('runs that delete BEFORE plant_varieties, while the smoke name still links the profile', () => {
    const care = run.indexOf('DELETE FROM care_profile')
    const varieties = run.indexOf("DELETE FROM plant_varieties WHERE name ILIKE '%smoke%'")
    expect(care).toBeGreaterThan(-1)
    expect(varieties).toBeGreaterThan(care)
  })

  it('captures the smoke variety ids before the sweep psql runs', () => {
    const capture = run.indexOf(
      `SMOKE_VARIETY_IDS=$(psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -At -c "SELECT COALESCE(string_agg(id::text, ','), '') FROM plant_varieties WHERE name ILIKE '%smoke%';")`,
    )
    const sweep = run.indexOf('psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 \\\n')
    expect(capture).toBeGreaterThan(-1)
    expect(sweep).toBeGreaterThan(capture)
  })

  it('counts leftover profiles by the captured ids, never by a join on the smoke name', () => {
    const remaining = run.split('\n').find((l) => l.startsWith('REMAINING='))
    expect(remaining).toContain(
      "(SELECT COUNT(*) FROM care_profile WHERE scope='cultivar' AND scope_id = ANY('{$SMOKE_VARIETY_IDS}'::uuid[]))",
    )
    expect(remaining).not.toMatch(/FROM care_profile[^)]*IN \(SELECT id FROM plant_varieties/)
  })

  it('still runs when the smoke itself failed', () => {
    expect(SWEEP.if).toBe('always()')
  })
})

describe('the smoke reads the care_profile back through SQL', () => {
  const start = SMOKE.indexOf('# D-profile)')
  const end = SMOKE.indexOf('❌ FAIL [crud:POST /varieties]')
  const block = SMOKE.slice(start, end)

  it('gets the same staging DSN the sweep uses, on the ship-gate run', () => {
    expect(RUN_SMOKE.env.NEON_STAGING_URL).toBe('${{ secrets.NEON_STAGING_URL }}')
    expect(RUN_SMOKE.env.NEON_STAGING_URL).toBe(SWEEP.env.NEON_STAGING_URL)
    expect(RUN_SMOKE.env.SMOKE_REQUIRE_AUTH).toBe('1')
  })

  it('sits in the variety-created branch, after the create passed', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('✅ PASS [crud:POST /varieties]'))
    expect(end).toBeGreaterThan(start)
  })

  it('asserts exactly one cultivar row for this variety id, still unresearched', () => {
    expect(block).toContain(
      "SELECT COUNT(*) FILTER (WHERE profile->>'_basis' = 'unresearched') || '/' || COUNT(*) FROM care_profile WHERE scope = 'cultivar' AND scope_id = :'vid'::uuid;",
    )
    expect(block).toContain('if [[ "$CP_GOT" == "1/1" ]]; then')
  })

  it('binds the variety id as a psql variable and never splices it into SQL text', () => {
    expect(block).toContain('-v vid="$CREATED_VARIETY_ID"')
    // psql does not interpolate :'vid' inside -c text, so the query has to arrive on stdin.
    expect(block).toMatch(/<<< "SELECT [^"]*:'vid'::uuid;"/)
    expect(block).not.toMatch(/-c "[^"]*\$CREATED_VARIETY_ID/)
    expect(block).not.toMatch(/'\$CREATED_VARIETY_ID'/)
  })

  it('fails the ship gate, rather than skipping, when the DSN or psql is missing', () => {
    const branch = block.match(/elif \[\[ -n "\$\{SMOKE_REQUIRE_AUTH:-\}" \]\]; then\n([\s\S]*?)\n\s*else\n/)
    expect(branch).not.toBeNull()
    expect(branch[1]).toContain('FAIL=$((FAIL+1))')
    expect(branch[1]).not.toContain('PASS=$((PASS+1))')
  })
})
