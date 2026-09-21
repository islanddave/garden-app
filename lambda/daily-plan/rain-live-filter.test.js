// OPS-RAININSERTLIVEFILTER-001 — the rain autologger credits LIVE plantings only, guarded at WRITE TIME.
// OPS-RAININSERTCONTAINERFILTER-001 — and only in a live container, or in none.
// BUG-RAINONENDEDPLANTINGS-001 — and never an ended or failed one: exactly the plan's status set.
// BUG-PLANSOFTDELCONTAINER-001 — and the daily plan's own plantings query hides the same containers.
//
// WHAT IS GUARDED. The rain INSERT in handler.js (logRainEvents) writes one event row per planting.
// Its outer WHERE carries `gn.deleted_at is null and gn.archived_at is null`, and this file proves
// that a soft-deleted planting and an archived planting are each REFUSED rain on their own, whatever
// the roof, or any term added later, says. It also carries
// `(ct.id is null or (ct.deleted_at is null and ct.archived_at is null))`, and this file proves that a
// live planting in a soft-deleted container and one in an archived container are each refused, while
// a project-less planting (no container row at all) is still credited. And it carries
// `(gn.status is null or gn.status not in ('ended','failed','dead','archived'))`, and this file proves
// that exactly those statuses are refused, that NULL, dormant and every growing status are credited,
// and that the set is the one the daily plan's own plantings query refuses.
//
// WHY BOTH EXCLUSIONS ARE RIGHT (claude-ops/project-rules/gardening.md):
//   * deleted — Deleted-Planting History Rule: a soft-deleted planting retracts the RECORD, not the
//     history. Rows written before the delete stay; the writer must not mint NEW history onto a
//     withdrawn record. `events_to_deleted_plants` is a census that grows with every planting
//     soft-delete by design; a writer that credited deleted plantings would grow it on every rain day
//     as well, and nobody could tell the two apart.
//   * archived — Archive-Hiding Rule: archiving is a statement about the garden. An archived planting
//     is no longer part of it, so the garden's rain is not its history; every row written under it is
//     one that every default view must hide, and it reappears, one row per rain day, on unarchive.
// The rule also says the two axes must stay SEPARATELY OBSERVABLE, so each is evaluated on its own.
//
// AND THE CONTAINER'S. Neither container state cascades to the plantings (lambda/projects/index.js
// sets the container's own column and nothing else), so the planting's filter cannot see it:
//   * deleted — the Deleted-Planting History Rule's own contrast, which is NOT a switch: a soft-deleted
//     container always hides its events, because the growing space is gone. The events feed already
//     hides those events and the plants API 404s the plantings (V4-SOFTDEL-001 F4); the writer was the
//     outlier.
//   * archived — Archive-Hiding Rule again; the plantings query and the anchor re-derivation target in
//     the same handler already exclude an archived container.
// Same two axes, same separate observation. `none` — the project-less planting the LEFT JOIN exists for
// (BUG-LOGMANYPROJECTLESS-001) — must still be credited, so it is a POSITIVE control, not a gap.
//
// AND THE STATUS — Dave's decision 2026-09-19 (BUG-RAINONENDEDPLANTINGS-001, Option 1): rain goes
// where the plan looks. Rain on an ended or failed planting reached only display surfaces, where
// a dug crop showed "Next watering" after every rain; the plan itself never selects them. Dormant stays
// credited: a dormant perennial is still in the ground, and its rain becomes last_water on Resume.
// Tied to the plan's query rather than restated, so the writer and that reader cannot drift apart.
//
// WHY THIS FILE EXISTS. Measured 2026-09-18 at 1408ca04: deleting either term, or both, from the rain
// insert left lambda/daily-plan 78/78 files green, and 690/690 tests green in the 65 files outside it
// that reference the daily-plan handler (lambda-level guards, the SQL-comment guards, the daily-plan
// parity suite, daily-plan-read). archived-exclusion.test.js pins the PLANTINGS query (the rain insert
// uses gn/ct aliases precisely so that guard does not latch onto it), and rain-roof-rule.test.js
// leaves every non-roof term FREE by design. So these two terms had no coverage anywhere. The container
// clause had neither a filter nor a guard until 2026-09-19; both landed in the same change.
//
// METHOD — the same one rain-roof-rule.test.js uses, and the same parser (copied below). The
// statement's own WHERE is parsed into its boolean skeleton and evaluated by truth table. Here the
// planting's two live-filter terms are PINNED from the planting's state and every other term — the
// roof, the gauge, anything a later edit adds — is left FREE, so "refused" means refused under every
// assignment of them. Semantic, not textual: reordering, regrouping, De Morgan and a double negation
// pass; an OR, IS NOT NULL, a comment, another alias or another statement fails; a live-filter term
// the parser cannot place (inside a CASE, a COALESCE, a subquery) THROWS and is never scored.
//
// The container is a second pass over the same WHERE: the planting is pinned LIVE (a retired one is
// already refused above, whatever the container says), the container's `id`, `deleted_at` and
// `archived_at` terms are pinned from its state, and the rest stays FREE. Its alias is READ from the
// statement like the planting's, and so is its join: only a LEFT JOIN lets a project-less planting
// reach the WHERE at all, so under any other join `none` is refused before the WHERE is consulted.
//
// The status is a third pass: planting live, container live and none, and the status pinned by VALUE
// — every PLANT_STATUSES entry, NULL, and the list's two out-of-vocabulary terms — through `is [not]
// null`, `[not] in (...)`, `=` and `<>`, with SQL's NULL for a NULL status. The plantings query's WHERE
// is parsed the same way from the same handler, and the two are compared status by status.
//
// The PLAN gets a container pass of its own (BUG-PLANSOFTDELCONTAINER-001, 2026-09-21). The plantings
// query filtered `pj.archived_at` and not `pj.deleted_at`, so a live planting in a soft-deleted container
// stayed in the nightly plan, carded, while the plants API 404ed it and this writer refused it rain. The
// query now carries both, each its own clause. The pass lives here rather than in a new file because this
// file already parses that query for the status parity, and a new file would be the third copy of the
// parser the note below asks not to make. Same five container states, the planting pinned live,
// everything else FREE, the join READ. Required: the writer's table, and equal to the writer's.
//
// DELIBERATELY NOT DECIDED HERE. A planting whose record was created after the rain day it is
// credited for (seen in the BUG-RAINONENDEDPLANTINGS-001 recon; the live writer can only do it at the
// 02:00 edge). Any term added for that is FREE here.
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
// two copies in step. If a third guard needs this parser, hoist it into a module OUTSIDE this function
// directory rather than copying it again: deploy-lambda.yml zips lambda/daily-plan/ excluding only
// *.test.js, so a helper placed here ships to production (noLambdaScratchRunners.test.js names
// _coverFlags.js as exactly that case).
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

// One statement, comments gone, on one line, lower-cased EXCEPT inside string literals: keywords and
// identifiers are case-blind in Postgres, and `'Ended'` is not `'ended'` to a status column.
const sqlFlat = (sql) => sqlOnly(sql).replace(/\s+/g, ' ')
  .replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()))

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

// The five states of the planting's CONTAINER. `id` set = the LEFT JOIN found a container row, so
// `none` is the project-less planting, whose row reaches the WHERE with EVERY container column NULL.
const CONTAINER_STATES = {
  none: { id: false, deleted_at: false, archived_at: false },
  live: { id: true, deleted_at: false, archived_at: false },
  deleted: { id: true, deleted_at: true, archived_at: false },
  archived: { id: true, deleted_at: false, archived_at: true },
  deletedAndArchived: { id: true, deleted_at: true, archived_at: true },
}

// For a LIVE planting: credited in a live container or in none, never in a retired one.
const CONTAINER_REFUSED = { none: true, live: true, deleted: false, archived: false, deletedAndArchived: false }

// The planting STATUSES rain is refused for — exactly the set the plantings query refuses. `dead`
// and `archived` are not legal values today (chk_plants_status), but both lists carry them.
const REFUSED_STATUSES = ['archived', 'dead', 'ended', 'failed']

// Every status the model evaluates: NULL, the vocabulary of record (src/lib/constants.js, the same
// read live-planting-predicate-sync.test.js makes) and the two out-of-vocabulary terms above. A status
// added to the vocabulary later is evaluated with no edit here, and expected to be credited, as the
// plan credits it.
const STATUSES = (() => {
  const src = readFileSync(join(here, '..', '..', 'src', 'lib', 'constants.js'), 'utf8')
  const m = src.match(/export const PLANT_STATUSES = \[([^\]]*)\]/)
  if (!m) throw new Error('PLANT_STATUSES not found in src/lib/constants.js — the status vocabulary moved')
  return [null, ...new Set([...[...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), ...REFUSED_STATUSES])]
})()
const statusName = (s) => s ?? 'null'

// The decided answer for a live planting, keyed `<status>/<container>`: refused for the four above,
// credited for every other status and for NULL, in a live container and in none alike.
const STATUS_TABLE = (refused) => Object.fromEntries(STATUSES.flatMap((s) =>
  ['none', 'live'].map((c) => [`${statusName(s)}/${c}`, !refused.includes(s)])))

// `<col> is null` / `<col> is not null`, for a column the state gives as SET (true) or NULL (false).
function nullTest(text, col) {
  if (text === `${col} is null`) return (isSet) => !isSet
  if (text === `${col} is not null`) return (isSet) => isSet
  return null
}

// For a column the state gives as a VALUE — the planting's status, or null: the two null tests, plus
// the comparisons the fleet writes, `[not] in (<literals>)` and `=` / `<>` / `!=` a literal. Compared
// with a NULL value they are NULL, as in SQL, so `status not in (...)` alone does NOT admit a NULL
// status. Any other spelling returns null, and the caller throws.
function valueTest(tokens, col) {
  if (tokens[0] !== col) return null
  const rest = tokens.slice(1)
  if (rest.join(' ') === 'is null') return (v) => v === null
  if (rest.join(' ') === 'is not null') return (v) => v !== null
  const lit = (s) => (/^'(?:[^']|'')*'$/.test(s) ? s.slice(1, -1).replaceAll("''", "'") : null)
  const sql = (test) => (v) => (v === null ? null : test(v))
  const negated = rest[0] === 'not'
  const body = negated ? rest.slice(1) : rest
  if (body[0] === 'in' && body[1] === '(' && body.at(-1) === ')') {
    const inner = body.slice(2, -1)
    const list = inner.filter((_, k) => k % 2 === 0).map(lit)
    if (!list.length || list.includes(null) || inner.some((s, k) => k % 2 === 1 && s !== ',')) return null
    return sql((v) => list.includes(v) !== negated)
  }
  const value = rest.length >= 2 && !negated ? lit(rest.at(-1)) : null
  const op = rest.slice(0, -1).join('')
  if (value !== null && op === '=') return sql((v) => v === value)
  if (value !== null && (op === '<>' || op === '!=')) return sql((v) => v !== value)
  return null
}

// Evaluate the WHERE for each state. A state pins columns — `true` = set, or for a column in
// `valueCols` the column's value — and a pinned column is read only through nullTest / valueTest; any
// other term that names one throws. Every remaining term is enumerated TRUE/FALSE — NULL needs no case
// of its own, because three-valued logic is monotone: if NULL admits the row, TRUE and FALSE both do
// too. `leak` records, for each state outside `credited`, the free terms under which it is admitted
// anyway.
function admitsByState(flat, states, credited, valueCols = new Set()) {
  const expr = boolTree(outerWhereOf(flat))
  const terms = []
  const walk = (n) => {
    if (n.op === 'term') terms.push(n)
    if (n.arg) walk(n.arg)
    if (n.args) n.args.forEach(walk)
  }
  walk(expr)
  const cols = Object.keys(Object.values(states)[0])
  const pinned = new Map()
  for (const t of terms) {
    for (const col of cols) {
      const of = valueCols.has(col) ? valueTest(t.tokens, col) : nullTest(t.text, col)
      if (of) pinned.set(t.text, { col, of })
      else if (t.tokens.includes(col)) {
        throw new Error(`the ${col} filter is buried inside a larger expression the guard cannot evaluate: ${t.text.slice(0, 90)}…`)
      }
    }
  }
  const others = [...new Set(terms.map((t) => t.text))].filter((t) => !pinned.has(t))
  if (others.length > 12) throw new Error(`the WHERE has ${others.length} free terms — too many to enumerate`)
  const admits = {}
  const leak = {}
  for (const [state, set] of Object.entries(states)) {
    admits[state] = false
    for (let mask = 0; mask < 2 ** others.length && !admits[state]; mask += 1) {
      const val = (t) => {
        const p = pinned.get(t)
        return p ? p.of(set[p.col]) : Boolean(mask & (1 << others.indexOf(t)))
      }
      if (truth(expr, val) === true) {
        admits[state] = true
        if (!credited.includes(state)) leak[state] = others.filter((_, k) => mask & (1 << k))
      }
    }
  }
  return { where: { expr, pinned: [...pinned.keys()], others }, admits, leak }
}

// The container pass. Pins the planting LIVE and the container's three columns from its state; `none`
// is refused outright unless the container is LEFT JOINed, since no other join lets a project-less
// planting reach the WHERE. Null when the statement binds no container at all.
function containerModelOf(flat, alias) {
  const bound = [...flat.matchAll(/\b(left\s+(?:outer\s+)?join|join|from)\s+(?:\w+\.)?container\s+(?:as\s+)?(\w+)\b/g)]
  if (bound.length > 1) throw new Error(`expected container bound at most once in the rain insert, found ${bound.length}`)
  if (!bound.length) return null
  const [, how, calias] = bound[0]
  const states = Object.fromEntries(Object.entries(CONTAINER_STATES).map(([state, set]) => [state, {
    ...Object.fromEntries(AXES.map((a) => [`${alias}.${a}`, false])),
    ...Object.fromEntries(Object.entries(set).map(([col, isSet]) => [`${calias}.${col}`, isSet])),
  }]))
  const model = admitsByState(flat, states, ['none', 'live'])
  const left = how.startsWith('left')
  if (!left) model.admits.none = false
  return { alias: calias, left, ...model }
}

// The status pass. The planting pinned live, its container pinned to each state that is credited
// (`none` only under a LEFT JOIN, the only join a project-less planting reaches the WHERE through),
// and the status pinned by VALUE; the roof and anything else stay FREE. Keyed `<status>/<container>`.
function statusModelOf(flat, alias, container) {
  const reach = container?.left ? ['none', 'live'] : ['live']
  const states = {}
  for (const s of STATUSES) {
    for (const c of reach) {
      states[`${statusName(s)}/${c}`] = {
        ...Object.fromEntries(AXES.map((a) => [`${alias}.${a}`, false])),
        ...(container && Object.fromEntries(Object.entries(CONTAINER_STATES[c])
          .map(([col, isSet]) => [`${container.alias}.${col}`, isSet]))),
        [`${alias}.status`]: s,
      }
    }
  }
  const credited = Object.keys(states).filter((k) => !REFUSED_STATUSES.includes(k.split('/')[0]))
  return admitsByState(flat, states, credited, new Set([`${alias}.status`]))
}

// The reader rain now follows: the daily plan's plantings query, in the same handler. Its WHERE is
// found by the phrase archived-exclusion.test.js anchors on (the rain INSERT is aliased gn/ct so that
// it never matches), required exactly once, and evaluated per status the same way. Keyed `<status>`.
function planStatusOf(src) {
  const flat = strip(src)
  const PHRASE = 'where p.deleted_at is null and p.archived_at is null'
  const at = flat.indexOf(PHRASE)
  const end = flat.indexOf('`', at)
  if (at < 0 || end < 0 || flat.includes(PHRASE, at + 1)) throw new Error('the plantings query WHERE is not anchored exactly once')
  const where = sqlFlat(flat.slice(at, end))
  const states = Object.fromEntries(STATUSES.map((s) =>
    [statusName(s), { 'p.deleted_at': false, 'p.archived_at': false, 'p.status': s }]))
  return admitsByState(where, states, Object.keys(states), new Set(['p.status']))
}

// The same plantings query WHOLE, since its join matters too: from the `rows: plantings` binding to the
// template's closing backtick, bound exactly once, and required to hold the WHERE planStatusOf reads, so
// the two plan passes cannot be reading two different statements. Both ends are found in the RAW source
// and only the slice is stripped: the closing backtick can sit on a `--` line (a clause deleted from
// under its comment), where strip() would take the backtick with the comment and run on past it.
function planStatementOf(src) {
  const hits = [...src.matchAll(/\{\s*rows:\s*plantings\s*\}\s*=\s*await\s+pg\.query\(`/g)]
  if (hits.length !== 1) throw new Error(`expected the plantings query bound exactly once, found ${hits.length}`)
  const start = hits[0].index + hits[0][0].length
  const end = src.indexOf('`', start)
  if (end < 0) throw new Error('the plantings query template is not terminated')
  const stmt = strip(src.slice(start, end))
  if (!stmt.includes('where p.deleted_at is null and p.archived_at is null')) {
    throw new Error('the plantings query does not hold the WHERE planStatusOf reads')
  }
  return stmt
}

// The plan's container pass (BUG-PLANSOFTDELCONTAINER-001): the planting pinned LIVE, the container's
// `id`, `deleted_at` and `archived_at` pinned from each CONTAINER_STATES entry, the status and every
// other term FREE. The container alias is READ from the plant_projects binding, and so is the join:
// under anything but a LEFT JOIN a project-less planting never reaches the WHERE, so `none` is refused.
function planContainerModelOf(stmt) {
  const flat = sqlFlat(stmt)
  const bound = [...flat.matchAll(/\b(left\s+(?:outer\s+)?join|join|from)\s+(?:\w+\.)?plant_projects\s+(?:as\s+)?(\w+)\b/g)]
  if (bound.length !== 1) throw new Error(`expected plant_projects bound exactly once in the plantings query, found ${bound.length}`)
  const [, how, calias] = bound[0]
  const states = Object.fromEntries(Object.entries(CONTAINER_STATES).map(([state, set]) => [state, {
    ...Object.fromEntries(AXES.map((a) => [`p.${a}`, false])),
    ...Object.fromEntries(Object.entries(set).map(([col, isSet]) => [`${calias}.${col}`, isSet])),
  }]))
  const model = admitsByState(flat, states, ['none', 'live'])
  const left = how.startsWith('left')
  if (!left) model.admits.none = false
  return { alias: calias, left, ...model }
}

// Which alias the statement's rows come from is READ, not assumed — `gn` in the handler, `p` in the
// migration — so the pinned terms are the PLANTING's columns, and `ct.deleted_at is null` is just
// another free term in the planting pass. Bound more than once would make "the planting" ambiguous,
// so that throws.
function liveModelOf(stmt) {
  const flat = sqlFlat(stmt)
  const bound = [...flat.matchAll(/(?:from|join)\s+(?:\w+\.)?garden_node\s+(?:as\s+)?(\w+)\b/g)].map((b) => b[1])
  if (bound.length !== 1) throw new Error(`expected garden_node bound exactly once in the rain insert, found ${bound.length}`)
  const [alias] = bound
  const planting = Object.fromEntries(Object.entries(STATES).map(([state, set]) =>
    [state, Object.fromEntries(AXES.map((a) => [`${alias}.${a}`, set[a]]))]))
  const container = containerModelOf(flat, alias)
  return { alias, ...admitsByState(flat, planting, ['live']), container, status: statusModelOf(flat, alias, container) }
}

const HANDLER_STMT = rainInsertOf(HANDLER, '`', 'handler.js')
const HANDLER_MODEL = liveModelOf(HANDLER_STMT)

describe('OPS-RAININSERTLIVEFILTER-001 / OPS-RAININSERTCONTAINERFILTER-001 — the rain autologger credits live plantings in live containers only, at write time', () => {
  it('is reading the real rain INSERT and a real live filter (vacuity floor)', () => {
    expect(strip(HANDLER).length, 'stripped handler.js is implausibly small').toBeGreaterThan(5000)
    expect(HANDLER_STMT.length, 'rain insert extracted as a stub').toBeGreaterThan(400)
    expect(HANDLER_STMT, 'extracted statement is not the rain insert').toMatch(/'rain'/)
    // One pinned term per axis, on the alias the rows come from. Named here so a parser that stopped
    // recognising the filter reports THAT, rather than only a leak table below.
    const cols = new Set(HANDLER_MODEL.where.pinned.map((t) => t.split(' ')[0]))
    expect([...cols].sort(), 'the WHERE carries no live-filter term for one of the axes')
      .toEqual(AXES.map((a) => `${HANDLER_MODEL.alias}.${a}`).sort())
    // The same for the container: bound, LEFT JOINed, and a pinned term on each axis. `id` is not
    // required — `ct.deleted_at is null and ct.archived_at is null` alone is equivalent, because the
    // LEFT JOIN's NULLs already pass a project-less planting through both.
    const c = HANDLER_MODEL.container
    expect(c, 'the rain insert no longer binds container').not.toBeNull()
    expect(c.left, 'container is no longer LEFT JOINed — a project-less planting gets no rain').toBe(true)
    const ccols = new Set(c.where.pinned.map((t) => t.split(' ')[0]))
    for (const a of AXES) expect(ccols.has(`${c.alias}.${a}`), `the WHERE carries no container ${a} term`).toBe(true)
    // And the planting's status.
    expect(HANDLER_MODEL.status.where.pinned.some((t) => t.startsWith(`${HANDLER_MODEL.alias}.status `)),
      'the WHERE carries no planting-status term').toBe(true)
  })

  it('refuses rain to a soft-deleted planting and to an archived one, whatever every other term says', () => {
    expect(HANDLER_MODEL.admits.live,
      'the WHERE admits no live planting at all — the writer, or this parser, has gone dead').toBe(true)
    // `leak` names the planting state and the free terms under which a retired planting gets rain.
    expect(HANDLER_MODEL.leak, 'a retired planting is credited rain whenever these other terms hold').toEqual({})
    expect(HANDLER_MODEL.admits).toEqual(RETIRED_REFUSED)
  })

  it('refuses rain to a live planting in a soft-deleted or archived container, and credits one in none', () => {
    const c = HANDLER_MODEL.container
    expect(c.admits.live,
      'a live planting in a live container is refused — the writer, or this parser, has gone dead').toBe(true)
    expect(c.admits.none, 'a project-less planting is refused rain (BUG-LOGMANYPROJECTLESS-001)').toBe(true)
    // `leak` names the container state and the free terms under which a live planting in it gets rain.
    expect(c.leak, 'a live planting in a retired container is credited rain whenever these other terms hold').toEqual({})
    expect(c.admits).toEqual(CONTAINER_REFUSED)
  })

  it('refuses rain to an ended or failed planting and credits a dormant or growing one', () => {
    const s = HANDLER_MODEL.status
    expect(s.admits['dormant/live'], 'a dormant planting is refused rain — its resume reads last_water').toBe(true)
    expect(s.admits['null/none'], 'a planting with no status is refused rain').toBe(true)
    // `leak` names the status/container and the free terms under which an ended or failed planting gets rain.
    expect(s.leak, 'an ended or failed planting is credited rain whenever these other terms hold').toEqual({})
    expect(s.admits).toEqual(STATUS_TABLE(REFUSED_STATUSES))
  })

  it('refuses exactly the statuses the daily plan refuses — rain goes where the plan looks', () => {
    // The writer and its one reader that acts on rain, compared status by status, so the two sets
    // cannot drift apart without this file saying which status moved.
    const plan = planStatusOf(HANDLER).admits
    const rain = Object.fromEntries(STATUSES.map((s) =>
      [statusName(s), HANDLER_MODEL.status.admits[`${statusName(s)}/live`]]))
    expect(Object.values(plan).some(Boolean), 'the plantings query admits no status at all — the parser has gone dead').toBe(true)
    expect(rain, 'the rain writer and the plantings query disagree about these statuses').toEqual(plan)
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

  it('reads the container filter from the predicate, not its spelling (synthetic WHEREs)', () => {
    // Same bench for the container pass. L is the planting's live filter, C the container's two axes.
    const L = 'gn.deleted_at is null and gn.archived_at is null'
    const C = 'ct.deleted_at is null and ct.archived_at is null'
    const R = 'not coalesce((select bool_or(l.covered) from locations l where l.id = gn.location_id), false)'
    const of = (w, join = 'left join container ct') => liveModelOf(
      `insert into event_log select 1 from garden_node gn ${join} on ct.id = gn.container_id\n where ${w}`).container
    const REFUSED = [
      `${L} and ${R} and (ct.id is null or (${C}))`,                      // the handler's shape
      `${L} and ${C} and ${R}`,                                           // no id arm: the NULLs pass it anyway
      `${L} and not (ct.deleted_at is not null or ct.archived_at is not null)`,  // De Morgan
      `(${L} and ct.id is null) or (${L} and ct.id is not null and ${C})`,       // distributed over the arms
      `${L} and (ct.id is null or (${C})) and (gn.status is null or gn.status <> 'ended')`,  // stricter
    ]
    for (const w of REFUSED) expect(of(w).admits, w).toEqual(CONTAINER_REFUSED)
    const T = true
    const F = false
    const ALL = { none: T, live: T, deleted: T, archived: T, deletedAndArchived: T }
    const LEAKS = [
      [`${L} and ${R}`, ALL],                                                                    // dropped
      [`${L} and (ct.id is null or ct.archived_at is null)`, { ...ALL, archived: F, deletedAndArchived: F }],  // no deleted
      [`${L} and (ct.id is null or ct.deleted_at is null)`, { ...ALL, deleted: F, deletedAndArchived: F }],    // no archived
      [`${L} and (ct.id is null or (ct.deleted_at is null or ct.archived_at is null))`, { ...ALL, deletedAndArchived: F }],  // and -> or
      [`${L} and not (ct.id is null or (${C}))`, { ...ALL, none: F, live: F }],                   // inverted
      [`${L} and (ct.id is not null or (${C}))`, ALL],                                           // id arm flipped
      [`${L} and ct.id is not null and ${C}`, { ...CONTAINER_REFUSED, none: F }],                // drops project-less
      [`${L} and (gn.deleted_at is null or (${C}))`, ALL],                                       // bypassed by the planting
      [`${L} and (ct.id is null or (${C})) or x`, ALL],                                          // made optional
      [`${L} and (ct.id is null or (ct.deleted_at is null\n --and ct.archived_at is null\n))`,   // half a comment
        { ...ALL, deleted: F, deletedAndArchived: F }],
      [`${L} and ${R} /* and (ct.id is null or (${C})) */`, ALL],                                // all a comment
      [`${L} and pp.deleted_at is null and pp.archived_at is null`, ALL],                        // another alias
    ]
    for (const [w, admits] of LEAKS) expect(of(w).admits, w).toEqual(admits)
    // The alias is READ: the same terms on `pp`, bound as the container, refuse.
    const pp = liveModelOf('insert into event_log select 1 from garden_node p\n'
      + ' left join public.container pp on pp.id = p.container_id\n'
      + ' where p.deleted_at is null and p.archived_at is null and pp.deleted_at is null and pp.archived_at is null')
    expect(pp.container.admits).toEqual(CONTAINER_REFUSED)
    // And the join is READ: only a LEFT JOIN lets a project-less planting reach the WHERE at all.
    expect(of(`${L} and (ct.id is null or (${C}))`, 'join container ct').admits).toEqual({ ...CONTAINER_REFUSED, none: F })
    expect(of(`${L} and (ct.id is null or (${C}))`, 'left outer join container ct').admits).toEqual(CONTAINER_REFUSED)
    // Bound twice, "the container" is ambiguous — as for the planting, that throws rather than guesses.
    expect(() => of(`${L} and ${C}`, 'left join container c2 on c2.id = gn.container_id left join container ct'))
      .toThrow(/at most once/)
    for (const w of [
      `${L} and coalesce(ct.deleted_at, ct.archived_at) is null`,
      `${L} and case when ct.id is null then true else ${C} end`,
      `${L} and not exists (select 1 from plant_projects pj where pj.id = ct.id and pj.archived_at is not null)`,
    ]) {
      expect(() => of(w), w).toThrow(/buried/)
    }
  })

  it('reads the status test from the predicate, not its spelling (synthetic WHEREs)', () => {
    // Same bench for the status pass. L is the planting and container filter, Q the plan's list.
    const L = 'gn.deleted_at is null and gn.archived_at is null and (ct.id is null or (ct.deleted_at is null and ct.archived_at is null))'
    const Q = "('ended','failed','dead','archived')"
    const of = (w) => liveModelOf(
      `insert into event_log select 1 from garden_node gn left join container ct on ct.id = gn.container_id\n where ${w}`).status
    const DECIDED = STATUS_TABLE(REFUSED_STATUSES)
    const SAME = [
      `${L} and (gn.status is null or gn.status not in ${Q})`,                               // the handler's shape
      `${L} and (gn.status is null or gn.status not in ('failed','archived','ended','dead'))`,  // order is not meaning
      `${L} and (gn.status is null or not gn.status in ${Q})`,                               // NOT IN as NOT (IN)
      `${L} and not (gn.status is not null and gn.status in ${Q})`,                          // De Morgan
      `${L} and (gn.status is null or (gn.status <> 'ended' and gn.status != 'failed' and gn.status <> 'dead' and gn.status <> 'archived'))`,
      `${L} AND (GN.STATUS IS NULL OR GN.STATUS NOT IN ${Q})`,                               // keywords are case-blind
      `${L} and (gn.status is null or not (gn.status = 'ended' or gn.status = 'failed' or gn.status = 'dead' or gn.status = 'archived'))`,
    ]
    for (const w of SAME) expect(of(w).admits, w).toEqual(DECIDED)
    const without = (s) => REFUSED_STATUSES.filter((x) => x !== s)
    const LEAKS = [
      [L, STATUS_TABLE([])],                                                                 // dropped
      ...REFUSED_STATUSES.map((s) => [                                                       // one status removed, each
        `${L} and (gn.status is null or gn.status not in (${without(s).map((x) => `'${x}'`).join(',')}))`,
        STATUS_TABLE(without(s))]),
      [`${L} and not (gn.status is null or gn.status not in ${Q})`,                          // inverted
        Object.fromEntries(Object.entries(DECIDED).map(([k, v]) => [k, !v]))],
      [`${L} and gn.status not in ${Q}`, { ...DECIDED, 'null/none': false, 'null/live': false }],  // no NULL arm
      [`${L} and (gn.status is null or gn.status not in ('failed','ended','dormant'))`,       // the LIVE list
        STATUS_TABLE(['dormant', 'ended', 'failed'])],
      [`${L} and (gn.status is null or gn.status not in ${Q.toUpperCase()})`, STATUS_TABLE([])],  // literals are not
      [`${L} and (gn.status is null or gn.status not in ${Q}) and (gn.status <> 'dormant' or ct.id is null)`,  // why the
        { ...DECIDED, 'dormant/live': false, 'null/live': false }],                          // container is pinned (and NULL <> x is NULL)
      [`${L} and (gn.status is null or gn.status not in ${Q}) or x`, STATUS_TABLE([])],      // made optional
      [`${L}\n --and (gn.status is null or gn.status not in ${Q})`, STATUS_TABLE([])],      // a comment
    ]
    for (const [w, admits] of LEAKS) expect(of(w).admits, w).toEqual(admits)
    for (const w of [
      `${L} and coalesce(gn.status, 'none') not in ${Q}`,
      `${L} and (gn.status is null or lower(gn.status) not in ${Q})`,
      `${L} and (gn.status is null or gn.status not in (select s from gone))`,
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
    // The CONTAINER axis is not parity and cannot be: the backfill predates
    // OPS-RAININSERTCONTAINERFILTER-001 and filters no container state. Characterised, not endorsed:
    // if this reds, the applied migration file was edited, and the edit is what to undo. Read-only prod
    // count 2026-09-18 (mainsync4 rainlivefilter): 0 machine-written rain rows under a container
    // archived before the write; deleted containers were not measured.
    expect(migration.container.alias).toBe('pp')
    expect(migration.container.left).toBe(true)
    expect(migration.container.admits)
      .toEqual({ none: true, live: true, deleted: true, archived: true, deletedAndArchived: true })
    // Nor any status (BUG-RAINONENDEDPLANTINGS-001 postdates it too) — characterised the same way.
    expect(migration.status.admits).toEqual(STATUS_TABLE([]))
  })
})

// Built inside each test rather than at load, so an extractor failure reds these tests and leaves the
// writer's tests above running.
const planOf = () => {
  const stmt = planStatementOf(HANDLER)
  return { stmt, container: planContainerModelOf(stmt) }
}

describe('BUG-PLANSOFTDELCONTAINER-001 — the daily plan drops a planting in a soft-deleted or archived container', () => {
  it('is reading the real plantings query and a container term per axis (vacuity floor)', () => {
    const { stmt, container: c } = planOf()
    // Anchor and ceiling: the plantings query and only it (about 4,600 stripped characters today).
    expect(stmt, 'extracted statement is not the plantings query').toMatch(/\bfrom plants p\b/)
    expect(stmt.length, 'plantings query extracted as a stub').toBeGreaterThan(2000)
    expect(stmt.length, 'extractor ran past the plantings query').toBeLessThan(9000)
    expect(c.left, 'plant_projects is no longer LEFT JOINed — every project-less planting leaves the plan').toBe(true)
    // One pinned term per axis, named, so a lost axis reports THAT rather than only a table below.
    const cols = new Set(c.where.pinned.map((t) => t.split(' ')[0]))
    for (const a of AXES) expect(cols.has(`${c.alias}.${a}`), `the plantings query carries no container ${a} term`).toBe(true)
  })

  it('drops a live planting in a soft-deleted container and in an archived one, and keeps one in none', () => {
    const { container: c } = planOf()
    expect(c.admits.live,
      'a live planting in a live container leaves the plan — the query, or this parser, has gone dead').toBe(true)
    expect(c.admits.none, 'a project-less planting leaves the plan (BUG-LOGMANYPROJECTLESS-001)').toBe(true)
    // `leak` names the container state and the free terms under which a planting in it is still planned.
    expect(c.leak, 'a live planting in a retired container stays in the plan whenever these other terms hold').toEqual({})
    expect(c.admits).toEqual(CONTAINER_REFUSED)
  })

  it('plans exactly the containers the rain writer credits', () => {
    // Container by container, so a drift on either side names the state that moved.
    expect(planOf().container.admits, 'the plantings query and the rain writer disagree about these container states')
      .toEqual(HANDLER_MODEL.container.admits)
  })

  it('reads the plan container filter from the predicate, not its spelling (synthetic WHEREs)', () => {
    // P is the planting's live filter, S the status terms (FREE here), A and D the two container axes.
    // The subquery in the select list carries its own WHERE, which must not be read as the statement's.
    const P = 'p.deleted_at is null and p.archived_at is null'
    const S = "(p.status is null or p.status not in ('ended','failed','dead','archived')) and (pj.status is null or pj.status <> 'planning')"
    const A = 'pj.archived_at is null'
    const D = 'pj.deleted_at is null'
    const of = (w, join = 'left join plant_projects pj') => planContainerModelOf(
      `select p.id, (select max(e.event_date) from event_log e where e.plant_id = p.id) as last_water\n`
      + ` from plants p ${join} on pj.id = p.project_id\n where ${w}`)
    const REFUSED = [
      `${P} and ${S} and ${A} and ${D}`,                                          // the handler's shape
      `${P} and ${D} and ${S} and ${A}`,                                          // order is not meaning
      `${P} and ${S} and (pj.id is null or (${D} and ${A}))`,                     // REDERIVE_CTE's shape
      `${P} and ${S} and not (pj.deleted_at is not null or pj.archived_at is not null)`,  // De Morgan
    ]
    for (const w of REFUSED) expect(of(w).admits, w).toEqual(CONTAINER_REFUSED)
    const T = true
    const F = false
    const ALL = { none: T, live: T, deleted: T, archived: T, deletedAndArchived: T }
    const LEAKS = [
      [`${P} and ${S} and ${A}`, { ...ALL, archived: F, deletedAndArchived: F }],            // the defect: no deleted term
      [`${P} and ${S} and ${D}`, { ...ALL, deleted: F, deletedAndArchived: F }],             // no archived term
      [`${P} and ${S} and ${D} and ${D}`, { ...ALL, deleted: F, deletedAndArchived: F }],    // archived replaced by deleted
      [`${P} and ${S} and ${A} and ${A}`, { ...ALL, archived: F, deletedAndArchived: F }],   // deleted replaced by archived
      [`${P} and ${S} and (${A} or ${D})`, { ...ALL, deletedAndArchived: F }],               // merged with OR
      [`${P} and ${S} and ${A} or ${D}`, { ...ALL, deletedAndArchived: F }],                 // made optional
      [`${P} and ${S} and ${A} and pj.deleted_at is not null`,                                // inverted
        { none: F, live: F, deleted: T, archived: F, deletedAndArchived: F }],
      [`${P} and ${S} and ${A} and p.deleted_at is null`, { ...ALL, archived: F, deletedAndArchived: F }],  // the planting's alias
      [`${P} and ${S} and ${A}\n --and ${D}`, { ...ALL, archived: F, deletedAndArchived: F }],             // a comment
      [`${P} and ${S} and ${A} /* and ${D} */`, { ...ALL, archived: F, deletedAndArchived: F }],           // a block comment
    ]
    for (const [w, admits] of LEAKS) expect(of(w).admits, w).toEqual(admits)
    // The join is READ: an INNER join refuses the project-less planting before the WHERE is consulted.
    expect(of(`${P} and ${S} and ${A} and ${D}`, 'join plant_projects pj').admits).toEqual({ ...CONTAINER_REFUSED, none: F })
    expect(of(`${P} and ${S} and ${A} and ${D}`, 'left outer join public.plant_projects pj').admits).toEqual(CONTAINER_REFUSED)
    for (const w of [
      `${P} and ${S} and coalesce(pj.deleted_at, pj.archived_at) is null`,
      `${P} and ${S} and case when pj.id is null then true else ${D} and ${A} end`,
    ]) {
      expect(() => of(w), w).toThrow(/buried/)
    }
  })
})
