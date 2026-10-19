// The keys instruments (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.0e, §2.4 "Unique keys and upserts").
//
// WHY THIS EXISTS. Once a second Space exists, a unique key that does not carry the Space makes two Spaces collide:
// B's insert of a name A already holds gets A's 23505, or an upsert in B updates A's row. So every unique index on
// an S, D or base-capable C table must carry the tenancy key, or be a named exemption with its class
// (scripts/tenancy-index-exemptions.json; classes 1-6 in §2.4). This file fails when:
//   1. an ON CONFLICT clause the 2.0a SQL census finds in non-test lambda/** targets an S, D or base-capable C
//      table and an arbiter PostgreSQL could infer for it carries no tenancy key and is not exempt, or no unique
//      index matches the target at all: the failure names the statement. A column list is matched to the
//      committed unique-index snapshot (tests/tenancy-unique-indexes.prod.json), an ON CONSTRAINT name through
//      its constraint map, and an untargeted DO NOTHING takes every unique index of its table (those statements
//      are printed). Person, P and C base-only targets are exempt by class;
//   2. the exemption file and the snapshot disagree: a failing index with no entry, an entry for an index that
//      passes by rule or no longer exists (unless pending on a stamp), a class-6 entry that names no 5.3 row, a
//      class-5 entry that names no route;
//   3. the gate's VALUES lists (migrations/v5-tenancykeys-001/gates.yml and 0a-stamp.sql) differ from the class
//      file's in-scope tables or from the exemption file (N16).
// The rule itself is in tests/lib/tenancyKeys.mjs; the gate post_s_unique_indexes_carry_workspace is the same rule
// over the live pg_index.
//
// REGENERATING. After a migration adds, drops or rebuilds a unique index (or a class row changes):
//   NEON_DATABASE_URL=… python3 scripts/tenancy-index-snapshot.py      (read-only; rewrites the snapshot)
//   node tests/lib/tenancyKeys.mjs --violations                        (what fails the rule, exempt or not)
//   node tests/lib/tenancyKeys.mjs --values                            (paste between the BEGIN/END markers)
//
// POSITIVE CONTROLS (kept as tests): a fixture ON CONFLICT whose target drops workspace_id is named; one exempt
// target reds once its exemption is deleted; deleting a class-6 row reds the closed world, naming the index; an
// unneeded and a stale entry red; a VALUES block one row short is caught.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadParser, censusOf } from '../tests/lib/sqlCensus.mjs'
import {
  loadClasses, loadExemptions, loadIndexSnapshot, passesBy, exemptionErrors, conflictVerdicts, classRows,
  exemptionRows, blocksIn, CLASS_MARKERS, EXEMPTION_MARKERS, VALUES_FILES, EXEMPTIONS_FILE, STAMP, GATE_DIR,
} from '../tests/lib/tenancyKeys.mjs'

const classes = loadClasses()
const exemptions = loadExemptions()
const snapshot = loadIndexSnapshot()
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
const clone = (o) => JSON.parse(JSON.stringify(o))
const without = (ex, index) => ({ ...ex, exemptions: ex.exemptions.filter((e) => e.index !== index) })

let census
beforeAll(async () => {
  await loadParser()
  census = censusOf()
})

describe('every ON CONFLICT arbiter the census finds carries the tenancy key or is exempt', () => {
  it('has no unresolved or unkeyed arbiter', () => {
    const verdicts = conflictVerdicts(census, classes, snapshot, exemptions)
    const bad = verdicts.filter((v) => v.problem).map((v) => `${v.id} (${v.at}) ON CONFLICT ${v.target}: ${v.problem}`)
    expect(bad, bad.join('\n')).toEqual([])
    expect(verdicts.length, 'the census found almost no ON CONFLICT: the walk is broken').toBeGreaterThan(50)
  })

  it('names the untargeted DO NOTHING statements (every unique index of the table is an arbiter)', () => {
    const untargeted = conflictVerdicts(census, classes, snapshot, exemptions).filter((v) => v.form === 'untargeted')
    for (const v of untargeted) {
      console.info(`untargeted DO NOTHING: ${v.id} (${v.at}) on ${v.table} (${v.class}); arbiters ${v.arbiters.map((a) => `${a.index} [${a.by}]`).join(', ')}`)
    }
    for (const v of untargeted) expect(v.arbiters.length, `${v.id}: ${v.table} has no unique index in the snapshot`).toBeGreaterThan(0)
  })

  it('resolves each ON CONSTRAINT target through the committed constraint map', () => {
    const named = conflictVerdicts(census, classes, snapshot, exemptions).filter((v) => v.form === 'on-constraint')
    expect(named.map((v) => v.target)).toContain('ON CONSTRAINT uq_voice_alias_user_phrase')
    for (const v of named) expect(v.arbiters.map((a) => a.index), `${v.id}: ${v.target}`).toHaveLength(1)
  })

  it('control: a fixture ON CONFLICT target without workspace_id is named; with it, it passes', () => {
    const file = 'lambda/zz-fixture/index.js'
    const upsert = (target) => 'export const bump = (sql, ws, k, n) => sql`INSERT INTO garden_shared_state ' +
      '(workspace_id, kind, natural_key, value) VALUES (${ws}, ${k}, ${n}, 1) ' +
      `ON CONFLICT (${target}) WHERE deleted_at IS NULL DO UPDATE SET value = garden_shared_state.value + 1\`\n`
    const run = (src) => conflictVerdicts(censusOf({ files: [file], read: () => src }), classes, snapshot, exemptions)
    const [red] = run(upsert('kind, natural_key'))
    expect(red.id).toMatch(/^lambda\/zz-fixture\/index\.js:bump:[0-9a-f]{10}$/)
    expect(red.problem).toBe('no unique index on public.garden_shared_state matches (kind, natural_key), and the target does not carry workspace_id')
    const [green] = run(upsert('workspace_id, kind, natural_key'))
    expect(green.problem).toBeNull()
    expect(green.arbiters).toEqual([{ index: 'idx_garden_shared_state_natural', by: 'key' }])
  })

  it('control: an exempt arbiter reds once its exemption is deleted; a Person target is exempt by class', () => {
    const file = 'lambda/zz-fixture/index.js'
    const src = 'export const fav = (sql, u, t, e) => sql`INSERT INTO favorites (user_id, entity_type, entity_id) ' +
      'VALUES (${u}, ${t}, ${e}) ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING`\n' +
      'export const pref = (sql, u) => sql`INSERT INTO user_notification_prefs (created_by) VALUES (${u}) ' +
      'ON CONFLICT (created_by) DO NOTHING`\n'
    const c = censusOf({ files: [file], read: () => src })
    const [fav, pref] = conflictVerdicts(c, classes, snapshot, exemptions)
    expect(fav.arbiters).toEqual([{ index: 'favorites_user_id_entity_type_entity_id_key', by: 'exemption class 6' }])
    expect(pref.how).toBe('exempt by class (Person)')
    const [red] = conflictVerdicts(c, classes, snapshot, without(exemptions, 'favorites_user_id_entity_type_entity_id_key'))
    expect(red.problem).toBe(`arbiter favorites_user_id_entity_type_entity_id_key on public.favorites (S needs key) carries no tenancy key and is not in ${EXEMPTIONS_FILE}`)
  })
})

describe('the exemption file against the committed unique-index snapshot (closed world)', () => {
  it('lists exactly the in-scope unique indexes that carry no tenancy key', () => {
    const errs = exemptionErrors(classes, snapshot, exemptions)
    expect(errs, errs.join('\n') + '\n(regenerate: scripts/tenancy-index-snapshot.py; node tests/lib/tenancyKeys.mjs --violations)').toEqual([])
  })

  it('names each pending stamp as some migration writes it', () => {
    const dirs = readdirSync(join(ROOT, 'migrations'))
    const sql = dirs.flatMap((d) => { try { return readdirSync(join(ROOT, 'migrations', d)).filter((f) => /^0[a-z].*\.sql$/.test(f) && f !== '0r-rollback.sql').map((f) => read(`migrations/${d}/${f}`)) } catch { return [] } })
    for (const e of exemptions.exemptions.filter((x) => x.pending)) {
      expect(sql.some((t) => t.includes(`'${e.pending}'`)), `${e.table} ${e.index}: no migration writes stamp ${e.pending}`).toBe(true)
    }
  })

  it('control: deleting one class-6 row reds, naming the index', () => {
    const errs = exemptionErrors(classes, snapshot, without(exemptions, 'idx_locations_root_slug'))
    expect(errs).toEqual([`public.locations.idx_locations_root_slug (S needs key; slug) carries no tenancy key and is not in ${EXEMPTIONS_FILE}`])
  })

  it('control: an entry the rule does not need, a stale entry and a class-6 entry with no 5.3 row each red', () => {
    const ex = clone(exemptions)
    ex.exemptions.push({ table: 'public.garden_shared_state', index: 'idx_garden_shared_state_natural', class: 3, reason: 'x' })
    ex.exemptions.push({ table: 'public.photos', index: 'zz_gone', class: 6, row: '5.3', reason: 'x' })
    ex.exemptions.find((e) => e.index === 'uq_slug_namespace').row = 'later'
    ex.exemptions.sort((a, b) => (`${a.table} ${a.index}` < `${b.table} ${b.index}` ? -1 : 1))
    const errs = exemptionErrors(classes, snapshot, ex)
    expect(errs).toContain('public.garden_shared_state idx_garden_shared_state_natural: passes by rule (key): the exemption is not needed')
    expect(errs.some((e) => e.startsWith('public.photos zz_gone: no such unique index'))).toBe(true)
    expect(errs).toContain('public.slug_redirects uq_slug_namespace: class 6 names its 5.3 row')
  })
})

describe('the index rule, per arm (the gate is the same rule in SQL)', () => {
  const idx = (keys, extra = {}) => ({ name: 'zz', constraint: null, primary: false, keys, predicate: null, nullsNotDistinct: false, ...extra })
  const rel = (fk = {}) => ({ fk, indexes: [] })

  it('S: workspace_id or the tenancy column; class 1 only for a single-column PK on id', () => {
    expect(passesBy(classes, 'public.plants', rel(), idx(['workspace_id', 'slug']))).toBe('key')
    expect(passesBy(classes, 'public.spacetheme', rel(), idx(['space_id']))).toBe('key')
    expect(passesBy(classes, 'public.plants', rel(), idx(['id'], { primary: true }))).toBe('class 1 (pk on id)')
    expect(passesBy(classes, 'public.favorites', rel(), idx(['user_id'], { primary: true }))).toBeNull()
    expect(passesBy(classes, 'public.plants', rel(), idx(['workspace_id', 'slug'], { nullsNotDistinct: true }))).toBeNull()
  })

  it("D via plot: space_id today and 3.2a's plot_id keys pass; a key with neither does not", () => {
    expect(passesBy(classes, 'public.weather_daily', rel(), idx(['space_id', 'date'], { primary: true }))).toBe('key')
    expect(passesBy(classes, 'public.weather_daily', rel(), idx(['plot_id', 'date']))).toBe('plot')
    expect(passesBy(classes, 'public.weather_cold_range', rel(), idx(['plot_id', 'night_date', 'init_time']))).toBe('plot')
    expect(passesBy(classes, 'public.weather_daily', rel(), idx(['date']))).toBeNull()
  })

  it('D: a leading single-column FK into an S or D table passes; into a C or Person table, or not leading, does not', () => {
    expect(passesBy(classes, 'public.harvest_log', rel({ event_id: ['public.event_log'] }), idx(['event_id']))).toBe('leading fk')
    expect(passesBy(classes, 'public.kitchen_batch_input', rel({ crop_type_slug: ['public.crop_types'] }), idx(['crop_type_slug']))).toBeNull()
    expect(passesBy(classes, 'public.kitchen_batch_input', rel({ harvest_log_id: ['public.harvest_log'] }), idx(['idempotency_key', 'harvest_log_id']))).toBeNull()
  })

  it('C base + private: workspace_id, or a bare top-level is_base conjunct with no OR', () => {
    const pv = 'public.plant_varieties'
    expect(passesBy(classes, pv, rel(), idx(['workspace_id', 'name']))).toBe('key')
    expect(passesBy(classes, pv, rel(), idx(['name'], { predicate: '(is_base AND (deleted_at IS NULL))' }))).toBe('is_base predicate')
    expect(passesBy(classes, pv, rel(), idx(['name'], { predicate: 'is_base' }))).toBe('is_base predicate')
    expect(passesBy(classes, pv, rel(), idx(['name'], { predicate: '(NOT is_base)' }))).toBeNull()
    expect(passesBy(classes, pv, rel(), idx(['name'], { predicate: '(is_base OR (deleted_at IS NULL))' }))).toBeNull()
  })
})

describe('the index gate carries the files (N16)', () => {
  const want = { classes: classRows(classes), exemptions: exemptionRows(exemptions) }
  for (const [f, n] of [[VALUES_FILES[0], 2], [VALUES_FILES[1], 1]]) {
    it(`${f}: every VALUES block equals the class file's in-scope tables and the exemption file`, () => {
      const text = read(f)
      for (const [kind, markers] of [['classes', CLASS_MARKERS], ['exemptions', EXEMPTION_MARKERS]]) {
        const blocks = blocksIn(text, markers)
        expect(blocks.length, `${f} should hold ${n} ${kind} VALUES block(s)`).toBe(n)
        for (const b of blocks) {
          const extra = b.rows.filter((r) => !want[kind].includes(r))
          const missing = want[kind].filter((r) => !b.rows.includes(r))
          expect({ extra, missing }, `${f}:${b.line} ${kind} block differs (node tests/lib/tenancyKeys.mjs --values)`).toEqual({ extra: [], missing: [] })
          expect(b.rows, `${f}:${b.line} ${kind} rows are out of order or punctuated differently`).toEqual(want[kind])
        }
      }
    })
  }

  it('arms the post gate, and only it, on the stamp the 0a writes and the 0r deletes', () => {
    const gates = read(VALUES_FILES[0])
    const post = gates.slice(gates.indexOf('\npost:'))
    expect(post).toContain(`EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${STAMP}')`)
    expect(gates.slice(0, gates.indexOf('\npost:')).match(/EXISTS \(SELECT 1 FROM public\.schema_version/g)).toBeNull()
    expect(read(VALUES_FILES[1])).toContain(`VALUES ('${STAMP}',`)
    expect(read(`${GATE_DIR}/0r-rollback.sql`)).toContain(`DELETE FROM public.schema_version WHERE version = '${STAMP}';`)
  })

  it('control: a VALUES block one row short is caught', () => {
    const text = read(VALUES_FILES[0]).replace(/^\s*\('public', 'photos', 'idx_photos_content_hash_uniq', 6\),?\n/m, '')
    const b = blocksIn(text, EXEMPTION_MARKERS)[0]
    expect(want.exemptions.filter((r) => !b.rows.includes(r))).toEqual([want.exemptions.find((r) => r.startsWith("('public', 'photos', 'idx_photos_content_hash_uniq',"))])
  })
})
