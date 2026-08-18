// V4-HARVDISPOSITION-001 — the harvest-disposition write path. DB-free: pure validators plus
// source-text assertions on the two SQL statements, which is what this Lambda's suite can prove
// (the unit suite is mock-sql + source text by construction; real arithmetic is proved on an
// ephemeral Postgres and reported, and belongs long-term in tests/integration/).
//
// ═══ WHY THIS FILE CARRIES AN ORDERING SECTION AND ITS SIBLINGS DO NOT ═══
//
// v4-losscapture-001 now contains changes ordered in BOTH directions, which is the single thing
// most likely to be got wrong by whoever ships it:
//
//   chk_plants_qty_lost_nonneg   NARROWING  -> CODE FIRST   (validateQtyLost live, THEN arm)
//   chk_plants_loss_cause        WIDENING   -> SCHEMA FIRST  (0b applied, THEN the widened Lambda)
//   harvest_log.disposition      NEW COLUMN -> SCHEMA FIRST  (0a applied, THEN this writer)
//
// The third one is the harshest, because it does not fail on the value — it fails on the STATEMENT.
// A column reference resolves at PARSE time, so an events Lambda naming harvest_log.disposition
// against a database where 0a has not run raises 42703 on EVERY harvest POST and EVERY harvest edit,
// including the 99.4% of picks that carry no disposition at all. That is the same parse-time fact
// that forced gates.yml's sweep_no_out_of_vocab_disposition out of the `pre` phase.
//
// Until this lane, the only thing keeping that safe was that NOTHING in the repo named the column,
// asserted by a tripwire in lambda/plants/loss-cause-vocab.test.js. That tripwire has now fired and
// been replaced by real parity assertions, so the ordering needs a new home — this one. The
// assertions below make the dependency mechanical rather than tribal: the SQL sites that name the
// column are ENUMERATED, so a new one cannot be added silently, and each is tied back to the
// migration that must precede it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateHarvestFields, validatePostBody, seedsWeightCalibration,
  ALLOWED_DISPOSITION, DISPOSITION_ERROR,
} from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same decommenter the sibling vocabulary guards use: a construct NAMED IN A COMMENT is not that
// construct, and every comment in the two statements below discusses `disposition` at length.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const BUNDLE = resolve(__dirname, '../../migrations/v4-losscapture-001');
const DDL_SQL = readFileSync(resolve(BUNDLE, '0a-additive-ddl.sql'), 'utf8').replace(/--[^\n]*/g, '');

const UUID = '11111111-1111-4111-8111-111111111111';
const h = (over = {}) => ({ quantity: 5, unit: 'count', ...over });
const ok = (over) => expect(validateHarvestFields(h(over))).toBeNull();
const bad = (over, re) => {
  const r = validateHarvestFields(h(over));
  expect(r).not.toBeNull();
  expect(r.status).toBe(400);
  if (re) expect(r.error).toMatch(re);
};

describe('validateHarvestFields — disposition is optional and additive', () => {
  it('accepts a harvest with no disposition key at all (the 99.4% path)', () => ok());

  it('accepts every value the armed CHECK will allow', () => {
    // Driven off the exported constant rather than a retyped list, so widening the vocabulary
    // cannot leave a value accepted by the DB and untested here.
    for (const d of ALLOWED_DISPOSITION) ok({ disposition: d });
  });

  it('accepts an explicit null — the user saying it was a normal pick after all', () => {
    ok({ disposition: null });
  });

  it('rejects anything outside the vocabulary, with a readable message', () => {
    // Without this the value reaches chk_harvest_log_disposition, which 0c VALIDATEs, and a 23514
    // surfaces as an opaque 500 — the same failure shape the treatment_category check exists to
    // stop. 'lost' and 'failed' specifically because they are the PLANT-grain vocabulary next door,
    // and confusing the two grains is the mistake this ticket is most likely to attract.
    bad({ disposition: 'spoiled' }, /disposition must be one of/);
    bad({ disposition: 'lost' });
    bad({ disposition: 'failed' });
    bad({ disposition: 'pest' });
    bad({ disposition: '' });
    bad({ disposition: 'Dropped' });   // case-sensitive: the CHECK is
    bad({ disposition: 7 });
    bad({ disposition: ['dropped'] });
  });

  it('names the whole vocabulary in the error, so the client need not guess', () => {
    for (const d of ALLOWED_DISPOSITION) expect(DISPOSITION_ERROR).toContain(d);
  });
});

describe('the rule reaches BOTH write paths, not just the one it was written for', () => {
  it('POST /api/events rejects a bad disposition through validatePostBody', () => {
    // validateHarvestFields is only load-bearing if the create path actually calls it. Asserted by
    // behaviour rather than by grepping for the call, so a refactor that keeps the call but stops
    // reaching this branch still reds.
    const r = validatePostBody({
      project_id: UUID, event_type: 'harvest',
      harvest: { quantity: 2, unit: 'count', disposition: 'spoiled' },
    });
    expect(r).not.toBeNull();
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/disposition must be one of/);
  });

  it('POST accepts a good one', () => {
    expect(validatePostBody({
      project_id: UUID, event_type: 'harvest',
      harvest: { quantity: 2, unit: 'count', disposition: 'aborted' },
    })).toBeNull();
  });

  it('a disposition cannot ride on a non-harvest event', () => {
    // The harvest sub-object is already forbidden on every other type, which is what keeps the pick
    // grain and the plant grain from leaking into each other at the API edge. Pinned here because
    // `failed` (V4-LOSSEVENT-001's reduction event) is precisely the type someone would try it on.
    const r = validatePostBody({
      project_id: UUID, event_type: 'failed',
      harvest: { quantity: 1, unit: 'count', disposition: 'aborted' },
    });
    expect(r).not.toBeNull();
    expect(r.error).toMatch(/harvest fields only valid on event_type=harvest/);
  });
});

describe('the POST write path', () => {
  it('binds the disposition only for harvests', () => {
    expect(SRC).toMatch(
      /const harvestDisposition = isHarvest \? \(body\.harvest\.disposition \?\? null\) : null;/,
    );
  });

  it('writes it into the harvest_log INSERT column list', () => {
    const m = SRC.match(/INSERT INTO harvest_log\s*\(([^)]*)\)/);
    expect(m, 'no harvest_log INSERT column list found').toBeTruthy();
    expect(m[1]).toMatch(/\bdisposition\b/);
  });

  it('binds harvestDisposition into that INSERT, not a literal', () => {
    // The column being in the list proves nothing about what lands in it: an INSERT that lists the
    // column and selects a constant would satisfy the assertion above while storing NULL forever,
    // which is the exact V4-EVENTSOURCE-001 shape (DDL landed, nothing wrote the data) this ticket
    // exists to avoid repeating.
    const stmt = SRC.slice(SRC.indexOf('INSERT INTO harvest_log'));
    const body = stmt.slice(0, stmt.indexOf('RETURNING'));
    expect(body).toMatch(/\$\{harvestDisposition\}::text/);
  });

  it('returns it, so the client sees what was stored', () => {
    const stmt = SRC.slice(SRC.indexOf('INSERT INTO harvest_log'));
    const returning = stmt.slice(stmt.indexOf('RETURNING'), stmt.indexOf('RETURNING') + 300);
    expect(returning).toMatch(/\bdisposition\b/);
  });
});

// There is MORE THAN ONE `UPDATE harvest_log h` in index.js — the soft-delete cascade and the
// batch-undo both come first — so an indexOf() on the verb finds the wrong statement and every
// assertion below then passes or fails for reasons unrelated to this ticket. Same trap
// harvest-weight-preserve.test.js documents; select by what the statement SETS.
function harvestUpdateStatement() {
  let from = 0;
  for (;;) {
    const i = SRC.indexOf('UPDATE harvest_log h', from);
    expect(i, 'no harvest_log UPDATE that sets quantity').toBeGreaterThan(-1);
    const stmt = SRC.slice(i, SRC.indexOf('`;', i));
    if (/SET quantity\s*=/.test(stmt)) return stmt;
    from = i + 1;
  }
}

describe('the PUT write path — absent must PRESERVE, null must CLEAR', () => {
  const putHarvest = harvestUpdateStatement;

  it('distinguishes an absent key from an explicit null', () => {
    // `in` rather than `!== undefined`, and the distinction is the whole safety property: EventDetail
    // round-trips the entire harvest object on every save and does not know this key yet, so an
    // absent-means-clear reading would wipe a recorded disposition on any unrelated edit. That is
    // BUG-TREATMENTPRODUCT-001 verbatim — the PUT ran last, won, and nulled a column silently.
    expect(SRC).toMatch(/const hTouchDisposition = 'disposition' in body\.harvest;/);
    expect(SRC).toMatch(/const hDisposition = body\.harvest\.disposition \?\? null;/);
  });

  it('the UPDATE is a genuine no-op when the key is absent', () => {
    // h.disposition is the PRE-UPDATE value (SET expressions see the old row), so the ELSE arm
    // rewrites the row's own value rather than a default. An unconditional assignment here would
    // pass a "sets disposition" test and still be the silent-nulling bug.
    expect(putHarvest()).toMatch(
      /disposition\s+= CASE WHEN \$\{hTouchDisposition\}::boolean\s+THEN \$\{hDisposition\}::text ELSE h\.disposition END/,
    );
  });

  it('returns the post-update value', () => {
    expect(putHarvest()).toMatch(/RETURNING[^`]*h\.disposition/);
  });
});

describe('a disposition-bearing pick must not calibrate the cultivar weight', () => {
  it('seedsWeightCalibration is true only for a normal pick', () => {
    expect(seedsWeightCalibration(null)).toBe(true);
    expect(seedsWeightCalibration(undefined)).toBe(true);
    for (const d of ALLOWED_DISPOSITION) expect(seedsWeightCalibration(d)).toBe(false);
  });

  it('the CREATE path stops seeding a sample', () => {
    // Measured on prod before this shipped: "Unripe abort" (2 g) is the SOLE cultivar_weight_sample
    // behind Habanero's derived 2.0 g/fruit, and "Very early aborts" (1 g / 2 count) the sole one
    // behind Pumpkin Jalapeno's 0.50 g/fruit. Both still `provisional`, so resolve_harvest_weight is
    // not using them YET — but its escape hatch is independent_n >= 5, and aborts are correlated and
    // repeatable, so more of them PROMOTE the wrong number rather than diluting it.
    expect(SRC).toMatch(
      /if \(isHarvest && harvestUserGrams > 0 && seedsWeightCalibration\(harvestDisposition\)\)/,
    );
  });

  it('the EDIT path RETIRES an existing sample when a disposition is added later', () => {
    // Not merely "stops seeding". record_harvest_weight_sample voids an event's samples when it is
    // passed no grams, and the PUT already calls it unconditionally for exactly that reason — so
    // zeroing savedGrams is how marking an already-saved pick "unripe abort" un-teaches it.
    // Read off the POST-UPDATE ROW so the absent-key preservation above is honoured.
    expect(SRC).toMatch(
      /const savedGrams = isUserSuppliedWeight\(harvestRow\)\s*&& seedsWeightCalibration\(harvestRow\.disposition\) \? Number\(harvestRow\.weight_grams\) : 0;/,
    );
  });
});

describe('the pick grain and the plant grain stay separated', () => {
  it('the harvest write touches no plant reduction counter', () => {
    // V4-LOSSEVENT-001's ledger decrements plants.quantity/qty_current and accrues plants.qty_lost.
    // A pick going wrong is NOT a plant dying: the fruit came off a planting that is still alive and
    // still has the same number of plants on it. If the harvest statements ever started moving those
    // counters, every "how much did I lose" answer would double-count a bad pick as a dead plant.
    const post = SRC.slice(SRC.indexOf('INSERT INTO harvest_log'));
    const postStmt = post.slice(0, post.indexOf('RETURNING') + 400);
    for (const [label, stmt] of [['POST', postStmt], ['PUT', harvestUpdateStatement()]]) {
      expect(stmt, `${label} harvest statement writes qty_lost`).not.toMatch(/qty_lost/);
      expect(stmt, `${label} harvest statement writes qty_current`).not.toMatch(/qty_current/);
      expect(stmt, `${label} harvest statement writes a loss reason`).not.toMatch(/loss_reason|loss_cause/);
    }
  });

  it('the reduction write touches no disposition', () => {
    // The mirror direction. If the reduction statement ever learned about harvest_log.disposition it
    // would silently inherit this ticket's 42703 deploy ordering.
    //
    // THE FIRST DRAFT OF THIS TEST WAS VACUOUS and the end-to-end harness is what caught it: it
    // looked for `UPDATE plants p` and RETURNED EARLY when it found nothing, so it asserted exactly
    // nothing — forever, silently. V4-LOSSEVENT-001's reduction targets the `garden_node` VIEW, not
    // the base table, because garden_node has no RLS and an inner join drops the container-less
    // plantings. Located by what it WRITES now, and its absence is a failure rather than a pass.
    const stmts = [...SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
    const reductions = stmts.filter((s) => /UPDATE public\.garden_node/.test(s) && /qty_lost/.test(s));
    expect(reductions.length, 'no plant-reduction statement found — has it moved?').toBeGreaterThan(0);
    for (const s of reductions) expect(s).not.toMatch(/disposition/);
  });

  it('the two vocabularies are allowed to overlap, and that is not a bug', () => {
    // 'culled' means both "I pulled the plant" and "I threw this fruit away". They are separate
    // facts on separate tables written by separate statements, so the overlap is inert — unlike
    // LOSS_REASONS vs GIVEAWAY_REASONS, whose disjointness IS load-bearing because
    // isIntentionalReduction() has to decide from the reason value alone. Pinned so nobody
    // "fixes" the overlap by renaming a value out from under a stored row.
    expect(ALLOWED_DISPOSITION).toContain('culled');
  });
});

// ── THE DEPLOY ORDERING, ASSERTED RATHER THAN ONLY DOCUMENTED ────────────────────────────────────
describe('V4-HARVDISPOSITION-001 — SCHEMA FIRST, and the sites are enumerated', () => {
  // Every place in the shipped Lambda source whose SQL names the column. Each one is a statement
  // that raises 42703 in full against a pre-0a database. Enumerated so the list can be COMPARED,
  // not just counted: a new site fails this test by name and its author has to come here, read the
  // ordering, and decide deliberately — the same tripwire idiom as "STILL no SPA caller sends
  // loss_cause" in lambda/plants/loss-cause-vocab.test.js.
  const EXPECTED_SQL_SITES = [
    'INSERT INTO harvest_log',   // POST column list + bound value + RETURNING
    'UPDATE harvest_log h',      // PUT SET + RETURNING
  ];

  it('exactly two SQL statements in this Lambda name harvest_log.disposition', () => {
    const stmts = [...SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
    const naming = stmts.filter((s) => /\bdisposition\b/.test(s));
    const found = naming.map((s) => EXPECTED_SQL_SITES.find((k) => s.includes(k)) ?? s.slice(0, 60).trim());
    expect([...new Set(found)].sort()).toEqual([...EXPECTED_SQL_SITES].sort());
    expect(naming).toHaveLength(2);
  });

  it('0a is the migration that must precede the deploy, and it is still in the bundle', () => {
    // The writer's precondition stated as a repo fact rather than a sentence in a README: if 0a is
    // renamed, gutted, or the ADD COLUMN dropped, this reds before anyone deploys against it.
    expect(DDL_SQL).toMatch(/ALTER TABLE public\.harvest_log\s+ADD COLUMN IF NOT EXISTS disposition text/);
  });

  it('0a stays nullable and defaultless, because NULL is a MEANING here', () => {
    // NULL = "this was a normal pick", not "nobody filled it in" — 703 of 707 live harvests. A
    // DEFAULT or a NOT NULL would force a value onto every pick and destroy the distinction the
    // column exists to carry. gates.yml asserts the same thing against the live database
    // (post_harvest_log_disposition_present_nullable_defaultless); this asserts it against the file,
    // so it reds in CI rather than at apply time.
    const stmt = DDL_SQL.slice(DDL_SQL.indexOf('ALTER TABLE public.harvest_log'));
    const line = stmt.slice(0, stmt.indexOf(';'));
    expect(line).not.toMatch(/DEFAULT/i);
    expect(line).not.toMatch(/NOT NULL/i);
  });

  it('the bundle README carries the writer step in its ordering', () => {
    // The runbook is what the operator actually follows. A test that pins behaviour but lets the
    // runbook forget the step protects nothing on the day it matters.
    const readme = readFileSync(resolve(BUNDLE, 'README.md'), 'utf8');
    expect(readme).toMatch(/42703/);
    expect(readme).toMatch(/harvest-disposition\.test\.js/);
  });
});
