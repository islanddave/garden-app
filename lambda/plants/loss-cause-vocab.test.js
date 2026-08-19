// BUG-LOSSCAUSE-001 / V4-HARVDISPOSITION-001 — loss_cause + disposition vocabulary parity.
//
// THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE, and it is the divergence_type story one table over.
// migrations/v4-losscapture-001/0b-arm-checks.sql arms chk_plants_loss_cause over a five-value
// ARRAY and its header calls that ARRAY "byte-comparable with lambda/plants/index.js's
// ALLOWED_LOSS". Nothing asserted it. index.js carries the allowlist as TWO independent literals
// (one on the PUT path, one on the POST path), so there were three hand-maintained copies of one
// vocabulary and no guard between any of them — the exact shape that left divergence_type with two
// disjoint vocabularies for 15 months (BUG-DIVERGENCEVOCAB-001). Modelled on divergence-enum.test.js
// for that reason: parse the CHECK, never hand-copy a fourth expectation into this file.
//
// AND A FOURTH COPY THAT DID NOT EXIST WHEN THAT PRECEDENT WAS WRITTEN: gates.yml's
// post_loss_cause_vocab_exact / post_disposition_vocab_exact now assert SET EQUALITY against a
// hard-coded ARRAY of their own (they used to be a conjunction of `LIKE '%value%'` substring tests,
// which passed against any superset — measured, see that file's comment). Set equality is only worth
// having if the set it compares to is the migration's. An edit to 0b that gates.yml did not follow
// would leave the gate confidently asserting a vocabulary the database no longer has, so the gate's
// literal is checked here against the same canonical source as the Lambda's.
//
// A NOTE ON WHAT IS NOT HERE. There is no ALLOWED_LOSS_CAUSES in lambda/events/ — 0b's header
// claimed one and no such constant has ever existed in this repo (the string appears in exactly one
// place: that comment). The header is corrected; nothing is asserted about a file that has nothing
// in it. harvest_log.disposition HAD no writer anywhere; V4-HARVDISPOSITION-001 shipped one in
// lambda/events/validators.js, so its vocabulary is now pinned across four homes (the CHECK, two
// gates, and that constant) exactly as loss_cause is.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decommenter the sibling vocabulary
// guards use, so `// was: 'transplant_shock'` cannot satisfy a parity assertion.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const LAMBDA_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
// V4-LOSSEVENT-001 — the vocabulary now has a FIFTH home: src/lib/eventTypes.js LOSS_REASONS, the
// canonical list the events Lambda validates a reduction's reason against. Read as SOURCE TEXT
// rather than imported, matching how every other copy here is read, so a `LOSS_REASONS` that is
// re-exported or aliased somewhere cannot satisfy the assertion by accident.
const CANON_SRC = decomment(
  readFileSync(resolve(__dirname, '../../src/lib/eventTypes.js'), 'utf8'),
);
// Every .js/.jsx under src/, concatenated. Used by the deploy-ordering tripwire at the bottom.
const SRC_ROOT = resolve(__dirname, '../../src');
const SPA_SOURCES = readdirSync(SRC_ROOT, { recursive: true })
  .filter((p) => /\.jsx?$/.test(String(p)) && !String(p).includes('__tests__'))
  .map((p) => ({ path: String(p), text: readFileSync(resolve(SRC_ROOT, String(p)), 'utf8') }));
const BUNDLE = resolve(__dirname, '../../migrations/v4-losscapture-001');
// SQL comments stripped before any match: 0b's header quotes both vocabularies in prose, and a
// regex that matched prose would "pass" against a file whose actual DDL had drifted.
const ARM_SQL = readFileSync(resolve(BUNDLE, '0b-arm-checks.sql'), 'utf8').replace(/--[^\n]*/g, '');
const GATES_SRC = readFileSync(resolve(BUNDLE, 'gates.yml'), 'utf8')
  .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** The one canonical vocabulary per column: parsed from the CHECK 0b actually arms. */
function canonicalVocabulary(conname) {
  const m = ARM_SQL.match(new RegExp(`ADD CONSTRAINT ${conname}[\\s\\S]*?ARRAY\\[([^\\]]*)\\]`));
  expect(m, `no ADD CONSTRAINT ${conname} ... ARRAY[...] found in 0b-arm-checks.sql`).toBeTruthy();
  const values = quoted(m[1]);
  expect(values.length, `${conname} vocabulary parsed as empty`).toBeGreaterThan(0);
  return values;
}

/** Every ALLOWED_LOSS literal in the Lambda, as arrays of strings. */
const lambdaAllowlists = () => [...LAMBDA_SRC.matchAll(/ALLOWED_LOSS\s*=\s*\[([^\]]*)\]/g)]
  .map((m) => quoted(m[1]));

/** One gate's YAML block, or null. The name is anchored to END-OF-LINE — `name: foo` must not be
 *  satisfied by a gate called `foo_RENAMED`, which is the substring vacuity mutation testing found
 *  in the first draft of the anti-shadowing assertion below. */
function gateBlock(gateName) {
  const m = GATES_SRC.match(new RegExp(`name: ${gateName}[ \\t]*\\r?\\n`));
  if (!m) return null;
  const rest = GATES_SRC.slice(m.index + m[0].length);
  const end = rest.indexOf('- name:');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The ARRAY literals a named gate compares against, one per containment direction. */
function gateExpectations(gateName) {
  const block = gateBlock(gateName);
  expect(block, `gate ${gateName} not found in gates.yml`).toBeTruthy();
  return [...block.matchAll(/ARRAY\[([^\]]*)\]/g)].map((m) => quoted(m[1]));
}

const LOSS_CAUSE = canonicalVocabulary('chk_plants_loss_cause');
const DISPOSITION = canonicalVocabulary('chk_harvest_log_disposition');
const sorted = (a) => [...a].sort();

describe('BUG-LOSSCAUSE-001 loss_cause vocabulary parity', () => {
  it('the migration declares the seven-value vocabulary', () => {
    // Sanity on the parse itself: a guard driven from a file it cannot read is worse than none.
    // V4-LOSSEVENT-001 widened the original five with Dave's animal_damage + culled.
    expect(sorted(LOSS_CAUSE)).toEqual([
      'animal_damage', 'culled', 'disease', 'pest', 'transplant_shock', 'unknown', 'weather',
    ]);
  });

  it('both Lambda write paths (PUT and POST) define ALLOWED_LOSS', () => {
    expect(lambdaAllowlists()).toHaveLength(2);
  });

  it('every ALLOWED_LOSS is the SAME SET as the armed CHECK — not a superset, not a subset', () => {
    // A superset is the original divergence_type bug: the API accepts what the DB 23514s on. A
    // subset silently makes a legal stored value unreachable through the app.
    for (const [i, list] of lambdaAllowlists().entries()) {
      expect(sorted(list), `ALLOWED_LOSS occurrence #${i + 1} drifted from chk_plants_loss_cause`)
        .toEqual(sorted(LOSS_CAUSE));
    }
  });

  it("the gate's set-equality expectation is the migration's vocabulary", () => {
    // Two ARRAY literals, one per containment direction (`@>` and `<@`). Both must be the canonical
    // set: an asymmetric pair would silently degrade the gate back to a one-directional test.
    const arrays = gateExpectations('post_loss_cause_vocab_exact');
    expect(arrays, 'expected @> and <@ to compare against the same vocabulary').toHaveLength(2);
    for (const a of arrays) expect(sorted(a)).toEqual(sorted(LOSS_CAUSE));
  });

  it("the pre-VALIDATE gate screens against the SAME vocabulary 0c will enforce", () => {
    // The third copy inside gates.yml, and the one that used to be invisible to this test: it was
    // written `NOT IN (...)`, which this parser cannot see, so it could have kept the old five
    // while the other two moved. At five it would red on a legitimately-stored 'culled'; at eight
    // it would wave through a row 0c then fails on. Rewritten to `<> ALL (ARRAY[...])` for exactly
    // this assertion.
    const arrays = gateExpectations('pre_no_out_of_vocab_loss_cause');
    expect(arrays, 'pre_no_out_of_vocab_loss_cause must screen against an ARRAY literal').toHaveLength(1);
    expect(sorted(arrays[0])).toEqual(sorted(LOSS_CAUSE));
  });

  it('LOSS_REASONS in the canonical src/lib/eventTypes.js is the same set', () => {
    // The events Lambda validates a reduction's reason against this list (via the generated
    // mirror). If it drifted ABOVE the CHECK, the reduction UI would offer a reason that
    // plants.loss_cause can never store; if BELOW, a stored value would be unreachable.
    const m = CANON_SRC.match(/export const LOSS_REASONS\s*=\s*\[([^\]]*)\]/);
    expect(m, 'LOSS_REASONS not found in src/lib/eventTypes.js').toBeTruthy();
    expect(sorted(quoted(m[1]))).toEqual(sorted(LOSS_CAUSE));
  });

  it('GIVEAWAY_REASONS is DISJOINT from the loss vocabulary', () => {
    // Dave's ruling, and the reason there are two lists rather than one: a plant swap is not a
    // loss, and if gifts became loss reasons every "how much did I lose to problems" answer would
    // overcount. Disjointness is also what makes isIntentionalReduction() decidable from the
    // reason value ALONE — an overlapping token would need the event type to disambiguate, which
    // is precisely the second source of truth the no-`intentional`-column decision refuses.
    const m = CANON_SRC.match(/export const GIVEAWAY_REASONS\s*=\s*\[([^\]]*)\]/);
    expect(m, 'GIVEAWAY_REASONS not found in src/lib/eventTypes.js').toBeTruthy();
    const overlap = quoted(m[1]).filter((r) => LOSS_CAUSE.includes(r));
    expect(overlap, 'a reason cannot mean both "lost" and "given away"').toEqual([]);
  });

  it("'unknown' survives as a real vocabulary member and is not folded into NULL", () => {
    // The inverse of divergence_type's call, and deliberate: 0a's header records that loss_cause's
    // 'unknown' means "asked, and nobody could say", which is a different claim from NULL's "never
    // recorded". Both spellings are load-bearing here, so a future edit that drops one reds first.
    expect(LOSS_CAUSE).toContain('unknown');
    expect(ARM_SQL).toMatch(/loss_cause IS NULL/);
  });
});

describe('V4-HARVDISPOSITION-001 disposition vocabulary parity', () => {
  it('the migration declares the four outcome values and nothing else', () => {
    expect(sorted(DISPOSITION)).toEqual(['aborted', 'culled', 'damaged', 'dropped']);
  });

  it("the gate's set-equality expectation is the migration's vocabulary", () => {
    const arrays = gateExpectations('post_disposition_vocab_exact');
    expect(arrays, 'expected @> and <@ to compare against the same vocabulary').toHaveLength(2);
    for (const a of arrays) expect(sorted(a)).toEqual(sorted(DISPOSITION));
  });

  it("the sweep gate screens against the SAME vocabulary 0c will enforce", () => {
    // The THIRD copy inside gates.yml, and — like pre_no_out_of_vocab_loss_cause before
    // V4-LOSSEVENT-001 — it used to be written `NOT IN (...)`, which this parser cannot see. It
    // could therefore have kept the original four while 0b moved: too narrow and the sweep reds on
    // a legitimately-stored value, too wide and it waves through a row 0c then fails on.
    // Rewritten to `<> ALL (ARRAY[...])` for exactly this assertion (V4-HARVDISPOSITION-001).
    const arrays = gateExpectations('sweep_no_out_of_vocab_disposition');
    expect(arrays, 'sweep_no_out_of_vocab_disposition must screen against an ARRAY literal').toHaveLength(1);
    expect(sorted(arrays[0])).toEqual(sorted(DISPOSITION));
  });

  it('the events Lambda ALLOWED_DISPOSITION is the SAME SET as the armed CHECK', () => {
    // THE TRIPWIRE THAT FIRED AS DESIGNED. Until V4-HARVDISPOSITION-001 this assertion read
    // `expect(LAMBDA_SRC).not.toMatch(/ALLOWED_DISPOSITION/)` — "no code twin yet, and when a writer
    // ships it must be added to the parity set above, it will not appear on its own." A writer has
    // now shipped, so this is that addition. Note the twin is in lambda/EVENTS/, not lambda/plants/:
    // the old assertion watched the plants Lambda and would have stayed green forever against a
    // writer living one directory over, which is why it is REPLACED rather than kept alongside.
    const src = decomment(
      readFileSync(resolve(__dirname, '../events/validators.js'), 'utf8'),
    );
    const m = src.match(/ALLOWED_DISPOSITION\s*=\s*\[([^\]]*)\]/);
    expect(m, 'ALLOWED_DISPOSITION not found in lambda/events/validators.js').toBeTruthy();
    expect(sorted(quoted(m[1]))).toEqual(sorted(DISPOSITION));
  });

  it('the SPA capture vocabulary in src/lib is the SAME SET, and its chips cover it', () => {
    // THE SIXTH HOME, registered on the day it was created (V4-HARVDISPOSITION-001 capture half).
    // The writer lane predicted this one: "the vocabulary needs an src/lib/ home when the UI ships,
    // and when it lands it must join the parity set — a sixth copy started outside that set is the
    // BUG-DIVERGENCEVOCAB-001 shape all over again." Read as SOURCE TEXT like every other copy
    // here, so a re-export or an alias cannot satisfy it by accident.
    const src = decomment(
      readFileSync(resolve(__dirname, '../../src/lib/harvestDisposition.js'), 'utf8'),
    );
    const m = src.match(/HARVEST_DISPOSITION_VALUES\s*=\s*\[([^\]]*)\]/);
    expect(m, 'HARVEST_DISPOSITION_VALUES not found in src/lib/harvestDisposition.js').toBeTruthy();
    expect(sorted(quoted(m[1]))).toEqual(sorted(DISPOSITION));

    // And the RENDERED set, separately: the chip table is what the user can actually reach, so a
    // value present in the constant but missing a chip is a value the UI can never write. Parsed
    // from the `value:` keys rather than the whole block, which also carries prose anchors.
    const chips = src.match(/HARVEST_DISPOSITION_CHIPS\s*=\s*\[([\s\S]*?)\n\]/);
    expect(chips, 'HARVEST_DISPOSITION_CHIPS not found').toBeTruthy();
    const rendered = [...chips[1].matchAll(/value:\s*'([^']+)'/g)].map((x) => x[1]);
    expect(sorted(rendered)).toEqual(sorted(DISPOSITION));
  });

  it('NULL stays legal, so a normal pick is never nagged for a value', () => {
    expect(ARM_SQL).toMatch(/disposition IS NULL/);
  });
});

// ── V4-LOSSEVENT-001 — the WIDENING's deploy ordering, asserted rather than only documented ──────
//
// This bundle now contains constraints ordered in BOTH directions, which is the thing most likely
// to be got wrong by the next reader:
//   chk_plants_qty_lost_nonneg  NARROWING  -> CODE FIRST (validateQtyLost live before the arming)
//   chk_plants_loss_cause       WIDENING   -> SCHEMA FIRST (0b applied before the widened Lambda)
// Reversed, the widened Lambda accepts 'culled' and the still-narrow live CHECK 23514s it.
describe('V4-LOSSEVENT-001 widening — deploy ordering', () => {
  const ROLLBACK_SQL = readFileSync(resolve(BUNDLE, '0r-rollback.sql'), 'utf8')
    .replace(/--[^\n]*/g, '');

  it('0b DROPS the legacy plants_loss_cause_check rather than shadow-adding beside it', () => {
    // Measured live 2026-08-18: plants_loss_cause_check exists on prod AND staging, convalidated,
    // over the original five values — a fact 0a's header explicitly denied ("The DB CHECK
    // loss_cause never had"). Widening only the house-named constraint would be COSMETIC: the
    // narrow VALIDATED one keeps rejecting, and every other gate in the bundle still reports green.
    expect(ARM_SQL).toMatch(/DROP CONSTRAINT plants_loss_cause_check/);
  });

  it('0r RESTORES it, so a rollback does not leave the column unconstrained', () => {
    // Dropping only chk_plants_loss_cause on the way back out would leave loss_cause with NO
    // database constraint at all — not the pre-migration state, and strictly worse than it.
    expect(ROLLBACK_SQL).toMatch(/ADD CONSTRAINT plants_loss_cause_check/);
    // Restored NARROW: it is the pre-widening contract being put back, not the new one.
    const m = ROLLBACK_SQL.match(/ADD CONSTRAINT plants_loss_cause_check[\s\S]*?ARRAY\[([^\]]*)\]/);
    expect(m, 'no ARRAY literal on the restored constraint').toBeTruthy();
    expect(sorted(quoted(m[1]))).toEqual(
      ['disease', 'pest', 'transplant_shock', 'unknown', 'weather'],
    );
  });

  it('a gate asserts the legacy constraint is GONE after 0b', () => {
    // Without this the two constraints can coexist and the vocab gate above is vacuous again —
    // the same vacuity class the 2026-08-18 fix removed from the LIKE-based form.
    //
    // THE FIRST DRAFT OF THIS ASSERTION WAS ITSELF VACUOUS, and mutation testing is the only
    // reason that is not still true: `toMatch(/name: post_legacy_loss_cause_check_removed/)` is a
    // SUBSTRING test, so renaming the gate to `..._removed_RENAMED` — which takes it out of the
    // runbook's expectations and out of every phase summary — left it passing. The name is now
    // anchored to end-of-line, and the gate's PREDICATE is checked too, so neither a rename nor a
    // gutted body survives.
    const block = gateBlock('post_legacy_loss_cause_check_removed');
    expect(block, 'gate post_legacy_loss_cause_check_removed is missing or renamed').toBeTruthy();
    expect(block).toMatch(/FROM pg_constraint WHERE conname='plants_loss_cause_check'/);
    // It must self-arm on 0b's row (quiet while unapplied) and demand ZERO rows.
    expect(block).toMatch(/schema_version WHERE version='4\.25\.1-losscapture-001-checks'/);
    expect(block).toMatch(/expect: rowcount_eq\s*\n\s*value: 0/);
  });

  it('STILL no SPA caller sends loss_cause — the tripwire on the ordering', () => {
    // THIS IS THE WHOLE REASON SHIPPING THE WIDENED ALLOWED_LOSS BEFORE THE APPLY IS SAFE TODAY.
    // The widened validator can only cause a 23514 if some client actually SENDS 'culled' or
    // 'animal_damage' to PUT/POST /api/plants, and nothing does: loss_cause appears in src/ only in
    // clearKeys.js's clearable list, which names it without ever assigning one. The moment a
    // capture UI for BUG-LOSSCAUSE-001 adds a real sender, this reds — and whoever adds it has to
    // confirm migrations/v4-losscapture-001 is applied to prod AND staging first, or delete this
    // test knowing what it was protecting. Same tripwire idiom as ALLOWED_DISPOSITION above.
    const senders = SPA_SOURCES.filter(({ path, text }) => {
      if (path.endsWith('clearKeys.js')) return false; // names the key, never assigns a value
      return /loss_cause\s*:/.test(text) || /loss_cause['"]?\s*\]?\s*=[^=]/.test(text);
    }).map(({ path }) => path);
    expect(senders, 'a SPA caller now writes loss_cause — see this test body before shipping').toEqual([]);
  });
});
