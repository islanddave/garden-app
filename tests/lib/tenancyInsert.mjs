#!/usr/bin/env node
// The writer rule (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.2, §2.4 "Writers"). Pure functions over the
// SQL census (tests/lib/sqlCensus.mjs) and the class file (lambda/tenancy-classes.json); the rule and its allowlist
// live in lambda/tenancy-insert.static.test.js.
//
// THE RULE. Every INSERT into an S table (a view such as garden_node or container resolved to its base table) names
// the table's tenancy column, and the value bound to it passes the slot rule (sqlCensus classifySlot): rooted at
// the resolver's `scope`, or at a parent-row variable on the reviewed list, or copied in SQL from a column of a row
// the statement reads (INSERT … SELECT p.workspace_id: the parent-derived stamp itself). Refused: no column (the
// DEFAULT, i.e. the original Space), an SQL literal, a function call, a string const, any event.* / body.* /
// queryStringParameters root, and a column of a row built from request arrays (unnest($n::uuid[]) AS u(…)).
//
//   node tests/lib/tenancyInsert.mjs            # every S-table INSERT with its verdict, one per line
//   node tests/lib/tenancyInsert.mjs --refused  # the paste-ready allowlist rows (carry `lane` and `reason` by hand)
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, classifySlot, loadParser, censusOf } from './sqlCensus.mjs'
import { loadClasses, qualify } from './tenancyClasses.mjs'

export const ALLOWLIST_FILE = 'tests/tenancy-insert-allowlist.json'
export const S_CLASSES = Object.freeze(['S has key', 'S needs key', 'S keyed by space_id', 'S new'])
// The views a writer can INSERT through, and the table whose row each INSERT writes (simple auto-updatable views).
export const VIEW_BASE = Object.freeze({
  'public.container': 'public.plant_projects',
  'public.garden_node': 'public.plants',
  'public.cultivar': 'public.plant_varieties',
})

export const loadAllowlist = (root = ROOT) => JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), 'utf8'))

// The S tables of the class file, by base table (views resolved): Map name → { class, column }.
export function sTables(classes) {
  const out = new Map()
  for (const [name, row] of Object.entries(classes.relations)) {
    if (!S_CLASSES.includes(row.class) || VIEW_BASE[name]) continue
    out.set(name, { class: row.class, column: row.column ?? 'workspace_id' })
  }
  return out
}

// rel as an INSERT names it → { relation, base, class, column }, or null when the base is not an S table, or
// { relation, base, unclassed: true } when the class file does not know it.
export function sTarget(classes, rel) {
  const relation = qualify(rel)
  const base = VIEW_BASE[relation] ?? relation
  const row = classes.relations[base]
  if (!row) return { relation, base, unclassed: true }
  if (!S_CLASSES.includes(row.class)) return null
  return { relation, base, class: row.class, column: row.column ?? 'workspace_id' }
}

function insertStmts(tree) {
  const out = []
  const go = (n) => {
    if (Array.isArray(n)) { n.forEach(go); return }
    if (!n || typeof n !== 'object') return
    if (n.InsertStmt) out.push(n.InsertStmt)
    for (const v of Object.values(n)) go(v)
  }
  go(tree)
  return out.sort((a, b) => (a.relation?.location ?? 0) - (b.relation?.location ?? 0))
}
const relName = (rv) => (rv.schemaname ? rv.schemaname + '.' : '') + rv.relname

// Aliases of a SELECT's FROM list that are row-producing functions (unnest of request arrays and the like).
function functionAliases(sel) {
  const out = new Set()
  const go = (n) => {
    if (Array.isArray(n)) { n.forEach(go); return }
    if (!n || typeof n !== 'object') return
    if (n.RangeFunction?.alias?.aliasname) out.add(n.RangeFunction.alias.aliasname)
    if (n.JoinExpr) { go(n.JoinExpr.larg); go(n.JoinExpr.rarg) }
  }
  go(sel?.fromClause ?? [])
  return out
}

const RANK = { accept: 0, refuse: 1 }
// The verdict for one SQL expression bound to the tenancy column.
function verdictOf(expr, stmt, sel, reviewedParents) {
  const x = expr?.TypeCast?.arg ?? expr
  if (!x) return { verdict: 'refuse', reason: 'missing', src: null }
  if (x.ParamRef) {
    const p = stmt.params.find((q) => q.n === x.ParamRef.number) ?? { origin: 'values-unresolved' }
    return { ...classifySlot(p, { reviewedParents }), src: p.src ?? `$${x.ParamRef.number}` }
  }
  if (x.A_Const) return { verdict: 'refuse', reason: 'sql-literal', src: x.A_Const.sval?.sval ?? JSON.stringify(x.A_Const) }
  if (x.ColumnRef) {
    const parts = (x.ColumnRef.fields ?? []).map((f) => f.String?.sval ?? '*')
    if (parts.length > 1 && functionAliases(sel).has(parts[0])) return { verdict: 'refuse', reason: 'function-row', src: parts.join('.') }
    return { verdict: 'accept', reason: 'sql-column', src: parts.join('.') }
  }
  if (x.FuncCall) return { verdict: 'refuse', reason: 'sql-function', src: (x.FuncCall.funcname ?? []).map((f) => f.String?.sval).join('.') + '()' }
  if (x.SetToDefault) return { verdict: 'refuse', reason: 'default', src: 'DEFAULT' }
  return { verdict: 'refuse', reason: 'unresolved', src: Object.keys(x)[0] ?? null }
}

// One INSERT's verdict for its tenancy column.
function insertVerdict(ins, column, stmt, reviewedParents) {
  const cols = (ins.cols ?? []).map((c) => c.ResTarget?.name)
  const j = cols.indexOf(column)
  if (j < 0) return { verdict: 'refuse', reason: cols.length ? 'missing' : 'no-column-list', src: null }
  const sel = ins.selectStmt?.SelectStmt
  if (!sel) return { verdict: 'refuse', reason: 'default', src: 'DEFAULT VALUES' }
  const exprs = sel.valuesLists
    ? sel.valuesLists.map((r) => r.List?.items?.[j])
    : sel.op && sel.op !== 'SETOP_NONE' ? [null] : [sel.targetList?.[j]?.ResTarget?.val]
  return exprs.map((e) => verdictOf(e, stmt, sel, reviewedParents)).sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0]
}

// Reviewed parent-row variables for one statement: the allowlist's reviewedParents rows for its file and function.
export const reviewedFor = (reviewed, s) => reviewed.filter((r) => r.file === s.file && r.fn === s.fn).map((r) => r.root)

// Every INSERT into an S table in the census: [{key, id, file, fn, line, target, base, column, verdict, reason, src}].
// key = `${statement id}>${target}` (with `#k` when one statement INSERTs into the same target twice).
export function writerFindings(census, classes, { reviewed = [] } = {}) {
  const rows = []
  for (const s of census.statements) {
    const seen = new Map()
    for (const ins of insertStmts(s.ast)) {
      const t = sTarget(classes, relName(ins.relation))
      if (!t) continue
      const k0 = `${s.id}>${t.relation}`
      const n = (seen.get(k0) ?? 0) + 1
      seen.set(k0, n)
      const base = { key: n === 1 ? k0 : `${k0}#${n}`, id: s.id, file: s.file, fn: s.fn, line: s.line, target: t.relation, base: t.base, column: t.column ?? null }
      if (t.unclassed) { rows.push({ ...base, verdict: 'refuse', reason: 'unclassed', src: null }); continue }
      rows.push({ ...base, ...insertVerdict(ins, t.column, s, reviewedFor(reviewed, s)) })
    }
  }
  return rows
}

// The ratchet (§2.4 "Allowlists"): per (file, function) counts, ids as the listing. Returns failure lines.
export const LANE_RE = /^\d\.\d+[a-z]*(-[a-z]+)?( [a-z0-9-]+)? lane$/
const fnOfKey = (key) => { const id = key.slice(0, key.indexOf('>')); return id.slice(0, id.lastIndexOf(':')) }
export function ratchetProblems(rows, allowlist) {
  const entries = allowlist.unstamped
  const refused = rows.filter((r) => r.verdict === 'refuse')
  const have = new Map(refused.map((r) => [r.key, r]))
  const want = new Map(entries.map((e) => [e.key, e]))
  const problems = []
  for (const r of refused.filter((x) => !want.has(x.key))) {
    const fn = fnOfKey(r.key)
    const gone = [...want.keys()].filter((k) => fnOfKey(k) === fn && !have.has(k))
    const countNow = refused.filter((x) => fnOfKey(x.key) === fn).length
    const countListed = entries.filter((e) => fnOfKey(e.key) === fn).length
    problems.push(gone.length && countNow <= countListed
      ? `REPLACEMENT in ${fn} (count ${countNow} <= ${countListed}): replace ${gone[0]} with ${r.key} in ${ALLOWLIST_FILE}`
      : `NEW unstamped INSERT into ${r.target} (${r.reason}${r.src ? `, ${r.src}` : ''}) at ${r.file}:${r.line} ${r.key}: stamp ${r.column} from the parent row the statement reads, or list it with the lane that clears it`)
  }
  for (const [k, e] of want) {
    const r = have.get(k)
    if (!r) { if (!problems.some((p) => p.includes(k))) problems.push(`stale entry in ${ALLOWLIST_FILE} (now stamped or gone): ${k}`); continue }
    if (e.rule !== r.reason) problems.push(`changed: ${k} was listed as ${e.rule}, is now ${r.reason}${r.src ? ` (${r.src})` : ''}: re-review`)
  }
  for (const e of entries) {
    if (!e.reason?.trim()) problems.push(`entry without a reason: ${e.key}`)
    if (!LANE_RE.test(e.lane ?? '')) problems.push(`entry without the lane that clears it (e.g. "4.3 photos lane"): ${e.key}`)
  }
  for (const r of allowlist.reviewedParents ?? []) if (!r.reason?.trim()) problems.push(`reviewed parent without a reason: ${r.file} ${r.fn} ${r.root}`)
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadParser()
  const rows = writerFindings(censusOf(), loadClasses(), { reviewed: loadAllowlist().reviewedParents ?? [] })
  if (process.argv.includes('--refused')) {
    console.log(JSON.stringify(rows.filter((r) => r.verdict === 'refuse').map(({ key, target, reason }) => ({ key, target, rule: reason })), null, 2))
  } else for (const r of rows) console.log([r.verdict, r.reason, r.target, `${r.file}:${r.line}`, r.src ?? ''].join('\t'))
}
