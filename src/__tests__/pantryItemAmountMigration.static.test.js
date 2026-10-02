// V5-PUTUPLOGRETIRE-001 R2a (B1) — static guards on migrations/v5-pantryitemamount-001, the twin of
// pantryMigration.static.test.js (the pattern every train directory is held to).
//
// What it pins, each a way the sitting would go wrong without a red here:
//   1. line 2 is `-- schema_version: 5.0.0-pantryitemamount-001` and the file INSERTs that stamp (the
//      integration train step reads line 2 to decide "already applied");
//   2. ONE transaction: exactly one BEGIN and one COMMIT, the stamp inside it;
//   3. it applies on top of v5-pantry-001 only (its guard names that stamp), and the train lists it LAST;
//   4. it alters public.pantry_item and nothing else: four ADD COLUMN IF NOT EXISTS, nine CHECKs, each
//      DROP IF EXISTS + ADD; no FK, trigger, function, index or CASCADE;
//   5. every CHECK is born VALIDATED: no NOT VALID and no VALIDATE step (the four columns are NULL on every
//      existing row, so there is nothing to sweep — three house precedents, v5-pantry-001 among them);
//   6. no name collides with a gate elsewhere that matches by conname with no table filter;
//   7. gates.yml: catalog joins only (no ::regclass); every post gate self-armed on the stamp, or explicitly
//      NOT ARMED, or apply-window only, or the receipt; no `sweep` phase; no gate reads a new column
//      except through a catalog or to_jsonb, so every gate is vacuous — never ERROR — on a database
//      without this DDL (prod, from the dev push to the sitting); columns are NAMED, never counted;
//   8. 0r undoes every object 0a creates, guards on the stamp, refuses while a row carries any of the four,
//      and uses no CASCADE.
// WHAT IT DOES NOT CATCH: whether the SQL applies — the integration run and the README's local rehearsal do.
// MUTATION: delete `EXISTS (SELECT 1 FROM public.schema_version WHERE version = …) AND` from one armed post
// gate -> "arms every post gate" reds, naming the gate.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DIR = 'migrations/v5-pantryitemamount-001'
const read = (f) => readFileSync(resolve(ROOT, DIR, f), 'utf8')
const A = read('0a-additive-ddl.sql')
const R = read('0r-rollback.sql')
const G = read('gates.yml')
// gates.yml with its comment lines removed (a comment may name what a gate must never do).
const G_CODE = G.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
// SQL with its comments removed, so a word in the header cannot satisfy a rule about statements.
const code = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
const A_CODE = code(A)
const R_CODE = code(R)
const STAMP = '5.0.0-pantryitemamount-001'
const STAMP_RE = STAMP.replace(/\./g, '\\.')
const COLUMNS = ['quantity_value', 'quantity_unit', 'source_kind', 'source_label']
const CHECKS = [
  'chk_pantry_item_quantity_pairing', 'chk_pantry_item_quantity_value', 'chk_pantry_item_quantity_unit',
  'chk_pantry_item_source_kind', 'chk_pantry_item_source_label_nonblank', 'chk_pantry_item_source_label_len',
  'chk_pantry_item_source_label_kind', 'chk_pantry_item_source_other', 'chk_pantry_item_source_plant',
]
const gateBlocks = (phase) => {
  const from = G.indexOf(`\n${phase}:`)
  const rest = G.slice(from + 1)
  const next = rest.slice(phase.length + 1).search(/^[a-z]+:\s*$/m)
  const body = next < 0 ? rest : rest.slice(0, next + phase.length + 1)
  return body.split(/\n {2}- name: /).slice(1)
}

describe('v5-pantryitemamount-001 0a', () => {
  it('names its stamp on line 2 and inserts that stamp', () => {
    expect(A.split('\n')[1]).toBe(`-- schema_version: ${STAMP}`)
    expect(A_CODE).toMatch(new RegExp(String.raw`INSERT INTO public\.schema_version[\s\S]*?VALUES\s*\('${STAMP_RE}'`))
  })

  it('is one transaction, with the stamp inside it', () => {
    expect(A_CODE.match(/^\s*BEGIN;/gm)).toHaveLength(1)
    expect(A_CODE.match(/^\s*COMMIT;/gm)).toHaveLength(1)
    const stampAt = A_CODE.indexOf('INSERT INTO public.schema_version')
    expect(stampAt).toBeGreaterThan(A_CODE.indexOf('BEGIN;'))
    expect(stampAt).toBeLessThan(A_CODE.indexOf('COMMIT;'))
  })

  it('applies on top of v5-pantry-001 only, and the integration train lists it last', () => {
    expect(A_CODE).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '5\.0\.0-pantry-001'\)/)
    const wf = readFileSync(resolve(ROOT, '.github/workflows/integration-test.yml'), 'utf8')
    const list = wf.match(/^\s*for dir in ([^;\n]+); do\s*$/m)[1].trim().split(/\s+/)
    expect(list.at(-1)).toBe('v5-pantryitemamount-001')
    expect(list.indexOf('v5-pantry-001')).toBeGreaterThan(-1)
    expect(list.indexOf('v5-pantry-001')).toBeLessThan(list.indexOf('v5-pantryitemamount-001'))
  })

  it('alters public.pantry_item and nothing else: the four columns, IF NOT EXISTS', () => {
    const alters = [...A_CODE.matchAll(/ALTER TABLE ([a-z_.]+)/g)].map((m) => m[1])
    expect(alters).toEqual(['public.pantry_item', 'public.pantry_item'])
    const added = [...A_CODE.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1])
    expect(added).toEqual(COLUMNS)
    expect(A_CODE).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/)
  })

  it('adds the nine CHECKs, each DROP IF EXISTS + ADD, and no FK, trigger, function, index or CASCADE', () => {
    const adds = [...A_CODE.matchAll(/ADD CONSTRAINT ([a-z_]+)\s+CHECK/g)].map((m) => m[1])
    expect(adds).toEqual(CHECKS)
    const drops = [...A_CODE.matchAll(/DROP CONSTRAINT IF EXISTS ([a-z_]+),/g)].map((m) => m[1])
    expect(drops).toEqual(CHECKS)
    expect(A_CODE).not.toMatch(/FOREIGN KEY|REFERENCES|CREATE (OR REPLACE )?(TRIGGER|FUNCTION)|CREATE (UNIQUE )?INDEX|CASCADE/)
    expect(A_CODE).not.toMatch(/\bDROP COLUMN\b|\bDROP TABLE\b/)
  })

  it('creates every CHECK validated: no NOT VALID, no VALIDATE step', () => {
    expect(A_CODE).not.toMatch(/NOT VALID/)
    expect(A_CODE).not.toMatch(/VALIDATE CONSTRAINT/)
  })

  it('names nothing a gate elsewhere matches by conname with no table filter', () => {
    // v4-putupprov-001 counts chk_preservation_log_* by name; v5-sourcekind-001 hunts the bare chk_source_kind.
    for (const name of CHECKS) {
      expect(name.startsWith('chk_pantry_item_'), name).toBe(true)
      expect(name).not.toBe('chk_source_kind')
    }
    expect(A_CODE).not.toMatch(/\bchk_preservation_log_/)
  })

  it('the planting rule is the put-up\'s exact text, with no `IS NOT NULL) OR` arm (the anchor-check shape a prod gate hunts)', () => {
    expect(A_CODE).toMatch(/CHECK \(source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL\)/)
    expect(A_CODE).not.toMatch(/IS NOT NULL\)\s+OR/)
    const putUp = code(readFileSync(resolve(ROOT, 'migrations/v4-putupprov-001/0a-additive-ddl.sql'), 'utf8'))
    expect(putUp).toMatch(/chk_preservation_log_source_plant\s+CHECK \(source_kind IS NULL OR source_kind = 'own_garden' OR plant_id IS NULL\)/)
  })
})

describe('v5-pantryitemamount-001 gates.yml', () => {
  it('reads catalogs by join, never ::regclass (pooled connections; vacuous before the apply)', () => {
    expect(G_CODE).not.toMatch(/::regclass/)
    expect(G_CODE).toMatch(/pg_class/)
  })

  it('names v4-cascadesweep-001 and v4-evtanchordel-001 in its census', () => {
    const census = G.slice(G.indexOf('THE GATE CENSUS'), G.indexOf('\npre:'))
    expect(census).toMatch(/v4-cascadesweep-001/)
    expect(census).toMatch(/v4-evtanchordel-001/)
  })

  it('has pre and post phases only: no sweep (nothing can meet existing data)', () => {
    expect([...G_CODE.matchAll(/^([a-z]+):\s*$/gm)].map((m) => m[1])).toEqual(['pre', 'post'])
    expect(gateBlocks('pre').map((b) => b.split('\n')[0].trim())).toEqual([
      'pre_not_already_applied', 'pre_pantry_applied', 'pre_no_item_amount_shape_yet', 'pre_put_up_source_checks_present',
    ])
  })

  it('arms every post gate on its stamp, or says NOT ARMED, or is apply-window only', () => {
    const post = G.slice(G.indexOf('\npost:'))
    const blocks = gateBlocks('post')
    expect(blocks.map((b) => b.split('\n')[0].trim())).toEqual([
      'post_schema_version_recorded', 'post_item_amount_columns', 'post_item_amount_checks_present_and_validated',
      'post_item_unit_check_carries_the_kitchen_units', 'post_item_unit_check_admits_no_legacy_plural',
      'post_item_source_checks_match_put_up', 'post_item_source_other_is_null_safe', 'post_no_item_amount_row_yet',
    ])
    const before = (name) => post.slice(0, post.indexOf(`- name: ${name}`)).split('\n').slice(-4).join('\n')
    for (const b of blocks) {
      const name = b.split('\n')[0].trim()
      const armed = b.includes(`EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${STAMP}')`)
      const notArmed = /NOT ARMED/.test(before(name))
      const window = /continuous: false/.test(b)
      const receipt = name === 'post_schema_version_recorded'
      expect(armed || notArmed || window || receipt, `${name} is neither armed nor declared NOT ARMED`).toBe(true)
    }
  })

  it('no gate reads a new column except through a catalog or to_jsonb: vacuous, never ERROR, without the DDL', () => {
    // A column named as a string ('quantity_value', in an IN-list or VALUES) is a catalog read. A column named
    // as an identifier would be a 42703 on a database that lacks it — prod, from the dev push to the sitting.
    // Each gate's SQL with its YAML comment lines and its string literals taken out ('' is a quote inside one).
    const sqls = [...gateBlocks('pre'), ...gateBlocks('post')]
      .map((b) => b.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/'(?:[^']|'')*'/g, "''"))
    expect(sqls).toHaveLength(12)
    for (const sql of sqls) {
      for (const col of COLUMNS) expect(sql, sql.split('\n')[0]).not.toMatch(new RegExp(String.raw`\b${col}\b`))
    }
    // the stripping leaves the SQL standing: a column read as an identifier would be seen
    expect("SELECT i.quantity_value FROM public.pantry_item i WHERE i.name = 'quantity_unit'".replace(/'(?:[^']|'')*'/g, "''"))
      .toMatch(/\bquantity_value\b/)
  })

  it('names the four columns and the nine CHECKs in lists, and never counts them', () => {
    const blocks = [...gateBlocks('pre'), ...gateBlocks('post')]
    const cataloged = blocks.filter((b) => /information_schema\.columns|pg_constraint/.test(b))
    expect(cataloged.length).toBeGreaterThanOrEqual(8)
    for (const b of cataloged) expect(b, b.split('\n')[0]).not.toMatch(/count\(/)
    const named = (name) => blocks.find((b) => b.startsWith(`${name}\n`))
    for (const col of COLUMNS) expect(named('post_item_amount_columns'), col).toContain(`'${col}'`)
    for (const con of CHECKS) {
      expect(named('post_item_amount_checks_present_and_validated'), con).toContain(`'${con}'`)
      expect(named('pre_no_item_amount_shape_yet'), con).toContain(`'${con}'`)
    }
    // only rowcount_eq / scalar_eq, as the runner's house gates are
    expect([...new Set([...G_CODE.matchAll(/^\s+expect: ([a-z_]+)$/gm)].map((m) => m[1]))].sort()).toEqual(['rowcount_eq', 'scalar_eq'])
  })

  it('the apply-window receipt is not continuous and reads rows through to_jsonb', () => {
    const b = gateBlocks('post').find((x) => x.startsWith('post_no_item_amount_row_yet\n'))
    expect(b).toMatch(/continuous: false/)
    for (const col of COLUMNS) expect(b, col).toContain(`(to_jsonb(i) ->> '${col}')`)
  })
})

describe('v5-pantryitemamount-001 0r', () => {
  it('refuses unless 0a is applied, and while any pantry item carries an amount or a source', () => {
    expect(R_CODE).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM public\\.schema_version WHERE version = '${STAMP_RE}'\\)`))
    for (const col of COLUMNS) expect(R_CODE, col).toContain(`(to_jsonb(i) ->> '${col}')`)
    expect(R_CODE).toMatch(/IF v_n > 0 THEN\s+RAISE EXCEPTION/)
    // the guard counts soft-deleted rows too: it never filters on deleted_at
    expect(R_CODE).not.toMatch(/deleted_at/)
    // the guard runs before anything is dropped
    expect(R_CODE.indexOf('RAISE EXCEPTION')).toBeLessThan(R_CODE.indexOf('DROP CONSTRAINT'))
  })

  it('drops every object 0a creates, with no CASCADE, and removes the stamp', () => {
    expect([...R_CODE.matchAll(/DROP CONSTRAINT IF EXISTS ([a-z_]+)/g)].map((m) => m[1]).sort()).toEqual([...CHECKS].sort())
    expect([...R_CODE.matchAll(/DROP COLUMN IF EXISTS ([a-z_]+)/g)].map((m) => m[1]).sort()).toEqual([...COLUMNS].sort())
    expect(R_CODE).not.toMatch(/CASCADE/)
    expect(R_CODE).not.toMatch(/DROP TABLE/)
    expect(R_CODE).toMatch(new RegExp(`DELETE FROM public\\.schema_version WHERE version = '${STAMP_RE}'`))
    expect(R_CODE.match(/^\s*BEGIN;/gm)).toHaveLength(1)
    expect(R_CODE.match(/^\s*COMMIT;/gm)).toHaveLength(1)
  })
})

describe('v5-pantryitemamount-001 README', () => {
  it('is there, in the house shape, with the rehearsal recorded', () => {
    const md = read('README.md')
    for (const f of ['0a-additive-ddl.sql', '0r-rollback.sql', 'gates.yml']) expect(md, f).toContain(f)
    expect(md).toContain(STAMP)
    for (const h of ['## What 0a adds', '## Apply order', '## Why the deployed writer is compatible', '## Undoing the release', '## Rehearsal']) {
      expect(md, h).toContain(h)
    }
  })
})
