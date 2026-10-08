// Put-Up R2a (lane S) — static guard on what the staging smoke gained: block S's S10 to S19, block P's P11,
// block T's T3b; and on what it must NOT have touched: block N.
//
// WHY A FILE-READING TEST. These blocks run only inside deploy-staging.yml (and the promote's staging smoke),
// against the staging Lambdas. Nothing else executes them, so the ways they can rot are silent. This file reads the
// script and holds four things:
//   1. BLOCK N IS BYTE-IDENTICAL. Cached bundles still post the "Log a put-up" form's shape for as long as one is
//      cached, and block N is the deployed stack's only proof that shape still lands. Its text is fingerprinted.
//   2. EVERY BODY THE NEW STEPS SEND IS ONE THE LAMBDA'S OWN VALIDATOR ACCEPTS. Each JSON body is cut out of the
//      shell text and handed to the real validator (the create's, the jar PATCH's, the Move's, the use's, the
//      place's, from-jars', the recipe PATCH's). A key the route does not take, or a value outside its vocabulary,
//      reds here instead of on staging at ship time.
//   3. EVERY EXPECTED STRING THAT RESTS ON A SERVER FACT IS BOUND TO THAT FACT: the engine's figures the dates are
//      computed from, the two refusal codes, the gram factor.
//   4. THE STEPS' SHAPE: eight functions, one loop, ONE token mint that is a plain capture (scripts/
//      test_smoke_mint_log.py holds the number of call sites in the script), S17 last, every row inside
//      pantry_sweep's prefix, no photo anywhere.
//
// The tags themselves are listed in stagingSmokePantryRecipes.static.test.js (S, T) and stagingSmokeFerment.static.
// test.js (P), beside their blocks' other tags. MUTATION: delete one new tag from the script → that file's
// "asserts <tag>" row reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { validateCreate, JAR_TEXTURES, JAR_TEXTURE_METHODS } from '../../lambda/preservation/jarRules.js'
import { validateJarPatch, validateMove } from '../../lambda/preservation/jarRoutes.js'
import { validateUse } from '../../lambda/preservation/pantryUses.js'
import { validateItemCreate, validateItemPatch, ITEM_CREATE_KEYS, ITEM_PATCH_KEYS } from '../../lambda/preservation/pantryItems.js'
import { validateFromJars } from '../../lambda/preservation/batchBuilder.js'
import { validateRecipePatch } from '../../lambda/preservation/recipeRules.js'
import { resolveJarUseBy, shelfLifeMonths } from '../../lambda/preservation/shelfLife.js'
import { MASS_G } from '../../lambda/preservation/kitchenBatch.js'
import { VALID_SOURCE_KINDS } from '../../lambda/preservation/provenance.js'

const { validateUpdate: validatePlaceUpdate, placeHasDatedJars, placeInUse } = await import('../../lambda/storage-location/index.js')

const SMOKE = readFileSync(resolve(process.cwd(), 'tests/smoke/run-smoke.sh'), 'utf8')
const blockAt = (heading) => {
  const start = SMOKE.indexOf(heading)
  return start < 0 ? '' : SMOKE.slice(start, SMOKE.indexOf('\n# ── ', start + 1))
}
const N = blockAt('# ── N) Put-Up: a place and a jar')
const P = blockAt('# ── P) Put-Up 1b + Ferment')
const S = blockAt('# ── S) Pantry (B′ release 2)')
const T = blockAt('# ── T) Recipes (B′ release 4)')

// The R2a section of block S: from its heading comment to the end of the loop that runs it.
const R2A_START = S.indexOf('# The place, through its own route')
const R2A = S.slice(R2A_START, S.indexOf('\n    fi\n    if pantry_sweep; then'))
const STEPS = ['pn_s10_door', 'pn_s11_dated', 'pn_s12_rekind', 'pn_s14_move', 'pn_s16_all_remaining', 'pn_s18_source',
  'pn_s19_as_is', 'pn_s17_place_delete']
// One step's body: from its definition to the closing brace at the step's own indent.
const stepText = (name) => {
  const at = R2A.indexOf(`      ${name}() {\n`)
  return at < 0 ? '' : R2A.slice(at, R2A.indexOf('\n      }\n', at))
}

// ── cutting a JSON body out of the shell text ──────────────────────────────────────────────────────────────────
const UUID = '11111111-1111-4111-8111-111111111111'
const DAY = '2026-10-02'
const fill = (text) => text
  .replace(/\$\((pn|fe|rc)_uuid\)|\$key\b|\$FE_FJ_KEY\b/g, UUID)
  .replace(/\$(PN_PLACE|PN_JAR|PN_DATED|PN_DOOR|FE_J11|RC_ID)\b/g, UUID)
  .replace(/\$(PN_DAY|FE_DAY|PN_DATED_BY)\b/g, DAY)
  .replace(/\$PN_TAG\b/g, 'smoke-test-pantry-RUN')
  .replace(/\$FE_TAG\b/g, 'smoke-test-ferment-RUN')
  .replace(/\$RC_TAG\b/g, 'smoke-test-recipe-RUN')
// A shell line's JSON body: the last argument, either "{\"k\": …}" (escaped, with $VARS) or '{"k": …}' (literal).
const bodyOf = (line) => {
  const dq = line.indexOf('"{\\"')
  if (dq >= 0) return JSON.parse(fill(line.slice(dq + 1, line.lastIndexOf('}"') + 1).replace(/\\"/g, '"')))
  const sq = line.indexOf("'{")
  expect(sq, `no JSON body on: ${line.trim().slice(0, 80)}`).toBeGreaterThan(-1)
  return JSON.parse(line.slice(sq + 1, line.lastIndexOf("}'") + 1))
}
// The one line of `text` that contains `needle`.
const lineOf = (text, needle) => {
  const hits = text.split('\n').filter((l) => l.includes(needle))
  expect(hits, `expected exactly one line with: ${needle}`).toHaveLength(1)
  return hits[0]
}
const linesOf = (text, needle) => text.split('\n').filter((l) => l.includes(needle))

describe('block N is byte-identical: the "Log a put-up" form\'s shape is still what it proves', () => {
  it('its text is the text it had before R2a (fingerprint, length, line count)', () => {
    // Measured at the R2a base (a3e00646) and at 1e24f61c, where it is the same. If this reds, block N was edited:
    // put it back. The form is deleted in R2b; cached bundles keep posting its shape after that.
    expect(N.length).toBe(14080)
    expect(N.split('\n')).toHaveLength(218)
    expect(createHash('sha256').update(N).digest('hex')).toBe('4e0f38f36eb05de37cdc7cc8fffbc47e34c6558e8a645ca4f426bf529e484ba5')
  })

  it('and, readably: its heading, its ten tags, and the form-shaped create (no key, no label)', () => {
    expect(SMOKE.indexOf('# ── N) Put-Up: a place and a jar, write → read-back (Put-Up release 1a; L-108)')).toBeGreaterThan(0)
    expect(N.match(/✅ PASS \[[^\]]+\]/g)).toEqual([
      '✅ PASS [crud:POST /storage-locations (smoke place)]', '✅ PASS [crud:POST /preservation (smoke jar)]',
      '✅ PASS [write:putup-dates-readback]', '✅ PASS [write:putup-echo-dates-unchanged]', '✅ PASS [write:putup-count-delta]',
      '✅ PASS [write:putup-mark-used]', '✅ PASS [write:putup-mark-used-again]', '✅ PASS [write:putup-count-below-used-refused]',
      '✅ PASS [delete:putup-jar-gone-from-list]', '✅ PASS [delete:putup-place-gone-from-list]',
    ])
    const create = lineOf(N, '\\"crop_type_slug\\": \\"tomato\\"')
    expect(Object.keys(bodyOf(create.replace('$PU_DAY', DAY).replace('$PU_PLACE_ID', UUID).replace('$TEST_RUN_ID', 'RUN')))).toEqual([
      'crop_type_slug', 'method', 'quantity_value', 'quantity_unit', 'package_count', 'preserved_at', 'preserved_at_approx',
      'source_kind', 'storage_location_id', 'notes',
    ])
  })

  it('it removes its jar before its place, so the new in-use refusal never meets it', () => {
    const jar = N.indexOf('# N6) the jar: soft-deleted')
    const place = N.indexOf('# N6) the place, after its jar: soft-deleted')
    expect(jar).toBeGreaterThan(0)
    expect(place).toBeGreaterThan(jar)
  })
})

describe('block S, R2a: eight steps, one loop, one mint', () => {
  it('the section sits after S9 and before the sweep, and every step is defined exactly once', () => {
    expect(R2A_START).toBeGreaterThan(S.indexOf('pn_check "s9-undo"'))
    expect(R2A.length).toBeGreaterThan(2000)
    for (const name of STEPS) {
      expect(R2A.split(`      ${name}() {\n`).length - 1, name).toBe(1)
      expect(stepText(name).length, name).toBeGreaterThan(100)
    }
    // No step function the loop does not run.
    expect((R2A.match(/^ {6}pn_s\d+_\w+\(\) \{$/gm) ?? []).map((l) => l.trim().replace('() {', ''))).toEqual(STEPS)
  })

  it('the loop runs them in this order, S17 (the place\'s delete) last, each on a fresh token', () => {
    const loop = R2A.slice(R2A.indexOf('      for PN_STEP in '))
    expect(loop.split('\n').slice(0, 5).map((l) => l.trim())).toEqual([
      `for PN_STEP in ${STEPS.join(' ')}; do`,
      'echo "── pantry (R2a) step ${PN_STEP#pn_} ──"',
      'CLERK_JWT=$(mint_session_token)',
      '"$PN_STEP"',
      'done',
    ])
  })

  it('the section has ONE mint, the loop\'s plain capture: no step mints for itself', () => {
    // scripts/test_smoke_mint_log.py counts the script's call sites (63) and requires each to be VAR=$(mint_session_token).
    // The loop's capture took the place of the one that used to precede this block's closing place DELETE.
    const mints = R2A.split('\n').filter((l) => l.includes('mint_session_token') && !l.trim().startsWith('#'))
    expect(mints.map((l) => l.trim())).toEqual(['CLERK_JWT=$(mint_session_token)'])
    for (const name of STEPS) expect(stepText(name), name).not.toContain('mint_session_token')
  })

  it('no step can end the script under set -e: a missing prerequisite is a FAIL and a return 0, never a bare test', () => {
    for (const name of ['pn_s12_rekind', 'pn_s14_move', 'pn_s16_all_remaining', 'pn_s18_source']) {
      const text = stepText(name)
      expect(text, name).toMatch(/if ! pn_id_ok "\$\{?PN_\w+(:-)?\}?"; then\n\s+pn_fail "[^"]+" "[^"]+"\n\s+return 0\n\s+fi/)
    }
    // `[[ … ]] && …` as a statement returns 1 when the test is false, which `set -e` treats as a failure at the end
    // of a function. The steps use if / fi throughout.
    for (const name of STEPS) expect(stepText(name), name).not.toMatch(/^\s*(\[\[[^\n]*\]\]|pn_id_ok "[^"]*") (&&|\|\|) /m)
  })

  it('every row a step writes carries the block\'s tag, so pantry_sweep takes it; renames stay inside its prefix', () => {
    const made = [...R2A.matchAll(/\\"(label|name|notes|source_label)\\": \\"([^"\\]*)\\"/g)].map((m) => m[2])
    expect(made.length).toBeGreaterThanOrEqual(14)
    for (const v of made) expect(v.startsWith('$PN_TAG'), v).toBe(true)
    expect(S).toContain('PN_TAG="smoke-test-pantry-$TEST_RUN_ID"')
    expect(S).toContain("CREATE TEMP TABLE pn_s ON COMMIT DROP AS SELECT id FROM storage_location WHERE label LIKE 'smoke-test-pantry-%';")
    // The workflow's own sweep keys on smoke-test-place- (block N's); nothing here may wander into another sweep's reach.
    expect(R2A).not.toMatch(/smoke-test-(place|putup|ferment|recipe)-/)
  })

  it('no smoke jar or item carries a photo', () => {
    // A photo needs an upload, and the workflow sweep's FK order assumes none. Comment lines may name the key.
    const code = S.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code.length).toBeGreaterThan(5000)
    expect(code).not.toContain('photo_id')
  })
})

// The tag lists in the two older static files accept a tag from pn_check, pn_pass OR pn_fail. Several steps here
// also name a tag on a missing-prerequisite FAIL path, so a tag whose CHECK was dropped would still be "present"
// there (a mutant that renamed one check's tag survived those lists). The pre-promote pass reads PASS lines by tag:
// each tag must have exactly one check that can print one.
describe('every R2a tag has exactly ONE check that can pass', () => {
  const S_TAGS = ['s10-door-create', 's10-door-replay', 's10-door-dried', 's11-dated-weighed', 's11-listed-weighed',
    's12-place-rename', 's13-rekind-refused', 's13-date-by-hand', 's13-rekind-after', 's14-work-it-out', 's14-move',
    's15-rekind-allowed', 's16-all-remaining', 's16-undo', 's17-delete-refused', 's17-delete-clean',
    's18-jar-source', 's18-jar-source-garden', 's18-jar-source-pair',
    // OPS-SMOKEWRITEGAPS-002: the door jar's two stamps on its replay, before and after a write.
    's10-door-replay-untouched', 's18-door-replay-touched',
    's19-item-create', 's19-item-replay', 's19-item-listed', 's19-item-patch', 's19-item-clear']

  it.each(S_TAGS)('pantry:%s', (tag) => {
    expect(R2A.split(`pn_check "${tag}"`).length - 1).toBe(1)
  })

  it('and the section checks no tag this list does not name', () => {
    expect([...R2A.matchAll(/pn_check "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([...S_TAGS].sort())
    expect([...R2A.matchAll(/pn_(?:fail|pass) "([^"]+)"/g)].map((m) => m[1]).filter((t) => !S_TAGS.includes(t))).toEqual([])
  })

  it.each(['p11-from-jars', 'p11-replay'])('ferment:%s', (tag) => {
    expect(P.split(`fe_check "${tag}"`).length - 1).toBe(1)
  })

  it('recipes:t3b-patch-lines', () => {
    expect(T.split('rc_check "t3b-patch-lines"').length - 1).toBe(1)
  })
})

describe('S10: the door\'s create, as the door sends it', () => {
  const step = stepText('pn_s10_door')
  const door = bodyOf(lineOf(step, 'PN_DOOR_BODY="{'))
  const dried = bodyOf(lineOf(step, '\\"method\\": \\"dehydrate\\"'))
  // The create's own column list, read from the route (its INSERT). A body key that is not a column is stored nowhere:
  // the route has no allowlist and would answer 201.
  const index = readFileSync(resolve(process.cwd(), 'lambda/preservation/index.js'), 'utf8')
  const insert = index.slice(index.indexOf('INSERT INTO preservation_log ('))
  const COLUMNS = insert.slice(insert.indexOf('(') + 1, insert.indexOf(') VALUES')).split(',').map((c) => c.trim())

  it('the create\'s column list was found (so the subset checks below are not vacuous)', () => {
    expect(COLUMNS).toContain('idempotency_key')
    expect(COLUMNS).toContain('source_label')
    expect(COLUMNS.length).toBeGreaterThan(25)
  })

  it('the hot sauce: a size as a TOTAL in qt, where it is from (a kind and a name), Raw and In oil, keyed, with a name', () => {
    expect(validateCreate(door)).toBeNull()
    expect(door).toMatchObject({
      method: 'hot_sauce', package_count: 3, quantity_value: 4.5, quantity_unit: 'qt', source_kind: 'farm_stand',
      source_label: 'smoke-test-pantry-RUN stand', is_raw: true, in_oil: true, preserved_at_precision: 'day',
      preserved_at_approx: false, label: 'smoke-test-pantry-RUN door sauce', idempotency_key: UUID,
    })
    // 3 containers of 1.5 qt: the door stores the TOTAL, never the size of one.
    expect(door.quantity_value).toBe(3 * 1.5)
    expect(Object.keys(door).filter((k) => !COLUMNS.includes(k))).toEqual([])
    expect(door).not.toHaveProperty('photo_id')
    expect(door).not.toHaveProperty('use_by_target')   // a typed date would hide the engine's answer
  })

  it('the read-back names every column the body sets, each in its place, and a NULL in any of them fails the check', () => {
    const check = lineOf(step, 'pn_check "s10-door-create"')
    expect(check).toContain("SELECT label||'|'||method||'|'||quantity_value::numeric(12,2)::text||'|'||quantity_unit||'|'||package_count::text||'|'||remaining_count::text||'|'||source_kind||'|'||source_label||'|'||is_raw::text||'|'||in_oil::text||'|'||preserved_at_precision||'|'||preserved_at_approx::text||'|'||use_by_basis||'|'||coalesce(use_by_target::text,'null')||'|'||crop_type_slug FROM preservation_log WHERE id = '$PN_DOOR'")
    expect(check).toContain('"$PN_TAG door sauce|hot_sauce|4.50|qt|3|3|farm_stand|$PN_TAG stand|true|true|day|false|none|null|tomato"')
  })

  it('"none|null" is Raw and In oil\'s doing: hot sauce has a shelf figure, and Raw or In oil off a freezer has no date', () => {
    expect(resolveJarUseBy({ method: 'hot_sauce', kind: 'pantry' }, DAY).use_by_basis).toBe('table')
    expect(resolveJarUseBy({ method: 'hot_sauce', kind: 'pantry', isRaw: true, inOil: true }, DAY))
      .toEqual({ use_by_target: null, use_by_basis: 'none' })
    expect(S).toContain('"{\\"label\\": \\"$PN_TAG place\\", \\"kind\\": \\"pantry\\"}"')
  })

  it('the replay sends the very body the create sent, and expects 200 replayed, the same id, one row on the key', () => {
    expect(linesOf(step, 'pn_req POST "$PN_BASE/api/preservation" "$PN_DOOR_BODY"')).toHaveLength(2)
    expect(lineOf(step, 'pn_check "s10-door-replay"')).toContain('"200 true $PN_DOOR 1"')
  })

  it('the dried row: How dry? on a dried method, a different where-from kind, no date for a bendy dried food', () => {
    expect(validateCreate(dried)).toBeNull()
    expect(JAR_TEXTURE_METHODS).toContain(dried.method)
    expect(JAR_TEXTURES).toContain(dried.texture)
    expect(dried).toMatchObject({ texture: 'bends', quantity_value: 1, quantity_unit: 'cup', package_count: 2, source_kind: 'u_pick' })
    expect(Object.keys(dried).filter((k) => !COLUMNS.includes(k))).toEqual([])
    expect(resolveJarUseBy({ method: 'dehydrate', kind: 'pantry', texture: 'bends' }, DAY).use_by_basis).toBe('none')
    expect(resolveJarUseBy({ method: 'dehydrate', kind: 'pantry', texture: 'snaps' }, DAY).use_by_basis).toBe('table')
    expect(lineOf(step, 'pn_check "s10-door-dried"')).toContain('"dehydrate|bends|1.00|cup|2|u_pick|$PN_TAG farm|none|null"')
  })

  it('both where-from kinds are ones the server knows', () => {
    expect(VALID_SOURCE_KINDS).toContain(door.source_kind)
    expect(VALID_SOURCE_KINDS).toContain(dried.source_kind)
  })
})

describe('S11 to S15: a dated jar, the rename, the refusal and its two ways out', () => {
  const s11 = stepText('pn_s11_dated')
  const s12 = stepText('pn_s12_rekind')
  const s14 = stepText('pn_s14_move')
  const dated = bodyOf(lineOf(s11, 'pn_req POST "$PN_BASE/api/preservation"'))

  it('S11 creates ONE container in a mass unit with no typed date: the engine dates it, and it is stored as weighed stock', () => {
    expect(validateCreate(dated)).toBeNull()
    expect(dated).toMatchObject({ method: 'hot_sauce', package_count: 1, quantity_value: 1, quantity_unit: 'lb' })
    expect(dated).not.toHaveProperty('use_by_target')
    expect(Object.keys(MASS_G)).toContain(dated.quantity_unit)
  })

  it('the figures its read-back expects are the engine\'s and the route\'s: 12 months on a shelf, 453.59 g to the pound', () => {
    expect(shelfLifeMonths('hot_sauce', 'pantry')).toBe(12)
    expect(resolveJarUseBy({ method: 'hot_sauce', kind: 'pantry' }, DAY)).toEqual({ use_by_target: '2027-10-02', use_by_basis: 'table' })
    expect((1 * MASS_G.lb).toFixed(2)).toBe('453.59')
    expect(s11).toContain(`PN_DATED_BY=$(pn_row "SELECT (DATE '$PN_DAY' + INTERVAL '12 months')::date::text")`)
    expect(lineOf(s11, 'pn_check "s11-dated-weighed"')).toContain('"table|$PN_DATED_BY|453.59"')
    expect(lineOf(s11, 'pn_check "s11-listed-weighed"')).toContain('"200 put_up|weighed|null"')
  })

  it('S8\'s jar and S10\'s two never count toward a refusal: none of them has a worked-out date on a shelf', () => {
    // The refusal's n: 1 in S13 rests on this. A frozen method on a shelf has no figure; neither has a Raw sauce.
    expect(resolveJarUseBy({ method: 'whole_freeze', kind: 'pantry' }, DAY).use_by_basis).toBe('none')
    expect(S).toContain('\\"method\\": \\"whole_freeze\\", \\"quantity_value\\": 1, \\"quantity_unit\\": \\"jar\\", \\"package_count\\": 3')
  })

  it('S12 is the SHIPPED editor\'s rename: both keys, the kind the place already has', () => {
    const put = lineOf(s12, '\\"kind\\": \\"pantry\\"')
    expect(put).toContain('pn_req PUT "$PN_PLACE_URL"')
    const body = bodyOf(put)
    expect(Object.keys(body)).toEqual(['label', 'kind'])
    expect(validatePlaceUpdate(body)).toBeNull()
    expect(lineOf(s12, 'pn_check "s12-place-rename"')).toContain('"200 $PN_TAG place-b|pantry"')
    // The place was created as a pantry shelf, so 'pantry' is "unchanged".
    expect(S).toContain('"{\\"label\\": \\"$PN_TAG place\\", \\"kind\\": \\"pantry\\"}"')
  })

  it('S13 sends a new name BESIDE the new kind, and reads back that neither was written, nor the jar\'s date', () => {
    const put = lineOf(s12, '\\"label\\": \\"$PN_TAG place-c\\"')
    const body = bodyOf(put)
    expect(body).toEqual({ label: 'smoke-test-pantry-RUN place-c', kind: 'fridge' })
    expect(validatePlaceUpdate(body)).toBeNull()
    const check = lineOf(s12, 'pn_check "s13-rekind-refused"')
    expect(check).toContain('"$PN_CODE $(pn_refusal) $(pn_place) $(pn_row "$PN_USE_BY_SQL \'$PN_DATED\'")"')
    expect(check).toContain('"409 place_has_dated_jars|1|true $PN_TAG place-b|pantry table|$PN_DATED_BY"')
    expect(s12.indexOf('pn_check "s13-rekind-refused"')).toBeGreaterThan(s12.indexOf('pn_check "s12-place-rename"'))
  })

  it('the code, the n and the "one sentence in both text fields" it expects are what the Lambda answers', () => {
    expect(R2A).toContain(`pn_refusal() { pn_jq '"\\(.code)|\\(.n)|\\(.message == .error and (.message | type) == "string")"'; }`)
    const one = placeHasDatedJars(1)
    expect([one.code, one.n, one.message === one.error && typeof one.message === 'string']).toEqual(['place_has_dated_jars', 1, true])
    const stock = placeInUse(4)
    expect([stock.code, stock.n, stock.message === stock.error && typeof stock.message === 'string']).toEqual(['place_in_use', 4, true])
    expect(R2A).toContain(`pn_place() { pn_row "SELECT label||'|'||kind FROM storage_location WHERE id = '$PN_PLACE'"; }`)
  })

  it('the way out the sentence names: the SAME date set by hand → basis typed → the SAME re-kind answers 200', () => {
    const patch = lineOf(s12, 'pn_req PATCH "$PN_BASE/api/preservation/$PN_DATED"')
    expect(patch).toContain('"{\\"discard_by\\": \\"$PN_DATED_BY\\"}"')
    expect(validateJarPatch(bodyOf(patch))).toBeNull()
    expect(lineOf(s12, 'pn_check "s13-date-by-hand"')).toContain('"200 typed|$PN_DATED_BY"')
    const again = lineOf(s12, `pn_req PUT "$PN_PLACE_URL" '{"kind": "fridge"}'`)
    expect(bodyOf(again)).toEqual({ kind: 'fridge' })
    expect(lineOf(s12, 'pn_check "s13-rekind-after"')).toContain('"200 $PN_TAG place-b|fridge"')
    const order = ['pn_check "s13-rekind-refused"', 'pn_check "s13-date-by-hand"', 'pn_check "s13-rekind-after"'].map((n) => s12.indexOf(n))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('S14 works the date out again (6 months in a fridge), then /move clears it and stamps the move', () => {
    const clear = lineOf(s14, `'{"discard_by": "clear"}'`)
    expect(validateJarPatch(bodyOf(clear))).toBeNull()
    expect(shelfLifeMonths('hot_sauce', 'fridge')).toBe(6)
    expect(lineOf(s14, 'pn_check "s14-work-it-out"')).toContain(`"200 table|$(pn_row "SELECT (DATE '$PN_DAY' + INTERVAL '6 months')::date::text")"`)
    const move = lineOf(s14, 'pn_req POST "$PN_BASE/api/preservation/$PN_DATED/move"')
    const body = bodyOf(move)
    expect(validateMove(body)).toBeNull()
    expect(body).toEqual({ place: { kind: 'pantry', label: 'smoke-test-pantry-RUN shelf' }, when: { date: DAY, precision: 'day' } })
    // fridge → pantry is a change of kind, which is what clears a worked-out date.
    expect(body.place.kind).not.toBe('fridge')
    expect(lineOf(s14, 'pn_check "s14-move"')).toContain('"200 true|none|null|true|pantry|$PN_TAG shelf"')
    expect(s14.indexOf('pn_check "s14-move"')).toBeGreaterThan(s14.indexOf('pn_check "s14-work-it-out"'))
  })

  it('S15 re-kinds the first place once the dated jar has left it: undated put-ups are still there', () => {
    const put = lineOf(s14, `pn_req PUT "$PN_PLACE_URL" '{"kind": "cold_storage"}'`)
    expect(validatePlaceUpdate(bodyOf(put))).toBeNull()
    expect(lineOf(s14, 'pn_check "s15-rekind-allowed"')).toContain('"200 $PN_TAG place-b|cold_storage"')
    expect(s14.indexOf('pn_check "s15-rekind-allowed"')).toBeGreaterThan(s14.indexOf('pn_check "s14-move"'))
  })
})

describe('S16: Went bad, all that is left, and its Undo', () => {
  const s16 = stepText('pn_s16_all_remaining')

  it('sends all_remaining with fate discarded (never a count), a body the Lambda\'s own validator accepts', () => {
    const post = lineOf(s16, 'pn_req POST "$PN_BASE/api/pantry/uses" ')
    const body = bodyOf(post)
    expect(body).toEqual({ idempotency_key: UUID, preservation_log_id: UUID, all_remaining: true, fate: 'discarded' })
    expect(validateUse(body)).toBeNull()
    expect(post).toContain('\\"preservation_log_id\\": \\"$PN_JAR\\"')
  })

  it('reads back 0 left and consumed, the use row 3|discarded, and the jar gone from the list', () => {
    expect(lineOf(s16, 'pn_check "s16-all-remaining"')).toContain('"201 0|true 3|discarded absent"')
    expect(S).toContain('"200 3|true -1|discarded|$PN_BAD"')   // where S9 leaves S8's jar: 3 of 3
  })

  it('the Undo is of THAT use, and reads back 3 left, not consumed, the reversing row, and the jar listed again', () => {
    expect(s16).toContain('pn_req POST "$PN_BASE/api/pantry/uses/$use/undo" "{\\"idempotency_key\\": \\"$(pn_uuid)\\"}"')
    expect(lineOf(s16, 'pn_check "s16-undo"')).toContain('"200 3|false -3|discarded|$use put_up|counted|3"')
  })
})

describe('S18: where it\'s from, corrected in Edit', () => {
  const s18 = stepText('pn_s18_source')
  const patches = linesOf(s18, 'pn_req PATCH "$PN_BASE/api/preservation/$PN_DOOR"')

  it('three PATCHes on S10\'s jar: a store with a name, our garden with null, and one of the pair alone', () => {
    expect(patches).toHaveLength(3)
    expect(patches.map(bodyOf)).toEqual([
      { source_kind: 'store', source_label: 'smoke-test-pantry-RUN market' },
      { source_kind: 'own_garden', source_label: null },
      { source_kind: 'store' },
    ])
  })

  it('the first two are bodies the jar PATCH takes; the third is refused by its pair rule', () => {
    expect(validateJarPatch(bodyOf(patches[0]))).toBeNull()
    expect(validateJarPatch(bodyOf(patches[1]))).toBeNull()
    expect(validateJarPatch(bodyOf(patches[2]))).toBe('source_kind and source_label are edited together')
  })

  it('each is read back from the row: stored, then the name cleared by our garden, then unchanged by the refusal', () => {
    expect(lineOf(s18, 'pn_check "s18-jar-source"')).toContain('"200 store|$PN_TAG market store|$PN_TAG market"')
    expect(lineOf(s18, 'pn_check "s18-jar-source-garden"')).toContain('"200 own_garden|null"')
    expect(lineOf(s18, 'pn_check "s18-jar-source-pair"')).toContain('"400 own_garden|null"')
    expect(s18).toContain(`"SELECT coalesce(source_kind,'null')||'|'||coalesce(source_label,'null') FROM preservation_log WHERE id = '$PN_DOOR'"`)
  })
})

describe('S19: an as-is item\'s amount and where it\'s from (lane M\'s contract 5, as amended)', () => {
  const s19 = stepText('pn_s19_as_is')
  const FOUR = ['quantity_value', 'quantity_unit', 'source_kind', 'source_label']
  const create = bodyOf(lineOf(s19, 'PN_AS_IS_BODY="{'))
  const patches = linesOf(s19, 'pn_req PATCH "$PN_BASE/api/pantry/items/$PN_AS_IS"').map(bodyOf)
  // The item routes take the four keys once lane M's allowlists are in the tree. Until then the validators refuse
  // them by name, so each body is judged whole when they are present and without the four when they are not: the
  // check tightens by itself at the merge, and is never skipped.
  const withFour = FOUR.every((k) => ITEM_CREATE_KEYS.includes(k) && ITEM_PATCH_KEYS.includes(k))
  const judged = (body) => (withFour ? body : Object.fromEntries(Object.entries(body).filter(([k]) => !FOUR.includes(k))))

  it('the create carries today\'s keys plus exactly the four the contract adds, as stored', () => {
    expect(Object.keys(create)).toEqual(['idempotency_key', 'name', 'storage_location_id', 'acquired_at', ...FOUR])
    expect(create).toMatchObject({ quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'smoke-test-pantry-RUN market' })
    expect(typeof create.quantity_value).toBe('number')
    expect(VALID_SOURCE_KINDS).toContain(create.source_kind)
    expect(validateItemCreate(judged(create))).toBeNull()
    for (const k of Object.keys(judged(create))) expect(ITEM_CREATE_KEYS, k).toContain(k)
  })

  it('the PATCHes send each pair whole: both pairs, then null, null on each', () => {
    expect(patches).toEqual([
      { quantity_value: 1, quantity_unit: 'bag', source_kind: 'own_garden', source_label: null },
      { quantity_value: null, quantity_unit: null, source_kind: null, source_label: null },
    ])
    for (const body of patches) {
      expect(Object.keys(body).sort()).toEqual([...FOUR].sort())
      if (withFour) expect(validateItemPatch(body)).toBeNull()
    }
  })

  it('reads the four back from the reply AND the row, replays under the same key, and lists the amount as logged', () => {
    expect(lineOf(s19, 'pn_check "s19-item-create"')).toContain('"2.5|lb|store|$PN_TAG market 2.50|lb|store|$PN_TAG market"')
    expect(linesOf(s19, 'pn_req POST "$PN_BASE/api/pantry/items" "$PN_AS_IS_BODY"')).toHaveLength(2)
    expect(lineOf(s19, 'pn_check "s19-item-replay"')).toContain('"200 true $PN_AS_IS 2.5|lb|store|$PN_TAG market 1"')
    // No count and no grams left, whatever the unit: nothing decrements the amount.
    expect(lineOf(s19, 'pn_check "s19-item-listed"')).toContain('"200 pantry_item|item|2.5|lb|store|$PN_TAG market|$PN_TAG market|false|null|null"')
    expect(lineOf(s19, 'pn_check "s19-item-patch"')).toContain('"200 1|bag|own_garden|null 1.00|bag|own_garden|null"')
    expect(lineOf(s19, 'pn_check "s19-item-clear"')).toContain('"200 null|null|null|null"')
    expect(s19).toContain(`"SELECT coalesce(quantity_value::numeric(12,2)::text,'null')||'|'||coalesce(quantity_unit,'null')||'|'||coalesce(source_kind,'null')||'|'||coalesce(source_label,'null') FROM pantry_item WHERE id = '$PN_AS_IS'"`)
  })
})

describe('S17: the place\'s DELETE — refused while in use, then clean', () => {
  const s17 = stepText('pn_s17_place_delete')

  it('counts what is stored there by its own SQL, and expects that n in the refusal, with deleted_at still null', () => {
    expect(s17).toContain(`held=$(pn_row "SELECT (SELECT count(*) FROM preservation_log WHERE storage_location_id = '$PN_PLACE' AND deleted_at IS NULL AND consumed_at IS NULL AND COALESCE(remaining_count, package_count) > 0) + (SELECT count(*) FROM pantry_item WHERE storage_location_id = '$PN_PLACE' AND deleted_at IS NULL AND used_up_at IS NULL)")`)
    expect(lineOf(s17, 'pn_check "s17-delete-refused"')).toContain('"$PN_CODE $(pn_refusal) $(pn_place_gone)" "409 place_in_use|$held|true false"')
    expect(R2A).toContain(`pn_place_gone() { pn_row "SELECT (deleted_at IS NOT NULL)::text FROM storage_location WHERE id = '$PN_PLACE'"; }`)
  })

  it('an empty place is a FAIL, not a pass: the refusal must have been exercised', () => {
    expect(s17).toMatch(/if \[\[ "\$held" =~ \^\[1-9\]\[0-9\]\*\$ \]\]; then\n\s+pn_check "s17-delete-refused"[^\n]+\n\s+else\n\s+pn_fail "s17-delete-refused"/)
  })

  it('then removes every jar and the item through their own routes, and the same DELETE answers 200, deleted', () => {
    expect(s17).toContain('for id in "${PN_JAR:-}" "$PN_DOOR" "$PN_DRIED" "$PN_DATED"; do')
    expect(s17).toContain('if pn_id_ok "$id"; then pn_req DELETE "$PN_BASE/api/preservation/$id"; fi')
    expect(s17).toContain('if pn_id_ok "$PN_AS_IS"; then pn_req DELETE "$PN_BASE/api/pantry/items/$PN_AS_IS"; fi')
    expect(linesOf(s17, 'pn_req DELETE "$PN_PLACE_URL"')).toHaveLength(2)
    expect(lineOf(s17, 'pn_check "s17-delete-clean"')).toContain('"200 true true"')
    expect(s17.indexOf('pn_check "s17-delete-clean"')).toBeGreaterThan(s17.indexOf('for id in'))
    // The old unconditional DELETE and its WARN are gone: under the refusal it would have answered 409 on every run.
    expect(S).not.toContain('WARN [pantry:place-delete]')
  })
})

describe('P11: a batch made from a jar that already exists (block P)', () => {
  const at = P.indexOf('# ── P11)')
  const P11 = P.slice(at, P.indexOf('if ferm_sweep; then'))

  it('sits after P10 and before block P\'s closing mint, and mints nothing of its own', () => {
    expect(at).toBeGreaterThan(P.indexOf('fe_fail "p10-raw-create"'))
    const mints = P11.split('\n').filter((l) => l.includes('mint_session_token') && !l.trim().startsWith('#'))
    expect(mints.map((l) => l.trim())).toEqual(['CLERK_JWT=$(mint_session_token)'])
    expect(P11.indexOf('CLERK_JWT=$(mint_session_token)')).toBeGreaterThan(P11.indexOf('fe_check "p11-replay"'))
  })

  it('the body is one from-jars accepts: keyed, the block\'s tag in the label, a start, one jar', () => {
    const body = bodyOf(lineOf(P11, 'FE_FJ_BODY="{'))
    expect(validateFromJars(body)).toBeNull()
    expect(body).toEqual({
      idempotency_key: UUID, label: 'smoke-test-ferment-RUN from-jars', started: { date: DAY, precision: 'day' }, kind: 'ferment', jar_ids: [UUID],
    })
    expect(P11).toContain('FE_J11=$(fe_newjar 2 "jar" 3)')
  })

  it('reads the JAR back (its batch closed as put_up, the label sent), then replays the very body: 200, one batch on the key', () => {
    expect(linesOf(P11, 'fe_req POST "$FE_BASE/api/kitchen-batches/from-jars" "$FE_FJ_BODY"')).toHaveLength(2)
    expect(lineOf(P11, 'fe_check "p11-from-jars"')).toContain(`"$FE_CODE $(fe_row "SELECT (b.closed_at IS NOT NULL)::text||'|'||b.outcome||'|'||b.label FROM preservation_log p JOIN kitchen_batch b ON b.id = p.batch_id WHERE p.id = '$FE_J11'")" "201 true|put_up|$FE_TAG from-jars"`)
    expect(lineOf(P11, 'fe_check "p11-replay"')).toContain(`$(fe_row "SELECT count(*) FROM kitchen_batch WHERE idempotency_key = '$FE_FJ_KEY'")" "200 true 1"`)
  })

  it('ferm_sweep takes both: the batch by its label, the jar by its notes or its batch, jars before batches', () => {
    const sweep = P.slice(P.indexOf('ferm_sweep() {'), P.indexOf('\nSQL\n}'))
    expect(sweep).toContain("SELECT id FROM kitchen_batch WHERE label LIKE 'smoke-test-ferment-%'")
    expect(sweep).toContain('batch_id IN (SELECT id FROM fe_b)')
    expect(sweep.indexOf('DELETE FROM preservation_log')).toBeLessThan(sweep.indexOf('DELETE FROM kitchen_batch WHERE'))
  })
})

describe('T3b: PATCH a recipe\'s lines (block T)', () => {
  const at = T.indexOf('# ── T3b)')
  const T3B = T.slice(at, T.indexOf('# ── T4)'))

  it('sits between T3 and T4, on T2\'s token', () => {
    expect(at).toBeGreaterThan(T.indexOf('rc_check "t3-no-ph-field"'))
    expect(T.indexOf('# ── T4)')).toBeGreaterThan(at)
    expect(T3B).not.toMatch(/^\s*CLERK_JWT=\$\(mint_session_token\)/m)
  })

  it('the body is one the recipe PATCH accepts: the whole line list, with what the sheet adds to a line', () => {
    const body = bodyOf(lineOf(T3B, 'rc_req PATCH "$RC_BASE/api/recipes/$RC_ID"'))
    expect(validateRecipePatch(body)).toBeNull()
    expect(body).toEqual({ lines: [{ name: 'smoke-test-recipe-RUN fresno', qty: 500, qty_unit: 'g', at_the_end: true, brand: 'smoke-brand' }] })
  })

  it('reads the line back through GET, and one live line and one soft-deleted through SQL', () => {
    const check = lineOf(T3B, 'rc_check "t3b-patch-lines"')
    expect(check).toContain(`"$RC_PATCH_HTTP $(rc_jq '.recipe | "\\(.lines | length)|\\(.lines[0].name)|\\(.lines[0].at_the_end)|\\(.lines[0].brand)"')`)
    expect(check).toContain('"200 1|$RC_TAG fresno|true|smoke-brand 1|1"')
    expect(T3B.indexOf('RC_PATCH_HTTP="$RC_CODE"')).toBeLessThan(T3B.indexOf('rc_req GET "$RC_BASE/api/recipes/$RC_ID"'))
  })
})
