// GUARD: security (OPS-SECREVIEW-001 do-not-remove list)
// The closed-world tenancy class file (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.0b, §2.1).
//
// WHY THIS EXISTS. Isolating Spaces needs one answer, for every relation, to "whose is this row?": the class
// (S, D, C, Person, P, View and their variants) and the tenancy column that says it. lambda/tenancy-classes.json
// is that answer. It is only useful if it is complete and true, so this file fails when:
//   1. a relation that SQL in non-test lambda/** names (the 2.0a census, CTE names subtracted per statement) is
//      not classed: the failure names it and the statements that name it;
//   2. a row disagrees with the catalog: the committed snapshot of prod's catalog (tests/tenancy-catalog.prod.json)
//      and the file must hold the same relations with the same relkinds, each tenancy column must exist with the
//      file's `notnull` equal to its attnotnull, and a relation has workspace_id exactly when its row names it;
//   3. the relkind gate's VALUES lists (migrations/v5-tenancyclasses-001/gates.yml and 0a-stamp.sql) or its
//      copy-table predicates differ from the file (N16).
//
// REGENERATING. After a migration adds or drops a relation or changes a tenancy column: edit the row(s), then
//   NEON_DATABASE_URL=… python3 scripts/tenancy-catalog-snapshot.py      (read-only; rewrites the snapshot)
//   node tests/lib/tenancyClasses.mjs --values                          (paste between the BEGIN/END markers)
// A relation a not-yet-applied migration creates is added with `pending: <its stamp>`, so the snapshot (and the
// live gate) tolerate its absence until the stamp exists.
//
// POSITIVE CONTROLS (kept as tests): a planted statement naming zz_new_table is reported by name, while a CTE of
// the same statement and a ctas_ copy are not; a row deleted from a copy of the file, or a flipped notnull,
// reds the sync check; a VALUES block one row short reds the N16 check.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadParser, censusOf } from '../tests/lib/sqlCensus.mjs'
import {
  loadClasses, loadSnapshot, unclassedRelations, shapeErrors, syncErrors, valuesRows, valuesBlocksIn,
  copyPredicates, VALUES_FILES, CLASSES_FILE,
} from '../tests/lib/tenancyClasses.mjs'

const classes = loadClasses()
const snapshot = loadSnapshot()
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
const clone = (o) => JSON.parse(JSON.stringify(o))

let census
beforeAll(async () => {
  await loadParser()
  census = censusOf()
})

describe('tenancy-classes.json: the file itself', () => {
  it('has the shape every rule below reads', () => {
    const errs = shapeErrors(classes)
    expect(errs, errs.join('\n')).toEqual([])
  })

  it('names each pending stamp as some migration writes it', () => {
    const dirs = readdirSync(join(ROOT, 'migrations'))
    const sql = dirs.flatMap((d) => { try { return readdirSync(join(ROOT, 'migrations', d)).filter((f) => /^0[a-z].*\.sql$/.test(f) && f !== '0r-rollback.sql').map((f) => read(`migrations/${d}/${f}`)) } catch { return [] } })
    const pending = Object.entries(classes.relations).filter(([, r]) => r.pending)
    expect(pending.map(([n]) => n)).toContain('public.plots')
    for (const [name, row] of pending) {
      expect(sql.some((t) => t.includes(`'${row.pending}'`)), `${name}: no migration writes stamp ${row.pending}`).toBe(true)
    }
  })
})

describe('tenancy-classes.json: every relation the Lambda SQL names is classed', () => {
  it('classes every relation in the census', () => {
    const missing = unclassedRelations(census, classes)
    const msg = missing.map((m) => `${m.relation} is not classed in ${CLASSES_FILE} (named by ${m.ids.slice(0, 3).join(', ')}${m.ids.length > 3 ? ', …' : ''})`)
    expect(missing.map((m) => m.relation), msg.join('\n')).toEqual([])
    expect(census.statements.length, 'the census found almost no SQL: the walk is broken').toBeGreaterThan(500)
  })

  it('control: a planted statement naming zz_new_table fails, naming it; its CTE and a ctas_ copy do not', () => {
    const file = 'lambda/zz-fixture/index.js'
    const src = 'export const q = (sql, id) => sql`WITH zz_cte AS (SELECT id FROM plants) ' +
      'SELECT t.id FROM zz_new_table t JOIN zz_cte c ON c.id = t.id JOIN ctas_zz_copy x ON x.id = t.id WHERE t.id = ${id}`\n'
    const planted = censusOf({ files: [file], read: () => src })
    expect(planted.statements).toHaveLength(1)
    expect(unclassedRelations(planted, classes)).toEqual([{ relation: 'public.zz_new_table', ids: [planted.statements[0].id] }])
  })
})

describe('tenancy-classes.json against the catalog (attnotnull sync)', () => {
  it('matches the committed prod catalog snapshot row for row', () => {
    const errs = syncErrors(classes, snapshot)
    expect(errs, errs.join('\n') + '\n(regenerate: scripts/tenancy-catalog-snapshot.py; see this file\'s header)').toEqual([])
  })

  it('control: deleting a file row reds, naming the relation', () => {
    const c = clone(classes)
    delete c.relations['public.plants']
    expect(syncErrors(c, snapshot)).toContain(`public.plants: in the catalog snapshot, not classed in ${CLASSES_FILE}`)
  })

  it('control: a notnull that disagrees with attnotnull reds; so does a stale row and a missing workspace_id row', () => {
    const c = clone(classes)
    c.relations['public.plants'].notnull = false
    c.relations['public.zz_gone'] = { kind: 'r', class: 'P' }
    // crop_types (C base only) never carries workspace_id; locations did not either, until multi-space 2.1.
    c.relations['public.crop_types'] = { kind: 'r', class: 'S has key', column: 'workspace_id', notnull: true }
    const errs = syncErrors(c, snapshot)
    expect(errs).toContain('public.plants: workspace_id notnull false, catalog attnotnull true')
    expect(errs.some((e) => e.startsWith('public.zz_gone: classed but not in the catalog snapshot'))).toBe(true)
    expect(errs).toContain('public.crop_types: tenancy column workspace_id does not exist')
  })
})

describe('the relkind gate carries the file (N16)', () => {
  const want = valuesRows(classes)
  for (const [f, n] of [[VALUES_FILES[0], 2], [VALUES_FILES[1], 1]]) {
    it(`${f}: every VALUES block equals the file, and the copy predicates equal copyPatterns`, () => {
      const text = read(f)
      const blocks = valuesBlocksIn(text)
      expect(blocks.length, `${f} should hold ${n} marked VALUES block(s)`).toBe(n)
      for (const b of blocks) {
        const extra = b.rows.filter((r) => !want.includes(r))
        const missing = want.filter((r) => !b.rows.includes(r))
        expect({ extra, missing }, `${f}:${b.line} VALUES block differs from ${CLASSES_FILE} (node tests/lib/tenancyClasses.mjs --values)`).toEqual({ extra: [], missing: [] })
        expect(b.rows, `${f}:${b.line} rows are out of order or punctuated differently`).toEqual(want)
      }
      const preds = text.match(/c\.relname !~ '[^']*'/g) ?? []
      expect(preds, `${f}: copy predicates differ from copyPatterns`).toEqual(Array(n).fill(copyPredicates(classes)).flat())
    })
  }

  it('control: a VALUES block one row short is caught', () => {
    const text = read(VALUES_FILES[0]).replace(/^\s*\('public', 'plants', [^\n]*\n/m, '')
    const b = valuesBlocksIn(text)[0]
    expect(want.filter((r) => !b.rows.includes(r))).toEqual([want.find((r) => r.startsWith("('public', 'plants',"))])
  })
})
