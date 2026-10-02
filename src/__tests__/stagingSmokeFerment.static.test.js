// V5-FERMENTPATH-001 — static guard on the staging smoke's block P (06-ferment-path §5.6; report-1a-smoke.md's
// "a text-reading static test pinning the block").
//
// WHY A FILE-READING TEST. Block P runs only inside deploy-staging.yml, against the staging Lambda, and until F's
// sitting it WARNs rather than runs. Nothing else executes it, so the ways it can rot are silent: its sweep
// reordered into a 23503 (a jar names its put_up row, so stage rows must go AFTER jars — the order 06 §5.6 wrote
// would fail), its scope widened to a pattern that reaches real rows, the dirty-run retry dropped from cleanup(),
// a sub-block dropped, the F-deployed gate turned into a silent skip, or the RowEditor edit quietly sent the
// remaining_count key again (which F refuses on a drawn jar, so the assert would test the 1a bundle instead).
// review-F-prepromote-early I1: the requirement is derived from the CHECKED-OUT TREE (deploy-staging runs dev's
// workflow file, so an env flag set there never reaches step 5); the derivation is executed below, not just read.
// I2: P3 smokes the stale 1a Mark used on a drawn jar (06 §1.3 item 6 case c).
// Put-Up UX pass R1 adds P1b (clearing a typed discard date: the engine's date, then the recipe's) and P10 (Raw at
// create). They are pinned at the bottom of this file, with the two engine figures the smoke's expectations rest on.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { resolveJarUseBy, shelfLifeMonths } from '../../lambda/preservation/shelfLife.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const start = SMOKE.indexOf('# ── P) Put-Up 1b + Ferment')
// Block P ends at the next block heading (block Q, STATS, follows it since 4.162.0), so nothing below reads a
// neighbour's lines as P's.
const end = SMOKE.indexOf('\n# ── ', start + 1)
const BLOCK = SMOKE.slice(start, end)
const sweepStart = BLOCK.indexOf('ferm_sweep() {')
const SWEEP = BLOCK.slice(sweepStart, BLOCK.indexOf('\nSQL\n}', sweepStart))

describe('block P is present, after block N, and closed by the next block heading', () => {
  it('sits after N; the slice ends before the next block and before the water recon', () => {
    expect(start).toBeGreaterThan(SMOKE.indexOf('# ── N) Put-Up: a place and a jar'))
    expect(end).toBeGreaterThan(start)
    expect(end).toBeLessThanOrEqual(SMOKE.indexOf('# ── DRG-WATERRECON-002'))
    expect(sweepStart).toBeGreaterThan(0)
  })

  it.each(['p1-putup-readback', 'p1-legacy-date-refused', 'p1-legacy-echo-noop', 'p2-salt-readback', 'p3-draw',
    'p3-legacy-stale-refused', 'p3-mark-used', 'p3-note-edit', 'p4-weighed-draw', 'p4-draw-to-zero', 'p5-take-out', 'p5-restore',
    'p6-stage-edit', 'p7-shu-save', 'p8-putup-row', 'p8-undo', 'p9-batch-remove', 'l058-sweep',
    // Put-Up UX pass R1
    'p1b-clear-table', 'p1b-clear-recipe', 'p10-raw-create',
    // Put-Up R2a (lane S): a batch made from a jar that already exists (pinned in PutUpR2S.smoke.static.test.js)
    'p11-from-jars', 'p11-replay'])('asserts %s', (tag) => {
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

  // I1. The derivation sits in block P before its outer `if` (so before the probe), and when the block cannot run
  // at all (no JWT, no preservation URL) a required block FAILs instead of WARNing.
  const outerIf = BLOCK.indexOf('if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}"')
  const derive = BLOCK.indexOf('[[ -d "$FE_TREE/migrations/v5-fermentpath-001" ]] && SMOKE_REQUIRE_FERMENT=1')
  it('I1: the requirement is derived from the checked-out tree, before the block runs or probes', () => {
    expect(outerIf).toBeGreaterThan(0)
    expect(derive, 'the derivation line is present').toBeGreaterThan(0)
    expect(derive).toBeLessThan(outerIf)
    expect(BLOCK.indexOf('FE_TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"')).toBeLessThan(derive)
    expect(BLOCK.indexOf('line-search?q=smoke')).toBeGreaterThan(outerIf)
  })

  it('I1: a required block that cannot run at all is a FAIL, not the WARN', () => {
    const tail = BLOCK.slice(BLOCK.lastIndexOf('\nelif '))
    expect(tail).toMatch(/^\nelif \[\[ "\$\{SMOKE_REQUIRE_FERMENT:-\}" == "1" \]\]; then\s+echo "❌ FAIL \[ferment:deployed\][^\n]*\n\s+FAIL=\$\(\(FAIL\+1\)\)\nelse\s+echo "⚠️  WARN \[ferment\]/)
  })

  // Executed, not read: the two derivation lines, cut from the script, run under the script's own `set -euo
  // pipefail` from a temp tree with and without F's migration, and from a working directory that is not the root.
  describe('I1: the derivation, executed', () => {
    const lines = BLOCK.split('\n')
    const i = lines.findIndex((l) => l.startsWith('FE_TREE="$('))
    const snippet = i >= 0 ? lines.slice(i, i + 2).join('\n') : ''
    const run = ({ withF, preset, cwdIsRoot }) => {
      const root = mkdtempSync(join(tmpdir(), 'smokeP-'))
      try {
        mkdirSync(join(root, 'tests', 'smoke'), { recursive: true })
        if (withF) mkdirSync(join(root, 'migrations', 'v5-fermentpath-001'), { recursive: true })
        const script = join(root, 'tests', 'smoke', 'probe.sh')
        writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\n${snippet}\necho "REQ=\${SMOKE_REQUIRE_FERMENT:-unset}"\n`)
        const env = { PATH: process.env.PATH, ...(preset ? { SMOKE_REQUIRE_FERMENT: preset } : {}) }
        const cwd = cwdIsRoot ? root : tmpdir()
        const arg = cwdIsRoot ? 'tests/smoke/probe.sh' : script
        return execFileSync('bash', [arg], { cwd, env, encoding: 'utf8' }).trim()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
    it('cut two lines from the script', () => {
      expect(snippet.split('\n')).toHaveLength(2)
      expect(snippet).toContain('SMOKE_REQUIRE_FERMENT=1')
    })
    it('a tree WITH migrations/v5-fermentpath-001 requires block P (from the root, and from elsewhere)', () => {
      expect(run({ withF: true, cwdIsRoot: true })).toBe('REQ=1')
      expect(run({ withF: true, cwdIsRoot: false })).toBe('REQ=1')
    })
    it('a tree WITHOUT it leaves the requirement unset, and set -e survives the false test', () => {
      expect(run({ withF: false, cwdIsRoot: true })).toBe('REQ=unset')
      expect(run({ withF: false, cwdIsRoot: false })).toBe('REQ=unset')
    })
    it('a hand-set SMOKE_REQUIRE_FERMENT=1 still holds on a tree without F', () => {
      expect(run({ withF: false, preset: '1', cwdIsRoot: true })).toBe('REQ=1')
    })
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
  const P3 = BLOCK.slice(BLOCK.indexOf('# ── P3)'), BLOCK.indexOf('# ── P4)'))
  const markUsed = P3.indexOf('fe_req POST "$FE_BASE/api/pantry/uses"')
  it("P3's note edit is the F bundle's: PATCH /api/preservation/:id, never the legacy PUT", () => {
    const afterUse = P3.slice(markUsed)
    expect(markUsed).toBeGreaterThan(0)
    expect(afterUse).toContain('fe_req PATCH "$FE_BASE/api/preservation/$FE_J3" "{\\"notes\\": \\"$FE_TAG edited\\"}"')
    expect(afterUse).not.toMatch(/fe_req PUT /)
    expect(afterUse).toContain('"200 2|null|false $FE_TAG edited"')
  })

  // I2 (06 §1.3 item 6 case c): after the draw and before the F Mark used, the stale 1a phone's Mark used — the full
  // nineteen-key echo WITH remaining_count, set to n-1 — must read 409 client_stale with count and delta_at unchanged.
  it("I2: P3 sends the 1a nineteen-key echo with remaining_count n-1 on the drawn jar and expects 409, nothing moved", () => {
    const draw = P3.indexOf('fe_check "p3-draw"')
    const stale = P3.indexOf('fe_check "p3-legacy-stale-refused"')
    expect(draw).toBeGreaterThan(0)
    expect(stale).toBeGreaterThan(draw)
    expect(stale).toBeLessThan(markUsed)
    const seg = P3.slice(draw, stale)
    const filter = seg.match(/FE_ROW=\$\(fe_jq '([^']*)'\)/)[1]
    const keys = filter.match(/^\{([^}]*)\}/)[1].split(',').map((k) => k.trim())
    expect(keys).toEqual(['crop_type_slug', 'variety_id', 'plant_id', 'harvest_log_id', 'preserved_at', 'preserved_at_approx',
      'method', 'method_other_text', 'quantity_value', 'quantity_unit', 'package_count', 'storage_location_id',
      'use_by_target', 'remaining_count', 'consumed_at', 'notes', 'photo_id', 'source_kind', 'source_label'])
    expect(filter).toContain('.remaining_count = (.remaining_count - 1)')
    expect(seg).toContain('fe_req PUT "$FE_BASE/api/preservation/$FE_J3" "$FE_ROW"')
    expect(seg).toContain("FE_STALE_SQL=\"SELECT coalesce(remaining_count::text,'null')||'|'||coalesce(delta_at::text,'null') FROM preservation_log WHERE id = '$FE_J3'\"")
    expect(seg.indexOf('FE_BEFORE=$(fe_row "$FE_STALE_SQL")')).toBeLessThan(seg.indexOf('fe_req PUT'))
    expect(P3.slice(stale)).toMatch(/^fe_check "p3-legacy-stale-refused" "\$FE_CODE \$\(fe_jq '\.code \/\/ "-"'\) \$\(fe_row "\$FE_STALE_SQL"\)" "409 client_stale \$FE_BEFORE"/)
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

// ── Put-Up UX pass R1 ─────────────────────────────────────────────────────────────────────────────────────────
// P1b: PATCH /api/preservation/:id {"discard_by": "clear"} resolves by the whole discard-by rule (a moved jar → no
// date; else the recipe on a matching kind; else the engine). The smoke reads back the engine rung on P1's jar and
// the recipe rung on a batch that follows a recipe. P10: POST /api/preservation stores is_raw, and Raw in a fridge is
// no date. What can rot silently: the clear moved ahead of P1's legacy-PUT checks (which need the typed date), the
// recipe renamed out of recipes_sweep's reach, the row no longer typed (create would already read "recipe" and the
// clear would prove nothing), or P10's method changed to one with no fridge figure (basis none without Raw).
describe('P1b — clearing a typed discard date: the engine, then the recipe', () => {
  const at = BLOCK.indexOf('# ── P1b)')
  const P1B = BLOCK.slice(at, BLOCK.indexOf('# ── P2)'))
  const line = (needle) => P1B.split('\n').find((l) => l.includes(needle)) ?? ''

  it('sits after P1\'s legacy-PUT checks (they need the typed date in place) and before P2', () => {
    expect(at).toBeGreaterThan(BLOCK.indexOf('fe_check "p1-legacy-echo-noop"'))
    expect(BLOCK.indexOf('# ── P2)')).toBeGreaterThan(at)
  })

  it('both clears are the PATCH with discard_by "clear", and each is read back as basis|discard-by before → after', () => {
    expect(P1B).toContain(`fe_req PATCH "$FE_BASE/api/preservation/$FE_J1" '{"discard_by": "clear"}'`)
    expect(P1B).toContain(`fe_req PATCH "$FE_BASE/api/preservation/$FE_J1B" '{"discard_by": "clear"}'`)
    expect(P1B).toContain(`FE_BASIS_SQL="SELECT coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id ="`)
    expect(line('fe_check "p1b-clear-table"')).toContain(`"$FE_WAS → $FE_CODE $(fe_row "$FE_BASIS_SQL '$FE_J1'")" "typed|$FE_LATER → 200 table|$(fe_row "SELECT (DATE '$FE_DAY' + INTERVAL '6 months')::date::text")"`)
    expect(line('fe_check "p1b-clear-recipe"')).toContain(`"$FE_WAS → $FE_CODE $(fe_row "$FE_BASIS_SQL '$FE_J1B'")" "typed|$FE_LATER → 200 recipe|$(fe_row "SELECT (DATE '$FE_DAY' + 7)::text")"`)
  })

  it('the engine figure the first clear expects is the engine\'s: a ferment in a fridge is 6 months, P1\'s method at P1\'s place', () => {
    expect(shelfLifeMonths('ferment', 'fridge')).toBe(6)
    const p1 = BLOCK.slice(BLOCK.indexOf('# ── P1)'), at)
    expect(p1).toContain('\\"method\\": \\"ferment\\"')
    expect(p1).toContain('\\"place\\": {\\"id\\": \\"$FE_PLACE\\"}')
    expect(BLOCK).toContain('"{\\"label\\": \\"$FE_TAG place\\", \\"kind\\": \\"fridge\\"}"')
  })

  it('the recipe says Fridge · 7 days; the batch follows it; the row put up on it is a TYPED row at the fridge place', () => {
    expect(line('fe_req POST "$FE_BASE/api/recipes"')).toContain('\\"keeps\\": {\\"n\\": 7, \\"unit\\": \\"day\\", \\"storage_kind\\": \\"fridge\\"}')
    const batch = line('fe_req POST "$FE_BASE/api/kitchen-batches" ')
    expect(batch).toContain('\\"label\\": \\"$FE_TAG P1b\\"')
    expect(batch).toContain('\\"recipe_id\\": \\"$FE_RCP\\"')
    const putUp = line('fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B1B/put-up"')
    expect(putUp).toContain('\\"place\\": {\\"id\\": \\"$FE_PLACE\\"}')
    expect(putUp).toContain('\\"discard_by\\": \\"$FE_LATER\\"')
    expect(putUp).toContain('\\"name\\": \\"$FE_TAG P1b\\"')
  })

  it('its rows are swept: the recipe by recipes_sweep (its prefix), the batch and jar by ferm_sweep (this block\'s tag)', () => {
    const rs = SMOKE.indexOf('recipes_sweep() {')
    const recipesSweep = SMOKE.slice(rs, SMOKE.indexOf('\nSQL\n}', rs))
    expect(recipesSweep).toContain("SELECT id FROM recipe WHERE name LIKE 'smoke-test-recipe-%'")
    expect(line('fe_req POST "$FE_BASE/api/recipes"')).toContain('\\"name\\": \\"smoke-test-recipe-$TEST_RUN_ID clear\\"')
    // The flag is raised before the recipe exists, and block T (whose end-of-block sweep removes it) runs after P.
    const dirty = P1B.indexOf('RECIPES_DIRTY=true')
    expect(dirty).toBeGreaterThan(0)
    expect(dirty).toBeLessThan(P1B.indexOf('fe_req POST "$FE_BASE/api/recipes"'))
    expect(SMOKE.indexOf('# ── T) Recipes (B′ release 4)')).toBeGreaterThan(end)
    // The sweep and its flag are DEFINED before this block begins (they used to sit in block T, below it): bash has
    // the function by the time P1b raises the flag, so a run that dies anywhere after P1b is swept by cleanup().
    const def = SMOKE.indexOf('\nrecipes_sweep() {\n')
    expect(def).toBeGreaterThan(0)
    expect(def).toBeLessThan(start)
    expect(SMOKE.indexOf('\nRECIPES_DIRTY=false\n')).toBeLessThan(def)
    // And the soft delete through the recipe's own route stays, as the belt: after the clear is checked, never before.
    expect(P1B.indexOf('fe_req DELETE "$FE_BASE/api/recipes/$FE_RCP"')).toBeGreaterThan(P1B.indexOf('fe_check "p1b-clear-recipe"'))
    // cleanup() sweeps ferment (the batch that names the recipe) before recipes: kitchen_batch.recipe_id is NO ACTION.
    const cleanup = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))
    expect(cleanup.indexOf('ferm_sweep >')).toBeGreaterThan(0)
    expect(cleanup.indexOf('ferm_sweep >')).toBeLessThan(cleanup.indexOf('recipes_sweep >'))
    expect(SWEEP).toContain("WHERE label LIKE 'smoke-test-ferment-%'")
    expect(SWEEP).toContain('batch_id IN (SELECT id FROM fe_b)')
  })
})

describe('P10 — Raw at create', () => {
  const at = BLOCK.indexOf('# ── P10)')
  const P10 = BLOCK.slice(at, BLOCK.indexOf('if ferm_sweep; then'))
  const post = P10.split('\n').find((l) => l.includes('fe_req POST "$FE_BASE/api/preservation"')) ?? ''

  it('sits after P9, before the sweep', () => {
    expect(at).toBeGreaterThan(BLOCK.indexOf('fe_check "p9-batch-remove"'))
    expect(BLOCK.indexOf('if ferm_sweep; then')).toBeGreaterThan(at)
  })

  it('creates a Raw hot sauce at the block\'s fridge place, tagged for ferm_sweep, with no typed date', () => {
    for (const s of ['\\"is_raw\\": true', '\\"method\\": \\"hot_sauce\\"', '\\"storage_location_id\\": \\"$FE_PLACE\\"', '\\"notes\\": \\"$FE_TAG\\"']) {
      expect(post).toContain(s)
    }
    expect(post).not.toContain('use_by_target')   // a typed date would hide the engine's answer
  })

  it('reads back BOTH halves: is_raw stored, and the basis none with no date', () => {
    expect(P10).toContain("SELECT coalesce(is_raw::text,'null')||'|'||coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id = '$FE_J10'")
    expect(P10).toContain('"true|none|null"')
  })

  it('hot sauce HAS a fridge figure, so "none" is Raw\'s doing: an ignored key would read table, and the check would fail', () => {
    expect(resolveJarUseBy({ method: 'hot_sauce', kind: 'fridge' }, '2026-10-01').use_by_basis).toBe('table')
    expect(resolveJarUseBy({ method: 'hot_sauce', kind: 'fridge', isRaw: true }, '2026-10-01'))
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
  })
})
