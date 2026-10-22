#!/usr/bin/env node
// The prosrc census (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.2, §2.4 "Writers", DSA-21, MF1). Every
// INSERT inside a public or gv function body, with its target, its column list, and whether it names workspace_id
// and from what. A function that INSERTs into an S table (or entity) without naming the column relies on the
// column DEFAULT (the original Space): that is the count 5.7's G2 precondition reads, and each such writer needs a
// decision in tests/tenancy-prosrc-decisions.json (lambda/tenancy-prosrc.static.test.js holds the two equal).
//
// This module only analyses bodies. The catalog read is scripts/tenancy-prosrc-census.py (read-only, URL by key
// name), which pipes the bodies here and writes tests/tenancy-prosrc.prod.json:
//   node tests/lib/prosrcCensus.mjs --analyze <bodies.json>     # census JSON on stdout
//   node tests/lib/prosrcCensus.mjs --file <migration.sql>      # the INSERTs of each CREATE FUNCTION in a file
//
// METHOD. A body is scanned once with comments, quoted strings, quoted identifiers and dollar quotes masked, and cut
// at every `;` outside parentheses. A piece that holds an INSERT is parsed by the real PostgreSQL 17 grammar
// (libpg-query, the 2.0a pin) from each statement keyword at depth 0 in turn (WITH, INSERT, SELECT, UPDATE, DELETE),
// so PL/pgSQL around it (BEGIN, IF … THEN, RETURN QUERY) is skipped; a trailing PL/pgSQL `RETURNING … INTO var` is
// cut first. Every InsertStmt in the parse tree is one row, CTE INSERTs included. An INSERT the grammar cannot read
// is a row with `unparsed: true` and the target read off the text, so nothing is dropped silently. An EXECUTE whose
// string mentions INSERT is listed as dynamic: its target cannot be read statically.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseSync } from 'libpg-query'
import { loadParser } from './sqlCensus.mjs'
import { sTables, sTarget } from './tenancyInsert.mjs'

export { loadParser }
export const md5 = (s) => createHash('md5').update(s).digest('hex')

// Mask comments, strings, quoted identifiers and dollar quotes with spaces (same length, so offsets hold).
export function mask(src) {
  const out = src.split('')
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '-' && n === '-') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; blank(i, j); i = j; continue }
    if (c === '/' && n === '*') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth) { if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2 } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2 } else j++ }
      blank(i, j); i = j; continue
    }
    if (c === "'") {
      const esc = /[eE]/.test(src[i - 1] ?? '') && !/[\w$]/.test(src[i - 2] ?? '')
      let j = i + 1
      while (j < src.length) {
        if (esc && src[j] === '\\') { j += 2; continue }
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      blank(i + 1, j); i = j + 1; continue
    }
    if (c === '"') { let j = src.indexOf('"', i + 1); if (j < 0) j = src.length; blank(i + 1, j); i = j + 1; continue }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i))
      if (m && !/[\w$]/.test(src[i - 1] ?? '')) {
        const end = src.indexOf(m[0], i + m[0].length)
        const j = end < 0 ? src.length : end
        blank(i + m[0].length, j); i = j + m[0].length; continue
      }
    }
    i++
  }
  return out.join('')
}

// Pieces of a body: [start, end) cut at each `;` at paren depth 0 of the masked text.
function pieces(masked) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) { out.push([start, i]); start = i + 1 }
  }
  if (masked.slice(start).trim()) out.push([start, masked.length])
  return out
}

const LEADS = /\b(with|insert|select|update|delete)\b/gi
const relName = (rv) => (rv.schemaname ? rv.schemaname + '.' : '') + rv.relname
// An unqualified name in a function body resolves through its search_path; every public/gv body this census reads
// names public tables either qualified or unqualified with public on the path, so unqualified means public.
export const qualifyRel = (rel) => (rel.includes('.') ? rel : `public.${rel}`)

// Describe the SQL expression bound to a column: what a reader needs to tell a parent-derived stamp from a DEFAULT.
function describe(e) {
  if (!e) return { kind: 'none', src: null }
  const x = e.TypeCast?.arg ?? e
  if (x.ColumnRef) {
    const parts = (x.ColumnRef.fields ?? []).map((f) => f.String?.sval ?? '*')
    // One field: a column of the FROM list or a PL/pgSQL variable; two or more: alias.column or NEW.column.
    return { kind: parts.length > 1 ? (/^(new|old)$/i.test(parts[0]) ? 'trigger-row' : 'column') : 'column-or-variable', src: parts.join('.') }
  }
  if (x.FuncCall) {
    const name = (x.FuncCall.funcname ?? []).map((f) => f.String?.sval).join('.')
    return { kind: 'function', src: `${name}()` }
  }
  if (x.A_Const) return { kind: 'literal', src: x.A_Const.sval?.sval ?? (x.A_Const.isnull ? 'NULL' : JSON.stringify(x.A_Const)) }
  if (x.ParamRef) return { kind: 'param', src: `$${x.ParamRef.number}` }
  if (x.SetToDefault) return { kind: 'default', src: 'DEFAULT' }
  return { kind: 'expression', src: Object.keys(x)[0] ?? null }
}

// The value(s) an InsertStmt binds to `column`: one per VALUES row, or the SELECT target at its position.
function valuesOf(ins, column) {
  const cols = (ins.cols ?? []).map((c) => c.ResTarget?.name)
  const j = cols.indexOf(column)
  if (j < 0) return null
  const sel = ins.selectStmt?.SelectStmt
  if (!sel) return [{ kind: 'default', src: 'DEFAULT VALUES' }]
  if (sel.valuesLists) return sel.valuesLists.map((r) => describe(r.List?.items?.[j]))
  if (sel.op && sel.op !== 'SETOP_NONE') return [{ kind: 'expression', src: sel.op }]
  return [describe(sel.targetList?.[j]?.ResTarget?.val)]
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

function parsePiece(text) {
  const tries = [text]
  if (/\breturning\b/i.test(mask(text))) tries.push(text.replace(/\binto\s+(strict\s+)?[a-z_][\w.]*(\s*,\s*[a-z_][\w.]*)*\s*$/i, ''))
  for (const t of tries) { try { return parseSync(t) } catch { /* next */ } }
  return null
}

// The INSERTs of one body: [{target, columns, workspace: {named, values}, unparsed?}], in body order.
export function insertsOfBody(src) {
  const masked = mask(src)
  const rows = []
  const dynamic = []
  for (const [a, b] of pieces(masked)) {
    const m = masked.slice(a, b)
    if (/\bexecute\b/i.test(m) && /insert\s+into/i.test(src.slice(a, b))) dynamic.push(src.slice(a, b).replace(/\s+/g, ' ').trim().slice(0, 160))
    if (!/\binsert\s+into\b/i.test(m)) continue
    let tree = null
    for (const lead of m.matchAll(LEADS)) {
      tree = parsePiece(src.slice(a + lead.index, b))
      if (tree && insertStmts(tree).length) break
      tree = null
    }
    if (!tree) {
      for (const t of m.matchAll(/\binsert\s+into\s+([\w.]+)/gi)) rows.push({ target: qualifyRel(t[1].toLowerCase()), columns: null, workspace: null, unparsed: true })
      continue
    }
    for (const ins of insertStmts(tree)) {
      const columns = (ins.cols ?? []).map((c) => c.ResTarget?.name)
      const values = valuesOf(ins, 'workspace_id')
      rows.push({
        target: qualifyRel(relName(ins.relation)),
        columns: columns.length ? columns : null,
        workspace: values ? { named: true, values } : { named: false, values: [] },
      })
    }
  }
  return { inserts: rows, dynamic }
}

// The census of a catalog read: functions [{schema, name, args, lang, md5, triggers, src}] → the committed shape.
// Bodies that hold an INSERT are kept (so the static test can re-run this analysis over them); others carry md5 only.
export function censusOfFunctions(functions, meta = {}) {
  const out = []
  for (const f of [...functions].sort((x, y) => key(x).localeCompare(key(y)))) {
    const { inserts, dynamic } = insertsOfBody(f.src)
    const row = { function: key(f), lang: f.lang, md5: f.md5 ?? md5(f.src), triggers: f.triggers ?? [] }
    if (inserts.length || dynamic.length) Object.assign(row, { inserts, dynamic, src: f.src })
    out.push(row)
  }
  return { ...meta, functions: out }
}
export const key = (f) => `${f.schema}.${f.name}(${f.args})`

// CREATE [OR REPLACE] FUNCTION … AS $tag$ body $tag$ in a migration file: [{function, body}] with the body exactly as
// prosrc will hold it (the text between the dollar quotes).
export function functionsInFile(text) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(([^)]*)\)[\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)/gi
  for (const m of text.matchAll(re)) {
    const start = m.index + m[0].length
    const end = text.indexOf(m[3], start)
    if (end < 0) continue
    out.push({ function: m[1], args: m[2].replace(/\s+/g, ' ').trim(), body: text.slice(start, end) })
  }
  return out
}

// ---------- the decisions check (lambda/tenancy-prosrc.static.test.js) ----------
export const DECISIONS_FILE = 'tests/tenancy-prosrc-decisions.json'
export const CENSUS_FILE = 'tests/tenancy-prosrc.prod.json'
export const ENTITY = 'public.entity'
const PARENT_KINDS = new Set(['column', 'trigger-row', 'column-or-variable'])

// The census's INSERTs into S tables (views resolved) and entity: [{function, md5, table, inserts: [row]}].
export function tenancyWriters(census, classes) {
  const s = sTables(classes)
  const out = new Map()
  for (const f of census.functions) {
    for (const ins of f.inserts ?? []) {
      const t = sTarget(classes, ins.target)
      const table = t && !t.unclassed ? t.base : ins.target === ENTITY ? ENTITY : null
      if (!table || (table !== ENTITY && !s.has(table))) continue
      const k = `${f.function}>${table}`
      if (!out.has(k)) out.set(k, { function: f.function, md5: f.md5, table, inserts: [] })
      out.get(k).inserts.push(ins)
    }
  }
  return [...out.values()]
}

// DEFAULT-reliant: an S-table or entity INSERT that does not name workspace_id (5.7's G2 precondition: none).
export const defaultReliant = (writers) => writers.flatMap((w) => w.inserts.filter((i) => !i.workspace?.named).map(() => `${w.function}>${w.table}`))

// Every disagreement between the census, the decisions and the class file. read(path) returns a repo file's text.
export function decisionProblems(census, decisions, classes, read) {
  const problems = []
  const want = new Set([...sTables(classes).keys(), ENTITY])
  const tables = decisions.tables
  for (const t of want) if (!tables[t]) problems.push(`S table ${t} has no census decision: add it to ${DECISIONS_FILE} (writers [] if no function writes it)`)
  for (const t of Object.keys(tables)) if (!want.has(t)) problems.push(`decision for ${t}, which lambda/tenancy-classes.json does not class S (and is not entity): remove it or re-class`)
  const writers = tenancyWriters(census, classes)
  for (const w of writers) {
    if (!tables[w.table]?.writers?.some((d) => d.function === w.function)) problems.push(`function INSERT into ${w.table} with no decision: ${w.function} (stamp it from its parent row, or allowlist it with its lane)`)
  }
  for (const [table, d] of Object.entries(tables)) {
    for (const e of d.writers ?? []) {
      const w = writers.find((x) => x.function === e.function && x.table === table)
      const at = `${table} ${e.function}`
      if (!w) { problems.push(`stale decision (the census has no such INSERT): ${at}`); continue }
      if (!e.reason?.trim()) problems.push(`decision without a reason: ${at}`)
      const valuesOk = (ins) => ins.workspace?.named && ins.workspace.values.every((v) => PARENT_KINDS.has(v.kind) && v.src === e.value)
      if (e.status === 'stamped') {
        if (!w.inserts.every(valuesOk)) problems.push(`${at}: decided stamped from ${e.value}, the census shows ${JSON.stringify(w.inserts.map((i) => i.workspace))}`)
      } else if (e.status === 'allowlisted') {
        if (!/^\d\.\d+[a-z]*(-[a-z]+)?( [a-z0-9-]+)? lane$/.test(e.lane ?? '')) problems.push(`${at}: an allowlisted writer names the lane that clears it (e.g. "2.6 lane")`)
      } else if (e.status === 'rewritten') {
        if (![e.from_md5, e.to_md5].includes(w.md5)) problems.push(`${at}: census body md5 ${w.md5} is neither ${e.from_md5} (before ${e.stamp}) nor ${e.to_md5} (after): re-read the body`)
        if (w.md5 === e.to_md5 && !w.inserts.every(valuesOk)) problems.push(`${at}: the census shows the rewritten body (${e.to_md5}) not naming workspace_id from ${e.value}`)
        let text = null
        try { text = read(e.file) } catch { problems.push(`${at}: ${e.file} not found`) }
        if (text != null) {
          const name = e.function.slice(0, e.function.indexOf('('))
          const fn = functionsInFile(text).find((f) => f.function === name)
          if (!fn) problems.push(`${at}: ${e.file} does not CREATE ${name}`)
          else {
            if (md5(fn.body) !== e.to_md5) problems.push(`${at}: ${e.file}'s body md5 is ${md5(fn.body)}, the decision pins ${e.to_md5}`)
            const mine = insertsOfBody(fn.body).inserts.filter((i) => (sTarget(classes, i.target)?.base ?? i.target) === table)
            if (!mine.length || !mine.every(valuesOk)) problems.push(`${at}: ${e.file}'s INSERT into ${table} does not name workspace_id from ${e.value}: ${JSON.stringify(mine.map((i) => i.workspace))}`)
          }
          if (!text.includes(`'${e.from_md5}'`)) problems.push(`${at}: ${e.file} has no definition pre-gate on ${e.from_md5}`)
          if (!text.includes(`'${e.stamp}'`)) problems.push(`${at}: ${e.file} does not write its stamp ${e.stamp}`)
        }
      } else problems.push(`${at}: unknown status ${e.status}`)
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  await loadParser()
  if (argv[0] === '--analyze') {
    const input = JSON.parse(readFileSync(argv[1] ?? 0, 'utf8'))
    console.log(JSON.stringify(censusOfFunctions(input.functions, input.meta ?? {}), null, 1))
  } else if (argv[0] === '--file') {
    const text = readFileSync(argv[1], 'utf8')
    for (const f of functionsInFile(text)) console.log(JSON.stringify({ function: f.function, md5: md5(f.body), ...insertsOfBody(f.body) }))
  } else {
    console.log('usage: prosrcCensus.mjs --analyze <bodies.json> | --file <migration.sql>')
  }
}
