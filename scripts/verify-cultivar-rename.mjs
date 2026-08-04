#!/usr/bin/env node
// verify-cultivar-rename.mjs — V4-CULTIVARNAME-001 repo-side proof.
//
//   node scripts/verify-cultivar-rename.mjs
//
// Exit 0 = every repo surface carries the new spelling and the care-Lambda key contract holds.
// Exit 1 = at least one surface is stale. Prints every failure, not just the first.
//
// The DB half lives in migrations/v4-cultivarname-001/0c-verify.sql. Both halves are required:
// this file cannot see the database, and that file cannot see the repo. The one contract that
// spans them — engine.js resolveCadence() looking up by_variety on the literal DB name — is
// asserted from both ends, deliberately.
//
// WHY A SCRIPT AND NOT A GREP. "grep finds no 'Floridade'" is the wrong assertion: several
// surfaces MUST keep the old string (the migration rollback, the ripeness test's belt-and-braces
// list, historical research artifacts). A bare grep either fails on those or gets weakened with
// exclusions until it proves nothing. This checks each surface for what that surface should say.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const J = (p) => JSON.parse(R(p));

const OLD_CZECH = 'Czech Bush Slicer';
const NEW_CZECH = "Czech's Bush";
const OLD_FLOR = 'Floridade';
const NEW_FLOR = 'Floradade';

const fails = [];
const notes = [];
const ok = (cond, msg) => { if (cond) notes.push(`  ok   ${msg}`); else fails.push(`  FAIL ${msg}`); };

// ---------------------------------------------------------------------------
// 1. The care Lambda's cadence map. THE load-bearing one: engine.js:34 does
//    `[p.variety, p.name].find(k => k && byV[k])` with no normalization, so a
//    missing key is a SILENT downgrade to the genus fallback — wrong watering
//    interval, no error, no log line.
// ---------------------------------------------------------------------------
{
  const cad = J('lambda/daily-plan/cadence-data-v2.json');
  const bv = cad.by_variety ?? {};
  ok(Object.hasOwn(bv, NEW_CZECH), `cadence by_variety has the new key "${NEW_CZECH}"`);

  // The legacy key is REQUIRED, not tolerated. It is what makes the deploy orderable at all
  // (Lambda ships before the migration) and what makes 0r-rollback.sql safe without a redeploy.
  // Drop it only in a later, separate deploy — and update this assertion in the same change.
  ok(Object.hasOwn(bv, OLD_CZECH),
     `cadence by_variety RETAINS the legacy key "${OLD_CZECH}" (needed for the deploy window and for 0r-rollback)`);

  if (Object.hasOwn(bv, NEW_CZECH) && Object.hasOwn(bv, OLD_CZECH)) {
    ok(JSON.stringify(bv[NEW_CZECH]) === JSON.stringify(bv[OLD_CZECH]),
       'the two Czech cadence entries are byte-identical (an alias, not a fork)');
  }

  // Neither Floradade spelling has ever had a cadence entry — it resolves via the genus fallback.
  // Assert that, so that if someone later adds one they are forced to add it under the new name.
  ok(!Object.hasOwn(bv, OLD_FLOR),
     `cadence by_variety has no stale "${OLD_FLOR}" key`);
}

// ---------------------------------------------------------------------------
// 2. Reference-weight authoring source. Consumed by gen-refweight-seed.mjs,
//    which emits `WHERE crop_type_slug=… AND name=…` — a stale name here means
//    a re-run silently matches 0 rows and that variety keeps no weight.
// ---------------------------------------------------------------------------
{
  const doc = J('src/data/harvest-weights-v3-reference.json');
  const names = new Set(doc.by_variety.map((r) => r.variety_name));
  ok(names.has(NEW_CZECH), `harvest-weights-v3-reference has "${NEW_CZECH}"`);
  ok(names.has(NEW_FLOR), `harvest-weights-v3-reference has "${NEW_FLOR}"`);
  ok(!names.has(OLD_CZECH), `harvest-weights-v3-reference has no stale "${OLD_CZECH}"`);
  ok(!names.has(OLD_FLOR), `harvest-weights-v3-reference has no stale "${OLD_FLOR}"`);
}

// ---------------------------------------------------------------------------
// 3. The GENERATED seed must match what the generator would emit today.
//    Checked as text rather than by re-running the generator so this stays a
//    dependency-free assertion about the committed artifact.
// ---------------------------------------------------------------------------
{
  const sql = R('migrations/v4-cal1-refweight-001/0b-seed.sql');
  ok(sql.includes(`name='Czech''s Bush'`), '0b-seed.sql targets Czech’s Bush (apostrophe SQL-escaped)');
  ok(sql.includes(`name='Floradade'`), '0b-seed.sql targets Floradade');
  ok(!sql.includes(`name='${OLD_CZECH}'`), `0b-seed.sql has no stale "${OLD_CZECH}"`);
  ok(!sql.includes(`name='${OLD_FLOR}'`), `0b-seed.sql has no stale "${OLD_FLOR}"`);
}

// ---------------------------------------------------------------------------
// 4. The measured-sample loop. No sample exists for either cultivar today, so
//    the name-keyed idempotency key in apply-measured-samples.mjs is currently
//    latent. It goes live the moment either is weighed — assert the latency
//    rather than assume it, so adding a sample under the OLD name fails here
//    instead of silently no-opping against the renamed DB row.
// ---------------------------------------------------------------------------
{
  const v2 = J('src/data/harvest-weights-v2.json');
  const rows = [...(v2.by_cultivar_samples ?? []), ...(v2.by_cultivar_voids ?? [])];
  const stale = rows.filter((s) => s.variety_name === OLD_CZECH || s.variety_name === OLD_FLOR);
  ok(stale.length === 0,
     `harvest-weights-v2.json carries no sample/void under a stale name (apply-measured-samples.mjs keys its idempotency + emitted WHERE on variety_name; ${rows.length} row(s) checked)`);
}

// ---------------------------------------------------------------------------
// 5. Migration files exist and are internally consistent.
// ---------------------------------------------------------------------------
{
  const rename = R('migrations/v4-cultivarname-001/0b-rename.sql');
  ok(rename.includes(`'Czech''s Bush'`), '0b-rename.sql writes the escaped new Czech name');
  ok(rename.includes(`'Floradade'`), '0b-rename.sql writes Floradade');
  // The rollback is only safe while the legacy cadence key is deployed, so the two are checked
  // TOGETHER rather than independently. Post-NARROW (legacy key dropped) the rollback file must be
  // GONE, not merely stale — see the NARROW CHECKLIST in the migration's README-BUILD.md. Without
  // this coupling, check 5 would keep passing after the narrow and keep vouching for a file whose
  // own header still promises it is safe to run without a deploy rollback.
  const legacyKeyLive = Object.hasOwn(J('lambda/daily-plan/cadence-data-v2.json').by_variety ?? {}, OLD_CZECH);
  let rollbackExists = true;
  let back = '';
  try { back = R('migrations/v4-cultivarname-001/0r-rollback.sql'); } catch { rollbackExists = false; }
  if (legacyKeyLive) {
    ok(rollbackExists && back.includes(`'${OLD_CZECH}'`) && back.includes(`'${OLD_FLOR}'`),
       '0r-rollback.sql exists and restores BOTH old spellings (it is supposed to contain them)');
  } else {
    ok(!rollbackExists,
       'the legacy cadence key is gone (NARROW shipped), so 0r-rollback.sql must be DELETED — running it now would set the DB to a name no deployed key matches');
  }
}

// ---------------------------------------------------------------------------
// 6. Surfaces that must KEEP the old spelling. Asserted positively so a
//    well-meaning future find-and-replace across the repo fails loudly here.
// ---------------------------------------------------------------------------
{
  const t = R('src/__tests__/ripenessCues.test.js');
  ok(t.includes(`'${OLD_FLOR}'`) && t.includes(`'${NEW_FLOR}'`),
     'ripenessCues.test.js still asserts BOTH Floradade spellings');
  ok(t.includes(`'${OLD_CZECH}'`) && t.includes(`"${NEW_CZECH}"`),
     'ripenessCues.test.js still asserts BOTH Czech spellings');
}

// ---------------------------------------------------------------------------

console.log('V4-CULTIVARNAME-001 — repo surface verification\n');
for (const n of notes) console.log(n);
if (fails.length) {
  console.error('\n' + fails.join('\n'));
  console.error(`\n${fails.length} of ${fails.length + notes.length} checks FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
console.log('DB half: psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-cultivarname-001/0c-verify.sql');
