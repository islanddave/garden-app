// Put-Up release 2 (B′) — static guards on migrations/v5-pantry-001 (the pattern the train's F directory is
// held to: integrationPutUpTrain.static.test.js for the train list, kitchen-columns.test.js for the DDL).
//
// What it pins, each a way the sitting would go wrong without a red here:
//   1. line 2 is `-- schema_version: 5.0.0-pantry-001` and the file INSERTs that stamp (the integration
//      train step reads line 2 to decide "already applied");
//   2. ONE transaction: exactly one BEGIN and one COMMIT, the stamp inside it;
//   3. it applies on top of F only (its guard names F's stamp), and the train lists it after F;
//   4. every FOREIGN KEY it adds states its ON DELETE, and none CASCADEs (05 §6; v4-cascadesweep-001);
//   5. the ownership trigger is the user_id variant, never prevent_ownership_transfer() (05 §6);
//   6. nothing F created is re-created (06 §1.3);
//   7. gates.yml: catalog joins only (no ::regclass), every post gate self-armed or explicitly NOT ARMED,
//      and the census names v4-cascadesweep-001 and v4-evtanchordel-001 (05 §6);
//   8. 0r undoes every object 0a creates, guards on the stamp, and uses no CASCADE.
// WHAT IT DOES NOT CATCH: whether the SQL applies — the integration run and the README's local rehearsal do.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const DIR = 'migrations/v5-pantry-001'
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
const STAMP = '5.0.0-pantry-001'

describe('v5-pantry-001 0a', () => {
  it('names its stamp on line 2 and inserts that stamp', () => {
    expect(A.split('\n')[1]).toBe(`-- schema_version: ${STAMP}`)
    expect(A_CODE).toMatch(new RegExp(String.raw`INSERT INTO public\.schema_version[\s\S]*?VALUES\s*\('${STAMP.replace(/\./g, '\\.')}'`))
  })

  it('is one transaction, with the stamp inside it', () => {
    expect(A_CODE.match(/^\s*BEGIN;/gm)).toHaveLength(1)
    expect(A_CODE.match(/^\s*COMMIT;/gm)).toHaveLength(1)
    const stampAt = A_CODE.indexOf('INSERT INTO public.schema_version')
    expect(stampAt).toBeGreaterThan(A_CODE.indexOf('BEGIN;'))
    expect(stampAt).toBeLessThan(A_CODE.indexOf('COMMIT;'))
  })

  it('applies on top of F only, and the integration train lists it right after F', () => {
    expect(A_CODE).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.schema_version WHERE version = '5\.0\.0-fermentpath-001'\)/)
    const wf = readFileSync(resolve(ROOT, '.github/workflows/integration-test.yml'), 'utf8')
    const list = wf.match(/^\s*for dir in ([^;\n]+); do\s*$/m)[1].trim().split(/\s+/)
    expect(list.indexOf('v5-pantry-001')).toBe(list.indexOf('v5-fermentpath-001') + 1)
  })

  it('states ON DELETE on every FOREIGN KEY it adds, and none CASCADEs', () => {
    const fks = [...A_CODE.matchAll(/FOREIGN KEY \(([a-z_]+)\) REFERENCES public\.([a-z_]+) \(([a-z_]+)\)([^,;]*)/g)]
    expect(fks.map((m) => `${m[1]}->${m[2]}`)).toEqual([
      'storage_location_id->storage_location', 'plant_id->plants', 'crop_type_slug->crop_types', 'pantry_item_id->pantry_item',
    ])
    const actions = fks.map((m) => m[4].trim())
    expect(actions).toEqual(['ON DELETE NO ACTION', 'ON DELETE SET NULL', 'ON DELETE NO ACTION', 'ON DELETE NO ACTION'])
    expect(A_CODE).not.toMatch(/CASCADE/)
  })

  it('guards ownership with the user_id variant, never prevent_ownership_transfer() (it reads created_by)', () => {
    expect(A_CODE).toMatch(/CREATE TRIGGER prevent_pantry_item_ownership_transfer BEFORE UPDATE ON public\.pantry_item\s+FOR EACH ROW EXECUTE FUNCTION public\.prevent_kitchen_batch_ownership_transfer\(\)/)
    expect(A_CODE).not.toMatch(/public\.prevent_ownership_transfer\(\)/)
    expect(A_CODE).toMatch(/CREATE TRIGGER set_updated_at BEFORE UPDATE ON public\.pantry_item/)
  })

  it('re-creates nothing F created, and touches no F function, trigger or view', () => {
    // The stamp's description may SAY what F owns; no statement may touch it.
    const ddl = A_CODE.slice(0, A_CODE.indexOf('INSERT INTO public.schema_version'))
    expect(ddl).not.toMatch(/\bpantry_use\b/)
    expect(ddl).not.toMatch(/\b(delta_at|remaining_amount)\b/)
    expect(ddl).not.toMatch(/prevent_kbi_identity_change|trg_audit_|v_kitchen_batch_current|audit_stmt_update/)
  })

  it('the idempotency key is a global unique PARTIAL index (the replay contract)', () => {
    expect(A_CODE).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_pantry_item_idempotency_key\s+ON public\.pantry_item \(idempotency_key\) WHERE idempotency_key IS NOT NULL;/)
  })
})

describe('v5-pantry-001 gates.yml', () => {
  it('reads catalogs by join, never ::regclass (pooled connections; vacuous before the apply)', () => {
    expect(G_CODE).not.toMatch(/::regclass/)
    expect(G_CODE).toMatch(/pg_class/)
  })

  it('names v4-cascadesweep-001 and v4-evtanchordel-001 in its census (05 §6)', () => {
    const census = G.slice(G.indexOf('THE GATE CENSUS'), G.indexOf('\npre:'))
    expect(census).toMatch(/v4-cascadesweep-001/)
    expect(census).toMatch(/v4-evtanchordel-001/)
  })

  it('arms every post gate on its stamp, or says NOT ARMED, or is apply-window only', () => {
    const post = G.slice(G.indexOf('\npost:'))
    const blocks = post.split(/\n  - name: /).slice(1)
    expect(blocks.length).toBeGreaterThanOrEqual(10)
    const before = (name) => post.slice(0, post.indexOf(`- name: ${name}`)).split('\n').slice(-4).join('\n')
    for (const b of blocks) {
      const name = b.split('\n')[0].trim()
      const armed = b.includes(`version = '${STAMP}'`)
      const notArmed = /NOT ARMED/.test(before(name))
      const window = /continuous: false/.test(b)
      const receipt = name === 'post_schema_version_recorded'
      expect(armed || notArmed || window || receipt, `${name} is neither armed nor declared NOT ARMED`).toBe(true)
    }
  })

  it('has a continuous gate that the ownership function names only pantry_item columns', () => {
    const at = G.indexOf('- name: post_pantry_item_ownership_trigger_names_real_columns')
    expect(at).toBeGreaterThan(-1)
    const block = G.slice(at, G.indexOf('\n  - name:', at + 10))
    expect(block).not.toMatch(/continuous: false/)
    expect(block).toMatch(/c\.table_name = 'pantry_item'/)
  })
})

describe('v5-pantry-001 0r', () => {
  it('refuses unless 0a is applied, and once a pantry item or a pantry line exists', () => {
    expect(R_CODE).toMatch(new RegExp(`version = '${STAMP.replace(/\./g, '\\.')}'`))
    expect(R_CODE).toMatch(/SELECT count\(\*\) FROM public\.pantry_item'/)
    expect(R_CODE).toMatch(/WHERE pantry_item_id IS NOT NULL'/)
  })

  it('drops every object 0a creates, with no CASCADE, and removes the stamp', () => {
    for (const obj of ['chk_kbi_pantry_item_kind', 'kitchen_batch_input_pantry_item_id_fkey', 'idx_kbi_pantry_item',
      'DROP COLUMN IF EXISTS pantry_item_id', 'prevent_pantry_item_ownership_transfer', 'set_updated_at ON public.pantry_item',
      'DROP TABLE IF EXISTS public.pantry_item']) {
      expect(R_CODE, obj).toContain(obj)
    }
    expect(R_CODE).not.toMatch(/CASCADE/)
    expect(R_CODE).toMatch(new RegExp(`DELETE FROM public\\.schema_version WHERE version = '${STAMP.replace(/\./g, '\\.')}'`))
    expect(R_CODE.match(/^\s*BEGIN;/gm)).toHaveLength(1)
    expect(R_CODE.match(/^\s*COMMIT;/gm)).toHaveLength(1)
  })
})
