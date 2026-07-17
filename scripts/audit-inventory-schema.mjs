#!/usr/bin/env node
// scripts/audit-inventory-schema.mjs
// Read-only schema introspection for public.inventory_items.
// Reads NEON_DATABASE_URL (default) or NEON_STAGING_URL (--staging) from ../.env.local.
// No mutations. Safe for any branch including prod.
//
// Usage (run from garden-app/):
//   node scripts/audit-inventory-schema.mjs
//   node scripts/audit-inventory-schema.mjs --staging
//   TARGET_DB_URL=postgres://... node scripts/audit-inventory-schema.mjs

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = join(__dirname, '..', '.env.local');
  const raw = readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const argv = process.argv.slice(2);
const useStaging = argv.includes('--staging');

let url = process.env.TARGET_DB_URL;
let target = 'TARGET_DB_URL (env)';
if (!url) {
  const env = loadEnvLocal();
  url = useStaging ? env.NEON_STAGING_URL : env.NEON_DATABASE_URL;
  target = useStaging ? 'STAGING (NEON_STAGING_URL)' : 'PROD/MAIN (NEON_DATABASE_URL)';
}
if (!url) {
  console.error('FATAL: No DB URL. Set NEON_DATABASE_URL in .env.local, pass --staging, or set TARGET_DB_URL.');
  process.exit(1);
}

const sql = neon(url);

console.log(`\n=== inventory_items audit — ${target} ===`);
console.log(`(read-only introspection; no writes)\n`);

async function main() {
  // 1. Table existence
  const tableRows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='inventory_items'
  `;
  if (!tableRows.length) {
    console.log('FATAL: public.inventory_items does not exist in this database.');
    return;
  }
  console.log('Table public.inventory_items: EXISTS\n');

  // 2. Columns
  const cols = await sql`
    SELECT column_name, data_type, udt_name, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale, ordinal_position
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_items'
    ORDER BY ordinal_position
  `;
  console.log(`--- Columns (${cols.length}) ---`);
  for (const c of cols) {
    let type;
    if (c.udt_name === '_text') type = 'text[]';
    else if (c.data_type === 'numeric' && c.numeric_precision) type = `numeric(${c.numeric_precision},${c.numeric_scale})`;
    else if (c.data_type === 'character varying' && c.character_maximum_length) type = `varchar(${c.character_maximum_length})`;
    else if (c.data_type === 'USER-DEFINED') type = c.udt_name;
    else type = c.data_type;
    const nn = c.is_nullable === 'NO' ? ' NOT NULL' : '';
    const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
    console.log(`  ${String(c.ordinal_position).padStart(2)}. ${c.column_name.padEnd(30)} ${type}${nn}${def}`);
  }
  console.log('');

  // 3. CHECK constraints
  const checks = await sql`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname='inventory_items' AND nsp.nspname='public' AND con.contype='c'
    ORDER BY con.conname
  `;
  console.log(`--- CHECK constraints (${checks.length}) ---`);
  for (const c of checks) {
    console.log(`  ${c.conname}`);
    console.log(`    ${c.def}`);
  }
  console.log('');

  // 4. FK constraints
  const fks = await sql`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname='inventory_items' AND nsp.nspname='public' AND con.contype='f'
    ORDER BY con.conname
  `;
  console.log(`--- FOREIGN KEYS (${fks.length}) ---`);
  for (const c of fks) {
    console.log(`  ${c.conname}`);
    console.log(`    ${c.def}`);
  }
  console.log('');

  // 5. Unique / primary
  const uniqs = await sql`
    SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname='inventory_items' AND nsp.nspname='public' AND con.contype IN ('p','u')
    ORDER BY con.contype, con.conname
  `;
  console.log(`--- PRIMARY/UNIQUE constraints (${uniqs.length}) ---`);
  for (const c of uniqs) {
    const kind = c.contype === 'p' ? 'PK' : 'UNIQUE';
    console.log(`  ${kind} ${c.conname}`);
    console.log(`    ${c.def}`);
  }
  console.log('');

  // 6. Indexes
  const idxs = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='inventory_items'
    ORDER BY indexname
  `;
  console.log(`--- Indexes (${idxs.length}) ---`);
  for (const i of idxs) {
    console.log(`  ${i.indexname}`);
    console.log(`    ${i.indexdef}`);
  }
  console.log('');

  // 7. Triggers
  const trigs = await sql`
    SELECT trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers
    WHERE event_object_schema='public' AND event_object_table='inventory_items'
    ORDER BY trigger_name, event_manipulation
  `;
  console.log(`--- Triggers (${trigs.length}) ---`);
  for (const t of trigs) {
    console.log(`  ${t.trigger_name} (${t.action_timing} ${t.event_manipulation})`);
  }
  console.log('');

  // 8. RLS
  const rls = await sql`
    SELECT relrowsecurity AS enabled
    FROM pg_class rel
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname='inventory_items' AND nsp.nspname='public'
  `;
  console.log(`--- Row Level Security ---`);
  console.log(`  RLS enabled: ${rls[0]?.enabled === true || rls[0]?.enabled === 't'}`);
  const policies = await sql`
    SELECT policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname='public' AND tablename='inventory_items'
    ORDER BY policyname
  `;
  console.log(`  Policies: ${policies.length}`);
  for (const p of policies) {
    console.log(`    ${p.policyname} [${p.cmd}]`);
    if (p.qual) console.log(`      USING: ${p.qual}`);
    if (p.with_check) console.log(`      WITH CHECK: ${p.with_check}`);
  }
  console.log('');

  // 9. Row count
  const total = await sql`SELECT COUNT(*)::text AS n FROM public.inventory_items`;
  let live = [{ n: 'n/a (no deleted_at column)' }];
  const hasDeletedAt = cols.some(c => c.column_name === 'deleted_at');
  if (hasDeletedAt) {
    live = await sql`SELECT COUNT(*)::text AS n FROM public.inventory_items WHERE deleted_at IS NULL`;
  }
  console.log(`--- Row count ---`);
  console.log(`  Total: ${total[0].n}`);
  console.log(`  Live:  ${live[0].n}`);
  console.log('');

  // 10. Sample row (column shape, real values redacted)
  if (parseInt(total[0].n, 10) > 0) {
    const sample = await sql`SELECT row_to_json(t.*) AS r FROM public.inventory_items t LIMIT 1`;
    console.log(`--- Sample row (1, raw JSON) ---`);
    console.log('  ' + JSON.stringify(sample[0].r, null, 2).split('\n').join('\n  '));
    console.log('');
  } else {
    console.log('--- Sample row ---');
    console.log('  (table is empty)');
    console.log('');
  }

  // 11. auth.users existence (legacy auth schema from the original DB)
  const authUsers = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='auth' AND table_name='users'
  `;
  console.log(`--- auth.users (legacy auth schema) ---`);
  console.log(`  exists: ${authUsers.length > 0 ? 'YES' : 'NO'}`);
  console.log('');

  // 12. public.profiles
  const profiles = await sql`
    SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles'
    ORDER BY ordinal_position
  `;
  console.log(`--- public.profiles ---`);
  console.log(`  exists: ${profiles.length > 0 ? 'YES' : 'NO'}`);
  for (const p of profiles) {
    const t = p.data_type === 'USER-DEFINED' ? p.udt_name : p.data_type;
    console.log(`    ${p.column_name} ${t}`);
  }
  console.log('');

  // 13. Cross-check: how does plants.created_by look (canonical reference)
  const plantsCreatedBy = await sql`
    SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='plants' AND column_name IN ('created_by','user_id')
    ORDER BY column_name
  `;
  console.log(`--- plants.created_by / plants.user_id (for comparison) ---`);
  for (const p of plantsCreatedBy) {
    const t = p.data_type === 'USER-DEFINED' ? p.udt_name : p.data_type;
    console.log(`    plants.${p.column_name}: ${t}`);
  }
  console.log('');

  console.log('=== End audit ===\n');
}

main().catch(err => {
  console.error('AUDIT FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
