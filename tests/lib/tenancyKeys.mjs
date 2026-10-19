#!/usr/bin/env node
// The keys instruments' checks (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.0e, §2.4 "Unique keys and
// upserts"). Pure functions over the SQL census (tests/lib/sqlCensus.mjs), the class file
// (lambda/tenancy-classes.json), the exemption file (scripts/tenancy-index-exemptions.json) and the committed
// unique-index snapshot (tests/tenancy-unique-indexes.prod.json, written by scripts/tenancy-index-snapshot.py).
// The rules live in lambda/tenancy-keys.static.test.js; this module only computes what each rule compares.
//
// THE INDEX RULE (the gate post_s_unique_indexes_carry_workspace is the same rule in SQL, over pg_index). A unique
// index on a table whose class is in scope passes when it is the single-column primary key on `id` (class 1),
// or, unless it is NULLS NOT DISTINCT, when
//   S  (any 'S …' class)     a key column is workspace_id or the table's tenancy column;
//   D  (any 'D …' class)     a key column is workspace_id or the tenancy column; on 'D via plot' space_id or
//                            plot_id (§2.2); or its leading key column alone carries a single-column FK into a
//                            table whose class is S or D;
//   C  ('C base + private')  a key column is workspace_id, or the predicate holds a bare top-level `is_base`
//                            conjunct (no OR anywhere in it).
// Anything else must be listed in the exemption file with its class (2-6).
//
// `node tests/lib/tenancyKeys.mjs --values` prints the two VALUES lists the gate carries (the in-scope class map,
// then the exemptions), ready to paste between the markers; `--violations` prints the snapshot's indexes that
// fail the rule, exempt or not.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './sqlCensus.mjs'
import { loadClasses, qualify } from './tenancyClasses.mjs'

export const EXEMPTIONS_FILE = 'scripts/tenancy-index-exemptions.json'
export const SNAPSHOT_FILE = 'tests/tenancy-unique-indexes.prod.json'
export const GATE_DIR = 'migrations/v5-tenancykeys-001'
export const STAMP = '5.3.12-tenancykeys-001'
export const VALUES_FILES = [`${GATE_DIR}/gates.yml`, `${GATE_DIR}/0a-stamp.sql`]
export const CLASS_MARKERS = ['-- BEGIN tenancy-keys classes VALUES', '-- END tenancy-keys classes VALUES']
export const EXEMPTION_MARKERS = ['-- BEGIN tenancy-index-exemptions VALUES', '-- END tenancy-index-exemptions VALUES']

const TABLE_KINDS = new Set(['r', 'p', 'm', 'f'])
const ENTRY_KEYS = new Set(['table', 'index', 'class', 'reason', 'route', 'row', 'pending'])

const readJson = (root, f) => JSON.parse(readFileSync(join(root, f), 'utf8'))
export const loadExemptions = (root = ROOT) => readJson(root, EXEMPTIONS_FILE)
export const loadIndexSnapshot = (root = ROOT) => readJson(root, SNAPSHOT_FILE)
export { loadClasses }

export const arm = (cls) => (cls?.startsWith('S') ? 'S' : cls?.startsWith('D') ? 'D' : cls === 'C base + private' ? 'C' : null)
export const inScope = (cls) => arm(cls) !== null

// A bare top-level `is_base` conjunct, as pg_get_expr prints it: `is_base`, `(is_base AND …)`, `(… AND is_base)`.
export const basePredicate = (pred) => !!pred && /(^|\(|AND )is_base( AND |\)|$)/.test(pred) && !/\bOR\b/i.test(pred)

// Which arm an index passes by, or null. `rel` is its snapshot relation (for the leading-column FKs).
export function passesBy(classes, relName, rel, idx) {
  const row = classes.relations[relName]
  const a = arm(row?.class)
  if (!a) return 'out of scope'
  const cols = idx.keys.filter((k) => typeof k === 'string')
  if (idx.primary && idx.keys.length === 1 && idx.keys[0] === 'id') return 'class 1 (pk on id)'
  if (idx.nullsNotDistinct) return null
  if (cols.includes('workspace_id') || (row.column && cols.includes(row.column))) return 'key'
  if (a === 'D') {
    if (row.class === 'D via plot' && (cols.includes('space_id') || cols.includes('plot_id'))) return 'plot'
    const lead = idx.keys[0]
    if (typeof lead === 'string' && (rel.fk?.[lead] ?? []).some((t) => ['S', 'D'].includes(arm(classes.relations[t]?.class)))) return 'leading fk'
  }
  if (a === 'C' && basePredicate(idx.predicate)) return 'is_base predicate'
  return null
}

// Every snapshot index on an in-scope table that fails the rule: [{ table, index, class, keys }].
export function violations(classes, snapshot) {
  const out = []
  for (const [table, rel] of Object.entries(snapshot.relations)) {
    if (!inScope(classes.relations[table]?.class)) continue
    for (const idx of rel.indexes) {
      if (!passesBy(classes, table, rel, idx)) out.push({ table, index: idx.name, class: classes.relations[table].class, keys: idx.keys })
    }
  }
  return out
}

const entryKey = (e) => `${e.table} ${e.index}`

// The exemption file's shape, and its closed world against the snapshot: every failing index listed, every entry
// naming a failing index (or pending on a stamp).
export function exemptionErrors(classes, snapshot, ex) {
  const errs = []
  const list = ex.exemptions
  const keys = list.map(entryKey)
  if (keys.join('\n') !== [...keys].sort().join('\n')) errs.push('exemptions are not sorted by table, then index')
  if (new Set(keys).size !== keys.length) errs.push('an exemption is listed twice')
  if (JSON.stringify(Object.keys(ex.classes)) !== JSON.stringify(['1', '2', '3', '4', '5', '6'])) errs.push('classes must name 1-6')
  const failing = new Map(violations(classes, snapshot).map((v) => [`${v.table} ${v.index}`, v]))
  for (const e of list) {
    const at = `${entryKey(e)}:`
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errs.push(`${at} unknown key ${k}`)
    if (![2, 3, 4, 5, 6].includes(e.class)) errs.push(`${at} class must be 2-6 (class 1 is by rule)`)
    if (typeof e.reason !== 'string' || !e.reason.trim()) errs.push(`${at} needs a one-line reason`)
    if (e.class === 5 && !(typeof e.route === 'string' && /^lambda\//.test(e.route))) errs.push(`${at} class 5 names its route (the writer files)`)
    if (e.class === 6 && !(typeof e.row === 'string' && /^5\.3\b/.test(e.row))) errs.push(`${at} class 6 names its 5.3 row`)
    if (e.pending !== undefined && !/^\d+\.\d+\.\d+-[a-z0-9-]+$/.test(e.pending)) errs.push(`${at} pending must be a schema_version stamp`)
    if (!inScope(classes.relations[e.table]?.class)) { errs.push(`${at} table is not an S, D or base-capable C table in the class file`); continue }
    const rel = snapshot.relations[e.table]
    const idx = rel?.indexes.find((i) => i.name === e.index)
    if (!idx) { if (!e.pending) errs.push(`${at} no such unique index in ${SNAPSHOT_FILE} (stale entry, or mark it pending on its stamp)`); continue }
    if (!failing.has(entryKey(e))) errs.push(`${at} passes by rule (${passesBy(classes, e.table, rel, idx)}): the exemption is not needed`)
  }
  for (const [k, v] of failing) {
    if (!keys.includes(k)) errs.push(`${v.table}.${v.index} (${v.class}; ${fmtKeys(v.keys)}) carries no tenancy key and is not in ${EXEMPTIONS_FILE}`)
  }
  return errs
}

export const fmtKeys = (keys) => keys.map((k) => (typeof k === 'string' ? k : k.expr)).join(', ')

// The unique indexes PostgreSQL could infer as the arbiter of one census ON CONFLICT clause (a superset: a partial
// index is kept whatever the clause's WHERE says). Columns match as a set; an expression element matches any
// expression key, by count.
export function arbitersOf(oc, snapshot) {
  const rel = snapshot.relations[qualify(oc.target)]
  if (!rel) return []
  if (oc.form === 'untargeted') return rel.indexes
  if (oc.form === 'on-constraint') return rel.indexes.filter((i) => i.constraint === oc.conname)
  const want = [...oc.cols].sort()
  return rel.indexes.filter((i) => {
    const have = i.keys.map((k) => (typeof k === 'string' ? k : 'expr')).sort()
    return have.length === want.length && have.every((k, n) => k === want[n])
  })
}

const describeTarget = (oc) => (oc.form === 'columns' ? `(${oc.cols.join(', ')})` : oc.form === 'on-constraint' ? `ON CONSTRAINT ${oc.conname}` : '(untargeted DO NOTHING)')

// One verdict per census ON CONFLICT clause: { id, at, target, class, how, arbiters: [{ index, by }], problem }.
// `problem` is null when the clause is fine. Person, P and C base-only targets are exempt by class.
export function conflictVerdicts(census, classes, snapshot, ex) {
  const exempt = new Map(ex.exemptions.map((e) => [entryKey(e), e]))
  return census.onConflict.map((oc) => {
    const table = qualify(oc.target)
    const cls = classes.relations[table]?.class ?? null
    const v = { id: oc.id, at: `${oc.file}:${oc.line}`, table, target: describeTarget(oc), class: cls, form: oc.form, arbiters: [], problem: null }
    if (!cls) { v.problem = `${table} is not classed in lambda/tenancy-classes.json`; return v }
    if (!inScope(cls)) { v.how = `exempt by class (${cls})`; return v }
    const rel = snapshot.relations[table]
    const found = arbitersOf(oc, snapshot)
    if (!found.length) {
      v.problem = `no unique index on ${table} matches ${v.target}` + (oc.form === 'columns' && !oc.cols.includes('workspace_id') ? ', and the target does not carry workspace_id' : '')
      return v
    }
    for (const idx of found) {
      const by = passesBy(classes, table, rel, idx)
      const e = exempt.get(`${table} ${idx.name}`)
      v.arbiters.push({ index: idx.name, by: by ?? (e ? `exemption class ${e.class}` : null) })
    }
    const bad = v.arbiters.filter((a) => !a.by)
    if (bad.length) v.problem = `arbiter ${bad.map((a) => a.index).join(', ')} on ${table} (${cls}) carries no tenancy key and is not in ${EXEMPTIONS_FILE}`
    return v
  })
}

// The gate's VALUES rows. Class map: (nspname, relname, class, tenancy_column), one per in-scope table of the class
// file (views and other kinds hold no index). Exemptions: (nspname, relname, indexname, class).
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const rowsOf = (tuples) => tuples.map((t, i) => `(${t.map(lit).join(', ')})` + (i < tuples.length - 1 ? ',' : ''))
export function classRows(classes) {
  return rowsOf(Object.entries(classes.relations)
    .filter(([, r]) => inScope(r.class) && TABLE_KINDS.has(r.kind))
    .map(([name, r]) => [...name.split('.'), r.class, r.column ?? null]))
}
export const exemptionRows = (ex) => rowsOf(ex.exemptions.map((e) => [...e.table.split('.'), e.index, e.class]))

// Every block between one pair of markers in a file's text, each as its trimmed, non-blank lines.
export function blocksIn(text, [begin, end]) {
  const blocks = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== begin) continue
    const block = []
    let j = i + 1
    for (; j < lines.length && lines[j].trim() !== end; j++) block.push(lines[j].trim())
    if (j === lines.length) throw new Error(`unterminated ${begin} at line ${i + 1}`)
    blocks.push({ line: i + 1, rows: block.filter(Boolean) })
    i = j
  }
  return blocks
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const classes = loadClasses()
  if (process.argv.includes('--values')) {
    console.log(`${CLASS_MARKERS[0]}\n${classRows(classes).join('\n')}\n${CLASS_MARKERS[1]}`)
    console.log(`${EXEMPTION_MARKERS[0]}\n${exemptionRows(loadExemptions()).join('\n')}\n${EXEMPTION_MARKERS[1]}`)
  } else if (process.argv.includes('--violations')) {
    for (const v of violations(classes, loadIndexSnapshot())) console.log(`${v.table}.${v.index}  ${v.class}  (${fmtKeys(v.keys)})`)
  } else {
    console.log(`${loadExemptions().exemptions.length} exemptions; --values prints the gate's VALUES rows, --violations the failing indexes`)
  }
}
