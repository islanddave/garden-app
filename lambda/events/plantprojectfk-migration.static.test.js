// BUG-PLANTPROJECTFKDRIFT-001 — static guard over migrations/v5-plantprojectfkdrift-001.
//
// WHAT IT HOLDS. Prod has carried plants_id_project_uq and event_log_plant_project_fk since 2026-08-21,
// added by hand. The migration exists to give staging the SAME two objects, so the one thing it must
// never do is drift from prod's definitions: a foreign key re-typed without ON UPDATE CASCADE would
// still be called event_log_plant_project_fk, the drift check (which compares names) would say
// "in sync", and moving a planting on staging would behave differently from prod. So prod's three
// catalog strings are typed ONCE, in PROD below, and every file in the directory is held to them.
//
// WHY FILE-READING. The unit lane has no database. What the files DO to a catalog is proved by
// migrations/v5-plantprojectfkdrift-001/rehearse_local.py on a throwaway local Postgres (it also shows
// that the ADD statements below render as exactly these strings). This file pins what can be read, on
// every push: the definitions, that nothing is skipped by name alone, that nothing validates blind,
// that nothing deletes a row, and that the rollback cannot reach an object it did not create.
// Mutation arms: drop ON UPDATE CASCADE from 0a's ADD → "renders as prod's" reds; add a deleted_at
// filter to 0c's count or to the sweep → "every row" reds; move a DROP outside its -created- branch →
// "only what it created" reds; arm post_foreign_key_is_validated on 0a's stamp → the arming test reds;
// drop one table from 0c's row-security check, or move it below the count → the row-security test reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const DIR = resolve(ROOT, 'migrations/v5-plantprojectfkdrift-001')
const read = (f) => readFileSync(resolve(DIR, f), 'utf8')

// Prod's definitions as its catalog renders them (pg_get_constraintdef, pg_indexes.indexdef), read
// 2026-10-09. Not to be edited to match the migration: the migration is edited to match these.
const PROD = Object.freeze({
  uq: 'UNIQUE (id, project_id)',
  idx: 'CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)',
  fk: 'FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT',
})
const STAMP = '5.0.0-plantprojectfkdrift-001'
const MADE_UQ = `${STAMP}-created-plants_id_project_uq`
const MADE_FK = `${STAMP}-created-event_log_plant_project_fk`
const VALIDATED = `${STAMP}-validate`

const sqlOnly = (s) => s.split('\n').map((l) => l.replace(/^\s*--.*$/, '')).join('\n')
// The same text with every string literal emptied: for "no statement of this kind" checks, which must
// not trip on a word inside a message or on prod's index definition held as a constant.
const noStrings = (s) => s.replace(/'(?:[^']|'')*'/g, "''")
const flat = (s) => s.replace(/\s+/g, ' ').trim()
const count = (s, re) => (s.match(re) ?? []).length
const literals = (s, prefix) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).filter((v) => v.startsWith(prefix))
// What VALIDATE refuses, as one line. The same text is the count in 0c, the sweep, and the data gate.
const RULE = 'e.plant_id IS NOT NULL AND e.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.id = e.plant_id AND p.project_id = e.project_id)'

const zeroA = sqlOnly(read('0a-additive-ddl.sql'))
const zeroC = sqlOnly(read('0c-validate.sql'))
const zeroR = sqlOnly(read('0r-rollback.sql'))
const gates = read('gates.yml')
const gateSql = gates.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const gate = (name) => {
  const at = gateSql.indexOf(`\n  - name: ${name}\n`)
  expect(at, `gates.yml has no gate named ${name}`).toBeGreaterThan(-1)
  const rest = gateSql.slice(at + 1)
  const end = rest.slice(1).search(/\n(  - name: |[a-z]+:\n)/)
  return end === -1 ? rest : rest.slice(0, end + 1)
}
// A gate's SQL alone. The notes are prose with apostrophes in them; a literal scan must not see them.
const sqlOf = (name) => {
  const g = gate(name)
  const at = g.indexOf('    sql: |\n')
  return at === -1 ? '' : g.slice(at + 11, g.indexOf('\n    expect:', at))
}
const gateNames = [...gateSql.matchAll(/\n  - name: (\S+)/g)].map((m) => m[1])
const allGateSql = gateNames.map(sqlOf).join('\n')

describe('v5-plantprojectfkdrift-001 — the definitions are prod\'s, in every file', () => {
  it('0a adds the key as a UNIQUE CONSTRAINT on (id, project_id), not as a bare index', () => {
    expect(flat(zeroA)).toContain('ALTER TABLE public.plants ADD CONSTRAINT plants_id_project_uq UNIQUE (id, project_id);')
    expect(noStrings(zeroA)).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\b/i)
  })

  it('0a\'s ADD ... FOREIGN KEY renders as prod\'s definition, NOT VALID', () => {
    const m = flat(zeroA).match(/ALTER TABLE public\.event_log ADD CONSTRAINT event_log_plant_project_fk FOREIGN KEY \(([^)]*)\) REFERENCES public\.(\w+) \(([^)]*)\)((?: MATCH \w+)?)((?: ON UPDATE (?:NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT))?)((?: ON DELETE (?:NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT))?)((?: (?:NOT )?DEFERRABLE| INITIALLY \w+)*)( NOT VALID)?;/)
    expect(m, 'the ADD CONSTRAINT event_log_plant_project_fk statement was not found in the expected clause order').toBeTruthy()
    const [, cols, target, targetCols, match, onUpdate, onDelete, defer, notValid] = m
    // The catalog prints nothing for MATCH SIMPLE and nothing for NO ACTION; a deferrable clause it does print.
    const rendered = `FOREIGN KEY (${cols}) REFERENCES ${target}(${targetCols})`
      + (match === ' MATCH SIMPLE' || match === '' ? '' : match)
      + (onUpdate.endsWith('NO ACTION') ? '' : onUpdate) + (onDelete.endsWith('NO ACTION') ? '' : onDelete) + defer
    expect(rendered).toBe(PROD.fk)
    expect(notValid, '0a must add it NOT VALID: validating is 0c\'s job and 0a must not read a row').toBe(' NOT VALID')
  })

  it('0a, 0c and 0r compare against the same three strings, declared once each', () => {
    for (const [name, sql, want] of [
      ['0a', zeroA, { c_uq_def: PROD.uq, c_uq_idx: PROD.idx, c_fk_def: PROD.fk }],
      ['0c', zeroC, { c_fk_def: PROD.fk }],
      ['0r', zeroR, { c_uq_def: PROD.uq, c_uq_idx: PROD.idx, c_fk_def: PROD.fk }],
    ]) {
      const declared = Object.fromEntries([...sql.matchAll(/\b(c_(?:uq_def|uq_idx|fk_def)) CONSTANT text := '([^']*)';/g)].map((m) => [m[1], m[2]]))
      expect(declared, name).toEqual(want)
    }
  })

  it('every definition literal in gates.yml is one of prod\'s (the foreign key with or without NOT VALID)', () => {
    const fks = literals(allGateSql, 'FOREIGN KEY (')
    expect(fks.length, 'pre x3, post_foreign_key_is_prods x2, post_foreign_key_is_validated x1').toBe(6)
    for (const v of fks) expect([PROD.fk, `${PROD.fk} NOT VALID`]).toContain(v)
    const uqs = literals(allGateSql, 'UNIQUE (')
    expect(uqs).toEqual([PROD.uq, PROD.uq, PROD.uq])
    const idxs = literals(allGateSql, 'CREATE UNIQUE INDEX')
    expect(idxs).toEqual([PROD.idx, PROD.idx, PROD.idx])
  })

  it('"validated" is compared WITHOUT the NOT VALID form; "is prod\'s" accepts both', () => {
    expect(literals(sqlOf('post_foreign_key_is_validated'), 'FOREIGN KEY (')).toEqual([PROD.fk])
    expect(sqlOf('post_foreign_key_is_validated')).toMatch(/AND c\.convalidated\n/)
    expect(literals(sqlOf('post_foreign_key_is_prods'), 'FOREIGN KEY (')).toEqual([PROD.fk, `${PROD.fk} NOT VALID`])
    expect(literals(sqlOf('pre_prod_already_carries_both_and_the_apply_changes_nothing'), 'FOREIGN KEY (')).toEqual([PROD.fk])
  })

  it('the README and the rehearsal quote the same three strings', () => {
    const readme = read('README.md')
    for (const v of Object.values(PROD)) expect(readme).toContain(`\`${v}\``)
    const rehearsal = read('rehearse_local.py')
    expect(rehearsal).toContain(`PROD_UQ = "${PROD.uq}"`)
    expect(rehearsal).toContain(`PROD_IDX = "${PROD.idx}"`)
    const fk = rehearsal.match(/PROD_FK = \("([^"]*)"\s*"([^"]*)"\)/)
    expect(fk && fk[1] + fk[2]).toBe(PROD.fk)
  })
})

describe('v5-plantprojectfkdrift-001 — 0a: by catalog lookup, loud on a different definition, no row read', () => {
  it('is one transaction with the search_path pinned (the definitions are compared as text)', () => {
    for (const sql of [zeroA, zeroC, zeroR]) {
      expect(count(sql, /^BEGIN;$/gm)).toBe(1)
      expect(count(sql, /^COMMIT;$/gm)).toBe(1)
      expect(sql).toMatch(/^SET LOCAL search_path = public;$/m)
      expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    }
  })

  it('each ADD CONSTRAINT runs only in the branch where the catalog has no constraint of that name', () => {
    expect(count(zeroA, /\bADD CONSTRAINT\b/g)).toBe(2)
    for (const [name, made] of [['plants_id_project_uq', MADE_UQ], ['event_log_plant_project_fk', MADE_FK]]) {
      const lookup = zeroA.indexOf(`AND c.conname = '${name}';`)
      const branch = zeroA.indexOf('IF v_n = 0 THEN', lookup)
      const add = zeroA.indexOf(`ADD CONSTRAINT ${name}`)
      const stamp = zeroA.indexOf(`VALUES ('${made}'`)
      const otherwise = zeroA.indexOf('\n  ELSE\n', branch)
      expect(lookup, name).toBeGreaterThan(-1)
      // lookup by name → IF absent → ADD → the -created- row → ELSE. Nothing of it outside the branch.
      expect([lookup < branch, branch < add, add < stamp, stamp < otherwise], name).toEqual([true, true, true, true])
      expect(count(zeroA, new RegExp(`VALUES \\('${made.replace(/\./g, '\\.')}'`, 'g')), name).toBe(1)
    }
  })

  it('does not lean on IF NOT EXISTS or on swallowing duplicate_object: a same-named object is compared, not skipped', () => {
    expect(zeroA).not.toMatch(/IF NOT EXISTS/i)
    expect(zeroA).not.toMatch(/duplicate_object|WHEN OTHERS|EXCEPTION\s+WHEN/i)
    const body = flat(zeroA)
    expect(body).toContain("IF v_n <> 1 OR v_tbl IS DISTINCT FROM 'plants' OR v_type IS DISTINCT FROM 'u' OR v_def IS DISTINCT FROM c_uq_def OR v_idx IS DISTINCT FROM c_uq_idx THEN RAISE EXCEPTION")
    expect(body).toContain("IF v_n <> 1 OR v_tbl IS DISTINCT FROM 'event_log' OR v_type IS DISTINCT FROM 'f' OR v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN RAISE EXCEPTION")
    // The name is looked for across the schema, so the name on another table is a finding too.
    expect(count(zeroA, /JOIN pg_namespace n ON n\.oid = c\.connamespace/g)).toBe(4)
    // A bare index holding the key's name is refused before the ADD could trip on it.
    expect(body).toMatch(/IF EXISTS \(SELECT 1 FROM pg_class r JOIN pg_namespace n ON n\.oid = r\.relnamespace WHERE n\.nspname = 'public' AND r\.relname = 'plants_id_project_uq'\) THEN RAISE EXCEPTION/)
    expect(count(zeroA, /RAISE EXCEPTION/g)).toBe(4)
  })

  it('validates nothing, drops nothing, and writes only schema_version rows that do not move on a re-run', () => {
    const shape = noStrings(zeroA)
    expect(shape).not.toMatch(/VALIDATE CONSTRAINT/i)
    expect(shape).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?\w+\s+SET\b/i)
    expect(shape).not.toMatch(/COMMENT ON/i)
    expect(zeroA.match(/\bINSERT INTO\s+\S+/g)).toEqual(Array(3).fill('INSERT INTO public.schema_version'))
    expect(count(zeroA, /ON CONFLICT \(version\) DO NOTHING;/g)).toBe(3)
    expect(shape).not.toMatch(/DO UPDATE/i)
    // No row of either table is read: the only FROM targets are catalogs and schema_version.
    expect(shape).not.toMatch(/\b(?:FROM|JOIN)\s+public\.(?:event_log|plants)\b/i)
  })
})

describe('v5-plantprojectfkdrift-001 — 0c: never validates blind, never touches a row', () => {
  const body = flat(zeroC)

  it('counts exactly what VALIDATE refuses, over every row', () => {
    const at = zeroC.indexOf('SELECT count(*) INTO v_bad')
    const end = zeroC.indexOf('IF v_bad > 0 THEN')
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const counted = flat(zeroC.slice(at, end))
    expect(counted).toBe(`SELECT count(*) INTO v_bad FROM public.event_log e WHERE ${RULE};`)
    expect(counted).not.toMatch(/deleted_at|archived_at/)
  })

  it('refuses with the count and the listing query before the one VALIDATE, and only validates what is not validated', () => {
    expect(count(noStrings(zeroC), /VALIDATE CONSTRAINT/g)).toBe(1)
    const order = ['IF v_valid THEN', 'ELSE', 'IF row_security_active(', 'SELECT count(*) INTO v_bad', 'IF v_bad > 0 THEN', 'RAISE EXCEPTION',
      'END IF;', 'ALTER TABLE public.event_log VALIDATE CONSTRAINT event_log_plant_project_fk;']
    let from = zeroC.indexOf(order[0])
    for (const step of order) {
      const at = zeroC.indexOf(step, from)
      expect(at, `"${step}" is not where the refusal-before-VALIDATE order needs it`).toBeGreaterThanOrEqual(from)
      from = at + step.length
    }
    expect(body).toMatch(/refused, nothing changed: % event_log row\(s\)/)
    const hint = read('0c-validate.sql').match(/List them: (SELECT .*? ORDER BY e\.created_at);/)
    expect(hint, 'the HINT carries the listing query').toBeTruthy()
    expect(hint[1]).toContain('NOT EXISTS (SELECT 1 FROM public.plants q WHERE q.id = e.plant_id AND q.project_id = e.project_id)')
    expect(hint[1]).not.toMatch(/WHERE[^;]*deleted_at/)
  })

  it('refuses to count as a role row security hides rows from: both tables asked, before the count', () => {
    // Under row security the count is of the visible rows. rehearse_local.py section F: a non-superuser
    // owner under FORCE counts 0 with three rows in the way, and without this check 0c VALIDATED.
    const guard = "IF row_security_active('public.event_log'::regclass) OR row_security_active('public.plants'::regclass) THEN RAISE EXCEPTION 'v5-plantprojectfkdrift-001 0c refused, nothing changed: row security is active on event_log or plants for role"
    expect(body).toContain(guard)
    expect(count(noStrings(zeroC), /row_security_active\(/g)).toBe(2)
    const at = zeroC.indexOf('IF row_security_active(')
    const closed = zeroC.indexOf('END IF;', at)
    // Inside the not-yet-validated branch, closed before the count: nothing between it and VALIDATE can skip it.
    expect(at).toBeGreaterThan(zeroC.indexOf('\n  ELSE\n', zeroC.indexOf('IF v_valid THEN')))
    expect(closed).toBeLessThan(zeroC.indexOf('SELECT count(*) INTO v_bad'))
    expect(zeroC.slice(at, closed)).not.toMatch(/\bELSE\b|\bELSIF\b|RAISE (?:NOTICE|WARNING)/)
    // gates.yml asks the same of the role the runner connects as, on both environments, before the apply.
    const g = 'pre_row_security_does_not_hide_rows_from_this_role'
    expect(flat(sqlOf(g))).toBe("SELECT 1 WHERE row_security_active(to_regclass('public.event_log')) OR row_security_active(to_regclass('public.plants'))")
    expect(gate(g)).toMatch(/expect: rowcount_eq\n\s+value: 0\n/)
    expect(gate(g)).not.toMatch(/\n\s+(?:env|manual|continuous): /)
  })

  it('refuses unless 0a ran here and the constraint is the one 0a records', () => {
    expect(body).toContain(`IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '${STAMP}') THEN RAISE EXCEPTION`)
    expect(body).toContain("IF v_n <> 1 OR v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN RAISE EXCEPTION")
  })

  it('writes its stamp last, only after reading back that the constraint is validated; no other write', () => {
    const readBack = zeroC.indexOf('IF v_valid IS NOT TRUE THEN')
    const stamp = zeroC.indexOf(`VALUES ('${VALIDATED}'`)
    expect(readBack).toBeGreaterThan(zeroC.indexOf('VALIDATE CONSTRAINT'))
    expect(stamp).toBeGreaterThan(readBack)
    expect(zeroC.match(/\bINSERT INTO\s+\S+/g)).toEqual(['INSERT INTO public.schema_version'])
    expect(noStrings(zeroC)).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?\w+\s+SET\b|ADD CONSTRAINT/i)
  })
})

describe('v5-plantprojectfkdrift-001 — 0r: only what this migration created here', () => {
  it('returns before any drop or delete when the database carries no -created- row (prod)', () => {
    const body = flat(zeroR)
    expect(body).toContain("c_fk_row CONSTANT text := '" + MADE_FK + "';")
    expect(body).toContain("c_uq_row CONSTANT text := '" + MADE_UQ + "';")
    expect(body).toContain('v_made_fk := EXISTS (SELECT 1 FROM public.schema_version WHERE version = c_fk_row);')
    expect(body).toContain('v_made_uq := EXISTS (SELECT 1 FROM public.schema_version WHERE version = c_uq_row);')
    const early = zeroR.indexOf('IF NOT v_made_fk AND NOT v_made_uq THEN')
    const ret = zeroR.indexOf('RETURN;', early)
    expect(early).toBeGreaterThan(-1)
    expect(ret).toBeGreaterThan(early)
    for (const write of ['DROP CONSTRAINT', 'DELETE FROM']) {
      expect(zeroR.indexOf(write), `${write} appears before the early return`).toBeGreaterThan(ret)
    }
    // Nothing reassigns the two flags: what the schema_version rows said is what decides.
    expect(count(zeroR, /v_made_(?:fk|uq)\s*:=/g)).toBe(2)
  })

  it('each DROP sits inside its own -created- branch, after a definition check, and the foreign key goes first', () => {
    expect(count(noStrings(zeroR), /\bDROP\b/g)).toBe(2)
    const fkBranch = zeroR.indexOf('IF v_made_fk THEN')
    const uqBranch = zeroR.indexOf('IF v_made_uq THEN')
    const fkDrop = zeroR.indexOf('ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk;')
    const uqDrop = zeroR.indexOf('ALTER TABLE public.plants DROP CONSTRAINT plants_id_project_uq;')
    expect([fkBranch > -1, fkBranch < fkDrop, fkDrop < uqBranch, uqBranch < uqDrop]).toEqual([true, true, true, true])
    // Between the branch and its DROP: the "no longer the constraint 0a created" refusal.
    expect(flat(zeroR.slice(fkBranch, fkDrop))).toContain("ELSIF v_def IS NULL OR v_def NOT IN (c_fk_def, c_fk_def || ' NOT VALID') THEN RAISE EXCEPTION")
    expect(flat(zeroR.slice(uqBranch, uqDrop))).toContain('ELSIF v_def IS DISTINCT FROM c_uq_def OR v_idx IS DISTINCT FROM c_uq_idx THEN RAISE EXCEPTION')
    // ... and for the key, the named refusal while any foreign key still rests on its index.
    expect(flat(zeroR.slice(uqBranch, uqDrop))).toContain('IF v_users IS NOT NULL THEN RAISE EXCEPTION')
    // The ELSE of each branch drops nothing.
    expect(noStrings(zeroR.slice(zeroR.indexOf(';', fkDrop), uqBranch))).not.toMatch(/\bDROP\b/)
  })

  it('never cascades, never drops an index or a table, and deletes only its own four schema_version rows', () => {
    const shape = noStrings(zeroR)
    expect(shape).not.toMatch(/\bCASCADE\b/i)
    expect(shape).not.toMatch(/DROP\s+(?:INDEX|TABLE)/i)
    expect(shape).not.toMatch(/\bTRUNCATE\b|\bINSERT INTO\b|\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?\w+\s+SET\b|ADD CONSTRAINT|VALIDATE CONSTRAINT/i)
    expect(zeroR.match(/\bDELETE FROM\s+\S+/g)).toEqual(['DELETE FROM public.schema_version'])
    expect(flat(zeroR)).toContain(`DELETE FROM public.schema_version WHERE version IN ('${VALIDATED}', c_fk_row, c_uq_row, '${STAMP}');`)
  })
})

describe('v5-plantprojectfkdrift-001 — gates.yml', () => {
  const names = (phase) => {
    const from = gateSql.indexOf(`\n${phase}:\n`)
    const rest = gateSql.slice(from + phase.length + 2)
    const end = rest.search(/\n[a-z]+:\n/)
    return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/\n  - name: (\S+)/g)].map((m) => m[1])
  }

  it('has the gates the README counts, in the phases it says', () => {
    expect(names('pre')).toEqual([
      'pre_the_three_tables_are_here', 'pre_no_same_named_object_with_another_definition',
      'pre_row_security_does_not_hide_rows_from_this_role',
      'pre_prod_already_carries_both_and_the_apply_changes_nothing',
      'pre_staging_lambdas_derive_the_event_project_from_the_planting',
    ])
    expect(names('sweep')).toEqual(['sweep_no_event_names_a_project_its_planting_is_not_in'])
    expect(names('post')).toEqual([
      'post_schema_version_recorded', 'post_unique_key_is_prods', 'post_foreign_key_is_prods',
      'post_validation_recorded', 'post_foreign_key_is_validated',
      'post_no_event_names_a_project_its_planting_is_not_in', 'post_prod_carries_no_created_row',
    ])
  })

  it('no pre gate asserts the constraints are absent: the migration is re-runnable and prod-safe', () => {
    for (const n of names('pre')) expect(gate(n), n).not.toMatch(/value: 0\n[\s\S]*schema_version WHERE version|pre_not_already_applied/)
    expect(names('pre').join(' ')).not.toMatch(/absent|not_already/)
  })

  it('every standing post gate arms itself on the stamp of the file that makes it true', () => {
    const armedOn = (n) => [...gate(n).matchAll(/schema_version\s+WHERE version = '([^']+)'/g)].map((m) => m[1])
    expect(armedOn('post_unique_key_is_prods')).toEqual([STAMP])
    expect(armedOn('post_foreign_key_is_prods')).toEqual([STAMP])
    // "validated" and "no row disagrees" belong to 0c. Armed on 0a's stamp they would red a staging
    // that 0c refused on, every week, for rows the owner has not yet decided about.
    expect(armedOn('post_foreign_key_is_validated')).toEqual([VALIDATED])
    expect(armedOn('post_no_event_names_a_project_its_planting_is_not_in')).toEqual([VALIDATED])
    for (const n of ['post_schema_version_recorded', 'post_validation_recorded']) expect(gate(n), n).toMatch(/continuous: false/)
    for (const n of names('post').filter((x) => !/_recorded$/.test(x))) expect(gate(n), n).not.toMatch(/continuous:/)
  })

  it('the two prod-only gates say so, and nothing else is scoped to one environment', () => {
    const scoped = [...names('pre'), ...names('sweep'), ...names('post')].filter((n) => /\n\s+env: /.test(gate(n)))
    expect(scoped).toEqual(['pre_prod_already_carries_both_and_the_apply_changes_nothing', 'post_prod_carries_no_created_row'])
    for (const n of scoped) expect(gate(n)).toMatch(/\n\s+env: prod\n/)
    expect(gate('post_prod_carries_no_created_row')).toContain(`'${MADE_UQ}'`)
    expect(gate('post_prod_carries_no_created_row')).toContain(`'${MADE_FK}'`)
  })

  it('the sweep and the data gate are the same rule 0c counts, with no deleted_at filter', () => {
    for (const n of ['sweep_no_event_names_a_project_its_planting_is_not_in', 'post_no_event_names_a_project_its_planting_is_not_in']) {
      const sql = flat(gate(n).slice(gate(n).indexOf('sql: |')))
      expect(sql, n).toContain(RULE)
      expect(sql, n).not.toMatch(/deleted_at|archived_at/)
    }
    const readme = flat(read('README.md'))
    expect(readme).toContain(`SELECT count(*) FROM public.event_log e WHERE ${RULE};`)
  })

  it('reads the catalog by joins, never by ::regclass, so every gate runs on an unapplied database', () => {
    expect(gateSql).not.toMatch(/::regclass/)
  })
})

describe('v5-plantprojectfkdrift-001 — README: what is known and tracked stays written down', () => {
  const readme = read('README.md')

  it('names the re-home cascade as known, tracked elsewhere, and not a reason to change the definition', () => {
    const at = readme.indexOf('\n## Known: emptying a container')
    expect(at).toBeGreaterThan(-1)
    const section = readme.slice(at, readme.indexOf('\n## ', at + 4))
    expect(section).toContain('BUG-PLANTPAIRCASCADENULLSHISTORY-001')
    expect(section).toContain('UPDATE plants SET project_id = NULL')
    expect(section).toContain('2026-08-21')
    expect(read('rehearse_local.py')).toContain('BUG-PLANTPAIRCASCADENULLSHISTORY-001')
  })

  it('the apply sequence carries the promote-safety conditions as steps, not as advice', () => {
    const apply = readme.slice(readme.indexOf('\n## Apply'), readme.indexOf('\n## If 0c refuses'))
    for (const must of ['python3 scripts/staged-promote.py check', 'integration-test.yml', '0r-rollback.sql',
      'pre_row_security_does_not_hide_rows_from_this_role', '10 passed', '5 skipped', '15 passed']) {
      expect(apply, must).toContain(must)
    }
  })
})

describe('tests/integration/anchor-pair.int.test.js — the refused fixture does not come back', () => {
  const int = readFileSync(resolve(ROOT, 'tests/integration/anchor-pair.int.test.js'), 'utf8')
  const code = int.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

  it('the only direct write of another project onto an event is the one that expects to be refused', () => {
    const writes = [...code.matchAll(/UPDATE event_log SET project_id = (\$\{\w+\}|NULL)/g)].map((m) => m[1])
    // NULL (the shape MATCH SIMPLE allows), the planting's own project (putting it back), and ONE other
    // project: inside the try whose catch reads the 23503.
    expect(writes.filter((w) => w !== 'NULL' && w !== '${projTrue}')).toEqual(['${projOther}'])
    const at = code.indexOf('UPDATE event_log SET project_id = ${projOther}')
    expect(code.lastIndexOf('try {', at)).toBeGreaterThan(code.lastIndexOf('it(', at))
    expect(code.slice(at, at + 600)).toMatch(/toBe\('23503'\)/)
  })

  it('the block that needs the constraint is skipped without it, and the stamp makes the constraint mandatory', () => {
    expect(code).toContain('describe.skipIf(!HAS_PAIR_FK)(')
    expect(code).toContain('it.runIf(HAS_PAIR_FK_STAMP)(')
    expect(code).toContain(`WHERE version = '${STAMP}'`)
    // Outside that block nothing is conditional on the constraint: the repair check runs everywhere.
    expect(count(code, /skipIf\(|runIf\(/g)).toBe(2)
  })
})
