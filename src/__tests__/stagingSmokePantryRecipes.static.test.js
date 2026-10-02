// B′ (Put-Up releases 2 and 4) — static guard on the staging smoke's blocks S (Pantry) and T (recipes)
// (05-release-train §5: "a pantry item create; a recipe create → GET → DELETE"; "Used one then read back remaining
// and delta_at, Undo"). Same idiom as stagingSmokeFerment.static.test.js, which pins block P.
//
// WHY A FILE-READING TEST. Blocks S and T run only inside deploy-staging.yml (and promote-gate's staging smoke),
// against the staging Lambda; nothing else executes them. The ways they can rot are silent: a sweep reordered into a
// 23503 or widened to a pattern that reaches real rows, the dirty-run retry dropped from cleanup(), a sub-block
// dropped, the deployed gate turned into a silent skip, or the requirement read from a workflow env flag that never
// reaches the run (review-F-prepromote-early I1: deploy-staging is dispatched --ref dev, so the requirement is derived
// from the CHECKED-OUT TREE's migrations dirs; that derivation is executed below, not just read). Block letters: Q and
// R are STATS's (421a1f9), so B′ takes S and T.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { RECIPE_BUILTIN_TYPES, parseRecipeRoute } from '../../lambda/preservation/recipeRules.js'
import { parsePantryRoute } from '../../lambda/preservation/pantryRoutes.js'
import { validateUse } from '../../lambda/preservation/pantryUses.js'

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const sliceBlock = (heading) => {
  const start = SMOKE.indexOf(heading)
  return { start, end: SMOKE.indexOf('\n# ── ', start + 1), text: SMOKE.slice(start, SMOKE.indexOf('\n# ── ', start + 1)) }
}
const S = sliceBlock('# ── S) Pantry (B′ release 2)')
const T = sliceBlock('# ── T) Recipes (B′ release 4)')
const sweepOf = (block, fn) => {
  const at = block.indexOf(`${fn}() {`)
  return at < 0 ? '' : block.slice(at, block.indexOf('\nSQL\n}', at))
}
const CLEANUP = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup'))

// sweepIn: the text the block's sweep function is read from. pantry_sweep is defined in block S. recipes_sweep is
// NOT in block T since Put-Up UX pass R1: block P's P1b writes a smoke-test-recipe row too, so the function and its
// flag sit above block P and are read from the whole script (the position is pinned under "block T — recipes").
const BLOCKS = [
  {
    name: 'S', block: S.text, sweepIn: S.text, tag: 'pantry', sweepFn: 'pantry_sweep', dirty: 'PANTRY_DIRTY', prefix: 'smoke-test-pantry-',
    tagVar: 'PN_TAG="smoke-test-pantry-$TEST_RUN_ID"', req: 'SMOKE_REQUIRE_PANTRY', mig: 'v5-pantry-001', treeVar: 'PN_TREE',
    probe: 'pn_req GET "$PN_BASE/api/pantry"', fail: 'pn_fail', uuid: 'PN_UUID_RE',
    outerIf: 'if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" && -n "${STAGING_API_STORAGE_LOCATIONS:-}" ]]; then',
    asserts: ['s1-create-readback', 's2-replay', 's3-listed', 's4-used-up', 's5-unlisted', 's6-delete', 's7-delete-again',
      's8-used-one', 's8-undo', 'l058-sweep',
      // Put-Up UX pass R1: Went bad as a count
      's9-went-bad-part', 's9-listed', 's9-undo',
      // Put-Up R2a (lane S): the door's create, the place refusals, /move, the where-from pair, the as-is amount.
      // What each one sends and reads back is pinned in PutUpR2S.smoke.static.test.js.
      's10-door-create', 's10-door-replay', 's10-door-dried', 's11-dated-weighed', 's11-listed-weighed',
      's12-place-rename', 's13-rekind-refused', 's13-date-by-hand', 's13-rekind-after', 's14-work-it-out', 's14-move',
      's15-rekind-allowed', 's16-all-remaining', 's16-undo', 's17-delete-refused', 's17-delete-clean',
      's18-jar-source', 's18-jar-source-garden', 's18-jar-source-pair',
      's19-item-create', 's19-item-replay', 's19-item-listed', 's19-item-patch', 's19-item-clear'],
    order: [
      'DELETE FROM pantry_use WHERE reverses_use_id IS NOT NULL',
      'DELETE FROM pantry_use WHERE preservation_log_id',
      'DELETE FROM preservation_source',
      'DELETE FROM preservation_log',
      'DELETE FROM pantry_item',
      'DELETE FROM storage_location',
    ],
  },
  {
    name: 'T', block: T.text, sweepIn: SMOKE, tag: 'recipes', sweepFn: 'recipes_sweep', dirty: 'RECIPES_DIRTY', prefix: 'smoke-test-recipe-',
    tagVar: 'RC_TAG="smoke-test-recipe-$TEST_RUN_ID"', req: 'SMOKE_REQUIRE_RECIPES', mig: 'v5-recipes-001', treeVar: 'RC_TREE',
    probe: 'rc_req GET "$RC_BASE/api/recipes/types"', fail: 'rc_fail', uuid: 'RC_UUID_RE',
    outerIf: 'if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" ]]; then',
    asserts: ['t1-builtin-types', 't2-create', 't3-readback', 't3-no-ph-field', 't4-delete', 't5-gone', 'l058-sweep',
      // Put-Up R2a (lane S): the recipe sheet's Save, PATCH { lines }
      't3b-patch-lines'],
    order: ['DELETE FROM recipe_ingredient', 'DELETE FROM recipe WHERE'],
  },
]

describe('blocks S and T are present, after block Q, before the water recon, each closed by the next heading', () => {
  it('Q < S < T < DRG-WATERRECON-002, and no other block took the letters', () => {
    const q = SMOKE.indexOf('# ── Q) A source')
    expect(q).toBeGreaterThan(0)
    expect(S.start).toBeGreaterThan(q)
    expect(T.start).toBeGreaterThan(S.start)
    expect(S.end).toBe(T.start - 1)
    expect(T.end).toBeLessThanOrEqual(SMOKE.indexOf('# ── DRG-WATERRECON-002'))
    expect(SMOKE.match(/^# ── S\)/gm)).toHaveLength(1)
    expect(SMOKE.match(/^# ── T\)/gm)).toHaveLength(1)
  })

  it('the header lists both blocks', () => {
    const header = SMOKE.slice(0, SMOKE.indexOf('# ── Required env'))
    expect(header).toMatch(/#\s+S\) Pantry \(B′ release 2/)
    expect(header).toMatch(/#\s+T\) Recipes \(B′ release 4\)/)
  })
})

describe.each(BLOCKS)('block $name', (b) => {
  const SWEEP = sweepOf(b.sweepIn, b.sweepFn)

  it.each(b.asserts)('asserts %s', (tag) => {
    expect(b.block).toMatch(new RegExp(`${b.name === 'S' ? 'pn' : 'rc'}_(check|pass|fail) "${tag}"`))
  })

  it('its sweep deletes in FK order', () => {
    const at = b.order.map((s) => SWEEP.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
  })

  it('its sweep is ONE psql transaction that stops on the first error', () => {
    expect(SWEEP).toMatch(/psql "\$NEON_STAGING_URL" -X -q -1 -v ON_ERROR_STOP=1 <<'SQL'/)
  })

  it(`every sweep scope is the ${b.prefix} prefix (or hangs off a row that has it), never a bare %smoke%`, () => {
    const likes = SWEEP.match(/LIKE '[^']*'/g)
    expect(likes.length).toBeGreaterThan(0)
    expect(new Set(likes)).toEqual(new Set([`LIKE '${b.prefix}%'`]))
    expect(b.block).toContain(b.tagVar)
  })

  it('cleanup() retries the sweep when the run died mid-block; the block clears the flag only after its sweep', () => {
    expect(CLEANUP).toMatch(new RegExp(`if \\[\\[ "\\$\\{${b.dirty}:-false\\}" == "true" \\]\\]; then\\s+${b.sweepFn}`))
    expect(b.block).toContain(`${b.dirty}=true`)
    expect(b.block.indexOf(`${b.dirty}=false\n`, b.block.indexOf(`if ${b.sweepFn}; then`)))
      .toBeGreaterThan(b.block.indexOf(`if ${b.sweepFn}; then`))
  })

  it(`without the release on staging it WARNs, and ${b.req}=1 turns that into a FAIL`, () => {
    const outer = b.block.indexOf(b.outerIf)
    expect(outer).toBeGreaterThan(0)
    expect(b.block.indexOf(b.probe)).toBeGreaterThan(outer)
    expect(b.block).toMatch(new RegExp(`if \\[\\[ "\\$\\{${b.req}:-\\}" == "1" \\]\\]; then\\s+${b.fail} "deployed"`))
  })

  it('a required block that cannot run at all is a FAIL, not the WARN', () => {
    const tail = b.block.slice(b.block.lastIndexOf('\nelif '))
    expect(tail).toMatch(new RegExp(
      `^\\nelif \\[\\[ "\\$\\{${b.req}:-\\}" == "1" \\]\\]; then\\s+echo "❌ FAIL \\[${b.tag}:deployed\\][^\\n]*\\n\\s+FAIL=\\$\\(\\(FAIL\\+1\\)\\)\\nelse\\s+echo "⚠️  WARN \\[${b.tag}\\]`))
  })

  it('a missing SQL read-back path is a FAIL, not a skip', () => {
    expect(b.block).toContain(`${b.fail} "readback-sql"`)
  })

  it('an id reaches SQL only after matching the uuid shape', () => {
    expect(b.block).toContain(`${b.uuid}='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`)
  })

  it('URLs are built on the preservation Lambda (STAGING_API_PRESERVATION), as block P builds them', () => {
    const v = b.name === 'S' ? 'PN_BASE' : 'RC_BASE'
    expect(b.block).toContain(`${v}="\${STAGING_API_PRESERVATION%/}"`)
  })

  // Executed, not read: the two derivation lines, cut from the script, run under the script's own `set -euo
  // pipefail` from a temp tree with and without the release's migration, and from a working directory that is not
  // the root.
  describe('I1: the requirement derivation, executed', () => {
    const lines = b.block.split('\n')
    const i = lines.findIndex((l) => l.startsWith(`${b.treeVar}="$(`))
    const snippet = i >= 0 ? lines.slice(i, i + 2).join('\n') : ''
    const run = ({ withRelease, preset, cwdIsRoot }) => {
      const root = mkdtempSync(join(tmpdir(), `smoke${b.name}-`))
      try {
        mkdirSync(join(root, 'tests', 'smoke'), { recursive: true })
        if (withRelease) mkdirSync(join(root, 'migrations', b.mig), { recursive: true })
        const script = join(root, 'tests', 'smoke', 'probe.sh')
        writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\n${snippet}\necho "REQ=\${${b.req}:-unset}"\n`)
        const env = { PATH: process.env.PATH, ...(preset ? { [b.req]: preset } : {}) }
        const cwd = cwdIsRoot ? root : tmpdir()
        const arg = cwdIsRoot ? 'tests/smoke/probe.sh' : script
        return execFileSync('bash', [arg], { cwd, env, encoding: 'utf8' }).trim()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
    it('sits before the block runs or probes, and the two lines were cut', () => {
      expect(snippet.split('\n')).toHaveLength(2)
      expect(snippet).toContain(`[[ -d "$${b.treeVar}/migrations/${b.mig}" ]] && ${b.req}=1`)
      expect(b.block.indexOf(snippet)).toBeLessThan(b.block.indexOf(b.outerIf))
    })
    it(`a tree WITH migrations/${b.mig} requires the block (from the root, and from elsewhere)`, () => {
      expect(run({ withRelease: true, cwdIsRoot: true })).toBe('REQ=1')
      expect(run({ withRelease: true, cwdIsRoot: false })).toBe('REQ=1')
    })
    it('a tree WITHOUT it leaves the requirement unset, and set -e survives the false test', () => {
      expect(run({ withRelease: false, cwdIsRoot: true })).toBe('REQ=unset')
      expect(run({ withRelease: false, cwdIsRoot: false })).toBe('REQ=unset')
    })
    it(`a hand-set ${b.req}=1 still holds on a tree without the release`, () => {
      expect(run({ withRelease: false, preset: '1', cwdIsRoot: true })).toBe('REQ=1')
    })
  })
})

describe('block S — the pantry route contract it smokes', () => {
  const id = '22222222-2222-4222-8222-222222222222'
  it('every pantry path it calls is one pantryRoutes.js answers (POST /api/pantry/uses is F\'s literal)', () => {
    expect(parsePantryRoute('/api/pantry')).toEqual({ route: 'list' })
    expect(parsePantryRoute('/api/pantry/items')).toEqual({ route: 'items' })
    expect(parsePantryRoute(`/api/pantry/items/${id}`)).toEqual({ route: 'item', id })
    expect(parsePantryRoute(`/api/pantry/uses/${id}/undo`)).toEqual({ route: 'undo', id })
    for (const p of ['"$PN_BASE/api/pantry"', '"$PN_BASE/api/pantry?place_id=$PN_PLACE"', '"$PN_BASE/api/pantry/items"',
      '"$PN_BASE/api/pantry/items/$PN_ITEM"', '"$PN_BASE/api/pantry/uses"', '"$PN_BASE/api/pantry/uses/$PN_USE/undo"']) {
      expect(S.text).toContain(p)
    }
  })

  it('S2 replays the very body S1 sent, and expects 200 replayed:true with the same id and one row on the key', () => {
    const s1 = S.text.indexOf('pn_req POST "$PN_BASE/api/pantry/items" "$PN_BODY"')
    const s2 = S.text.indexOf('pn_req POST "$PN_BASE/api/pantry/items" "$PN_BODY"', s1 + 1)
    expect(s1).toBeGreaterThan(0)
    expect(s2).toBeGreaterThan(s1)
    expect(S.text).toContain('"200 true $PN_ITEM 1"')
  })

  it('S4 sends used_up_at "now"; S5 expects absent; S7 expects 404 not_found', () => {
    expect(S.text).toContain(`pn_req PATCH "$PN_BASE/api/pantry/items/$PN_ITEM" '{"used_up_at": "now"}'`)
    expect(S.text).toMatch(/pn_check "s5-unlisted" "\$\(pn_listed "\$PN_ITEM"\)" "absent"/)
    expect(S.text).toContain('"404 not_found" "the same DELETE again"')
  })

  it("S3 reads the row back as stock_kind 'pantry_item', stock_mode 'item'", () => {
    expect(S.text).toContain('"pantry_item|item|$PN_NAME|$PN_PLACE"')
  })

  // Put-Up UX pass R1. S9 is the deployed stack's proof that Went bad may be a COUNT: a Lambda from before the
  // release answers S9a with 400. What can rot silently: the body turned back into all_remaining (which every Lambda
  // has always accepted, so the check would pass on an old one), or S9 moved ahead of S8's Undo (the jar would not be
  // at 3 of 3 and the three literals below would be about some other count).
  describe('S9 — Went bad as a count, listed with what is left, undone', () => {
    const at = S.text.indexOf('# ── S9)')
    const S9 = S.text.slice(at, S.text.indexOf('# The place, through its own route'))
    const post = S9.split('\n').find((l) => l.includes('pn_req POST "$PN_BASE/api/pantry/uses" ')) ?? ''

    it('runs on S8\'s jar, after S8\'s Undo, before the place is deleted', () => {
      expect(at).toBeGreaterThan(S.text.indexOf('pn_check "s8-undo"'))
      expect(S.text.indexOf('# The place, through its own route')).toBeGreaterThan(at)
      expect(S.text).toContain('"200 3|true -1|$PN_USE"')   // where S8 leaves the jar: 3 of 3
    })

    it('S9a sends a count with fate discarded, never all_remaining; and it is a body the Lambda\'s own validator accepts', () => {
      expect(post).toContain('\\"preservation_log_id\\": \\"$PN_JAR\\", \\"count_used\\": 1, \\"fate\\": \\"discarded\\"}')
      expect(post).toContain('\\"idempotency_key\\": \\"$(pn_uuid)\\"')
      expect(S9).not.toContain('all_remaining')
      expect(validateUse({ idempotency_key: id, preservation_log_id: id, count_used: 1, fate: 'discarded' })).toBeNull()
    })

    it('S9a reads back 2 left and not consumed, and the use row 1|discarded', () => {
      expect(S9).toContain("SELECT coalesce(remaining_count::text,'null')||'|'||(consumed_at IS NOT NULL)::text FROM preservation_log WHERE id = '$PN_JAR'")
      expect(S.text).toContain(`pn_use() { pn_id_ok "$1" && pn_row "SELECT count_used||'|'||coalesce(fate,'null') FROM pantry_use WHERE id = '$1'" || echo "bad-id"; }`)
      expect(S9).toContain('$(pn_use "$PN_BAD")" "201 2|false 1|discarded"')
    })

    it('S9b reads the jar back from GET /api/pantry?place_id= with count_left 2', () => {
      const get = S9.indexOf('pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"')
      expect(get).toBeGreaterThan(S9.indexOf('pn_check "s9-went-bad-part"'))
      expect(S9.indexOf('pn_check "s9-listed"')).toBeGreaterThan(get)
      expect(S9).toContain('"\\(.stock_kind)|\\(.stock_mode)|\\(.count_left)"')
      expect(S9).toContain('"200 put_up|counted|2"')
    })

    it('S9c undoes THAT use and reads back 3 left, delta_at moved, and the reversing row −1|discarded|<the use>', () => {
      expect(S9).toContain('pn_req POST "$PN_BASE/api/pantry/uses/$PN_BAD/undo" "{\\"idempotency_key\\": \\"$(pn_uuid)\\"}"')
      expect(S9).toContain("SELECT count_used||'|'||coalesce(fate,'null')||'|'||reverses_use_id FROM pantry_use WHERE reverses_use_id = '$PN_BAD'")
      expect(S9).toContain('"200 3|true -1|discarded|$PN_BAD"')
    })

    it('its rows hang off the block\'s jar, which pantry_sweep takes with its uses: no sweep change', () => {
      const sweep = sweepOf(S.text, 'pantry_sweep')
      expect(sweep).toContain("WHERE notes LIKE 'smoke-test-pantry-%' OR storage_location_id IN (SELECT id FROM pn_s)")
      expect(sweep).toContain('DELETE FROM pantry_use WHERE preservation_log_id IN (SELECT id FROM pn_j)')
      expect(S9).not.toMatch(/pn_req POST "\$PN_BASE\/api\/(preservation|pantry\/items)"/)   // S9 creates no stock of its own
    })
  })
})

describe('block T — recipes', () => {
  it('expects exactly the built-in count recipeRules.js (and 0a) carries, and names Sambal as one of them', () => {
    expect(RECIPE_BUILTIN_TYPES).toHaveLength(16)
    expect(RECIPE_BUILTIN_TYPES.map((t) => t.label)).toContain('Sambal & chili relish')
    expect(T.text).toContain('RC_SAMBAL="Sambal & chili relish"')
    expect(T.text).toContain(`"${RECIPE_BUILTIN_TYPES.length}|true"`)
  })

  it('every recipe path it calls is one recipeRoutes.js answers', () => {
    const id = '55555555-5555-4555-8555-555555555555'
    expect(parseRecipeRoute('/api/recipes/types')).toEqual({ kind: 'types' })
    expect(parseRecipeRoute('/api/recipes')).toEqual({ kind: 'collection' })
    expect(parseRecipeRoute(`/api/recipes/${id}`)).toEqual({ kind: 'recipe', id })
    for (const p of ['"$RC_BASE/api/recipes/types"', '"$RC_BASE/api/recipes"', '"$RC_BASE/api/recipes/$RC_ID"']) {
      expect(T.text).toContain(p)
    }
  })

  it('T2 creates with a key, one line, a keeps line and the built-in type it read', () => {
    const post = T.text.split('\n').find((l) => l.includes('rc_req POST "$RC_BASE/api/recipes"'))
    expect(post).toBeDefined()
    for (const s of ['\\"idempotency_key\\": \\"$(rc_uuid)\\"', '\\"recipe_type_id\\": \\"$RC_TYPE\\"',
      '\\"keeps\\": {\\"n\\": 2, \\"unit\\": \\"month\\", \\"storage_kind\\": \\"fridge\\"}', '\\"lines\\": [{']) {
      expect(post).toContain(s)
    }
  })

  it('T3 looks for a pH-named key ANYWHERE in the detail body and expects none (V4 "pH")', () => {
    expect(T.text).toContain(`rc_check "t3-no-ph-field" "$(rc_jq '[.. | objects | keys[] | select(test("(^|_)ph(_|$)"; "i"))] | unique')" "[]"`)
  })

  it('T5 reads the deleted recipe back 404', () => {
    expect(T.text).toMatch(/rc_check "t5-gone" "\$RC_CODE \$\(rc_jq '\.code \/\/ "-"'\)" "404 not_found"/)
  })

  // Put-Up UX pass R1. Block P's P1b writes a smoke-test-recipe row too. While recipes_sweep and its flag were defined
  // in THIS block, a run that died between P1b and here left cleanup() calling a function bash had not reached yet
  // (so the recipe stayed on staging), and this block's own initialisation then lowered the flag P1b had raised. Both
  // now sit above block P. What the sweep deletes is pinned by the block's sweep tests above, unchanged.
  describe('recipes_sweep and its flag are defined above block P, once; this block does not lower a raised flag', () => {
    const P_START = SMOKE.indexOf('# ── P) Put-Up 1b + Ferment')
    const def = SMOKE.indexOf('\nrecipes_sweep() {\n')
    const init = SMOKE.indexOf('\nRECIPES_DIRTY=false\n')
    const tSweep = T.start + T.text.indexOf('if recipes_sweep; then')

    it('one definition and one initialisation in the whole script: the flag directly above its sweep, both before block P', () => {
      expect(P_START).toBeGreaterThan(0)
      expect(SMOKE.match(/^recipes_sweep\(\) \{$/gm)).toHaveLength(1)
      expect(SMOKE.match(/^RECIPES_DIRTY=false$/gm)).toHaveLength(1)
      expect(init).toBeGreaterThan(0)
      expect(def).toBe(init + '\nRECIPES_DIRTY=false'.length)
      expect(def).toBeLessThan(P_START)
    })

    it('block T neither defines the sweep nor initialises the flag: it raises it at T2 and lowers it only after its own sweep', () => {
      expect(T.text).not.toContain('recipes_sweep() {')
      const sweepAt = T.text.indexOf('if recipes_sweep; then')
      expect(sweepAt).toBeGreaterThan(0)
      expect(T.text.match(/RECIPES_DIRTY=false/g)).toHaveLength(1)
      expect(T.text.indexOf('RECIPES_DIRTY=false')).toBeGreaterThan(sweepAt)
      expect(T.text.indexOf('RECIPES_DIRTY=true')).toBeGreaterThan(0)
      expect(T.text.indexOf('RECIPES_DIRTY=true')).toBeLessThan(sweepAt)
    })

    it('nothing between P1b raising the flag and block T\'s own sweep lowers it, so cleanup() still sees it raised', () => {
      const raised = SMOKE.indexOf('RECIPES_DIRTY=true', P_START)
      expect(raised).toBeGreaterThan(P_START)
      expect(raised).toBeLessThan(T.start)   // P1b's, not T2's
      expect(SMOKE.slice(raised, tSweep)).not.toMatch(/RECIPES_DIRTY=false/)
      expect(CLEANUP).toMatch(/if \[\[ "\$\{RECIPES_DIRTY:-false\}" == "true" \]\]; then\s+recipes_sweep/)
    })
  })
})
