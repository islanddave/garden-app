// v5-tenancykey-001 (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.1): the 25 SQL files, the gate and
// rollback VALUES lists and owner-classes.json are one thing written in four places. This holds them together.
//
// It fails when:
//   1. a numbered SQL file differs from what generate.mjs renders from owner-classes.json (the owner lists, the
//      per-table owner columns and parent joins, the env fingerprints, the stamps): edit the JSON or the
//      generator, never a file, then `node migrations/v5-tenancykey-001/generate.mjs --write`;
//   2. a marked VALUES block in gates.yml or 0r-rollback.sql differs from `generate.mjs --values`;
//   3. owner-classes.json breaks its own rules (ownerClassErrors): a LIKE pattern with an unescaped _, a class
//      without a reason, NULL allowed anywhere but staging locations, a test-sub pattern in prod, a table the
//      class file does not call 'S needs key' (or, after the apply, 'S has key' on workspace_id), or an
//      'S needs key' relation in lambda/tenancy-classes.json with no row here;
//   4. the rollback no longer restores the eleven-name audit trigger file 21 replaces, or a trigger body here
//      names a Space literal (N12).
//
// POSITIVE CONTROLS (kept as tests): an unescaped _ in a pattern, a class with no reason, a null class on prod,
// a forgotten 'S needs key' row, and a VALUES block one row short each red; an edited file reds the render check.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIR, loadOwnerClasses, render, valuesRows, valuesBlocksIn, ownerClassErrors, stampOf, fileOf, fkName,
} from './generate.mjs'

const oc = loadOwnerClasses()
const classes = JSON.parse(readFileSync(join(DIR, '..', '..', 'lambda', 'tenancy-classes.json'), 'utf8'))
const read = (f) => readFileSync(join(DIR, f), 'utf8')
const clone = (o) => JSON.parse(JSON.stringify(o))
const SPACE = oc.space

describe('the 25 SQL files are rendered from owner-classes.json', () => {
  const files = render(oc)

  it('one numbered file per table, no other numbered file', () => {
    const onDisk = readdirSync(DIR).filter((f) => /^\d\d-.*\.sql$/.test(f)).sort()
    expect(onDisk).toEqual(files.map((f) => f.name))
    expect(files).toHaveLength(25)
  })

  it.each(files.map((f) => [f.name, f.text]))('%s equals its rendering', (name, text) => {
    expect(read(name), `${name} differs from owner-classes.json: run node migrations/v5-tenancykey-001/generate.mjs --write`).toBe(text)
  })

  it('control: an edited file no longer equals its rendering', () => {
    const [{ name, text }] = files
    expect(read(name).replace('NOT VALID', 'NOT  VALID')).not.toBe(text)
  })

  it('each file writes its own stamp exactly once and names its own key', () => {
    for (const t of oc.tables) {
      const text = read(fileOf(t))
      const stamp = stampOf(oc, t)
      expect(text.match(/INSERT INTO public\.schema_version \(version, description\)\s*VALUES \('([^']+)'/g), fileOf(t)).toHaveLength(1)
      expect(text).toContain(`VALUES ('${stamp}',`)
      expect(text).toContain(`ADD CONSTRAINT ${fkName(t)}`)
      expect(text).toContain('ON DELETE RESTRICT NOT VALID')
      expect(text.includes('ADD COLUMN workspace_id uuid NOT NULL DEFAULT'), fileOf(t)).toBe(!t.fkOnly)
    }
  })

  it('no trigger body carries a Space literal (N12)', () => {
    for (const { name, text } of files) {
      for (const m of text.matchAll(/CREATE TRIGGER[\s\S]*?;/g)) expect(m[0], name).not.toContain(SPACE.slice(0, 9))
    }
  })
})

describe('marked VALUES blocks equal owner-classes.json (generate.mjs --values)', () => {
  const want = valuesRows(oc)

  it.each([['gates.yml', 5], ['0r-rollback.sql', 1]])('%s: %i block(s), each equal', (file, count) => {
    const blocks = valuesBlocksIn(read(file))
    expect(blocks).toHaveLength(count)
    for (const b of blocks) expect(b.rows, `${file}:${b.line}`).toEqual(want)
  })

  it('control: a block one row short reds', () => {
    const text = read('gates.yml').replace(`${want[3]}\n`, '')
    expect(valuesBlocksIn(text).some((b) => JSON.stringify(b.rows) !== JSON.stringify(want))).toBe(true)
  })
})

describe('owner-classes.json keeps its own rules', () => {
  it('is clean against lambda/tenancy-classes.json', () => {
    expect(ownerClassErrors(oc, classes)).toEqual([])
  })

  it('22 tables gain the column and 3 gain the key only', () => {
    expect(oc.tables.filter((t) => !t.fkOnly)).toHaveLength(22)
    expect(oc.tables.filter((t) => t.fkOnly).map((t) => t.table)).toEqual(['treatment_association', 'garden_shared_state', 'seen_event'])
  })

  it('the stamps name the release this step ships in (the session renames them if it moves)', () => {
    expect(oc.stampPrefix).toBe('5.3.13-tenancykey-001-')
  })

  it.each([
    ['an unescaped _ in a LIKE pattern', (o) => { o.classes.find((c) => c.match === 'like').value = 'user_int%' }, /unescaped _/],
    ['a class with no reason', (o) => { o.classes[0].reason = '' }, /needs a reason/],
    ['NULL allowed on prod', (o) => { o.classes.find((c) => c.match === 'null').envs = ['prod', 'staging'] }, /staging locations only/],
    ['a test-sub pattern on prod', (o) => { o.classes.find((c) => c.id === 'integration_fixture').envs.push('prod') }, /staging only/],
    ['an S needs key table forgotten', (o) => { o.tables = o.tables.filter((t) => t.table !== 'tag') }, /public\.tag: 'S needs key'/],
    ['a table that is not S', (o) => { o.tables[0].table = 'xp_events' }, /xp_events/],
  ])('control: %s reds', (_label, mutate, pattern) => {
    const o = clone(oc)
    mutate(o)
    expect(ownerClassErrors(o, classes).join('\n')).toMatch(pattern)
  })

  it('after the apply (push B) a key-adding row may read S has key on workspace_id', () => {
    const c = clone(classes)
    for (const t of oc.tables) Object.assign(c.relations[`public.${t.table}`], { class: 'S has key', column: 'workspace_id', notnull: true })
    expect(ownerClassErrors(oc, c)).toEqual([])
  })
})

describe('file 21 and the rollback agree on the source audit trigger', () => {
  const a = oc.tables.find((t) => t.auditWatch).auditWatch
  const rollback = read('0r-rollback.sql')

  it('the rollback re-creates the eleven names, in order, over the definition file 21 wrote', () => {
    expect(rollback).toContain(`audit_stmt_update(${a.before.map((c) => `'${c}'`).join(', ')});`)
    expect(rollback).toContain(`'${a.afterMd5}'`)
    expect(rollback).toContain(`'${a.beforeMd5}'`)
  })

  it('file 21 adds workspace_id last, behind the definition pre-gate', () => {
    const text = read(fileOf(oc.tables.find((t) => t.auditWatch)))
    expect(text).toContain(`audit_stmt_update(${[...a.before, 'workspace_id'].map((c) => `'${c}'`).join(', ')});`)
    expect(text).toContain(`IF v_def IS DISTINCT FROM '${a.beforeMd5}' THEN`)
  })
})
