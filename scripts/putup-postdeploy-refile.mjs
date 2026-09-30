// Put-Up 1b, post-deploy — the pesto re-file (04-design-final §9.2 Q4; Dave: "yes, re-file them").
//
// The two basil pestos logged before 1b as `passata` become `pesto` through the APP PATH, never a direct UPDATE: the
// REAL preservation handler (lambda/preservation/index.js) is imported in-process and invoked once per jar for
// PATCH /api/preservation/:id {"method":"pesto"}, as the jar's own owner. The write therefore carries everything the
// Lambda gives a real request: set_config('app.actor_clerk_sub', <owner>, true) in the same transaction (the audit
// actor), V4's correction rule for the date (jarRoutes.js correctionUseBy: a table date on a never-moved jar is
// re-derived from its stored put-up date; a moved jar's table date is cleared; a typed date survives), the xmin
// guard, and the set_updated_at trigger.
//
// Two dependencies are stubbed at module resolution, the same two the integration harness stubs
// (lambda/_test-stubs/): @clerk/backend (verifyToken answers the jar owner's sub) and @aws-sdk/client-secrets-manager
// (the secret carries the database URL from the environment). @neondatabase/serverless is the REAL driver, the copy
// lambda/preservation/package-lock.json pins.
//
// SAFETY
//  - DRY RUN by default: reads every target and prints its method, use_by_target and use_by_basis before, and after
//    as the PATCH will compute them (the PATCH's own rule, correctionUseBy). Writes nothing.
//  - Writes only with --i-mean-it, and a real run checks what was stored against that plan (exit 3 on a mismatch).
//  - Targets are explicit: --jar <uuid>, repeatable. Every target is re-read and checked BEFORE anything is written,
//    and one refusal writes nothing. A target must be live, have method passata, carry a date basis (1b's 0p
//    backfill has run), and say basil or pesto in its label, crop, variety or notes (what matched is printed).
//  - Idempotent: a jar that is already pesto is a no-op, so a second run writes nothing.
//  - The database URL is read from PUTUP_REFILE_DATABASE_URL only. It is never an argument and never printed; only
//    its host and database name are, so a Neon branch can be told from prod.
//
// Usage — from the repo root of a checkout of the SHA that was promoted (the in-process handler is this checkout's
// lambda/preservation, so it must be the deployed code), after verify-deploy shows the 1b Lambda live and 1b's 0p
// backfill has run:
//   (cd lambda/preservation && npm ci)                        # the Lambda's own driver and deps
//   export PUTUP_REFILE_DATABASE_URL="$NEON_DATABASE_URL"     # by key name; never type the URL on a command line
//   node scripts/putup-postdeploy-refile.mjs --jar <uuid> --jar <uuid>                # dry run
//   node scripts/putup-postdeploy-refile.mjs --jar <uuid> --jar <uuid> --i-mean-it    # write
// Exit: 0 done, dry run or nothing to do · 1 usage/environment · 2 refused (nothing written) · 3 a write failed or
//       stored something other than the plan.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { correctionUseBy, parseJarRoute } from '../lambda/preservation/jarRoutes.js';
import { JAR_TEXTURE_METHODS } from '../lambda/preservation/jarRules.js';
import { shelfLifeMonths } from '../lambda/preservation/shelfLife.js';

export const ENV_KEY = 'PUTUP_REFILE_DATABASE_URL';
export const FROM_METHOD = 'passata';
export const TO_METHOD = 'pesto';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_RE = /\b(basil|pesto)/i;
// trg_audit_preservation_log_upd's watched columns (v5-putupmake-001 0a). `method` is not one of them.
export const AUDIT_WATCHED = ['storage_location_id', 'use_by_target', 'use_by_basis', 'package_count',
  'remaining_count', 'label', 'is_raw', 'in_oil', 'deleted_at'];

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRESERVATION = join(REPO, 'lambda', 'preservation');
const STUBS = join(REPO, 'lambda', '_test-stubs');

export const USAGE = `usage: node scripts/putup-postdeploy-refile.mjs --jar <uuid> [--jar <uuid> ...] [--i-mean-it]
  Re-files basil jars logged as passata as pesto, through the preservation Lambda's own PATCH.
  Dry run unless --i-mean-it. The database URL is read from ${ENV_KEY}; never pass it as an argument.`;

export function parseArgs(argv) {
  const jars = [];
  let write = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // A connection string on the command line is refused before anything else, and never echoed back.
    if (/:\/\/|@/.test(a)) return { error: `argument ${i + 1} looks like a connection string; refusing. Set ${ENV_KEY} instead.` };
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--i-mean-it') { write = true; continue; }
    let v = null;
    if (a === '--jar') { v = argv[i + 1]; i += 1; } else if (a.startsWith('--jar=')) v = a.slice(6);
    else return { error: /^--?[a-z][a-z-]*$/i.test(a) ? `unknown flag: ${a}` : `argument ${i + 1} is not recognised (value not shown)` };
    if (v == null || !UUID_RE.test(v)) return { error: `--jar needs a jar id (a uuid), got ${v == null ? 'nothing' : JSON.stringify(v)}` };
    if (!jars.includes(v.toLowerCase())) jars.push(v.toLowerCase());
  }
  if (!jars.length) return { error: 'name at least one --jar <uuid>' };
  return { jars, write };
}

const pad = (n) => String(n).padStart(2, '0');
// A calendar day as the handler's jarRoutes.js dayOf reads one: the driver parses `date` into a local-midnight Date.
export const day = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
};

/** Every basil/pesto mention in the fields a person would recognise the jar by: [{field, value}]. */
export function basilEvidence(jar) {
  const fields = ['label', 'container_label', 'crop_type_slug', 'crop_display_name', 'variety_name',
    'variety_crop_type_slug', 'notes'];
  return fields.filter((f) => typeof jar[f] === 'string' && EVIDENCE_RE.test(jar[f]))
    .map((f) => ({ field: f, value: jar[f] }));
}

/**
 * What PATCH {"method":"pesto"} will do to this jar, decided by the handler's own rule. The `next` facts mirror
 * jarRoutes.js patchJar for this exact body (only the method is sent; a stored texture is cleared if the method
 * cannot carry one), and the date is correctionUseBy's answer — the function the PATCH itself calls.
 * Returns { verdict: 'refile' | 'noop' | 'refuse', reasons, evidence, before, after, rule }.
 */
export function planRefile(jar) {
  const evidence = basilEvidence(jar);
  const before = { method: jar.method, use_by_target: day(jar.use_by_target), use_by_basis: jar.use_by_basis ?? null };
  const reasons = [];
  if (jar.deleted_at != null) reasons.push('the jar is deleted');
  if (jar.method === TO_METHOD) {
    if (reasons.length) return { verdict: 'refuse', reasons, evidence, before, after: before, rule: null };
    return { verdict: 'noop', reasons: [`already ${TO_METHOD}`], evidence, before, after: before, rule: null };
  }
  if (jar.method !== FROM_METHOD) reasons.push(`method is ${JSON.stringify(jar.method)}, not ${FROM_METHOD}`);
  if (!evidence.length) reasons.push('nothing on the jar says basil or pesto (label, crop, variety, notes)');
  if (jar.use_by_basis == null) {
    reasons.push("use_by_basis is NULL: 1b's 0p backfill has not run on this jar — run it first (the post-deploy order)");
  }
  if (reasons.length) return { verdict: 'refuse', reasons, evidence, before, after: null, rule: null };

  const next = { method: TO_METHOD, is_raw: jar.is_raw, in_oil: jar.in_oil, texture: jar.texture };
  if (next.texture != null && !JAR_TEXTURE_METHODS.includes(next.method)) next.texture = null;
  const useBy = correctionUseBy(jar, next);
  const after = {
    method: TO_METHOD,
    use_by_target: useBy ? day(useBy.use_by_target) : before.use_by_target,
    use_by_basis: useBy ? useBy.use_by_basis : before.use_by_basis,
  };
  const kind = jar.storage_kind ?? null;
  const months = shelfLifeMonths(TO_METHOD, kind);
  const figure = `pesto ${kind ? `in a ${kind}` : 'with no recorded place'}: ${months == null ? 'no figure (no date)' : `${months} months`}`;
  let rule;
  if (useBy == null) rule = `date kept: its basis is ${JSON.stringify(before.use_by_basis)}, which a correction never re-derives`;
  else if (jar.storage_moved_at != null) rule = 'moved since it was put up: a correction clears a table date (basis none)';
  else rule = `never moved: re-derived from its stored put-up date ${day(jar.preserved_at)}; ${figure}`;
  return { verdict: 'refile', reasons: [], evidence, before, after, rule };
}

const fmt = (s) => `method ${s.method} · use by ${s.use_by_target ?? 'none'} · basis ${s.use_by_basis ?? 'NULL'}`;

function printPlan(jar, plan) {
  const place = jar.storage_kind ? `${jar.storage_kind} "${jar.storage_label ?? ''}"` : 'no recorded place';
  const moved = jar.storage_moved_at ? `moved ${new Date(jar.storage_moved_at).toISOString()}` : 'never moved';
  console.log(`\njar ${jar.id}  owner ${jar.user_id}  · ${place} · put up ${day(jar.preserved_at)} (${moved})`);
  console.log(`  matched : ${plan.evidence.length ? plan.evidence.map((e) => `${e.field}=${JSON.stringify(e.value)}`).join(', ') : '(nothing)'}`);
  console.log(`  before  : ${fmt(plan.before)}`);
  if (plan.verdict === 'refile') console.log(`  after   : ${fmt(plan.after)}   [${plan.rule}]`);
  else console.log(`  ${plan.verdict === 'noop' ? 'no-op   ' : 'REFUSED '}: ${plan.reasons.join('; ')}`);
}

// Columns as jarRoutes.js loadJar reads them (the date rule's inputs), plus what a person needs to recognise the jar.
async function readJars(sql, ids) {
  return sql`
    SELECT p.id, p.user_id, p.method, p.method_other_text, p.label, p.container_label, p.notes, p.is_raw, p.in_oil,
           p.texture, p.crop_type_slug, ct.display_name AS crop_display_name, pv.name AS variety_name,
           pv.crop_type_slug AS variety_crop_type_slug, p.storage_location_id, s.kind AS storage_kind,
           s.label AS storage_label, p.preserved_at, p.preserved_at_precision, p.use_by_target, p.use_by_basis,
           p.storage_moved_at, p.package_count, p.remaining_count, p.deleted_at
    FROM preservation_log p
    LEFT JOIN storage_location s ON s.id = p.storage_location_id
    LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
    LEFT JOIN plant_varieties pv ON pv.id = p.variety_id
    WHERE p.id = ANY(${ids}::uuid[])
  `;
}

// The Lambda's driver, resolved exactly as lambda/preservation/index.js resolves it (package exports → import).
async function loadDriver() {
  const pkgDir = join(PRESERVATION, 'node_modules', '@neondatabase', 'serverless');
  if (!existsSync(join(pkgDir, 'package.json'))) return null;
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const entry = typeof pkg.exports?.import === 'string' ? pkg.exports.import : 'index.mjs';
  const mod = await import(pathToFileURL(realpathSync(join(pkgDir, entry))).href);
  return { neon: mod.neon, version: pkg.version };
}

// @clerk/backend and @aws-sdk/client-secrets-manager, imported by lambda/preservation/index.js only, resolve to the
// integration harness's stubs; nothing else is redirected.
function redirectAuthAndSecrets() {
  const scope = pathToFileURL(`${realpathSync(PRESERVATION)}/`).href;
  const to = {
    '@clerk/backend': pathToFileURL(realpathSync(join(STUBS, 'clerk-backend.js'))).href,
    '@aws-sdk/client-secrets-manager': pathToFileURL(realpathSync(join(STUBS, 'aws-secrets.js'))).href,
  };
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, next) {
        if (to[specifier] && context.parentURL?.startsWith(scope)) return { url: to[specifier], shortCircuit: true };
        return next(specifier, context);
      },
    });
    return;
  }
  const src = `const T=${JSON.stringify(to)},S=${JSON.stringify(scope)};`
    + 'export async function resolve(s,c,n){if(T[s]&&c.parentURL?.startsWith(S))return{url:T[s],shortCircuit:true};return n(s,c)}';
  module.register(`data:text/javascript,${encodeURIComponent(src)}`);
}

// The real handler, with the stub state it reads its caller and its secret from.
async function loadHandler(url, env) {
  redirectAuthAndSecrets();
  const { stubState } = await import(pathToFileURL(realpathSync(join(STUBS, 'state.js'))).href);
  stubState.secrets = { [env.SECRET_NAME ?? 'garden-app/secrets']: { NEON_DATABASE_URL: url, CLERK_SECRET_KEY: 'stub-not-validated' } };
  const { handler } = await import(pathToFileURL(realpathSync(join(PRESERVATION, 'index.js'))).href);
  return { handler, stubState };
}

const changedKeys = (b, a) => [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])]
  .filter((k) => JSON.stringify(b?.[k] ?? null) !== JSON.stringify(a?.[k] ?? null));

// `deps` exists for the unit test (putup-postdeploy-refile.test.js), which swaps in a scripted driver and handler.
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(`${args.error}\n${USAGE}`); return 1; }
  const url = env[ENV_KEY];
  if (!url) { console.error(`${ENV_KEY} is not set.\n${USAGE}`); return 1; }
  let target;
  try { const u = new URL(url); target = `${u.hostname}${u.pathname}`; } catch { console.error(`${ENV_KEY} is not a valid URL (value not shown).`); return 1; }

  const driver = await (deps.loadDriver ?? loadDriver)();
  if (!driver) { console.error('lambda/preservation/node_modules is missing: run `(cd lambda/preservation && npm ci)` first.'); return 1; }
  const { handler, stubState } = await (deps.loadHandler ?? loadHandler)(url, env);
  const sql = driver.neon(url);

  console.log(`${args.write ? 'WRITE' : 'DRY RUN'} · target ${target} · ${args.jars.length} jar(s) · `
    + `handler lambda/preservation/index.js · @neondatabase/serverless ${driver.version}`);
  if (!parseJarRoute(`/api/preservation/${args.jars[0]}`)) {
    console.error('lambda/preservation/jarRoutes.js no longer claims PATCH /api/preservation/:id; refusing.');
    return 1;
  }
  const rows = await readJars(sql, args.jars);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plans = args.jars.map((id) => {
    const jar = byId.get(id);
    if (!jar) {
      console.log(`\njar ${id}\n  REFUSED : no such jar`);
      return { id, verdict: 'refuse' };
    }
    const plan = planRefile(jar);
    printPlan(jar, plan);
    return { id, jar, ...plan };
  });

  const refused = plans.filter((p) => p.verdict === 'refuse');
  const todo = plans.filter((p) => p.verdict === 'refile');
  if (refused.length) {
    console.log(`\nREFUSED: ${refused.length} of ${plans.length} target(s) failed the checks above. Nothing was written.`);
    return 2;
  }
  if (!todo.length) { console.log('\nNothing to do: every target is already pesto. Nothing was written.'); return 0; }
  if (!args.write) {
    console.log(`\nDRY RUN: ${todo.length} jar(s) would be re-filed as ${TO_METHOD}. Nothing was written. Re-run with --i-mean-it to write.`);
    return 0;
  }

  let failed = 0;
  for (const p of todo) {
    const [{ t0, prior }] = await sql`
      SELECT now()::text AS t0, (SELECT to_jsonb(p) FROM preservation_log p WHERE p.id = ${p.id}::uuid) AS prior`;
    stubState.verifyTokenResult = { sub: p.jar.user_id };
    const res = await handler({
      requestContext: { http: { method: 'PATCH' } },
      rawPath: `/api/preservation/${p.id}`,
      rawQueryString: '',
      headers: { authorization: 'Bearer putup-postdeploy-refile' },
      body: JSON.stringify({ method: TO_METHOD }),
    });
    const body = res.body ? JSON.parse(res.body) : null;
    console.log(`\njar ${p.id}\n  PATCH /api/preservation/${p.id} {"method":"${TO_METHOD}"} as ${p.jar.user_id} -> ${res.statusCode}`);
    if (res.statusCode !== 200) {
      console.log(`  FAILED  : ${JSON.stringify(body)}`);
      failed += 1;
      continue;
    }
    const [{ row }] = await sql`SELECT to_jsonb(p) AS row FROM preservation_log p WHERE p.id = ${p.id}::uuid`;
    console.log(`  stored  : ${JSON.stringify(row)}`);
    console.log(`  changed : ${changedKeys(prior, row).map((k) => `${k} ${JSON.stringify(prior?.[k] ?? null)} -> ${JSON.stringify(row[k] ?? null)}`).join('; ')}`);
    const stored = { method: row.method, use_by_target: row.use_by_target ?? null, use_by_basis: row.use_by_basis ?? null };
    const same = stored.method === p.after.method && stored.use_by_target === p.after.use_by_target
      && stored.use_by_basis === p.after.use_by_basis;
    console.log(`  planned : ${fmt(p.after)}\n  got     : ${fmt(stored)}   ${same ? '(as planned)' : 'MISMATCH'}`);
    if (!same) failed += 1;
    const audits = await sql`
      SELECT id, action, actor_clerk_sub, ts, before_jsonb, after_jsonb
      FROM audit_events
      WHERE table_name = 'preservation_log' AND row_id = ${p.id}::uuid AND ts >= ${t0}::timestamptz
      ORDER BY ts, id`;
    const watchedMoved = AUDIT_WATCHED.filter((k) => changedKeys(prior, row).includes(k));
    if (!audits.length) {
      console.log('  audit   : no audit_events row. trg_audit_preservation_log_upd writes one only when a watched column '
        + `changes (${AUDIT_WATCHED.join(', ')}) and \`method\` is not one of them; `
        + `${watchedMoved.length ? `yet ${watchedMoved.join(', ')} changed — the audit row is MISSING` : 'no watched column changed'}.`);
      if (watchedMoved.length) failed += 1;
    }
    for (const a of audits) {
      const keys = changedKeys(a.before_jsonb, a.after_jsonb).filter((k) => k !== 'updated_at');
      const ofThisWrite = a.after_jsonb?.updated_at === row.updated_at ? 'this write' : 'NOT this write (updated_at differs)';
      // The actor is what set_config('app.actor_clerk_sub') put in the transaction: the jar's owner, or the GUC was lost.
      const actor = a.actor_clerk_sub === p.jar.user_id ? "the jar's owner" : 'NOT THE OWNER';
      if (a.actor_clerk_sub !== p.jar.user_id) failed += 1;
      console.log(`  audit   : ${a.id} ${a.action} actor=${a.actor_clerk_sub} (${actor}) at ${new Date(a.ts).toISOString()} [${ofThisWrite}]`);
      for (const k of keys) console.log(`            ${k}: ${JSON.stringify(a.before_jsonb?.[k] ?? null)} -> ${JSON.stringify(a.after_jsonb?.[k] ?? null)}`);
    }
  }
  console.log(failed ? `\n${failed} jar(s) FAILED or differ from the plan — see above.` : `\nDone: ${todo.length} jar(s) re-filed as ${TO_METHOD}.`);
  return failed ? 3 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`FAILED: ${err?.message ?? err}`);
    process.exitCode = 3;
  });
}
