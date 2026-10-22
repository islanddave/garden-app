// v5-tenancyvalidate-001 (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.3): the 25 SQL files, the gate and
// rollback VALUES lists, scripts/phase7-gate.json's G1 list and step 2.1's key files are one key list written in
// five places. This holds them together.
//
// It fails when:
//   1. a numbered SQL file differs from what generate.mjs renders (edit the generator, never a file, then
//      `node migrations/v5-tenancyvalidate-001/generate.mjs --write`);
//   2. a file stops validating the key 2.1's file of the same number made, or its sweep gains a deleted_at filter;
//   3. a marked VALUES block in gates.yml or 0r-rollback.sql differs from `generate.mjs --values`;
//   4. the comment 0r-rollback.sql writes back is not the one each 2.1 file wrote;
//   5. scripts/phase7-gate.json G1 "2.3" is not this directory's 25 stamps, in order.
//
// POSITIVE CONTROLS (kept as tests): an edited file, a VALUES block one row short, a sweep with a deleted_at filter
// and a comment one character off each red.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIR, KEY_DIR, STAMP_PREFIX, loadOwnerClasses, render, valuesRows, valuesBlocksIn, stampOf, fileOf, keyStampOf,
  keyFileOf, fkName, keyComment,
} from './generate.mjs'

const oc = loadOwnerClasses(KEY_DIR)
const read = (f) => readFileSync(join(DIR, f), 'utf8')
const readKey = (f) => readFileSync(join(KEY_DIR, f), 'utf8')
const code = (text) => text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
// code without its string literals (messages and descriptions may say anything)
const bare = (text) => code(text).replace(/'(?:[^']|'')*'/g, "''")
// A sweep statement: the FROM public.<table> t that the guard counts over, with whatever follows it to the ;.
const sweepOf = (text, table) => code(text).match(new RegExp(`INTO v_orphan, v_null\\s+FROM public\\.${table} t[^;]*;`))?.[0]

describe('the 25 SQL files are rendered by generate.mjs', () => {
  const files = render(oc)

  it('one numbered file per 2.1 key, no other numbered file', () => {
    const onDisk = readdirSync(DIR).filter((f) => /^\d\d-.*\.sql$/.test(f)).sort()
    expect(onDisk).toEqual(files.map((f) => f.name))
    expect(files).toHaveLength(25)
  })

  it.each(files.map((f) => [f.name, f.text]))('%s equals its rendering', (name, text) => {
    expect(read(name), `${name} differs from the generator: run node migrations/v5-tenancyvalidate-001/generate.mjs --write`).toBe(text)
  })

  it('control: an edited file no longer equals its rendering', () => {
    const [{ name, text }] = files
    expect(read(name).replace('VALIDATE CONSTRAINT', 'VALIDATE  CONSTRAINT')).not.toBe(text)
  })
})

describe('file NN validates the key 2.1 file NN made, after an unfiltered sweep', () => {
  it.each(oc.tables.map((t) => [fileOf(t), t]))('%s', (_name, t) => {
    const text = read(fileOf(t))
    const key = fkName(t)
    expect(readKey(keyFileOf(t))).toContain(`ADD CONSTRAINT ${key}`)
    expect(text.match(/INSERT INTO public\.schema_version \(version, description\)\s*VALUES \('([^']+)'/g)).toHaveLength(1)
    expect(text).toContain(`VALUES ('${stampOf(t)}',`)
    expect(text).toContain(`WHERE version = '${keyStampOf(oc, t)}'`)
    expect(code(text).match(/ALTER TABLE \S+ VALIDATE CONSTRAINT \w+;/g)).toEqual([`ALTER TABLE public.${t.table} VALIDATE CONSTRAINT ${key};`])
    expect(code(text)).toContain(`LOCK TABLE public.${t.table} IN SHARE UPDATE EXCLUSIVE MODE;`)
    const sweep = sweepOf(text, t.table)
    expect(sweep, 'the guard counts over every row of the table').toBeTruthy()
    expect(bare(text)).not.toMatch(/deleted_at/)
    expect(text).not.toContain('00000000-0000-0000-0000-000000000001')
  })

  it('control: a sweep with a deleted_at filter reds', () => {
    const t = oc.tables[1]
    const text = read(fileOf(t)).replace(`FROM public.${t.table} t;`, `FROM public.${t.table} t WHERE t.deleted_at IS NULL;`)
    expect(bare(text)).toMatch(/deleted_at/)
  })

  it('the stamps name the release this step ships in (the session renames them if it moves)', () => {
    expect(STAMP_PREFIX).toBe('5.3.14-tenancyvalidate-001-')
    expect(new Set(oc.tables.map(stampOf)).size).toBe(25)
  })
})

describe('marked VALUES blocks equal generate.mjs --values', () => {
  const want = valuesRows(oc)

  it.each([['gates.yml', 3], ['0r-rollback.sql', 1]])('%s: %i block(s), each equal', (file, count) => {
    const blocks = valuesBlocksIn(read(file))
    expect(blocks).toHaveLength(count)
    for (const b of blocks) expect(b.rows, `${file}:${b.line}`).toEqual(want)
  })

  it('control: a block one row short reds', () => {
    const text = read('gates.yml').replace(`${want[3]}\n`, '')
    expect(valuesBlocksIn(text).some((b) => JSON.stringify(b.rows) !== JSON.stringify(want))).toBe(true)
  })
})

describe('0r-rollback.sql puts back exactly what 2.1 wrote', () => {
  const rollback = read('0r-rollback.sql')
  const template = rollback.match(/format\('(V5-SPACETENANCYKEY-001 \(v5-tenancykey-001 %s[^']*(?:''[^']*)*)',\s*lpad/)[1].replace(/''/g, "'")

  it.each(oc.tables.map((t) => [keyFileOf(t), t]))('%s: the comment it re-adds is the one 2.1 wrote', (_name, t) => {
    const twoOne = readKey(keyFileOf(t)).match(new RegExp(`COMMENT ON CONSTRAINT ${fkName(t)} ON public\\.${t.table} IS\\s+'((?:[^']|'')*)'`))[1].replace(/''/g, "'")
    expect(twoOne).toBe(keyComment(t))
    expect(template.replace('%s', String(t.n).padStart(2, '0'))).toBe(twoOne)
  })

  it('control: a comment one character off reds', () => {
    const t = oc.tables[0]
    expect(template.replace('%s', String(t.n).padStart(2, '0')).replace('step 2.1', 'step 2.l')).not.toBe(keyComment(t))
  })

  it('re-adds the key in 2.1\'s exact shape, NOT VALID', () => {
    expect(rollback).toContain("'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) '\n                     'ON DELETE RESTRICT NOT VALID'")
    for (const t of oc.tables) {
      expect(readKey(keyFileOf(t))).toContain(`FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID`)
    }
  })
})

describe('scripts/phase7-gate.json G1 reads this step\'s stamps', () => {
  it('G1 "2.3" is the 25 stamps in file order', () => {
    const g = JSON.parse(readFileSync(join(DIR, '..', '..', 'scripts', 'phase7-gate.json'), 'utf8'))
    expect(g.items.G1.migrations['2.3']).toEqual(oc.tables.map(stampOf))
  })
})
