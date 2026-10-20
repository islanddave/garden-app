#!/usr/bin/env node
// generate.mjs — writes this directory's 25 per-table SQL files from owner-classes.json (V5-SPACETENANCYKEY-001,
// multi-space plan V204 step 2.1). The JSON is the one source: the owner lists, the per-table owner columns and
// parent joins, the env fingerprints, the order and the stamps. tenancykey.test.js holds every file equal to what
// this renders, and the marked VALUES blocks in gates.yml and 0r-rollback.sql equal to valuesRows().
//
//   node migrations/v5-tenancykey-001/generate.mjs           check: exit 1 naming each file that differs
//   node migrations/v5-tenancykey-001/generate.mjs --write   rewrite the 25 files
//   node migrations/v5-tenancykey-001/generate.mjs --values  print the rows for the marked VALUES blocks
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = dirname(fileURLToPath(import.meta.url))
export const VALUES_BEGIN = '-- BEGIN tenancykey tables'
export const VALUES_END = '-- END tenancykey tables'

export const loadOwnerClasses = (dir = DIR) => JSON.parse(readFileSync(join(dir, 'owner-classes.json'), 'utf8'))

const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const pad = (n) => String(n).padStart(2, '0')
const slug = (t) => t.table.replace(/_/g, '-')

export const stampOf = (oc, t) => `${oc.stampPrefix}${t.fkOnly ? 'fk-' : ''}${slug(t)}`
export const fileOf = (t) => `${pad(t.n)}-${t.fkOnly ? 'fk-' : ''}${slug(t)}.sql`
export const fkName = (t) => `${t.table}_workspace_id_fkey`

// The classes a table's file accepts, per env: ('prod', 'exact', 'system'), ... A class with `tables` is in that
// table's file only.
export function allowedRows(oc, t) {
  const rows = []
  for (const env of ['prod', 'staging']) {
    for (const c of oc.classes) {
      if (!c.envs.includes(env)) continue
      if (c.tables && !c.tables.includes(t.table)) continue
      rows.push(`(${[env, c.match, c.match === 'null' ? null : c.value, c.id].map(lit).join(', ')})`)
    }
  }
  return rows
}

function ownerQuery(t) {
  if (t.parent) {
    return [`SELECT ${lit(t.parent.label)} AS col, ${t.parent.value} AS val, count(*) AS n`,
      `      FROM ${t.parent.from}`,
      '     GROUP BY 1, 2']
  }
  const parts = t.owner.map((c, i) =>
    `${i ? '    UNION ALL\n    ' : ''}SELECT ${lit(c)} AS col, t.${c} AS val, count(*) AS n FROM public.${t.table} t GROUP BY t.${c}`)
  return [parts.join('\n')]
}

// The audit trigger's catalog fingerprint: type, enabled, function, transition tables, arguments. Read through the
// catalog, so it does not depend on the session's search_path the way pg_get_triggerdef's text does.
export const triggerCanonSql = (table, trigger) => `SELECT md5(concat_ws('|', t.tgtype::text, t.tgenabled::text, pn.nspname, p.proname,
                     pg_get_function_identity_arguments(p.oid), coalesce(t.tgoldtable, ''), coalesce(t.tgnewtable, ''),
                     t.tgnargs::text, encode(t.tgargs, 'escape'), (t.tgqual IS NULL)::text, t.tgattr::text,
                     t.tgdeferrable::text, t.tginitdeferred::text))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
   WHERE n.nspname = 'public' AND c.relname = ${lit(table)} AND t.tgname = ${lit(trigger)}`

function auditPregate(t, tag) {
  const a = t.auditWatch
  if (!a) return ''
  return `
  -- Definition pre-gate: ${a.trigger} is exactly the definition this file was written from.
  ${triggerCanonSql(t.table, a.trigger)}
    INTO v_def;
  IF v_def IS DISTINCT FROM ${lit(a.beforeMd5)} THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: ${a.trigger} fingerprint is %, not ${a.beforeMd5}, the definition this file re-creates from.', coalesce(v_def, 'absent')
      USING HINT = 'Someone changed the trigger since 2026-10-20. Fold their change into owner-classes.json auditWatch, regenerate, re-rehearse.';
  END IF;
`
}

function auditDdl(t, tag) {
  const a = t.auditWatch
  if (!a) return ''
  const args = [...a.before, 'workspace_id'].map(lit).join(', ')
  return `
  -- workspace_id joins ${a.trigger}'s watched list (owner-classes.json auditWatch). The list is the trigger's
  -- arguments; there is no ALTER for it, so DROP + CREATE, same shape, the eleven names in order plus this one.
  DROP TRIGGER ${a.trigger} ON public.${t.table};
  CREATE TRIGGER ${a.trigger}
    AFTER UPDATE ON public.${t.table}
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(${args});
  ${triggerCanonSql(t.table, a.trigger)}
    INTO v_def;
  IF v_def IS DISTINCT FROM ${lit(a.afterMd5)} THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag}: the re-created ${a.trigger} fingerprint is %, not ${a.afterMd5}; rolled back.', coalesce(v_def, 'absent');
  END IF;
`
}

const auditText = (t) => (t.auditWatch
  ? `\n--   AUDIT. ${t.auditWatch.trigger} is re-created with workspace_id added to its watched list, behind a\n--      definition pre-gate (its catalog fingerprint must be ${t.auditWatch.beforeMd5}). Reason: owner-classes.json\n--      auditWatch. Same name, type and function, so restore-verify's dump-time trigger list still matches.`
  : '')

const ownerText = (t) => (t.parent
  ? `no owner column; the owner is read through a parent join (${t.parent.label})`
  : t.owner.length === 1 ? `the owner column is ${t.owner[0]}` : `the owner columns are ${t.owner.join(' and ')} (both are read)`)

// The guard's opening: the env, the database's fingerprint, the stamp short-circuit.
function guardHead(oc, t, tag) {
  const f = oc.fingerprint
  const stamp = stampOf(oc, t)
  return `DO $pregate$
DECLARE
  v_env text := current_setting('tenancykey.env', true);
  v_bad text;
  v_def text;
BEGIN
  IF v_env IS NULL OR v_env NOT IN ('prod', 'staging') THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: env is %, not prod or staging.', coalesce(quote_literal(v_env), 'unset')
      USING HINT = 'Run it with psql -v env=prod or -v env=staging (scripts/tenancykey-apply.py does).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_version
                  WHERE version = CASE v_env WHEN 'prod' THEN ${lit(f.prod.present)} ELSE ${lit(f.staging.present)} END)
     OR EXISTS (SELECT 1 FROM public.schema_version
                 WHERE version = CASE v_env WHEN 'prod' THEN ${lit(f.prod.absent)} ELSE ${lit(f.staging.absent)} END) THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: this database does not carry the % fingerprint (owner-classes.json "fingerprint").', v_env
      USING HINT = 'The -v env value names the other database. Check which URL this is before anything else.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = ${lit(stamp)}) THEN
    RAISE NOTICE 'v5-tenancykey-001 ${tag}: stamp ${stamp} present; nothing to check.';
    RETURN;
  END IF;`
}

function addColumnFile(oc, t, total) {
  const stamp = stampOf(oc, t)
  const tag = `${pad(t.n)} (${t.table})`
  const q = `public.${t.table}`
  return `-- ${fileOf(t)}
-- V5-SPACETENANCYKEY-001, multi-space step 2.1 (plan V204 §2.1, §3 row 2.1). File ${pad(t.n)} of ${total}.
-- ${q} gains its Space key. Stamp ${stamp}.
-- GENERATED by generate.mjs from owner-classes.json. Edit those, run \`node generate.mjs --write\`;
--   tenancykey.test.js reds on any difference.
--
-- WHAT, in one transaction:
--   0. LOCK ${t.table} (ACCESS EXCLUSIVE), so the owner census and the DDL see the same rows.
--   1. The guard ($pregate$): the env, the database's fingerprint, the Space the DEFAULT names, and the owner
--      pre-gate: every distinct owner value of every row (soft-deleted rows included) must be in this env's
--      section of owner-classes.json; ${ownerText(t)}.${t.note ? `\n--      ${t.note}` : ''}
--      Anything else refuses, naming the values, and changes nothing.
--   2. ADD COLUMN workspace_id uuid NOT NULL DEFAULT '${oc.space}'.
--      A constant default is metadata only: existing rows read it from pg_attribute (atthasmissing); no row is
--      rewritten (rehearsed: filenode kept).
--   3. FOREIGN KEY (workspace_id) -> public.spaces(id) ON DELETE RESTRICT NOT VALID, single column (C-BLOCK:
--      spaces_delete_guard reads single-column keys only). No row scan. Step 2.3 validates it.
--   4. Comments and the stamp.${auditText(t)}
-- ENV. Run with psql -v env=prod|staging (scripts/tenancykey-apply.py passes it). Without -v env psql cannot
--   parse the set_config line and nothing runs. Any other value, or a database without that env's
--   schema_version fingerprint, refuses.
-- DEPLOYED CODE. No deployed writer names workspace_id on this table, so every INSERT takes the DEFAULT, which
--   is a Space, and no UPDATE changes the column (README.md "Arming census").
-- LOCKS. ACCESS EXCLUSIVE on ${t.table} and SHARE ROW EXCLUSIVE on spaces, to COMMIT; catalog changes plus one
--   scan of ${t.table} for the census. lock_timeout 5s: a wait fails fast (55P03) having changed nothing.
--   The runner refuses at :58-:02 and 07:00-08:00 UTC.
-- RE-RUN. With the stamp present nothing changes. A workspace_id column or a key into spaces without the stamp
--   refuses: something else made it.
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SELECT set_config('tenancykey.env', :'env', true) AS env \\gset tk_

LOCK TABLE ${q} IN ACCESS EXCLUSIVE MODE;

-- ── 1. The guard (read-only: the runner's --dry-run runs this block alone). ───────────────────────────────
${guardHead(oc, t, tag)}
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE id = ${lit(oc.space)}) THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: the DEFAULT''s Space ${oc.space} is not a row of public.spaces.';
  END IF;
${auditPregate(t, tag)}
  WITH allowed (env, match, val, class) AS (
    VALUES
    ${allowedRows(oc, t).join(',\n    ')}
  ), owners (col, val, n) AS (
    ${ownerQuery(t).join('\n')}
  )
  SELECT string_agg(format('%s %s: %s row(s)', o.col, coalesce(quote_literal(o.val), 'NULL'), o.n), ', '
                    ORDER BY o.col, o.val)
    INTO v_bad
    FROM owners o
   WHERE NOT EXISTS (SELECT 1 FROM allowed a
                      WHERE a.env = v_env
                        AND ((a.match = 'exact' AND o.val = a.val)
                          OR (a.match = 'like' AND o.val LIKE a.val)
                          OR (a.match = 'null' AND o.val IS NULL)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: owner value(s) outside the % section of owner-classes.json: %', v_env, v_bad
      USING HINT = 'Class each value in owner-classes.json with its reason, regenerate and re-review; or correct the row. Never widen a pattern to fit.';
  END IF;
END $pregate$;

-- ── 2-3. The column and the key, once. ──────────────────────────────────────────────────────────────────
DO $ddl$
DECLARE
  v_bad text;
  v_def text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = ${lit(stamp)}) THEN
    RAISE NOTICE 'v5-tenancykey-001 ${tag}: already applied; nothing changed.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = ${lit(t.table)}
                AND a.attname = 'workspace_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: ${q}.workspace_id exists but stamp ${stamp} does not.'
      USING HINT = 'Something other than this file added it. Find what, before anything else.';
  END IF;
  SELECT string_agg(k.conname, ', ' ORDER BY k.conname) INTO v_bad
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class f ON f.oid = k.confrelid
    JOIN pg_namespace fn ON fn.oid = f.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ${lit(t.table)} AND k.contype = 'f'
     AND fn.nspname = 'public' AND f.relname = 'spaces' AND k.conname = ${lit(fkName(t))};
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: ${q} already has key % into spaces.', v_bad;
  END IF;

  ALTER TABLE ${q}
    ADD COLUMN workspace_id uuid NOT NULL DEFAULT ${lit(oc.space)};
  ALTER TABLE ${q}
    ADD CONSTRAINT ${fkName(t)}
    FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID;
${auditDdl(t, tag)}END $ddl$;

-- ── 4. Comments and the stamp. ───────────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN ${q}.workspace_id IS
  'V5-SPACETENANCYKEY-001 (v5-tenancykey-001 ${pad(t.n)}, step 2.1). The Space this row belongs to. The DEFAULT is the one Space until writers stamp it (2.2, 4.3); RESTRICT key into spaces, validated by step 2.3.';
COMMENT ON CONSTRAINT ${fkName(t)} ON ${q} IS
  'V5-SPACETENANCYKEY-001 (v5-tenancykey-001 ${pad(t.n)}, step 2.1). A row''s Space is a row of public.spaces. RESTRICT: a Space with rows here cannot be deleted. NOT VALID until step 2.3.';

INSERT INTO public.schema_version (version, description)
VALUES (${lit(stamp)},
        'TENANCYKEY ${t.table}: V5-SPACETENANCYKEY-001 (multi-space step 2.1, file ${pad(t.n)} of ${total}). '
        'ADD COLUMN workspace_id uuid NOT NULL DEFAULT the one Space; ${fkName(t)} -> spaces(id) '
        'ON DELETE RESTRICT NOT VALID. Owner pre-gate: owner-classes.json, section '
        || current_setting('tenancykey.env') || '.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
`
}

function fkOnlyFile(oc, t, total) {
  const stamp = stampOf(oc, t)
  const tag = `${pad(t.n)} (${t.table})`
  const q = `public.${t.table}`
  return `-- ${fileOf(t)}
-- V5-SPACETENANCYKEY-001, multi-space step 2.1 (plan V204 §2.1, §3 row 2.1). File ${pad(t.n)} of ${total}.
-- ${q} already carries workspace_id (NOT NULL, DEFAULT the one Space); it gains the key only.
-- Stamp ${stamp}.
-- GENERATED by generate.mjs from owner-classes.json. Edit those, run \`node generate.mjs --write\`;
--   tenancykey.test.js reds on any difference.
--
-- WHAT, in one transaction:
--   0. LOCK ${t.table} (SHARE ROW EXCLUSIVE: writers wait, readers do not), so the guard and the key see the
--      same rows.
--   1. The guard ($pregate$): the env, the database's fingerprint, the column as expected (uuid NOT NULL), and
--      every row naming a Space. A row that names no Space refuses: under a NOT VALID key a second UPDATE of
--      such a row in one transaction raises 23503 (v5-spacefk-001 README, "Why fold first").
--   2. FOREIGN KEY (workspace_id) -> public.spaces(id) ON DELETE RESTRICT NOT VALID, single column (C-BLOCK).
--      No row scan. Step 2.3 validates it.
--   3. Comment and the stamp.
-- ENV. As every file here: psql -v env=prod|staging; missing, other, or the other database's fingerprint
--   refuses.
-- DEPLOYED CODE. Every deployed writer either takes the column DEFAULT or writes the literal one Space
--   (README.md "Arming census"): a Space on both envs, so no INSERT meets the key.
-- LOCKS. SHARE ROW EXCLUSIVE on ${t.table} and on spaces, to COMMIT. lock_timeout 5s.
-- RE-RUN. With the stamp present nothing changes. A key of this name without the stamp refuses.
-- ROLLBACK: 0r-rollback.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SELECT set_config('tenancykey.env', :'env', true) AS env \\gset tk_

LOCK TABLE ${q} IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. The guard (read-only: the runner's --dry-run runs this block alone). ───────────────────────────────
${guardHead(oc, t, tag)}
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                   JOIN pg_class c ON c.oid = a.attrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = ${lit(t.table)}
                    AND a.attname = 'workspace_id' AND NOT a.attisdropped
                    AND a.atttypid = 'uuid'::regtype AND a.attnotnull) THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: ${q}.workspace_id is not a NOT NULL uuid column.';
  END IF;
  SELECT string_agg(format('%s: %s row(s)', x.workspace_id, x.n), ', ' ORDER BY x.workspace_id::text)
    INTO v_bad
    FROM (SELECT t.workspace_id, count(*) AS n
            FROM ${q} t
           WHERE NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = t.workspace_id)
           GROUP BY t.workspace_id) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: row(s) name no Space: %', v_bad;
  END IF;
END $pregate$;

-- ── 2. The key, once. ───────────────────────────────────────────────────────────────────────────────────
DO $ddl$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = ${lit(stamp)}) THEN
    RAISE NOTICE 'v5-tenancykey-001 ${tag}: already applied; nothing changed.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint k
               JOIN pg_class c ON c.oid = k.conrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = ${lit(t.table)} AND k.conname = ${lit(fkName(t))}) THEN
    RAISE EXCEPTION 'v5-tenancykey-001 ${tag} refused, nothing changed: ${fkName(t)} exists but stamp ${stamp} does not.'
      USING HINT = 'Something other than this file added it. Find what, before anything else.';
  END IF;

  ALTER TABLE ${q}
    ADD CONSTRAINT ${fkName(t)}
    FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID;
END $ddl$;

-- ── 3. Comment and the stamp. ────────────────────────────────────────────────────────────────────────────
COMMENT ON CONSTRAINT ${fkName(t)} ON ${q} IS
  'V5-SPACETENANCYKEY-001 (v5-tenancykey-001 ${pad(t.n)}, step 2.1). A row''s Space is a row of public.spaces. RESTRICT: a Space with rows here cannot be deleted. NOT VALID until step 2.3.';

INSERT INTO public.schema_version (version, description)
VALUES (${lit(stamp)},
        'TENANCYKEY fk ${t.table}: V5-SPACETENANCYKEY-001 (multi-space step 2.1, file ${pad(t.n)} of ${total}). '
        '${fkName(t)} -> spaces(id) ON DELETE RESTRICT NOT VALID on the existing workspace_id. Section '
        || current_setting('tenancykey.env') || '.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
`
}

export function render(oc = loadOwnerClasses()) {
  const total = oc.tables.length
  return oc.tables.map((t) => ({ name: fileOf(t), text: t.fkOnly ? fkOnlyFile(oc, t, total) : addColumnFile(oc, t, total) }))
}

// (n, relname, stamp, adds_column), one row per table in file order, for the marked VALUES blocks.
export function valuesRows(oc = loadOwnerClasses()) {
  const rows = oc.tables.map((t) => `(${t.n}, ${[t.table, stampOf(oc, t)].map(lit).join(', ')}, ${t.fkOnly ? 'false' : 'true'})`)
  return rows.map((r, i) => r + (i < rows.length - 1 ? ',' : ''))
}

// The JSON's own rules, against the class file (lambda/tenancy-classes.json): every 'S needs key' relation is a
// row here (none forgotten), every key-adding row is 'S needs key' or, after push B, 'S has key' on workspace_id,
// and every class is well formed. Returns error strings; [] is clean.
export function ownerClassErrors(oc, classes) {
  const errs = []
  const ids = new Set()
  for (const c of oc.classes) {
    const at = `class ${c.id ?? '?'}:`
    if (!c.id || ids.has(c.id)) errs.push(`${at} missing or repeated id`)
    ids.add(c.id)
    if (!['exact', 'like', 'null'].includes(c.match)) errs.push(`${at} match must be exact, like or null`)
    if (!Array.isArray(c.envs) || !c.envs.length || c.envs.some((e) => !['prod', 'staging'].includes(e))) errs.push(`${at} envs must be prod and/or staging`)
    if (typeof c.reason !== 'string' || c.reason.trim().length < 20) errs.push(`${at} needs a reason`)
    if (c.match === 'null' && c.value !== undefined) errs.push(`${at} a null class has no value`)
    if (c.match !== 'null' && (typeof c.value !== 'string' || !c.value)) errs.push(`${at} needs a value`)
    if (c.match === 'like' && /(^|[^\\])_/.test(c.value ?? '')) errs.push(`${at} LIKE pattern ${c.value} has an unescaped _ (write \\_)`)
    if (c.match === 'like' && !(c.value ?? '').includes('%')) errs.push(`${at} a like class without % is an exact value`)
    if (c.match === 'null' && (c.envs.join() !== 'staging' || JSON.stringify(c.tables) !== '["locations"]')) errs.push(`${at} NULL is allowed on staging locations only`)
    if (/int-test/.test(c.value ?? '') && c.envs.includes('prod')) errs.push(`${at} a test-sub pattern is staging only`)
    if (c.tables && c.tables.some((t) => !oc.tables.some((r) => r.table === t))) errs.push(`${at} names a table that is not a row`)
  }
  const ns = oc.tables.map((t) => t.n)
  if (ns.join() !== ns.map((_, i) => i + 1).join()) errs.push('tables: n must run 1..N in order')
  const stamps = oc.tables.map((t) => stampOf(oc, t))
  if (new Set(stamps).size !== stamps.length) errs.push('tables: two rows share a stamp')
  if (!/^\d+\.\d+\.\d+-tenancykey-001-$/.test(oc.stampPrefix)) errs.push('stampPrefix must be <release>-tenancykey-001-')
  const f = oc.fingerprint
  if (f.prod.present !== f.staging.absent || f.staging.present !== f.prod.absent) errs.push('fingerprint: each env\'s present stamp is the other\'s absent one')
  for (const t of oc.tables) {
    const at = `table ${t.table}:`
    const row = classes.relations[`public.${t.table}`]
    if (!row) { errs.push(`${at} not in lambda/tenancy-classes.json`); continue }
    if (t.fkOnly) {
      if (row.class !== 'S has key' || row.column !== 'workspace_id') errs.push(`${at} a key-only row must be 'S has key' on workspace_id`)
      continue
    }
    const keyed = row.class === 'S has key' && row.column === 'workspace_id'
    if (row.class !== 'S needs key' && !keyed) errs.push(`${at} class ${row.class}, expected 'S needs key' (or 'S has key' after the apply)`)
    if (!t.parent && !(t.owner ?? []).length) errs.push(`${at} names no owner column and no parent join`)
    if (t.parent && (t.owner ?? []).length) errs.push(`${at} names both owner columns and a parent join`)
  }
  for (const [name, row] of Object.entries(classes.relations)) {
    if (row.class === 'S needs key' && !oc.tables.some((t) => `public.${t.table}` === name)) errs.push(`${name}: 'S needs key' in the class file but no row here`)
  }
  return errs
}

// Every marked VALUES block in a file's text, each as its trimmed, non-empty lines.
export function valuesBlocksIn(text) {
  const blocks = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== VALUES_BEGIN) continue
    const rows = []
    let j = i + 1
    for (; j < lines.length && lines[j].trim() !== VALUES_END; j++) if (lines[j].trim()) rows.push(lines[j].trim())
    if (j === lines.length) throw new Error(`unterminated ${VALUES_BEGIN} at line ${i + 1}`)
    blocks.push({ line: i + 1, rows })
    i = j
  }
  return blocks
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  if (argv.includes('--values')) {
    console.log(valuesRows().join('\n'))
  } else {
    let bad = 0
    for (const { name, text } of render()) {
      const p = join(DIR, name)
      if (argv.includes('--write')) writeFileSync(p, text)
      else if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { console.error(`differs from owner-classes.json: ${name}`); bad++ }
    }
    if (bad) process.exit(1)
  }
}
