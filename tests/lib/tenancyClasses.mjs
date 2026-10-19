#!/usr/bin/env node
// The tenancy class file's checks (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.0b, §2.1). Pure functions
// over lambda/tenancy-classes.json, the SQL census (tests/lib/sqlCensus.mjs) and the committed catalog snapshot
// (tests/tenancy-catalog.prod.json, written by scripts/tenancy-catalog-snapshot.py). The rules live in
// lambda/tenancy-classes.test.js; this module only computes what each rule compares.
//
// `node tests/lib/tenancyClasses.mjs --values` prints the VALUES rows the relkind gate carries
// (migrations/v5-tenancyclasses-001/gates.yml and 0a-stamp.sql), ready to paste between the markers.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './sqlCensus.mjs'

export const CLASSES_FILE = 'lambda/tenancy-classes.json'
export const SNAPSHOT_FILE = 'tests/tenancy-catalog.prod.json'
export const GATE_DIR = 'migrations/v5-tenancyclasses-001'
export const VALUES_FILES = [`${GATE_DIR}/gates.yml`, `${GATE_DIR}/0a-stamp.sql`]
export const VALUES_BEGIN = '-- BEGIN tenancy-classes VALUES'
export const VALUES_END = '-- END tenancy-classes VALUES'

export const RELKINDS = ['r', 'p', 'v', 'm', 'f']
const ROW_KEYS = new Set(['kind', 'class', 'column', 'notnull', 'parent', 'alsoVia', 'pending', 'note'])
const TABLE_KINDS = new Set(['r', 'p', 'f'])

// What each class's tenancy column must be. `key` = the column it must name (null: none); `nn` = for a table,
// the column must be NOT NULL.
const CLASS_RULES = {
  'S has key': { key: 'workspace_id', nn: true },
  'S needs key': { key: null },
  'S keyed by space_id': { key: 'space_id', nn: true },
  'S new': { key: 'workspace_id', nn: true },
  D: { key: 'any' },
  'D event-time copy': { key: 'workspace_id', nn: true },
  'D via plot': { key: 'space_id', nn: true },
  'C base only': { key: null },
  'C base + private': { key: 'optional-workspace_id' },
  Person: { key: 'any' },
  P: { key: null },
  View: { key: 'optional' },
}

const readJson = (root, f) => JSON.parse(readFileSync(join(root, f), 'utf8'))
export const loadClasses = (root = ROOT) => readJson(root, CLASSES_FILE)
export const loadSnapshot = (root = ROOT) => readJson(root, SNAPSHOT_FILE)

// An unqualified name in Lambda SQL resolves through the default search_path, i.e. to public.
export const qualify = (rel) => (rel.includes('.') ? rel : `public.${rel}`)
const bare = (rel) => rel.slice(rel.indexOf('.') + 1)
export const isCopy = (classes, rel) => classes.copyPatterns.some((p) => new RegExp(p).test(bare(qualify(rel))))
export const isClassed = (classes, rel) => Object.hasOwn(classes.relations, qualify(rel)) || isCopy(classes, rel)

// Relations the census's statements name (CTE names already subtracted per statement, sqlCensus relationsOf) that
// the class file does not class: [{ relation, ids }], one entry per relation, the statements naming it.
export function unclassedRelations(census, classes) {
  const out = new Map()
  for (const s of census.statements) {
    for (const r of s.relations) {
      if (isClassed(classes, r)) continue
      const q = qualify(r)
      if (!out.has(q)) out.set(q, [])
      out.get(q).push(s.id)
    }
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([relation, ids]) => ({ relation, ids }))
}

// The file's own shape: known keys and classes, each class's column rule, parents that are rows of the file.
export function shapeErrors(classes) {
  const errs = []
  const names = Object.keys(classes.relations)
  if (names.join('\n') !== [...names].sort().join('\n')) errs.push('relations are not sorted by name')
  for (const p of classes.copyPatterns) if (!p.startsWith('^')) errs.push(`copy pattern ${p} is not anchored`)
  for (const [name, row] of Object.entries(classes.relations)) {
    const at = `${name}:`
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name)) errs.push(`${at} not a schema.relname key`)
    if (isCopy(classes, name)) errs.push(`${at} matches a copy pattern; copies are classed by pattern only`)
    for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) errs.push(`${at} unknown key ${k}`)
    if (!RELKINDS.includes(row.kind)) errs.push(`${at} kind ${row.kind} is not one of ${RELKINDS.join(', ')}`)
    const rule = CLASS_RULES[row.class]
    if (!rule || !classes.classes.includes(row.class)) { errs.push(`${at} unknown class ${row.class}`); continue }
    const col = row.column ?? null
    if (rule.key === null && col !== null) errs.push(`${at} class ${row.class} names no tenancy column, got ${col}`)
    if (rule.key === 'any' && col === null) errs.push(`${at} class ${row.class} needs a tenancy column`)
    if (rule.key === 'optional-workspace_id' && col !== null && col !== 'workspace_id') errs.push(`${at} class ${row.class} column must be workspace_id or absent`)
    if (!['any', 'optional', 'optional-workspace_id', null].includes(rule.key) && col !== rule.key) errs.push(`${at} class ${row.class} column must be ${rule.key}, got ${col}`)
    if ((col === null) !== (row.notnull === undefined)) errs.push(`${at} notnull is given exactly when column is`)
    if (col !== null && typeof row.notnull !== 'boolean') errs.push(`${at} notnull must be a boolean`)
    if (rule.nn && TABLE_KINDS.has(row.kind) && row.notnull !== true) errs.push(`${at} class ${row.class} needs ${col} NOT NULL`)
    if (row.class === 'D' && !row.parent && !row.note) errs.push(`${at} a D row names its parent, or says in a note why it has none`)
    for (const t of [row.parent, ...Object.values(row.alsoVia ?? {})].filter(Boolean)) {
      if (!Object.hasOwn(classes.relations, t)) errs.push(`${at} parent ${t} is not a row of the file`)
    }
    if (row.pending !== undefined && !/^\d+\.\d+\.\d+-[a-z0-9-]+$/.test(row.pending)) errs.push(`${at} pending must be a schema_version stamp`)
  }
  return errs
}

// The attnotnull sync: every row against the snapshot, and the two relation sets equal. A pending row may be
// absent from the snapshot (its migration is not applied); once present it is checked like any other.
export function syncErrors(classes, snapshot) {
  const errs = []
  const snap = snapshot.relations
  for (const name of Object.keys(snap)) {
    if (!Object.hasOwn(classes.relations, name)) errs.push(`${name}: in the catalog snapshot, not classed in ${CLASSES_FILE}`)
  }
  for (const [name, row] of Object.entries(classes.relations)) {
    const s = snap[name]
    if (!s) {
      if (!row.pending) errs.push(`${name}: classed but not in the catalog snapshot (stale row, or mark it pending on its stamp)`)
      continue
    }
    if (s.kind !== row.kind) errs.push(`${name}: kind ${row.kind}, catalog ${s.kind}`)
    const cols = s.columns
    if (row.column) {
      if (!cols[row.column]) errs.push(`${name}: tenancy column ${row.column} does not exist`)
      else {
        if (cols[row.column].notnull !== row.notnull) errs.push(`${name}: ${row.column} notnull ${row.notnull}, catalog attnotnull ${cols[row.column].notnull}`)
        const fk = cols[row.column].fk
        if (fk && row.parent && fk !== row.parent) errs.push(`${name}: ${row.column} FKs ${fk}, file says parent ${row.parent}`)
      }
    }
    for (const [c, t] of Object.entries(row.alsoVia ?? {})) {
      if (!cols[c]) errs.push(`${name}: alsoVia column ${c} does not exist`)
      else if (cols[c].fk && cols[c].fk !== t) errs.push(`${name}: ${c} FKs ${cols[c].fk}, file says ${t}`)
    }
    // A relation carries workspace_id exactly when the file names it as the tenancy column: so 2.1 / 2.4a's
    // ADD COLUMN cannot land without the row moving class.
    if (Boolean(cols.workspace_id) !== (row.column === 'workspace_id')) {
      errs.push(`${name}: catalog ${cols.workspace_id ? 'has' : 'has no'} workspace_id, file column is ${row.column ?? 'none'}`)
    }
  }
  return errs
}

// The gate's VALUES rows: (nspname, relname, relkind, class, tenancy_column, pending_stamp), one per line.
const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
export function valuesRows(classes) {
  const rows = Object.entries(classes.relations).map(([name, row]) => {
    const [nsp, rel] = name.split('.')
    return `(${[nsp, rel, row.kind, row.class, row.column, row.pending].map(lit).join(', ')})`
  })
  return rows.map((r, i) => r + (i < rows.length - 1 ? ',' : ''))
}

// Every marked VALUES block in a file's text, each as its trimmed lines.
export function valuesBlocksIn(text) {
  const blocks = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== VALUES_BEGIN) continue
    const block = []
    let j = i + 1
    for (; j < lines.length && lines[j].trim() !== VALUES_END; j++) block.push(lines[j].trim())
    if (j === lines.length) throw new Error(`unterminated ${VALUES_BEGIN} at line ${i + 1}`)
    blocks.push({ line: i + 1, rows: block.filter(Boolean) })
    i = j
  }
  return blocks
}

// The copy patterns as the gate writes them: one `c.relname !~ '<pattern>'` per pattern.
export const copyPredicates = (classes) => classes.copyPatterns.map((p) => `c.relname !~ ${lit(p)}`)

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const classes = loadClasses()
  if (process.argv.includes('--values')) console.log(valuesRows(classes).join('\n'))
  else console.log(`${Object.keys(classes.relations).length} classed relations; --values prints the gate's VALUES rows`)
}
