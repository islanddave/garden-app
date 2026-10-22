#!/usr/bin/env node
// The SQL census (V5-SPACEISOLATION-001, multi-space plan V204 step 2.0a, §2.4 "The SQL census"). Spike 1.18's
// extractor (project-state/_multispace-20261015/lanes/S-spike-extract.mjs, report S-spike-1.18.md) made permanent:
// every template literal and string literal in non-test lambda/** that looks like SQL is parsed by the real
// PostgreSQL 17 grammar (libpg-query, exact pin in package.json: a grammar bump changes ASTs and so every id).
// This module only finds things. The rules and their allowlists live in the tests that import it:
//
//   lambda/sql-census.static.test.js   2.0a  unparseable = 0, near-misses, splices, the sql-tag cross-check,
//                                            the workspace_id slot allowlist and the slot-map controls
//   lambda/tenancy-insert.static.test.js  2.2  every INSERT into an S table names workspace_id from a passing slot
//                                            (tests/lib/tenancyInsert.mjs); 5.1's scope test builds on it too.
//
// REGENERATING THE LISTS. `node tests/lib/sqlCensus.mjs` prints the summary; `--near-misses`, `--splices` and
// `--ws-slots` print the paste-ready current entries (no `reason`: carry reasons over by hand); `--root <dir>`
// runs over another checkout (a dir holding lambda/).
//
// METHOD (as the spike, S-spike-1.18.md §2):
//   * Files: lambda/**/*.{js,mjs,cjs} minus *.test.* / *.spec.* / __tests__ / _test-stubs / test(s)/ /
//     node_modules. acorn parses each (module, then script).
//   * Candidates: every TemplateLiteral (tagged or not, so the {text, values} builders are covered), every string
//     Literal longer than 3 characters, and every `+` chain whose leftmost piece looks like SQL. classify() sorts
//     them into statements, fragments and near-misses (a statement verb with no SQL structure: 'DELETE' as an HTTP
//     method, prose).
//   * `${}` → `$n`. Exact for the neon sql`` tag, where every slot is a bound parameter. An untagged template
//     splices text, so for it alone: a slot bound to a string/template const (directly, or through `c ? X : ''` /
//     `c && X`) is INLINED, and a slot the parser rejects is REPAIRED (stepped through ident / empty / `a = a` /
//     `a b`). Each inline and each repair is a splice; the test requires a reviewed entry for each.
//     Untagged slots are numbered from $1001 so they never collide with the literal $1..$n a {text, values}
//     builder writes itself.
//   * Fragments (WHERE…, ON CONFLICT…, a WITH that only declares CTEs) parse inside a minimal host statement.
//
// STABLE IDS, scheme B: `<file>:<function path>:<md5(canonical AST)[0:10]>[#k]`. The function path is the chain
// of enclosing functions joined by `>` (declaration, variable, property, method or assignment name;
// `callee(cbN)` for an inline callback; `anon#N` by order within the parent scope; `<module>` at top level). The
// canonical AST drops location, stmt_location and stmt_len and sorts keys, so whitespace, comments and keyword
// case never move an id, and ids carry no line numbers. `#k` (k ≥ 2) only when one function holds the same AST
// twice. Near-misses get `<file>:<function path>:near:<md5(collapsed text)[0:10]>[#k]`.
//
// THE SLOT MAP. Per statement, `params` has one entry per `$n` in the AST: where its value comes from (`origin`:
// `tag` for a sql`` slot, `splice` for an untagged `${}`, `values` for a {text, values} / .query(text, [..])
// array element, `values-unresolved` when that array is not a literal in reach), the JS source text (`src`), the
// JS AST kind (`kind`), the expression's root identifier and member path (`root`, `path`), `constString` when
// the expression is an Identifier bound to a string, and the SQL columns it is bound to (`columns`: `insert`,
// `set` or `cmp`). Each statement's `workspaceBindings` lists every value bound to workspace_id (a slot, an SQL
// literal, or a column copied in SQL), and classifySlot() is the slot rule (§2.4, QA-B1): accept only an
// expression rooted at the resolver's `scope` or at a reviewed parent-row variable; refuse an Identifier bound to
// a string, any event.* / body.* root, and any path through queryStringParameters. A column copied in SQL
// (INSERT … SELECT t.workspace_id) is the parent-derived stamp itself and is accepted; an SQL literal is refused.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import { loadModule, parseSync } from 'libpg-query'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

let loading = null
// loadModule() is async (the WASM instantiation); call once, before censusOf(). Repeated calls share one load.
export const loadParser = () => (loading ??= loadModule())

// ---------- file set ----------
export const isTestPath = (p) =>
  /\.(test|spec)\.[cm]?js$/.test(p) || /(^|\/)(__tests__|_test-stubs|tests?|node_modules)(\/|$)/.test(p)

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else if (/\.(js|mjs|cjs)$/.test(e)) out.push(p)
  }
  return out
}

// Non-test lambda files, as repo-relative paths with forward slashes, sorted.
export const lambdaFiles = (root = ROOT) =>
  walkFiles(join(root, 'lambda')).map((f) => relative(root, f).split('\\').join('/')).sort().filter((f) => !isTestPath(f))

// ---------- SQL-looking classification ----------
const STMT_LEAD = /^(select|insert|update|delete|with)\b/i
const OTHER_LEAD = /^(begin|commit|rollback|set\s+local|set|create|alter|drop|truncate|lock|refresh|notify|listen|vacuum|analyze|copy|do|call|explain|savepoint|release|grant|revoke|comment\s+on)\b/i
const FRAG_LEAD = /^(where|and|or|not\s+exists|exists|set|order\s+by|group\s+by|limit|offset|having|(left\s+|inner\s+|right\s+|full\s+|cross\s+)?(outer\s+)?join|from|on\s+conflict|do\s+update|do\s+nothing|returning|values|union(\s+all)?|except|intersect|case|coalesce|lateral)\b/i
const STRUCT = { select: /\b(from|as|where|limit|union|returning)\b|\$\d|^select\s+[\w.*'"(]+\s*$/i, insert: /\binto\b/i, update: /\bset\b/i, delete: /\bfrom\b/i, with: /\bas\s+(not\s+)?(materialized\s+)?\(/i }
const SQL_SIGNAL = /(=|\$\d|\$\{|::|\bIS\s+(NOT\s+)?NULL\b|\b(AND|OR|NOT|IN|ANY|ILIKE|LIKE|NULL|EXCLUDED|BETWEEN|DESC|ASC)\b|\w\.\w)/

// Leading whitespace, SQL comments and opening parens are skipped to find the lead keyword.
function leadOf(text) {
  let s = text
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\(/, '')
    if (s === before) return s
  }
}
const caseOk = (w) => w === w.toUpperCase() || w === w.toLowerCase()

export function classify(text, tagged) {
  const s = leadOf(text)
  let m = s.match(STMT_LEAD)
  if (m && caseOk(m[1])) {
    const k = m[1].toLowerCase()
    if (tagged || STRUCT[k].test(s)) return { cls: 'statement', lead: k.toUpperCase() }
    return { cls: 'near-miss', lead: k.toUpperCase() }
  }
  m = s.match(OTHER_LEAD)
  if (m && (tagged || (m[1] === m[1].toUpperCase() && /\s\S/.test(s.trim())))) {
    if (m[1].toLowerCase() !== 'set' || tagged || /^set\s+(local\s+)?[\w.]+\s*(=|to)\b/i.test(s)) return { cls: 'other-stmt', lead: m[1].toUpperCase().replace(/\s+/g, ' ') }
  }
  m = s.match(FRAG_LEAD)
  if (m && caseOk(m[1].split(/\s+/)[0]) && (tagged || m[1] === m[1].toUpperCase() || SQL_SIGNAL.test(s))) {
    const lead = m[1].toUpperCase().replace(/\s+/g, ' ')
    if (lead === 'CASE' && !(/\bwhen\b/i.test(s) && /\bend\b/i.test(s))) return null
    if (/^(AND|OR)$/.test(lead) && !s.trim().slice(lead.length).trim()) return { cls: 'fragment', lead: 'SEPARATOR' }
    return { cls: 'fragment', lead }
  }
  if (tagged && s.trim()) return { cls: 'fragment', lead: 'EXPR' }
  return null
}

// ---------- substitution + parse with slot repair ----------
// Slot i becomes $(base + i + 1): base 0 for a sql`` tag, UNTAGGED_BASE otherwise. When the parser errors at a
// slot, that slot alone steps through the alternatives; each repaired slot is recorded as a splice.
export const UNTAGGED_BASE = 1000
const ALTS = [(n) => `$${n}`, (n) => `__s${n}`, () => '', (n) => `__s${n} = __s${n}`, (n) => `__s${n} __s${n}b`]
const ALT_NAMES = ['$n', 'ident', 'empty', 'assign', 'ident-pair']
function build(quasis, choice, base) {
  let text = ''
  const spans = []
  for (let i = 0; i < quasis.length; i++) {
    text += quasis[i]
    if (i < quasis.length - 1) {
      const sub = ALTS[choice[i]](base + i + 1)
      spans.push([text.length, text.length + sub.length])
      text += sub
    }
  }
  return { text, spans }
}
function parseWithRepair(quasis, base) {
  const nslots = quasis.length - 1
  const choice = new Array(nslots).fill(0)
  let firstErr = null
  for (let attempt = 0; attempt <= nslots * ALTS.length + 2; attempt++) {
    const { text, spans } = build(quasis, choice, base)
    try {
      return { ok: true, ast: parseSync(text), text, choice }
    } catch (e) {
      const pos = e.sqlDetails?.cursorPosition ?? text.length
      if (!firstErr) firstErr = { msg: e.sqlDetails?.message ?? e.message, pos, text }
      if (!nslots) return { ok: false, err: firstErr }
      // The slot holding the error, else the last slot starting before it (the slot that made the next token
      // illegal), else the first; an exhausted slot hands on to the one before it.
      let k = spans.findIndex(([a, b]) => pos >= a && pos <= Math.max(a, b))
      if (k < 0) for (let i = spans.length - 1; i >= 0; i--) if (spans[i][0] <= pos) { k = i; break }
      if (k < 0) k = 0
      while (k >= 0 && choice[k] >= ALTS.length - 1) k--
      if (k < 0) return { ok: false, err: firstErr }
      choice[k]++
    }
  }
  return { ok: false, err: firstErr }
}

// Fragments: wrap by lead keyword in a minimal host statement, then parse.
function wrapFragment(lead, text) {
  const W = {
    WHERE: (f) => [`SELECT 1 FROM __t ${f}`], AND: (f) => [`SELECT 1 FROM __t WHERE true ${f}`], OR: (f) => [`SELECT 1 FROM __t WHERE true ${f}`],
    SET: (f) => [`UPDATE __t ${f}`], 'ON CONFLICT': (f) => [`INSERT INTO __t (a) VALUES (1) ${f}`],
    'DO UPDATE': (f) => [`INSERT INTO __t (a) VALUES (1) ON CONFLICT (a) ${f}`], 'DO NOTHING': (f) => [`INSERT INTO __t (a) VALUES (1) ON CONFLICT (a) ${f}`],
    RETURNING: (f) => [`DELETE FROM __t ${f}`], VALUES: (f) => [`INSERT INTO __t ${f}`, `INSERT INTO __t (a) ${f}`], FROM: (f) => [`SELECT 1 ${f}`],
  }
  const fn = W[lead] || (/JOIN|ORDER BY|GROUP BY|LIMIT|OFFSET|HAVING|LATERAL/.test(lead) ? (f) => [`SELECT 1 FROM __t ${f}`] : /UNION|EXCEPT|INTERSECT/.test(lead) ? (f) => [`SELECT 1 ${f}`] : null)
  const hosts = fn ? fn(text) : []
  hosts.push(`SELECT ${text}`, `SELECT 1 FROM __t WHERE ${text}`, `SELECT 1 FROM __t ${text}`, `SELECT __c FROM __t ORDER BY ${text}`, `UPDATE __t SET ${text}`, `INSERT INTO __t (${text}) VALUES (1)`)
  return hosts
}

// ---------- SQL AST helpers ----------
const DROP_KEYS = new Set(['location', 'stmt_location', 'stmt_len'])
function canon(node) {
  if (Array.isArray(node)) return node.map(canon)
  if (node && typeof node === 'object') {
    const o = {}
    for (const k of Object.keys(node).sort()) if (!DROP_KEYS.has(k)) o[k] = canon(node[k])
    return o
  }
  return node
}
const md5 = (s) => createHash('md5').update(s).digest('hex')
export const astHash = (stmt) => md5(JSON.stringify(canon(stmt)))

// visit(node, fn): fn(key, value, keyPath) for every object below node; keyPath is the chain of keys above it.
function visit(node, fn, path = []) {
  if (Array.isArray(node)) { for (const n of node) visit(n, fn, path); return }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') { fn(k, v, path); visit(v, fn, [...path, k]) }
  }
}
const relName = (rv) => (rv.schemaname ? rv.schemaname + '.' : '') + rv.relname
const colName = (columnRef) => {
  const f = columnRef.fields ?? []
  const last = f[f.length - 1]
  return last?.String?.sval ?? (last?.A_Star ? '*' : null)
}

// Relations a statement names, with CTE names subtracted within their WITH scope: a CTE of a non-recursive WITH
// is visible to the CTEs after it and to the statement body; of a recursive WITH, to all of them. A
// schema-qualified name is never a CTE.
export function relationsOf(stmt) {
  const rels = new Set()
  const ctes = new Set()
  const go = (node, scope) => {
    if (Array.isArray(node)) { for (const n of node) go(n, scope); return }
    if (!node || typeof node !== 'object') return
    let inner = scope
    if (node.withClause?.ctes) {
      const wc = node.withClause
      const names = wc.ctes.map((c) => c.CommonTableExpr?.ctename).filter(Boolean)
      names.forEach((n) => ctes.add(n))
      wc.ctes.forEach((c, i) => go(c.CommonTableExpr?.ctequery, new Set([...scope, ...(wc.recursive ? names : names.slice(0, i))])))
      inner = new Set([...scope, ...names])
    }
    if (typeof node.relname === 'string' && !(node.schemaname == null && scope.has(node.relname))) rels.add(relName(node))
    for (const [k, v] of Object.entries(node)) if (k !== 'withClause' && v && typeof v === 'object') go(v, inner)
  }
  go(stmt, new Set())
  return { relations: [...rels].sort(), ctes: [...ctes].sort() }
}

const PRED_KEYS = new Set(['whereClause', 'quals', 'havingClause'])
const TARGET_KEYS = new Set(['targetList', 'returningList'])
// Where workspace_id appears in a statement: in a predicate (WHERE / JOIN … ON / HAVING), in a target or
// RETURNING list, as an INSERT column, as an UPDATE (or DO UPDATE) SET column, in an ON CONFLICT target.
export function workspacePlacement(stmt) {
  const p = { predicate: false, target: false, insertColumn: false, setColumn: false, conflictTarget: false }
  visit(stmt, (k, v, path) => {
    if (k === 'ColumnRef' && colName(v) === 'workspace_id') {
      for (let i = path.length - 1; i >= 0; i--) {
        if (PRED_KEYS.has(path[i])) { p.predicate = true; break }
        if (TARGET_KEYS.has(path[i])) { p.target = true; break }
      }
    }
    if (k === 'ResTarget' && v.name === 'workspace_id') {
      const [owner, list] = path.slice(-2)
      if (list === 'cols') p.insertColumn = true
      else if (list === 'targetList' && (owner === 'UpdateStmt' || owner === 'onConflictClause')) p.setColumn = true
    }
    if (k === 'IndexElem' && v.name === 'workspace_id') p.conflictTarget = true
  })
  return p
}
// The scope-rule flag (§2.4, 5.1): the statement reads workspace_id only in its target / RETURNING list, so no
// predicate scopes it to a Space.
export const targetOnlyWorkspace = (pl) => pl.target && !pl.predicate && !pl.insertColumn && !pl.setColumn

const paramsIn = (node) => {
  const out = []
  visit(node, (k, v) => { if (k === 'ParamRef') out.push(v.number) })
  return out
}
// Each SQL value bound to a column: INSERT column ← VALUES item / SELECT target; UPDATE and DO UPDATE SET; and a
// comparison of a column with an expression. Returns [{ctx, column, expr}] with expr the SQL node.
export function columnBindings(stmt) {
  const out = []
  visit({ root: stmt }, (k, v) => {
    if (k === 'InsertStmt') {
      const cols = (v.cols ?? []).map((c) => c.ResTarget?.name)
      const sel = v.selectStmt?.SelectStmt
      for (const row of sel?.valuesLists ?? []) (row.List?.items ?? []).forEach((e, j) => cols[j] && out.push({ ctx: 'insert', column: cols[j], expr: e }))
      if (sel && !sel.valuesLists) (sel.targetList ?? []).forEach((t, j) => cols[j] && out.push({ ctx: 'insert', column: cols[j], expr: t.ResTarget?.val }))
    }
    if ((k === 'UpdateStmt' || k === 'onConflictClause') && v.targetList) {
      for (const t of v.targetList) if (t.ResTarget?.name) out.push({ ctx: 'set', column: t.ResTarget.name, expr: t.ResTarget.val })
    }
    if (k === 'A_Expr') {
      for (const [a, b] of [[v.lexpr, v.rexpr], [v.rexpr, v.lexpr]]) {
        const ref = a?.ColumnRef ?? a?.TypeCast?.arg?.ColumnRef
        if (ref && b && !b.ColumnRef) out.push({ ctx: 'cmp', column: colName(ref), expr: b })
      }
    }
  })
  return out
}

// ---------- JS walk ----------
function childrenOf(node) {
  const out = []
  for (const k in node) {
    if (k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x) }
    else if (v && typeof v === 'object' && typeof v.type === 'string') out.push(v)
  }
  return out.sort((a, b) => a.start - b.start)
}
// fn(node, ancestors) for every node in source order; ancestors ends with node itself (acorn-walk's fullAncestor).
function walkAncestors(root, fn) {
  const anc = []
  const go = (n) => {
    anc.push(n)
    fn(n, anc)
    for (const c of childrenOf(n)) go(c)
    anc.pop()
  }
  go(root)
}
const isFn = (n) => /Function/.test(n.type)

function parseJs(code) {
  const base = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true, locations: true }
  try { return acorn.parse(code, { ...base, sourceType: 'module' }) } catch {
    return acorn.parse(code, { ...base, sourceType: 'script' })
  }
}

// An expression's root identifier and member path: scope.workspaceId → root 'scope', path 'scope.workspaceId'.
function describeExpr(e, code, consts, at) {
  if (!e) return { src: null, kind: null, root: null, path: null, constString: false }
  const src = code.slice(e.start, e.end)
  let n = e.type === 'ChainExpression' ? e.expression : e
  const parts = []
  while (n.type === 'MemberExpression') {
    parts.unshift(n.computed ? (n.property.type === 'Literal' ? String(n.property.value) : '[]') : n.property.name)
    n = n.object.type === 'ChainExpression' ? n.object.expression : n.object
  }
  const root = n.type === 'Identifier' ? n.name : n.type === 'ThisExpression' ? 'this' : null
  let constString = false
  if (e.type === 'Identifier' && consts.has(e.name)) {
    const decls = consts.get(e.name)
    const d = decls.filter((x) => x.start < at).pop() ?? decls[0]
    constString = (d.init.type === 'Literal' && typeof d.init.value === 'string') || (d.init.type === 'TemplateLiteral' && !d.init.expressions.length)
  }
  return { src, kind: e.type, root, path: root ? [root, ...parts].join('.') : null, constString }
}

function fnName(node, parent, code) {
  if (node.id?.name) return node.id.name
  if (!parent) return 'anon'
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key)
    return parent.key.name ?? String(parent.key.value)
  if (parent.type === 'AssignmentExpression') return code.slice(parent.left.start, parent.left.end).replace(/\s+/g, '')
  if (parent.type === 'CallExpression' || parent.type === 'NewExpression') return `${code.slice(parent.callee.start, parent.callee.end).replace(/\s+/g, '').slice(0, 40)}(cb${parent.arguments.indexOf(node)})`
  if (parent.type === 'ExportDefaultDeclaration') return 'default'
  return 'anon'
}

// The {text, values} shapes: a template that is the `text` property of an object literal with a sibling
// `values: [..]`, or the first argument of `.query(text, [..])`. Returns the array's elements, or null.
function valuesFor(anc) {
  const node = anc[anc.length - 1]
  const parent = anc[anc.length - 2]
  const gp = anc[anc.length - 3]
  if (parent?.type === 'Property' && parent.value === node && (parent.key.name ?? parent.key.value) === 'text' && gp?.type === 'ObjectExpression') {
    const v = gp.properties.find((p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'values')
    return v?.value.type === 'ArrayExpression' ? v.value.elements : null
  }
  if (parent?.type === 'CallExpression' && parent.arguments[0] === node && parent.callee.type === 'MemberExpression' && parent.callee.property.name === 'query') {
    return parent.arguments[1]?.type === 'ArrayExpression' ? parent.arguments[1].elements : null
  }
  return null
}

// Candidates of one file: [{file, line, start, fn, kind, tag, quasis, slots, inlined, values, inSlot}].
function candidatesOf(file, code) {
  const ast = parseJs(code)
  const cands = []

  // Anonymous-function ordinals: by order of appearance within the parent function scope.
  const anonOrd = new Map()
  const perScope = new Map()
  walkAncestors(ast, (node, anc) => {
    if (!isFn(node) || fnName(node, anc[anc.length - 2], code) !== 'anon') return
    let scope = 'module'
    for (let i = anc.length - 2; i >= 0; i--) if (isFn(anc[i])) { scope = anc[i]; break }
    const n = (perScope.get(scope) ?? 0) + 1
    perScope.set(scope, n)
    anonOrd.set(node, n)
  })
  const scopePath = (anc) => {
    const parts = []
    for (let i = 0; i < anc.length; i++) {
      const a = anc[i]
      if (isFn(a)) {
        const name = fnName(a, anc[i - 1], code)
        parts.push(name === 'anon' ? `anon#${anonOrd.get(a)}` : name)
      }
      if (a.type === 'ClassDeclaration' || a.type === 'ClassExpression') parts.push(a.id?.name ?? 'Class')
    }
    return parts.length ? parts.join('>') : '<module>'
  }

  const consts = new Map()
  walkAncestors(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
      if (!consts.has(n.id.name)) consts.set(n.id.name, [])
      consts.get(n.id.name).push(n)
    }
  })
  const resolveSlot = (e, at, depth = 0) => {
    if (!e || depth > 6) return null
    if (e.type === 'Literal' && typeof e.value === 'string') return { quasis: [e.value], exprs: [] }
    if (e.type === 'TemplateLiteral') return { quasis: e.quasis.map((q) => q.value.cooked ?? q.value.raw), exprs: e.expressions }
    if (e.type === 'ConditionalExpression') {
      for (const b of [e.consequent, e.alternate]) { const r = resolveSlot(b, at, depth + 1); if (r && r.quasis.join('').trim()) return r }
      return null
    }
    if (e.type === 'LogicalExpression' && e.operator === '&&') return resolveSlot(e.right, at, depth + 1)
    if (e.type === 'Identifier' && consts.has(e.name)) {
      const decls = consts.get(e.name)
      const d = decls.filter((x) => x.start < at).pop() ?? decls[0]
      return resolveSlot(d.init, d.start, depth + 1)
    }
    return null
  }
  // Untagged only: inline const-bound slots (recursively), keep the rest as slots (expression nodes).
  const expand = (quasis0, exprs0, at, inlined, depth = 0) => {
    const quasis = [quasis0[0]]
    const slots = []
    exprs0.forEach((e, i) => {
      const r = depth < 6 ? resolveSlot(e, at) : null
      if (r) {
        inlined.push(code.slice(e.start, e.end).slice(0, 60))
        const sub = expand(r.quasis, r.exprs, at, inlined, depth + 1)
        quasis[quasis.length - 1] += sub.quasis[0]
        for (let j = 1; j < sub.quasis.length; j++) { slots.push(sub.slots[j - 1]); quasis.push(sub.quasis[j]) }
      } else { slots.push(e); quasis.push('') }
      quasis[quasis.length - 1] += quasis0[i + 1]
    })
    return { quasis, slots }
  }
  const describe = (e) => describeExpr(e, code, consts, e?.start ?? 0)

  // '+' chains whose leftmost string looks like SQL become one candidate; their pieces are consumed.
  const consumed = new Set()
  walkAncestors(ast, (node, anc) => {
    if (node.type !== 'BinaryExpression' || node.operator !== '+') return
    const parent = anc[anc.length - 2]
    if (parent?.type === 'BinaryExpression' && parent.operator === '+') return
    const parts = []
    const flat = (n) => { if (n.type === 'BinaryExpression' && n.operator === '+') { flat(n.left); flat(n.right) } else parts.push(n) }
    flat(node)
    const first = parts[0]
    const firstText = first.type === 'Literal' && typeof first.value === 'string' ? first.value : first.type === 'TemplateLiteral' ? first.quasis[0].value.cooked : null
    if (firstText == null || !classify(firstText, false)) return
    for (const p of parts) consumed.add(p)
    const quasis = ['']
    const exprs = []
    for (const p of parts) {
      if (p.type === 'Literal' && typeof p.value === 'string') quasis[quasis.length - 1] += p.value
      else if (p.type === 'TemplateLiteral') {
        p.quasis.forEach((q, i) => { quasis[quasis.length - 1] += q.value.cooked; if (i < p.expressions.length) { exprs.push(p.expressions[i]); quasis.push('') } })
      } else { exprs.push(p); quasis.push('') }
    }
    const inlined = []
    const ex = expand(quasis, exprs, node.start, inlined)
    cands.push({ file, line: node.loc.start.line, start: node.start, fn: scopePath(anc), kind: 'concat', tag: null, quasis: ex.quasis, slots: ex.slots.map(describe), inlined, values: null, inSlot: false })
  })

  walkAncestors(ast, (node, anc) => {
    if (consumed.has(node)) return
    const parent = anc[anc.length - 2]
    let inSlot = false
    for (let i = anc.length - 2; i >= 0; i--) if (anc[i].type === 'TemplateLiteral' && anc[i].expressions.some((e) => e.start <= node.start && node.end <= e.end)) { inSlot = true; break }
    if (node.type === 'TemplateLiteral') {
      const tag = parent?.type === 'TaggedTemplateExpression' && parent.quasi === node ? code.slice(parent.tag.start, parent.tag.end) : null
      const q0 = node.quasis.map((q) => q.value.cooked ?? q.value.raw)
      const inlined = []
      const ex = tag ? { quasis: q0, slots: node.expressions } : expand(q0, node.expressions, node.start, inlined)
      const values = tag ? null : valuesFor(anc)
      cands.push({ file, line: node.loc.start.line, start: node.start, fn: scopePath(anc), kind: tag ? 'tagged' : 'template', tag, quasis: ex.quasis, slots: ex.slots.map(describe), inlined, values: values && values.map(describe), inSlot })
    } else if (node.type === 'Literal' && typeof node.value === 'string' && node.value.length > 3) {
      if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') return
      if (parent?.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'require') return
      const values = valuesFor(anc)
      cands.push({ file, line: node.loc.start.line, start: node.start, fn: scopePath(anc), kind: 'string', tag: null, quasis: [node.value], slots: [], inlined: [], values: values && values.map(describe), inSlot })
    }
  })
  return cands
}

// ---------- per-statement analysis ----------
function onConflictOf(stmt) {
  const out = []
  visit({ root: stmt }, (k, v) => {
    if (k !== 'InsertStmt' || !v.onConflictClause) return
    const oc = v.onConflictClause
    const inf = oc.infer
    let form = 'untargeted'
    let cols = null
    if (inf?.conname) form = 'on-constraint'
    else if (inf?.indexElems?.length) {
      form = 'columns'
      cols = inf.indexElems.map((e) => e.IndexElem?.name ?? (e.IndexElem?.expr ? 'expr' : '?'))
    }
    out.push({ target: relName(v.relation), form, cols, conname: inf?.conname ?? null, partial: !!inf?.whereClause, action: oc.action, loc: oc.location })
  })
  return out
}

// The value behind one $n (see THE SLOT MAP above).
function paramSource(rec, n) {
  if (rec.sqlTag) return { origin: 'tag', ...(rec.slots[n - 1] ?? {}) }
  if (n > UNTAGGED_BASE) return { origin: 'splice', ...(rec.slots[n - UNTAGGED_BASE - 1] ?? {}) }
  if (rec.values) return rec.values[n - 1] ? { origin: 'values', ...rec.values[n - 1] } : { origin: 'values-unresolved', src: null, kind: null, root: null, path: null, constString: false }
  return { origin: 'values-unresolved', src: null, kind: null, root: null, path: null, constString: false }
}

function analyseStmt(rec, stmt) {
  const { relations, ctes } = relationsOf(stmt)
  const bindings = columnBindings(stmt)
  const nums = [...new Set(paramsIn(stmt))].sort((a, b) => a - b)
  const params = nums.map((n) => ({
    n,
    ...paramSource(rec, n),
    columns: bindings.filter((b) => paramsIn(b.expr).includes(n)).map(({ ctx, column }) => ({ ctx, column })),
  }))
  const ws = bindings.filter((b) => b.column === 'workspace_id').map(({ ctx, expr }) => {
    const ps = paramsIn(expr)
    if (ps.length) return { ctx, value: params.find((p) => p.n === ps[0]) }
    const c = expr?.A_Const ?? expr?.TypeCast?.arg?.A_Const
    if (c) return { ctx, value: { origin: 'sql-literal', src: c.sval?.sval ?? JSON.stringify(c), kind: 'A_Const' } }
    const ref = expr?.ColumnRef ?? expr?.TypeCast?.arg?.ColumnRef
    if (ref) return { ctx, value: { origin: 'sql-column', src: (ref.fields ?? []).map((f) => f.String?.sval ?? '*').join('.'), kind: 'ColumnRef' } }
    return { ctx, value: { origin: 'sql-expr', src: null, kind: Object.keys(expr ?? {})[0] ?? null } }
  })
  const placement = workspacePlacement(stmt)
  return {
    type: Object.keys(stmt)[0],
    relations,
    ctes,
    mentionsWs: Object.values(placement).some(Boolean),
    placement,
    onConflict: onConflictOf(stmt),
    params,
    workspaceBindings: ws,
    astHash: astHash(stmt),
    ast: stmt,
  }
}

// ---------- the slot rule ----------
export const REQUEST_ROOTS = Object.freeze(['event', 'body'])
// verdict 'accept' or 'refuse', with the reason. reviewedParents: parent-row variable names a reviewer accepted.
export function classifySlot(value, { reviewedParents = [] } = {}) {
  if (!value || value.origin === 'sql-literal') return { verdict: 'refuse', reason: 'sql-literal' }
  // Copied from a column in SQL (INSERT … SELECT t.workspace_id): the parent-derived stamp itself (R1), no slot.
  if (value.origin === 'sql-column') return { verdict: 'accept', reason: 'sql-column' }
  if (value.origin === 'sql-expr' || value.origin === 'values-unresolved') return { verdict: 'refuse', reason: 'unresolved' }
  if (value.path && value.path.split('.').includes('queryStringParameters')) return { verdict: 'refuse', reason: 'request-root' }
  if (REQUEST_ROOTS.includes(value.root)) return { verdict: 'refuse', reason: 'request-root' }
  if (value.constString) return { verdict: 'refuse', reason: 'string-const' }
  if (value.root === 'scope' && value.kind === 'MemberExpression') return { verdict: 'accept', reason: 'scope' }
  if (value.root && reviewedParents.includes(value.root)) return { verdict: 'accept', reason: 'reviewed-parent' }
  return { verdict: 'refuse', reason: 'unreviewed-root' }
}

// ---------- the census ----------
const collapse = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()

// censusOf({root, files, read}): loadParser() must have resolved. `read(file)` returns the source (default: the
// file under root), so a test can feed a rewritten or planted tree without touching disk.
export function censusOf({ root = ROOT, files = lambdaFiles(root), read = (f) => readFileSync(join(root, f), 'utf8') } = {}) {
  const T0 = performance.now()
  const jsErrors = []
  const candidates = []
  const tagTextCount = {}
  for (const file of files) {
    const code = read(file)
    // The crude cross-check: sql`…` openings in the file text, whole-line comments dropped, counted without
    // any parser, so it still counts when the extractor goes blind.
    const text = code.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
    tagTextCount[file] = (text.match(/(?:^|[^\w$])sql`/g) || []).length
    try { candidates.push(...candidatesOf(file, code)) } catch (e) { jsErrors.push({ file, err: e.message }) }
  }
  candidates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start))

  const records = []
  const nearMisses = []
  let parseCalls = 0
  for (const c of candidates) {
    const sqlTag = !!c.tag && /(^|\.)sql$/.test(c.tag)
    const joined = c.quasis.join('${}')
    let k = classify(joined, sqlTag)
    if (!k && c.inSlot && joined.trim() && SQL_SIGNAL.test(joined) && /^[\s(]*[A-Z_]{2,}\b/.test(joined) && /\b(AND|OR|WHERE|SET|JOIN|ORDER|LIMIT|IS|NULL|IN|ANY|COALESCE|EXCLUDED|DESC|ASC)\b/.test(joined)) k = { cls: 'fragment', lead: 'SLOT' }
    if (!k) continue
    if (k.cls === 'near-miss') { nearMisses.push({ file: c.file, line: c.line, fn: c.fn, lead: k.lead, text: collapse(leadOf(joined)).slice(0, 70) }); continue }
    const base = sqlTag ? 0 : UNTAGGED_BASE
    const rec = { file: c.file, line: c.line, fn: c.fn, kind: c.kind, tag: c.tag, sqlTag, cls: k.cls, lead: k.lead, slots: c.slots, values: c.values, inlined: c.inlined, splices: [] }
    // A WITH that only declares CTEs (spliced in front of a statement elsewhere) is a prefix fragment.
    if (k.lead === 'WITH') {
      const strict = build(c.quasis, new Array(c.quasis.length - 1).fill(0), base).text
      let whole = true
      parseCalls++
      try { parseSync(strict) } catch { whole = false }
      if (!whole) {
        parseCalls++
        try { parseSync(strict + ' SELECT 1'); k = { cls: 'fragment', lead: 'WITH-PREFIX' }; rec.cls = k.cls; rec.lead = k.lead } catch { /* stays a statement */ }
      }
    }
    if (k.lead === 'SEPARATOR') { rec.text = c.quasis.join(''); rec.status = 'fragment-separator'; records.push(rec); continue }
    if (k.cls === 'fragment') {
      const strict = build(c.quasis, new Array(c.quasis.length - 1).fill(0), base).text
      rec.text = strict
      rec.status = 'fragment-unparsed'
      for (const host of k.lead === 'WITH-PREFIX' ? [strict + ' SELECT 1'] : wrapFragment(k.lead, strict)) {
        parseCalls++
        try { parseSync(host); rec.status = 'fragment-parsed'; rec.host = host; break } catch { /* next host */ }
      }
      if (rec.status === 'fragment-unparsed') {
        parseCalls++
        const r = parseWithRepair(c.quasis.map((q, i) => (i === 0 ? wrapFragment(k.lead, '')[0].trimEnd() + ' ' + q : q)), base)
        if (r.ok) { rec.status = 'fragment-parsed'; rec.host = r.text; rec.repaired = true }
      }
      rec.hasOnConflict = /\bon\s+conflict\b/i.test(strict.replace(/--[^\n]*/g, ''))
    } else {
      parseCalls++
      const r = parseWithRepair(c.quasis, base)
      if (r.ok) {
        rec.text = r.text
        rec.status = r.choice.some((x) => x) ? 'parsed-repaired' : 'parsed'
        rec.splices = r.choice.map((x, i) => (x ? { slot: i + 1, expr: (c.slots[i]?.src ?? '').slice(0, 60), as: ALT_NAMES[x] } : null)).filter(Boolean)
        rec.stmts = r.ast.stmts.map((s, i) => ({ idx: i, ...analyseStmt(rec, s.stmt) }))
      } else {
        rec.text = build(c.quasis, new Array(c.quasis.length - 1).fill(0), base).text
        rec.status = 'unparseable'
        rec.error = r.err.msg
        rec.errAt = r.err.text.slice(Math.max(0, r.err.pos - 25), r.err.pos + 25).replace(/\s+/g, ' ')
      }
    }
    records.push(rec)
  }

  // Scheme B ids, in source order per file.
  const seen = new Map()
  const nextId = (base) => { const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return n === 1 ? base : `${base}#${n}` }
  const statements = []
  for (const r of records) for (const s of r.stmts ?? []) {
    s.id = nextId(`${r.file}:${r.fn}:${s.astHash.slice(0, 10)}`)
    statements.push(Object.assign(s, { file: r.file, line: r.line, fn: r.fn, record: r }))
  }
  for (const m of nearMisses) m.id = nextId(`${m.file}:${m.fn}:near:${md5(m.text).slice(0, 10)}`)

  const by = (arr, f) => arr.reduce((acc, x) => ((acc[f(x)] = (acc[f(x)] ?? 0) + 1), acc), {})
  const stmtRecs = records.filter((r) => r.cls !== 'fragment')
  const frags = records.filter((r) => r.cls === 'fragment')
  const onConflict = statements.flatMap((s) => s.onConflict.map((oc) => ({ ...oc, file: s.file, line: s.line, fn: s.fn, id: s.id })))
  const tagCensusCount = by(records.filter((r) => r.sqlTag), (r) => r.file)
  const summary = {
    node: process.version,
    files: { nonTest: files.length, jsParseErrors: jsErrors.length },
    candidates: records.length,
    byKind: by(records, (r) => r.kind),
    statementLiterals: { total: stmtRecs.length, status: by(stmtRecs, (r) => r.status), parsedStatements: statements.length, byType: by(statements, (s) => s.type), withSplices: records.filter((r) => r.splices.length || r.inlined.length).length },
    fragments: { total: frags.length, status: by(frags, (r) => r.status) },
    unparseable: records.filter((r) => r.status === 'unparseable' || r.status === 'fragment-unparsed').length,
    nearMisses: nearMisses.length,
    onConflict: { statements: onConflict.length, byForm: by(onConflict, (o) => o.form), byAction: by(onConflict, (o) => o.action), files: new Set(onConflict.map((o) => o.file)).size },
    mentionsWorkspaceId: statements.filter((s) => s.mentionsWs).length,
    workspaceTargetOnly: statements.filter((s) => targetOnlyWorkspace(s.placement)).length,
    ids: { unique: new Set(statements.map((s) => s.id)).size, withDupSuffix: statements.filter((s) => /#\d+$/.test(s.id)).length },
    ms: { total: +(performance.now() - T0).toFixed(1), parseCalls },
  }
  return { summary, jsErrors, records, statements, nearMisses, onConflict, tagTextCount, tagCensusCount }
}

// Splice listing: one entry per statement whose untagged slots were inlined or repaired.
export const splicesOf = (census) =>
  census.statements.filter((s) => s.record.inlined.length || s.record.splices.length).map((s) => ({
    id: s.id, file: s.file, fn: s.fn,
    inlined: s.record.inlined,
    repaired: s.record.splices.map((x) => `${x.expr} as ${x.as}`),
  }))

// workspace_id bindings with their slot-rule verdicts, one row per binding. opts is classifySlot's, or a function of
// the statement returning them (the reviewed parents are per file and function: tests/tenancy-insert-allowlist.json).
export const workspaceSlotsOf = (census, opts) =>
  census.statements.flatMap((s) => s.workspaceBindings.map((b) => ({ id: s.id, file: s.file, fn: s.fn, ctx: b.ctx, src: b.value?.src ?? null, origin: b.value?.origin ?? null, ...classifySlot(b.value, typeof opts === 'function' ? opts(s) : opts) })))

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--root')
  const root = at >= 0 ? resolve(argv[at + 1]) : ROOT
  await loadParser()
  const census = censusOf({ root })
  const show = (x) => console.log(JSON.stringify(x, null, 2))
  if (argv.includes('--near-misses')) show(census.nearMisses.map(({ id, line, text }) => ({ id, line, text })))
  else if (argv.includes('--splices')) show(splicesOf(census))
  else if (argv.includes('--ws-slots')) show(workspaceSlotsOf(census))
  else if (argv.includes('--ids')) console.log(census.statements.map((s) => s.id).join('\n'))
  else show(census.summary)
}
