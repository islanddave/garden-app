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
    ...connectiveOf(flat),
  }
}

// ── THE CONNECTIVE (OPS-RAINROOFGUARDCONNECTIVE-001, 2026-09-18) ────────────────────────────────
// Everything above models the exclusion ITSELF; nothing modelled WHERE IT SITS. So a writer that
// kept the clause byte-for-byte but made it optional ran 8/8 green: `and not coalesce((` ->
// `or not coalesce((`, a trailing `or gn.deleted_at is null` or `or true`, an OR inside the same
// parenthesised group, the clause wrapped in a CASE, a double negation (EXCLUSION reads the INNER
// `not`). Every one of those credits rain to every live planting under every roof.
//
// So the statement's own WHERE is parsed into its boolean skeleton — AND / OR / NOT / parentheses
// over opaque terms, Postgres precedence NOT > AND > OR — and evaluated by truth table, 3-valued as
// SQL does it. `vetoes`: with the roof COALESCE true, NO assignment of the other terms admits the
// row. `admits`: with it false, SOME assignment does — the positive control, without which a parser
// that returned false for everything would score a perfect veto. A property of the predicate, not of
// its spelling: `(a and not R) or (b and not R)` still vetoes and passes, where a "no OR" regex would
// red a correct rewrite and teach the next reader to weaken this file. A roof term the parser cannot
// place (inside a CASE, compared with IS, wrapped in a subquery) THROWS; it is never scored.
const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-z0-9_$.]+|\S/g

function matching(tokens, open) {
  for (let depth = 0, k = open; k < tokens.length; k += 1) {
    if (tokens[k] === '(') depth += 1
    else if (tokens[k] === ')' && --depth === 0) return k
  }
  throw new Error(`unbalanced ( at token ${open} of the WHERE`)
}

// A term runs to the next AND / OR at its own depth, so a function call, a subquery, `is not null`,
// BETWEEN's own AND and a CASE … END all stay inside the term they belong to.
function boolTree(tokens) {
  let i = 0
  const term = () => {
    const start = i
    for (let depth = 0, cases = 0, between = false; i < tokens.length; i += 1) {
      const t = tokens[i]
      if (t === '(') depth += 1
      else if (t === ')' && --depth < 0) throw new Error('unbalanced ) in the WHERE')
      else if (t === 'case') cases += 1
      else if (t === 'end') cases -= 1
      else if (depth === 0 && cases === 0) {
        if (t === 'between') between = true
        else if (t === 'and' && between) between = false
        else if (t === 'and' || t === 'or') break
      }
    }
    const own = tokens.slice(start, i)
    if (!own.length) throw new Error(`empty term in the WHERE at token ${start}`)
    const text = own.join(' ')
    return Object.hasOwn(LITERAL, text) ? { op: 'const', value: LITERAL[text] } : { op: 'term', text, tokens: own }
  }
  // A leading ( is a GROUP only when a connective (or the end) follows its close; `(x) is not false`
  // and `(select …)` are the start of a term.
  const unary = () => {
    if (tokens[i] === 'not') { i += 1; return { op: 'not', arg: unary() } }
    if (tokens[i] === '(') {
      const close = matching(tokens, i)
      const after = tokens[close + 1]
      if (!/^(select|with|values)$/.test(tokens[i + 1]) && (after === undefined || after === 'and' || after === 'or')) {
        const group = boolTree(tokens.slice(i + 1, close))
        i = close + 1
        return group
      }
    }
    return term()
  }
  const chain = (op, next) => () => {
    const args = [next()]
    while (tokens[i] === op) { i += 1; args.push(next()) }
    return args.length === 1 ? args[0] : { op, args }
  }
  const tree = chain('or', chain('and', unary))()
  if (i !== tokens.length) throw new Error(`the WHERE did not parse to its end — stopped at "${tokens.slice(i, i + 6).join(' ')}"`)
  return tree
}

// Kleene logic, as a WHERE is evaluated: NULL AND FALSE is FALSE, NULL OR TRUE is TRUE, NOT NULL is
// NULL — and only TRUE admits the row.
function truth(node, val) {
  if (node.op === 'const') return node.value
  if (node.op === 'term') return val(node.text)
  if (node.op === 'not') { const v = truth(node.arg, val); return v === null ? null : !v }
  const vs = node.args.map((a) => truth(a, val))
  const [decides, otherwise] = node.op === 'and' ? [false, true] : [true, false]
  return vs.includes(decides) ? decides : vs.includes(null) ? null : otherwise
}

// The statement's OWN where — the one at parenthesis depth 0. The CTE's `where l.id = …` sits two
// levels down and belongs to the exclusion, not to the connective.
const CLAUSE_END = new Set(['group', 'order', 'limit', 'offset', 'returning', 'having', 'window', 'union', 'on', ';'])

function outerWhereOf(flat) {
  const tokens = flat.match(TOKEN) ?? []
  const at = []
  let end = tokens.length
  let depth = 0
  tokens.forEach((t, k) => {
    if (t === '(') depth += 1
    else if (t === ')') depth -= 1
    else if (depth === 0 && t === 'where') at.push(k)
    else if (depth === 0 && at.length && end === tokens.length && CLAUSE_END.has(t)) end = k
  })
  if (at.length !== 1) throw new Error(`expected exactly 1 top-level WHERE in the rain insert, found ${at.length}`)
  return tokens.slice(at[0] + 1, end)
}

// Every term other than the roof is left FREE and enumerated. For the veto that is the conservative
// reading — whatever gn.deleted_at, the gauge or the re-run guard say, a roof still refuses.
function connectiveOf(flat) {
  const expr = boolTree(outerWhereOf(flat))
  const terms = []
  const walk = (n) => {
    if (n.op === 'term') terms.push(n)
    if (n.arg) walk(n.arg)
    if (n.args) n.args.forEach(walk)
  }
  walk(expr)
  const roofs = [...new Set(terms.filter((t) => t.text.includes('with recursive')).map((t) => t.text))]
  if (roofs.length !== 1) throw new Error(`expected the roof exclusion as exactly 1 term of the WHERE, found ${roofs.length}`)
  const [roof] = roofs
  const own = terms.find((t) => t.text === roof).tokens
  if (own[0] !== 'coalesce' || own[1] !== '(' || matching(own, 1) !== own.length - 1) {
    throw new Error(`the roof exclusion is buried inside a larger expression the guard cannot evaluate: ${roof.slice(0, 90)}…`)
  }
  const others = [...new Set(terms.map((t) => t.text))].filter((t) => t !== roof)
  if (others.length > 12) throw new Error(`the WHERE has ${others.length} free terms — too many to enumerate`)
  let leak = null
  let admits = false
  for (let mask = 0; mask < 2 ** others.length; mask += 1) {
    const under = (covered) => (t) => (t === roof ? covered : Boolean(mask & (1 << others.indexOf(t))))
    if (leak === null && truth(expr, under(true)) === true) leak = others.filter((_, k) => mask & (1 << k))
    if (truth(expr, under(false)) === true) admits = true
  }
  return { where: { expr, roof, others }, vetoes: leak === null, admits, leak }
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
  // The WHOLE outer WHERE decides, with the roof term set to what the climb found and every other
  // term free: true = SOME planting row at startLoc would be credited, false = NO row would be,
  // whatever its other terms say. Only that reading makes "refused" a claim about every planting
  // under the roof — and it is what lets an optional roof show up in every test below.
  const { expr, roof, others } = model.where
  for (let mask = 0; mask < 2 ** others.length; mask += 1) {
    if (truth(expr, (t) => (t === roof ? coalesced : Boolean(mask & (1 << others.indexOf(t))))) === true) return true
  }
  return false
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

  it('the roof is a VETO — a required AND term of the outer WHERE, never an optional disjunct', () => {
    // OPS-RAINROOFGUARDCONNECTIVE-001. Until this, `or not coalesce((` and a trailing `or true` both
    // scored 8/8 green. `leak` names the other terms under which a covered planting gets rain.
    expect(HANDLER_MODEL.admits,
      'the WHERE admits no planting even under open sky — the writer, or this parser, has gone dead').toBe(true)
    expect(HANDLER_MODEL.leak, 'rain is credited under a roof whenever these other terms hold').toBeNull()
    expect(HANDLER_MODEL.vetoes).toBe(true)
  })

  it('reads the veto from the predicate, not its spelling (synthetic WHEREs)', () => {
    // The same parser on WHEREs no writer contains, so it is proved to SEPARATE the shapes rather
    // than merely agree with today's handler. R is a stand-in roof: its CTE body is irrelevant here,
    // only its place in the boolean skeleton is under test.
    const R = 'coalesce((with recursive up as (select 1) select bool_or(up.covered) from up), false)'
    const of = (w) => connectiveOf(`insert into event_log select 1 from garden_node gn where ${w}`)
    const VETO = [
      `a and not ${R}`,
      `a and (b and not ${R})`,
      `(a and not ${R}) or (b and not ${R})`,                     // an OR, and still a veto
      `a and not ${R} or false`,
      `x between 1 and 2 and not ${R}`,                           // BETWEEN's AND is not a connective
      `not ${R} and not exists (select 1 from t where p or q)`,   // nor is a subquery's OR
    ]
    const LEAK = [
      `a or not ${R}`,
      `a and not ${R} or b`,
      `a and (not ${R} or b)`,
      `not ${R} or true`,
      `(true or not ${R})`,
      `a and not (not ${R})`,
      `a and ${R}`,
    ]
    for (const w of VETO) {
      expect(of(w).vetoes, w).toBe(true)
      expect(of(w).admits, `positive control: ${w}`).toBe(true)
    }
    for (const w of LEAK) expect(of(w).vetoes, w).toBe(false)
    for (const w of [`a and case when b then true else not ${R} end`, `a and (not ${R}) is not false`]) {
      expect(() => of(w), w).toThrow(/buried/)
    }
    // creditsRain evaluates the same skeleton: grafted onto the real exclusion, an optional roof
    // credits the Stable. Without this, creditsRain could drop back to reading the atom alone.
    const optional = { ...HANDLER_MODEL, ...of(`gn.deleted_at is null or not ${R}`) }
    expect(creditsRain(optional, TREE, 'Stable'), 'creditsRain ignored the WHERE around the roof').toBe(true)
    expect(creditsRain(HANDLER_MODEL, TREE, 'Stable')).toBe(false)
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
    expect(migration.leak, 'the backfill credits rain under a roof whenever these other terms hold').toBeNull()
    // Aliases differ by design (gn vs p), and so do the WHERE's other terms — the backfill also
    // filters on the gauge, the day and its re-run guard. `vetoes` and `admits` must still agree.
    const shape = ({ seedAlias, cte, where, leak, ...rest }) => rest
    expect(shape(migration)).toEqual(shape(HANDLER_MODEL))
    for (const name of [...Object.keys(LIVE), 'Stable Bench', 'Bench Tray', 'Low Tunnel Bed']) {
      expect(creditsRain(migration, TREE, name), `writers disagree at ${name}`)
        .toBe(creditsRain(HANDLER_MODEL, TREE, name))
    }
  })
})
