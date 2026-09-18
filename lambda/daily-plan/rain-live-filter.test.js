// OPS-RAININSERTLIVEFILTER-001 — the rain autologger credits LIVE plantings only, guarded at WRITE TIME.
//
// WHAT IS GUARDED. The rain INSERT in handler.js (logRainEvents) writes one event row per planting.
// Its outer WHERE carries `gn.deleted_at is null and gn.archived_at is null`, and this file proves
// that a soft-deleted planting and an archived planting are each REFUSED rain on their own, whatever
// the roof, or any term added later, says.
//
// WHY BOTH EXCLUSIONS ARE RIGHT (claude-ops/project-rules/gardening.md):
//   * deleted — Deleted-Planting History Rule: a soft-deleted planting retracts the RECORD, not the
//     history. Rows written before the delete stay; the writer must not mint NEW history onto a
//     withdrawn record. `events_to_deleted_plants` is a census that grows once per delete by design;
//     a writer that credited deleted plantings would grow it on every rain day as well, and nobody
//     could tell the two apart.
//   * archived — Archive-Hiding Rule: archiving is a statement about the garden. An archived planting
//     is not in it, so no rain fell on it, and every row written under it is one that every default
//     view must hide — and that reappears, one row per rain day, if the planting is ever unarchived.
// The rule also says the two axes must stay SEPARATELY OBSERVABLE, so each is evaluated on its own.
//
// WHY THIS FILE EXISTS. Measured 2026-09-18 at 1408ca04: deleting either term, or both, from the rain
// insert left lambda/daily-plan 78/78 files green, and the ten fleet guards outside it that read
// handler.js 690/690 green. archived-exclusion.test.js pins the PLANTINGS query (the rain insert
// uses gn/ct aliases precisely so that guard does not latch onto it), and rain-roof-rule.test.js
// leaves every non-roof term FREE by design. So these two terms had no coverage anywhere.
//
// METHOD — the same one rain-roof-rule.test.js uses, and the same parser (copied below). The
// statement's own WHERE is parsed into its boolean skeleton and evaluated by truth table. Here the
// planting's two live-filter terms are PINNED from the planting's state and every other term — the
// roof, the gauge, anything a later edit adds — is left FREE, so "refused" means refused under every
// assignment of them. Semantic, not textual: reordering, regrouping, De Morgan and a double negation
// pass; an OR, IS NOT NULL, a comment, another alias or another statement fails; a live-filter term
// the parser cannot place (inside a CASE, a COALESCE, a subquery) THROWS and is never scored.
//
// DELIBERATELY NOT DECIDED HERE. Only the planting's own two columns are pinned. This writer does
// not filter on container state or planting status, unlike the plantings query; that is a separate
// open question. Any such term added later is FREE here, so closing it cannot red this file.
//
// LIMIT, unchanged from its sibling: a source-text guard. The Lambda unit suite mocks SQL, so nothing
// here executes the statement against Postgres.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HANDLER = readFileSync(join(here, 'handler.js'), 'utf8')
const MIGRATION = readFileSync(
  join(here, '..', '..', 'migrations', 'v4-rainbackfill-001', '0b-data.sql'), 'utf8')

// ── COPIED VERBATIM from rain-roof-rule.test.js (code only; its comments explain each piece) ─────
// Same helper and same reason, which is the house pattern for strip() across these guards. Keep the
// two copies in step. If a third guard needs this parser, hoist it into a test-only module on the
// _coverFlags.js pattern instead of copying it again.
const strip = (src) => src.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')

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

const LITERAL = { true: true, false: false, null: null }

const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-z0-9_$.]+|\S/g

function matching(tokens, open) {
  for (let depth = 0, k = open; k < tokens.length; k += 1) {
    if (tokens[k] === '(') depth += 1
    else if (tokens[k] === ')' && --depth === 0) return k
  }
  throw new Error(`unbalanced ( at token ${open} of the WHERE`)
}

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

function truth(node, val) {
  if (node.op === 'const') return node.value
  if (node.op === 'term') return val(node.text)
  if (node.op === 'not') { const v = truth(node.arg, val); return v === null ? null : !v }
  const vs = node.args.map((a) => truth(a, val))
  const [decides, otherwise] = node.op === 'and' ? [false, true] : [true, false]
  return vs.includes(decides) ? decides : vs.includes(null) ? null : otherwise
}

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
// ── end of the copy ──────────────────────────────────────────────────────────────────────────────

// SQL comments, as POSTGRES reads them — the one addition to the copied parser. strip() removes a
// `--` only when a space follows it (it has to: it runs over JavaScript, where `i--` is code), and it
// never removes a block comment. Measured without this pass: `--AND p.deleted_at IS NULL` in the
// backfill left this file's writer assertions AND rain-roof-rule.test.js green, and the same edit
// placed after the handler's roof was caught only by accident, by the roof guard's "buried" check.
// Quoted strings are matched first, so a `--` inside a literal stays a literal.
const SQL_COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g
const sqlOnly = (sql) => sql.replace(SQL_COMMENT, (m) => (m.startsWith('--') || m.startsWith('/*') ? ' ' : m))

const AXES = ['deleted_at', 'archived_at']

// The four states a planting can be in on these two axes. `true` = that column is set.
const STATES = {
  live: { deleted_at: false, archived_at: false },
  deleted: { deleted_at: true, archived_at: false },
  archived: { deleted_at: false, archived_at: true },
  deletedAndArchived: { deleted_at: true, archived_at: true },
}

// The ONLY acceptable answer: a live planting can be credited, a retired one never.
const RETIRED_REFUSED = { live: true, deleted: false, archived: false, deletedAndArchived: false }

// Evaluate the WHERE for each planting state. The two live-filter spellings the model knows are
// `<alias>.<col> is null` and `<alias>.<col> is not null`; any other term that names the column
// throws. Every remaining term is enumerated TRUE/FALSE — NULL needs no case of its own, because
// three-valued logic is monotone: if NULL admits the row, TRUE and FALSE both do too.
function liveFilterOf(flat, alias) {
  const expr = boolTree(outerWhereOf(flat))
  const terms = []
  const walk = (n) => {
    if (n.op === 'term') terms.push(n)
    if (n.arg) walk(n.arg)
    if (n.args) n.args.forEach(walk)
  }
  walk(expr)
  const pinned = new Map()
  for (const t of terms) {
    for (const axis of AXES) {
      const col = `${alias}.${axis}`
      if (t.text === `${col} is null`) pinned.set(t.text, { axis, whenSet: false })
      else if (t.text === `${col} is not null`) pinned.set(t.text, { axis, whenSet: true })
      else if (t.tokens.includes(col)) {
        throw new Error(`the ${col} filter is buried inside a larger expression the guard cannot evaluate: ${t.text.slice(0, 90)}…`)
      }
    }
  }
  const others = [...new Set(terms.map((t) => t.text))].filter((t) => !pinned.has(t))
  if (others.length > 12) throw new Error(`the WHERE has ${others.length} free terms — too many to enumerate`)
  const admits = {}
  const leak = {}
  for (const [state, set] of Object.entries(STATES)) {
    admits[state] = false
    for (let mask = 0; mask < 2 ** others.length && !admits[state]; mask += 1) {
      const val = (t) => {
        const p = pinned.get(t)
        return p ? (set[p.axis] ? p.whenSet : !p.whenSet) : Boolean(mask & (1 << others.indexOf(t)))
      }
      if (truth(expr, val) === true) {
        admits[state] = true
        if (state !== 'live') leak[state] = others.filter((_, k) => mask & (1 << k))
      }
    }
  }
  return { where: { expr, pinned: [...pinned.keys()], others }, admits, leak }
}

// Which alias the statement's rows come from is READ, not assumed — `gn` in the handler, `p` in the
// migration — so the pinned terms are the PLANTING's columns, and `ct.deleted_at is null` is just
// another free term. Bound more than once would make "the planting" ambiguous, so that throws.
function liveModelOf(stmt) {
  const flat = sqlOnly(stmt).replace(/\s+/g, ' ').toLowerCase()
  const bound = [...flat.matchAll(/(?:from|join)\s+(?:\w+\.)?garden_node\s+(?:as\s+)?(\w+)\b/g)].map((b) => b[1])
  if (bound.length !== 1) throw new Error(`expected garden_node bound exactly once in the rain insert, found ${bound.length}`)
  return { alias: bound[0], ...liveFilterOf(flat, bound[0]) }
}

const HANDLER_STMT = rainInsertOf(HANDLER, '`', 'handler.js')
const HANDLER_MODEL = liveModelOf(HANDLER_STMT)

describe('OPS-RAININSERTLIVEFILTER-001 — the rain autologger credits live plantings only, at write time', () => {
  it('is reading the real rain INSERT and a real live filter (vacuity floor)', () => {
    expect(strip(HANDLER).length, 'stripped handler.js is implausibly small').toBeGreaterThan(5000)
    expect(HANDLER_STMT.length, 'rain insert extracted as a stub').toBeGreaterThan(400)
    expect(HANDLER_STMT, 'extracted statement is not the rain insert').toMatch(/'rain'/)
    // One pinned term per axis, on the alias the rows come from. Named here so a parser that stopped
    // recognising the filter reports THAT, rather than only a leak table below.
    const cols = new Set(HANDLER_MODEL.where.pinned.map((t) => t.split(' ')[0]))
    expect([...cols].sort(), 'the WHERE carries no live-filter term for one of the axes')
      .toEqual(AXES.map((a) => `${HANDLER_MODEL.alias}.${a}`).sort())
  })

  it('refuses rain to a soft-deleted planting and to an archived one, whatever every other term says', () => {
    expect(HANDLER_MODEL.admits.live,
      'the WHERE admits no live planting at all — the writer, or this parser, has gone dead').toBe(true)
    // `leak` names the planting state and the free terms under which a retired planting gets rain.
    expect(HANDLER_MODEL.leak, 'a retired planting is credited rain whenever these other terms hold').toEqual({})
    expect(HANDLER_MODEL.admits).toEqual(RETIRED_REFUSED)
  })

  it('reads the filter from the predicate, not its spelling (synthetic WHEREs)', () => {
    // The same model on WHEREs no writer contains, so it is proved to SEPARATE the shapes rather than
    // merely agree with today's handler. R stands in for the roof; only its place matters here.
    const D = 'gn.deleted_at is null'
    const A = 'gn.archived_at is null'
    const R = 'not coalesce((select bool_or(l.covered) from locations l where l.id = gn.location_id), false)'
    const of = (w) => liveModelOf(`insert into event_log select 1 from garden_node gn\n where ${w}`)
    const REFUSED = [
      `${D} and ${A} and ${R}`,
      `${A} and ${D}`,
      `(${D} and ${A}) and x`,
      `(${D} and ${A} and a) or (${D} and ${A} and b)`,                 // an OR, and still refused
      'not (gn.deleted_at is not null or gn.archived_at is not null)',   // De Morgan
      `not (not ${D}) and ${A}`,                                         // a double negation is the identity
      `${D} and ${A} and ${R} and ct.archived_at is null`,               // a stricter writer stays green
      `x <> '--' and ${D} and ${A} and ${R}`,                            // a quoted -- is not a comment
    ]
    for (const w of REFUSED) expect(of(w).admits, w).toEqual(RETIRED_REFUSED)
    // Each shape with the states it lets through — exact, so a model that merely says "leaks" for
    // everything cannot pass.
    const T = true
    const F = false
    const LEAKS = [
      [`${A} and ${R}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${D} and ${R}`, { live: T, deleted: F, archived: T, deletedAndArchived: F }],
      [`${D} or ${A}`, { live: T, deleted: T, archived: T, deletedAndArchived: F }],
      [`(${D} or x) and ${A}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${D} and ${A} or x`, { live: T, deleted: T, archived: T, deletedAndArchived: T }],
      [`gn.deleted_at is not null and ${A}`, { live: F, deleted: T, archived: F, deletedAndArchived: F }],
      [`not ${D} and ${A}`, { live: F, deleted: T, archived: F, deletedAndArchived: F }],
      [`ct.deleted_at is null and ${A}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`(${D} and ${A}) or (${A} and x)`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${A}\n --and ${D}\n and ${R}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${A} and ${R}\n --and ${D}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${A} /* and ${D} */ and ${R}`, { live: T, deleted: T, archived: F, deletedAndArchived: F }],
      [`${D}\n -- and ${A}\n and ${R}`, { live: T, deleted: F, archived: T, deletedAndArchived: F }],
    ]
    for (const [w, admits] of LEAKS) expect(of(w).admits, w).toEqual(admits)
    for (const w of [
      `case when x then ${D} else true end and ${A}`,
      'coalesce(gn.deleted_at, gn.archived_at) is null',
      `(${D}) is not false and ${A}`,
      `${A} and not exists (select 1 from t where gn.deleted_at is not null)`,
    ]) {
      expect(() => of(w), w).toThrow(/buried/)
    }
  })

  it('the v4-rainbackfill-001 backfill applied the same live filter', () => {
    // History, not a live writer — the migration is applied and is never edited. Read here for the
    // same reason rain-roof-rule.test.js reads it: the two writers must not have forked, and a second,
    // differently spelled statement (upper case, `p` alias, `public.` schema, four more free terms)
    // is the proof that this model reads a predicate rather than one statement's spelling.
    const migration = liveModelOf(rainInsertOf(MIGRATION, ';', '0b-data.sql'))
    expect(migration.leak, 'the backfill credits a retired planting whenever these other terms hold').toEqual({})
    expect(migration.admits).toEqual(RETIRED_REFUSED)
  })
})
