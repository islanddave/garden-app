// Put-Up release 4, post-deploy — the recipe seed (V4 §2.6 "Seeding"; 05-release-train §3 step 12: LAST, and only
// after Dave has seen the list — project-state/_crucible-pantry-20260928/seed-recipes/SEED-REVIEW.md).
//
// Every recipe is written through the APP PATH, never a direct INSERT: the REAL preservation handler
// (lambda/preservation/index.js → recipeRoutes.js) is imported in-process and invoked as Dave (the --user),
// exactly the way scripts/putup-postdeploy-refile.mjs drives the jar PATCH. So each write carries what a real
// request carries: the household scope (GARDEN_HOUSEHOLD_IDS, read by the handler), the body rules (a link that
// is not http/https, a keeps line missing a part, a line the CHECKs would refuse — all refused with the route's
// own words), the recipe and its lines in ONE statement, and the idempotency key on the recipe row.
//
// Two dependencies are stubbed at module resolution, the same two the integration harness stubs
// (lambda/_test-stubs/): @clerk/backend (verifyToken answers the --user) and @aws-sdk/client-secrets-manager (the
// secret carries the database URL from the environment). @neondatabase/serverless is the REAL driver, the copy
// lambda/preservation/package-lock.json pins.
//
// SAFETY
//  - DRY RUN by default: reads the household's recipes and types THROUGH THE HANDLER (GET only), and prints, per
//    recipe, what it would do — create (with its type: a built-in, a household type, or a NEW type) or skip (a
//    recipe with the same name already exists for that user). Writes nothing.
//  - Writes only with --i-mean-it. A file with any recipe the rules refuse writes NOTHING (exit 2), dry run or not.
//  - Idempotent: a recipe whose name (case and outer spaces aside) the --user already has is skipped, and each
//    create's idempotency key is derived from (user, name), so even two racing runs make one recipe.
//  - Types (Dave 2026-09-30): each recipe's `type` label is found-or-created through POST /api/recipes/types
//    (built-ins first, then the household's, then a new one) — only with --i-mean-it.
//  - The database URL is read from RECIPE_SEED_DATABASE_URL only. It is never an argument and never printed; only
//    its host and database name are, so a Neon branch can be told from prod.
//
// Input: a JSON array, or an object with a `recipes` array (the seed file's own shape), each item
//   {ordinal, name, kind, type?, link_url, notes, keeps: {n, unit, storage_kind} | null, vessel?, bottle?,
//    lines: [{ordinal, name, amount_text, qty, qty_unit, form, brand, at_the_end, role, note, shu_listed}]}
// Other keys (keeps_source_quote, flags, …) are review notes and are ignored. `vessel` / `bottle` are container
// text ("16 oz jar", "4 oz woozy bottles"): the size and unit are read only where unambiguous, else the label only.
//
// Usage — from the repo root of a checkout of the SHA that was promoted, after verify-deploy shows the release-4
// Lambda live and Dave has approved the list:
//   (cd lambda/preservation && npm ci)
//   export RECIPE_SEED_DATABASE_URL="$NEON_DATABASE_URL"   # by key name; never type the URL on a command line
//   export GARDEN_HOUSEHOLD_IDS="<dave>,<jen>"               # the household scope the handler reads
//   node scripts/seed-recipes.mjs --user <clerk id> --file recipes-seed-v1.json               # dry run
//   node scripts/seed-recipes.mjs --user <clerk id> --file recipes-seed-v1.json --i-mean-it   # write
// Exit: 0 done / dry run / nothing to do · 1 usage or environment · 2 refused (nothing written) · 3 a write failed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import module from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRecipeCreate, parseRecipeRoute } from '../lambda/preservation/recipeRules.js';
import { KITCHEN_BATCH_KINDS } from '../lambda/preservation/kitchenBatch.js';

export const ENV_KEY = 'RECIPE_SEED_DATABASE_URL';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRESERVATION = join(REPO, 'lambda', 'preservation');
const STUBS = join(REPO, 'lambda', '_test-stubs');

export const USAGE = `usage: node scripts/seed-recipes.mjs --user <clerk user id> --file <seed.json> [--i-mean-it]
  Seeds recipes through the preservation Lambda's own POST /api/recipes, as --user.
  Dry run unless --i-mean-it. The database URL is read from ${ENV_KEY}; never pass it as an argument.`;

export function parseArgs(argv) {
  let user = null;
  let file = null;
  let write = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // A connection string on the command line is refused before anything else, and never echoed back.
    if (/:\/\/|@/.test(a)) return { error: `argument ${i + 1} looks like a connection string; refusing. Set ${ENV_KEY} instead.` };
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--i-mean-it') { write = true; continue; }
    let flag = a;
    let v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { flag = a.slice(0, eq); v = a.slice(eq + 1); }
    if (flag === '--user' || flag === '--file') {
      if (v === undefined) { v = argv[i + 1]; i += 1; }
      if (v == null || v === '' || v.startsWith('--')) return { error: `${flag} needs a value` };
      if (flag === '--user') {
        if (!/^[A-Za-z0-9_-]{3,128}$/.test(v)) return { error: '--user must be a Clerk user id (letters, digits, _ and -)' };
        user = v;
      } else file = v;
      continue;
    }
    return { error: /^--?[a-z][a-z-]*$/i.test(a) ? `unknown flag: ${a}` : `argument ${i + 1} is not recognised (value not shown)` };
  }
  if (!user) return { error: 'name the user with --user <clerk id>' };
  if (!file) return { error: 'name the seed file with --file <path>' };
  return { user, file, write };
}

// The seed file: an array, or {recipes: [...]}.
export function recipesOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object' && Array.isArray(json.recipes)) return json.recipes;
  return null;
}

const CONTAINER_WORDS = /\b(woozy|woozies|bottles?|jars?|jar)\b/i;
// "16 oz jar" → {label, size 16, unit 'fl oz'}; "quart jar" → {size 1, unit 'qt'}; "a crock" → label only. A bare
// "oz" is read as fluid ounces only beside a container noun (the house's presets: "8 oz woozy" = 8 fl oz);
// anything else ambiguous stays a label.
export function parseContainerText(text) {
  if (text == null) return null;
  const label = String(text).trim().replace(/\s+/g, ' ');
  if (!label) return null;
  const out = { label: label.slice(0, 120), size: null, unit: null };
  const body = label.replace(/^(one|a|an)\s+/i, '');
  let m = body.match(/^(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid\s+ounces?|oz|ounces?|ml|millilit(?:re|er)s?|l|lit(?:re|er)s?|qt|quarts?|pints?|cups?|gal|gallons?)\b/i);
  if (m) {
    const n = m[1];
    const u = m[2].toLowerCase().replace(/\s+/g, ' ');
    let unit = null;
    if (/^fl\.? ?oz$|^fluid/.test(u)) unit = 'fl oz';
    else if (/^(oz|ounces?)$/.test(u)) unit = CONTAINER_WORDS.test(body) ? 'fl oz' : null;
    else if (/^(ml|millilit)/.test(u)) unit = 'ml';
    else if (/^(l|lit)/.test(u)) unit = 'l';
    else if (/^(qt|quart)/.test(u)) unit = 'qt';
    else if (/^pint/.test(u)) unit = 'pint';
    else if (/^cup/.test(u)) unit = 'cup';
    else if (/^gal/.test(u)) unit = 'gal';
    if (unit && Number(n) > 0) { out.size = n; out.unit = unit; }
    return out;
  }
  m = body.match(/^(half[- ]pint|quart|pint|gallon)\b/i);
  if (m) {
    const w = m[1].toLowerCase().replace(' ', '-');
    const known = { 'half-pint': ['1', 'cup'], quart: ['1', 'qt'], pint: ['1', 'pint'], gallon: ['1', 'gal'] }[w];
    if (known) { [out.size, out.unit] = known; }
  }
  return out;
}

// The listed heat as the seed writes it: a number, [low, high], {low, high} or "2,500–8,000".
export function shuOf(v) {
  if (v == null || v === '') return null;
  let lo; let hi;
  if (typeof v === 'number') { lo = v; hi = v; } else if (Array.isArray(v)) { [lo, hi] = v; } else if (typeof v === 'object') { lo = v.low; hi = v.high ?? v.low; } else {
    const nums = String(v).replace(/,/g, '').match(/\d+/g);
    if (!nums) return { error: `listed heat ${JSON.stringify(v)} is not a number` };
    lo = Number(nums[0]); hi = Number(nums[1] ?? nums[0]);
  }
  if (!Number.isInteger(Number(lo)) || !Number.isInteger(Number(hi ?? lo))) return { error: `listed heat ${JSON.stringify(v)} is not whole` };
  return { low: Number(lo), high: Number(hi ?? lo) };
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonblank = (v) => (v == null || String(v).trim() === '' ? null : v);

// A deterministic key per (user, name): a rerun, or two racing runs, write one recipe (the route replays).
export function seedKey(user, name) {
  const h = createHash('sha256').update(`seed-recipes:v1:${user}:${String(name).trim().toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// One seed item → { body, type, warnings } or { error }. `body` is exactly what POST /api/recipes receives (minus
// recipe_type_id, which the run resolves from `type`), validated by the route's own rules.
export function planRecipe(item, user) {
  if (!item || typeof item !== 'object') return { error: 'not an object' };
  const warnings = [];
  const body = { idempotency_key: seedKey(user, item.name ?? ''), name: typeof item.name === 'string' ? item.name.trim() : item.name };
  if (item.kind != null) {
    if (KITCHEN_BATCH_KINDS.includes(item.kind)) body.kind = item.kind;
    else warnings.push(`kind ${JSON.stringify(item.kind)} is not a batch kind — left out`);
  }
  if (nonblank(item.link_url)) body.link_url = String(item.link_url).trim();
  if (nonblank(item.notes)) body.notes = String(item.notes);
  if (item.keeps != null) body.keeps = { n: item.keeps.n, unit: item.keeps.unit, storage_kind: item.keeps.storage_kind };
  const vessel = parseContainerText(item.vessel);
  if (vessel) {
    body.vessel_label = vessel.label;
    if (vessel.size) { body.vessel_size = vessel.size; body.vessel_unit = vessel.unit; }
  }
  const bottle = parseContainerText(item.bottle);
  if (bottle) {
    body.bottle_label = bottle.label;
    if (bottle.size) { body.bottle_size = bottle.size; body.bottle_unit = bottle.unit; }
  }
  if (has(item, 'bottle_cooked') && typeof item.bottle_cooked === 'boolean') body.bottle_cooked = item.bottle_cooked;
  if (nonblank(item.made_text)) body.made_text = String(item.made_text).trim();
  const lines = [];
  for (const [i, l] of (item.lines ?? []).entries()) {
    const line = { ordinal: l.ordinal ?? i + 1, name: typeof l.name === 'string' ? l.name.trim() : l.name };
    if (nonblank(l.amount_text)) line.amount_text = String(l.amount_text).trim();
    if (l.qty != null && nonblank(l.qty_unit)) { line.qty = l.qty; line.qty_unit = l.qty_unit; }
    else if (l.qty != null || nonblank(l.qty_unit)) warnings.push(`line ${i + 1} (${l.name}): a number without its unit (or the reverse) — kept as written only`);
    if (l.at_the_end === true) line.at_the_end = true;
    for (const k of ['form', 'brand', 'role', 'note']) if (nonblank(l[k])) line[k] = l[k];
    if (line.role && line.form) { warnings.push(`line ${i + 1} (${l.name}): a ${line.role} line has no form — form left out`); delete line.form; }
    const shu = shuOf(l.shu_listed);
    if (shu?.error) return { error: `line ${i + 1} (${l.name}): ${shu.error}` };
    if (shu && !line.role) { line.shu_rating_low = shu.low; line.shu_rating_high = shu.high; }
    for (const k of ['salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from']) if (l[k] != null) line[k] = l[k];
    lines.push(line);
  }
  if (lines.length) body.lines = lines;
  const verr = validateRecipeCreate(body);
  if (verr) return { error: verr };
  return { body, type: nonblank(item.type) ? String(item.type).trim().replace(/\s+/g, ' ') : null, warnings };
}

const fold = (s) => String(s ?? '').trim().toLowerCase();

// The Lambda's driver is resolved inside index.js; this checks it is installed, as the refile script does.
function driverInstalled() {
  return existsSync(join(PRESERVATION, 'node_modules', '@neondatabase', 'serverless', 'package.json'));
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

async function loadHandler(url, env) {
  redirectAuthAndSecrets();
  const { stubState } = await import(pathToFileURL(realpathSync(join(STUBS, 'state.js'))).href);
  stubState.secrets = { [env.SECRET_NAME ?? 'garden-app/secrets']: { NEON_DATABASE_URL: url, CLERK_SECRET_KEY: 'stub-not-validated' } };
  const { handler } = await import(pathToFileURL(realpathSync(join(PRESERVATION, 'index.js'))).href);
  return { handler, stubState };
}

// ONE request through the real handler, as `user`.
async function call({ handler, stubState }, user, method, path, body = null) {
  stubState.verifyTokenResult = { sub: user };
  const res = await handler({
    requestContext: { http: { method } },
    rawPath: path,
    rawQueryString: '',
    queryStringParameters: {},
    headers: { authorization: 'Bearer seed-recipes' },
    body: body == null ? null : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}

// `deps` exists for the unit test (seed-recipes.test.js), which swaps in the handler and the file reader.
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.error) { console.error(`${args.error}\n${USAGE}`); return 1; }
  const url = env[ENV_KEY];
  if (!url) { console.error(`${ENV_KEY} is not set.\n${USAGE}`); return 1; }
  let target;
  try { const u = new URL(url); target = `${u.hostname}${u.pathname}`; } catch { console.error(`${ENV_KEY} is not a valid URL (value not shown).`); return 1; }
  const household = String(env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!household.includes(args.user)) {
    console.error(`GARDEN_HOUSEHOLD_IDS does not include --user; set it to the household (e.g. "<dave>,<jen>") so the handler scopes as the app does.`);
    return 1;
  }
  let json;
  try { json = JSON.parse((deps.readFile ?? ((p) => readFileSync(resolve(p), 'utf8')))(args.file)); } catch (e) {
    console.error(`could not read ${args.file} as JSON: ${e.message}`);
    return 1;
  }
  const items = recipesOf(json);
  if (!items) { console.error(`${args.file}: expected an array of recipes, or an object with a "recipes" array`); return 1; }
  if (!parseRecipeRoute('/api/recipes') || !parseRecipeRoute('/api/recipes/types')) {
    console.error('lambda/preservation/recipeRules.js no longer claims /api/recipes; refusing.');
    return 1;
  }

  const plans = items.map((item, i) => ({ i, item, ...planRecipe(item, args.user) }));
  const refused = plans.filter((p) => p.error);
  console.log(`${args.write ? 'WRITE' : 'DRY RUN'} · target ${target} · user ${args.user} · ${items.length} recipe(s) in ${args.file}`
    + ' · handler lambda/preservation/index.js');
  if (refused.length) {
    for (const p of refused) console.log(`\n#${p.item?.ordinal ?? p.i + 1} ${JSON.stringify(p.item?.name ?? null)}\n  REFUSED : ${p.error}`);
    console.log(`\nREFUSED: ${refused.length} of ${plans.length} recipe(s) break the rules above. Nothing was written.`);
    return 2;
  }
  if (!deps.loadHandler && !driverInstalled()) {
    console.error('lambda/preservation/node_modules is missing: run `(cd lambda/preservation && npm ci)` first.');
    return 1;
  }
  const h = await (deps.loadHandler ?? loadHandler)(url, env);

  const list = await call(h, args.user, 'GET', '/api/recipes');
  const typesRes = await call(h, args.user, 'GET', '/api/recipes/types');
  if (list.status !== 200 || typesRes.status !== 200) {
    console.error(`reading the household's recipes/types failed: ${list.status} / ${typesRes.status}`);
    return 3;
  }
  const mine = new Set((list.body?.recipes ?? []).filter((r) => r.user_id === args.user).map((r) => fold(r.name)));
  const typeByLabel = new Map((typesRes.body?.types ?? []).map((t) => [fold(t.label), t]));

  const todo = [];
  const seenInFile = new Set();
  for (const p of plans) {
    const key = fold(p.body.name);
    const head = `\n#${p.item.ordinal ?? p.i + 1} ${p.body.name}`;
    if (mine.has(key) || seenInFile.has(key)) {
      console.log(`${head}\n  skip    : ${mine.has(key) ? `${args.user} already has a recipe named this` : 'named twice in the file — the first one wins'}`);
      continue;
    }
    seenInFile.add(key);
    const t = p.type ? typeByLabel.get(fold(p.type)) : null;
    const typeWords = !p.type ? 'no type' : t ? `${t.builtin ? 'built-in' : 'household'} type "${t.label}"` : `NEW type "${p.type}"`;
    const b = p.body;
    console.log(`${head}\n  create  : ${typeWords} · kind ${b.kind ?? '—'} · ${b.lines?.length ?? 0} line(s) · `
      + `${b.keeps ? `${b.keeps.n} ${b.keeps.unit} · ${b.keeps.storage_kind}` : 'no time-and-place line'} · notes ${b.notes ? `${b.notes.length} chars` : '—'}`
      + `${b.link_url ? ' · link' : ''}${b.vessel_label ? ` · made in "${b.vessel_label}"` : ''}${b.bottle_label ? ` · put up in "${b.bottle_label}"` : ''}`);
    for (const w of p.warnings) console.log(`  note    : ${w}`);
    todo.push(p);
  }
  if (!todo.length) { console.log('\nNothing to do: every recipe is already there. Nothing was written.'); return 0; }
  if (!args.write) {
    console.log(`\nDRY RUN: ${todo.length} recipe(s) would be created. Nothing was written. Re-run with --i-mean-it to write.`);
    return 0;
  }

  let failed = 0;
  for (const p of todo) {
    const body = { ...p.body };
    if (p.type) {
      let t = typeByLabel.get(fold(p.type));
      if (!t) {
        const made = await call(h, args.user, 'POST', '/api/recipes/types', { label: p.type });
        if (made.status !== 200 && made.status !== 201) {
          console.log(`\n${p.body.name}\n  FAILED  : type "${p.type}" -> ${made.status} ${JSON.stringify(made.body)}`);
          failed += 1;
          continue;
        }
        t = made.body.type;
        typeByLabel.set(fold(t.label), t);
        console.log(`\ntype "${t.label}" -> ${made.status} (${made.body.created ? 'created' : 'found'})`);
      }
      body.recipe_type_id = t.id;
    }
    const res = await call(h, args.user, 'POST', '/api/recipes', body);
    const ok = res.status === 201 || (res.status === 200 && res.body?.replayed);
    console.log(`\n${p.body.name}\n  POST /api/recipes as ${args.user} -> ${res.status}${res.body?.replayed ? ' (replayed)' : ''}`
      + `${ok ? ` · id ${res.body.recipe?.id} · ${res.body.recipe?.lines?.length ?? 0} line(s)` : ` · ${JSON.stringify(res.body)}`}`);
    if (!ok) failed += 1;
  }
  console.log(failed ? `\n${failed} recipe(s) FAILED — see above. A re-run skips the ones that landed.` : `\nDone: ${todo.length} recipe(s) seeded.`);
  return failed ? 3 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`FAILED: ${err?.message ?? err}`);
    process.exitCode = 3;
  });
}
