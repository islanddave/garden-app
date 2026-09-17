// BUG-RAINCOVEREDGATESTATIC-001 — the rain autologger's roof rule, guarded at WRITE TIME.
//
// WHY THIS FILE EXISTS. Until 2026-09-17 the only automated check on `handler.js`'s coverage
// exclusion was a DATA gate: v4-rainbackfill-001 :: post_no_rain_backfilled_onto_a_covered_planting.
// That gate joins an immutable event row to `garden_node.location_id` — the planting's location
// *now* — so it does not assert "the writer obeyed the roof rule", it asserts "no plant that ever
// received rain has since moved indoors". Dave moved 10 tropicals into House/Stable on 2026-09-17 and
// 96 correctly-written rows became "violations" retroactively. The gate is retired as a census (see
// its `retired:` block, and §Rain-Event History Rule in claude-ops/project-rules/gardening.md), and
// this file is the rehomed guard: the invariant is only decidable where the decision is made, which
// is in the writer, at write time.
//
// Measured 2026-09-17 before this file was written: `bool_or(up.covered)` appeared in exactly four
// files — handler.js, and v4-rainbackfill-001's gates.yml / 0b-data.sql / README.md — and in NO test.
// covered-backfill-parity.test.js reads handler.js but asserts on the PLANTINGS query's `cov` lateral
// (~handler.js:1152), a different statement from the rain insert at 1003-1028. So the clause this
// file guards had zero coverage anywhere in the repo.
//
// SEMANTIC, NOT TEXTUAL — same argument as covered-backfill-parity.test.js. A regex that the SQL
// "contains bool_or" proves the predicate is spelled a certain way; it does not prove the predicate
// refuses rain to a plant sitting on a bench inside the Stable. So `roofModelOf` PARSES the exclusion
// out of the writer into a structural model, and `creditsRain` evaluates whatever shape it found.
// Restating the predicate in JS would make this a second implementation free to drift from the first,
// which is worth nothing as a guard. Edit the writer and this test changes with it.
//
// FIXTURES ARE MEASURED. LIVE is the 21 live `public.locations` rows (name, parent, covered) read
// from prod on 2026-09-17. SYNTHETIC covers the arms live data cannot reach — and note that TODAY
// live data reaches none of the recursion: every covered location in prod is covered in its own
// right, so a writer that checked only the direct location would agree with the real one on all 21
// rows. The recursion is load-bearing and untestable from prod alone; that is why the bench fixtures
// are here and why they are not optional.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HANDLER = readFileSync(join(here, 'handler.js'), 'utf8')
const MIGRATION = readFileSync(
  join(here, '..', '..', 'migrations', 'v4-rainbackfill-001', '0b-data.sql'), 'utf8')

// Line comments stripped, same helper and same reason as archived-exclusion.test.js: a clause
// DESCRIBED in prose must not be able to stand in for a clause that executes. This matters more here
// than usual — the rain insert opens with a nine-line `--` header that names `location_id`,
// `deleted_at` and the alias rules, so an unstripped haystack would satisfy several assertions below
// from the comment alone. The `[^:]` guard keeps `https://` intact and the `--` arm requires a
// following space, so a JS decrement is not a comment.
const strip = (src) => src.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')

// Scope to the rain INSERT. A whole-file match would still pass if the exclusion drifted to some
// unrelated statement — the looseness archived-exclusion.test.js was bitten by, and which the
// "ALIASES ARE gn/ct" comment in handler.js exists to document. Uniqueness is asserted rather than
// assumed: a second `insert into event_log` would make this anchor ambiguous and it must say so
// loudly rather than latch onto whichever came first.
//
// `end` differs by substrate: the handler's statement is a template literal that carries no
// backticks of its own (handler.js says so — one would end the string mid-SQL), while the
// migration's is terminated by a semicolon, and both of ITS in-statement semicolons live inside
// `--` comments the stripper has already removed.
function rainInsertOf(src, end, where) {
  const flat = strip(src)
  const hits = [...flat.matchAll(/insert\s+into\s+(?:\w+\.)?event_log\b/gi)]
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 \`insert into event_log\` in ${where}, found ${hits.length} — extractor anchor is ambiguous`)
  }
  const rest = flat.slice(hits[0].index)
  const stop = rest.indexOf(end)
  if (stop < 0) throw new Error(`rain insert in ${where} is not terminated by ${end}`)
  return rest.slice(0, stop)
}

// The exclusion, as ONE anchored shape. Every capture is a thing a regression could change:
//   1 polarity   2 cte name   3 cte body   4 aggregate fn   5 agg alias   6 agg column   7 fallback
// A miss throws. It must never degrade to "no exclusion found, nothing to assert, green".
const EXCLUSION = /(\bnot\b\s+)?coalesce\s*\(\s*\(\s*with\s+recursive\s+(\w+)\s+as\s*\((.+?)\)\s*select\s+(\w+)\s*\(\s*(\w+)\.(\w+)\s*\)\s*from\s+\w+\s*\)\s*,\s*(true|false|null)\s*\)/

const LITERAL = { true: true, false: false, null: null }

function roofModelOf(sql) {
  const flat = strip(sql).replace(/\s+/g, ' ').toLowerCase()
  const m = flat.match(EXCLUSION)
  if (!m) throw new Error('no recursive coverage exclusion found — this guard has gone blind')
  const [, not, cte, body, agg, aggAlias, aggCol, fallback] = m

  // The CTE's two arms. The seed decides which location the climb starts from; the recursive arm is
  // the climb itself. Splitting on UNION ALL rather than regexing the whole body means a DELETED
  // recursive arm produces a model with `climbs: false` — which the evaluator then honours — instead
  // of a parse failure that could be mistaken for an unrelated breakage.
  const arms = body.split(/\bunion\s+all\b/)
  const seed = arms[0]
  const climb = arms.slice(1).join(' ')

  const anchor = seed.match(/where\s+l\.id\s*=\s*(\w+)\.(\w+)\b/)
  if (!anchor) throw new Error('the recursive seed is not anchored to a planting column')

  // Optional schema qualifier: the handler writes `locations`, the migration writes
  // `public.locations`. Ignoring the difference is what lets the two writers be compared as one
  // shape; NOT ignoring it reported the migration as having no climb at all.
  const LOCATIONS = '(?:\\w+\\.)?locations'

  // WHICH ROW THE CLIMB STARTS FROM, derived rather than hardcoded. The alias is read off whatever
  // this statement binds `garden_node` to — `gn` in the handler, `p` in the migration — so the
  // assertion is "the climb starts at the PLANTING's location", not "the climb says gn". Added after
  // a mutation survived: swapping `gn.location_id` for `ct.location_id` climbs from the CONTAINER
  // instead, and since container is LEFT JOINed that seeds NOTHING for a project-less planting, so
  // the aggregate is NULL, the COALESCE says false, and rain is credited under every roof.
  const planting = [...flat.matchAll(/(?:from|join)\s+(?:\w+\.)?garden_node\s+(\w+)\b/g)].map((b) => b[1])
  if (!planting.length) throw new Error('the statement does not bind garden_node to an alias')

  return {
    negated: Boolean(not),
    cte,
    seedAlias: anchor[1],                       // `gn` in the handler, `p` in the migration
    seedStartsAtPlanting: planting.includes(anchor[1]),
    seedColumn: anchor[2],                      // must be location_id
    seedFromLocations: new RegExp(`from\\s+${LOCATIONS}\\s+l\\b`).test(seed),
    seedSkipsDeleted: /l\.deleted_at\s+is\s+null/.test(seed),
    seedSelectsCovered: /\bl\.covered\b/.test(seed),
    // The climb is only real if it joins locations back to the CTE's own parent_id. A recursive arm
    // that re-seeds from the planting, or joins on something else, is not a climb.
    climbs: new RegExp(`join\\s+${LOCATIONS}\\s+l\\s+on\\s+l\\.id\\s*=\\s*${cte}\\.parent_id\\b`).test(climb),
    climbSkipsDeleted: /l\.deleted_at\s+is\s+null/.test(climb),
    agg,
    aggregatesOverCte: aggAlias === cte,
    aggColumn: aggCol,
    fallback: LITERAL[fallback],
  }
}

// SQL aggregate semantics, not JS: NULLs are skipped, and an aggregate over an empty set is NULL
// (which is what the COALESCE is there to catch). bool_and is modelled too, so swapping the
// aggregate produces a WRONG ANSWER the assertions can catch rather than a parse error that only
// proves something moved.
const AGGS = {
  bool_or: (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.some(Boolean) : null },
  bool_and: (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.every(Boolean) : null },
  every: (xs) => AGGS.bool_and(xs),
}

// Evaluate the model against a location tree. Returns TRUE when the WHERE clause admits the row —
// i.e. when the writer WOULD credit rain to a planting standing at `startLoc`.
function creditsRain(model, tree, startLoc) {
  const flags = []
  const seedRow = startLoc == null ? undefined : tree[startLoc]
  if (seedRow && !(model.seedSkipsDeleted && seedRow.deleted)) {
    flags.push(seedRow[model.aggColumn])
    if (model.climbs) {
      let at = seedRow.parent
      for (let hops = 0; at && hops < 50; hops += 1) {
        const row = tree[at]
        if (!row) break
        if (model.climbSkipsDeleted && row.deleted) break   // the join filters it; the chain ends here
        flags.push(row[model.aggColumn])
        at = row.parent
      }
    }
  }
  const agg = AGGS[model.agg]
  if (!agg) throw new Error(`unmodelled aggregate ${model.agg}() — the guard cannot evaluate it`)
  const value = agg(flags)
  const coalesced = value === null ? model.fallback : value
  return model.negated ? !coalesced : Boolean(coalesced)
}

const L = (parent, covered) => ({ parent, covered })

// Live prod `public.locations`, 21 rows, read 2026-09-17. Three levels deep: Shelf N -> Indoor Rack
// -> Stable.
const LIVE = {
  'Deck': L(null, false), 'Drive': L(null, false), 'House': L(null, true),
  'Pasture': L(null, false), 'Stable': L(null, true), 'Yard': L(null, false),
  'Drive-Shade': L('Drive', false), 'Trough': L('Drive', false),
  'Indoor Rack': L('Stable', true),
  'Shelf 1': L('Indoor Rack', true), 'Shelf 2': L('Indoor Rack', true),
  'Shelf 3': L('Indoor Rack', true), 'Shelf 4': L('Indoor Rack', true),
  'Shelf 5': L('Indoor Rack', true),
  'Bag Area': L('Pasture', false), 'In-Ground': L('Pasture', false),
  'Legacy Pasture In-Ground': L('Pasture', false), 'Pasture-Shade': L('Pasture', false),
  'Yard - Back': L('Yard', false), 'Yard - Front': L('Yard', false),
  'Yard - Stable': L('Yard', false),
}

const TREE = {
  ...LIVE,
  // THE RECURSION CASES. Nothing in prod exercises these: every covered live location carries
  // covered=true itself, so a direct-only predicate scores 21/21 on real data. A bench inside the
  // Stable is the shape the recursion exists for.
  'Stable Bench': L('Stable', false),
  'Bench Tray': L('Stable Bench', false),
  // Unknown coverage. `covered` is nullable and NULL means "unknown", never "open to the sky" —
  // BUG-NOLOCOUTDOOR-001. The COALESCE resolves unknown to `not false` = rain IS credited.
  'Low Tunnel Bed': L('Yard', null),
  // A soft-deleted rung. `l.deleted_at is null` on the recursive join ends the climb there, so the
  // roof two levels up is never seen.
  'Retired Shelf': { parent: 'Stable', covered: true, deleted: true },
  'Orphan Bench': L('Retired Shelf', false),
}

const HANDLER_MODEL = roofModelOf(rainInsertOf(HANDLER, '`', 'handler.js'))

describe('BUG-RAINCOVEREDGATESTATIC-001 — rain autologger roof rule, at write time', () => {
  it('is reading the real rain INSERT and a real exclusion (vacuity floor)', () => {
    // Without this, a moved anchor or a renamed column would collapse the haystack and the
    // assertions below could pass on nothing. Named causes, not a bare failure.
    const stmt = rainInsertOf(HANDLER, '`', 'handler.js')
    expect(strip(HANDLER).length, 'stripped handler.js is implausibly small').toBeGreaterThan(5000)
    expect(stmt.length, 'rain insert extracted as a stub').toBeGreaterThan(400)
    expect(stmt, 'extracted statement is not the rain insert').toMatch(/'rain'/)
    expect(stmt, 'exclusion survived only as a comment').toMatch(/coalesce/i)
  })

  it('the exclusion is a NEGATED recursive bool_or over locations.covered, defaulting to false', () => {
    // Every field here is read from handler.js. These are the four things a regression changes:
    // polarity, the climb, the aggregate, and the unknown-coverage default.
    expect(HANDLER_MODEL.negated, 'the exclusion is not negated — this CREDITS rain only under a roof').toBe(true)
    expect(HANDLER_MODEL.climbs, 'the recursive arm no longer climbs parent_id — only the direct location is checked').toBe(true)
    expect(HANDLER_MODEL.agg).toBe('bool_or')
    expect(HANDLER_MODEL.aggColumn).toBe('covered')
    expect(HANDLER_MODEL.aggregatesOverCte, 'the aggregate does not read the recursive CTE').toBe(true)
    expect(HANDLER_MODEL.seedColumn, 'the climb does not start at a location_id').toBe('location_id')
    expect(HANDLER_MODEL.seedStartsAtPlanting,
      'the climb starts from some other row\'s location_id, not the planting\'s').toBe(true)
    expect(HANDLER_MODEL.seedFromLocations, 'the climb no longer reads the locations table').toBe(true)
    expect(HANDLER_MODEL.seedSkipsDeleted).toBe(true)
    expect(HANDLER_MODEL.climbSkipsDeleted).toBe(true)
    expect(HANDLER_MODEL.seedSelectsCovered).toBe(true)
    expect(HANDLER_MODEL.fallback, 'unknown coverage no longer resolves to exposed').toBe(false)
  })

  it('refuses rain to a planting standing directly under a roof', () => {
    for (const name of ['Stable', 'House', 'Indoor Rack', 'Shelf 1', 'Shelf 3', 'Shelf 5']) {
      expect(creditsRain(HANDLER_MODEL, TREE, name), `${name} is covered`).toBe(false)
    }
  })

  it('credits rain to a planting open to the sky', () => {
    for (const name of ['Trough', 'Drive', 'Drive-Shade', 'Yard - Back', 'Pasture', 'Bag Area', 'Deck']) {
      expect(creditsRain(HANDLER_MODEL, TREE, name), `${name} is exposed`).toBe(true)
    }
    // Near-miss on the retired name-match: "Yard - Stable" is an area in the Yard, not the Stable.
    expect(creditsRain(HANDLER_MODEL, TREE, 'Yard - Stable')).toBe(true)
  })

  it('refuses rain through an ANCESTOR roof — the recursion, which no live row exercises', () => {
    // The discriminating pair. Drop the recursive arm and both of these flip to true: the bench
    // carries covered=false in its own right and the roof is one and two hops above it.
    expect(creditsRain(HANDLER_MODEL, TREE, 'Stable Bench'), 'bench inside the Stable').toBe(false)
    expect(creditsRain(HANDLER_MODEL, TREE, 'Bench Tray'), 'tray on a bench inside the Stable').toBe(false)
  })

  it('classifies the 21 live locations exactly 8 sheltered / 13 exposed', () => {
    // The census pinned, so a silent reclassification of the whole garden cannot ship green. Matches
    // covered-backfill-parity.test.js's independently measured 8/13.
    const names = Object.keys(LIVE)
    const sheltered = names.filter((n) => creditsRain(HANDLER_MODEL, LIVE, n) === false)
    expect(sheltered.sort()).toEqual(
      ['House', 'Indoor Rack', 'Shelf 1', 'Shelf 2', 'Shelf 3', 'Shelf 4', 'Shelf 5', 'Stable'])
    expect(names.length - sheltered.length).toBe(13)
  })

  it('characterises the three edges the COALESCE decides (current behaviour, not an endorsement)', () => {
    // Unknown coverage -> exposed. Deliberate: NULL is "not yet stated", and the alternative is
    // withholding rain from every location Dave has not ticked.
    expect(creditsRain(HANDLER_MODEL, TREE, 'Low Tunnel Bed')).toBe(true)
    // No location at all -> exposed. The seed matches nothing, bool_or is NULL, COALESCE says false.
    expect(creditsRain(HANDLER_MODEL, TREE, null)).toBe(true)
    // A soft-deleted rung ends the climb, so a roof above it is invisible. Worth knowing before
    // anyone soft-deletes a location with children.
    expect(creditsRain(HANDLER_MODEL, TREE, 'Orphan Bench')).toBe(true)
  })

  it('the live writer and the v4-rainbackfill-001 migration apply the SAME rule', () => {
    // The claim the retired census rested on, made executable. Both writers judge the roof at write
    // time; if they ever stop agreeing, the backfill and the autologger have silently forked.
    const migration = roofModelOf(rainInsertOf(MIGRATION, ';', '0b-data.sql'))
    const shape = ({ seedAlias, cte, ...rest }) => rest   // aliases differ by design: gn vs p
    expect(shape(migration)).toEqual(shape(HANDLER_MODEL))
    for (const name of [...Object.keys(LIVE), 'Stable Bench', 'Bench Tray', 'Low Tunnel Bed']) {
      expect(creditsRain(migration, TREE, name), `writers disagree at ${name}`)
        .toBe(creditsRain(HANDLER_MODEL, TREE, name))
    }
  })
})
