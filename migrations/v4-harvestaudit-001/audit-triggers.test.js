// OPS-HARVESTAUDIT-001 — artifact guards for the audit_events triggers.
//
// DIVISION OF LABOUR, so nothing is guarded twice and nothing falls between:
//   gates.yml                 live truth. Reads pg_trigger / pg_proc on a real environment. Can see
//                             a column added to event_log tomorrow; cannot see this repo.
//   0c-verify-triggers.sql    behaviour. Proves the triggers CAPTURE, with a fixture + ROLLBACK.
//   this file                 the ARTIFACTS. Proves the SQL and the gate file agree with each other
//                             and still say what they were written to say. A gate cannot check the
//                             migration it is shipped beside, because the gate only ever runs
//                             against a database.
//
// The one thing only this file can catch: gates.yml hardcodes the IGNORED column list while
// 0b-arm-triggers.sql hardcodes the WATCHED list, and the completeness gate is the union of the
// two. Drift between them silently reopens the gap that gate exists to close.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(DIR, f), 'utf8');

// Structural claims ("0a attaches no trigger", "0r drops triggers before functions") are claims
// about EXECUTABLE SQL, so they are made against the comment-stripped text. Both of these files
// discuss CREATE TRIGGER and DROP FUNCTION in their headers, and matching raw text made two of the
// assertions below read prose instead of code — caught on the first run of this file.
const stripComments = (s) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const SQL_0A = stripComments(read('0a-additive-ddl.sql'));
const SQL_0B = stripComments(read('0b-arm-triggers.sql'));
const SQL_0C = read('0c-verify-triggers.sql');
const SQL_0R = stripComments(read('0r-rollback.sql'));
const SQL_0R_RAW = read('0r-rollback.sql');
const GATES = yaml.load(read('gates.yml'));
const GATES_RAW = read('gates.yml');

const V_FN = '4.36.0-harvestaudit-001-fn';
const V_ARM = '4.36.0-harvestaudit-001';

// Column sets measured on live prod 2026-08-18 (information_schema.columns, owner DSN).
// gates.yml's post_column_classification_is_complete re-derives this against the LIVE table, so a
// column added after this date is caught there. This literal is the artifact-side half: it pins what
// the classification was designed against, so a change here has to be deliberate.
const PROD_COLUMNS = {
  event_log: [
    'id', 'project_id', 'event_type', 'event_date', 'title', 'notes', 'private_notes', 'quantity',
    'is_public', 'logged_by', 'created_at', 'updated_at', 'location_id', 'plant_id', 'deleted_at',
    'quantity_numeric', 'created_by', 'metadata', 'flagged_as_issue', 'severity', 'resolved_at',
    'resolved_by', 'treatment_product_id', 'treatment_product_text', 'treatment_category',
    'treatment_amount', 'pest_target', 'source',
  ],
  harvest_log: [
    'id', 'event_id', 'project_id', 'quantity', 'unit', 'quality_rating', 'notes', 'created_by',
    'created_at', 'updated_at', 'deleted_at', 'weight_grams', 'weight_estimated', 'weight_basis',
    // Added DELIBERATELY, per the note above. `disposition` is not on prod as of 2026-08-18 — it
    // arrives in the SAME fleet from v4-losscapture-001/0a, so by the time this bundle is applied to
    // prod the column exists and this list is again a true prod snapshot. Discovered exactly as the
    // note predicts: post_column_classification_is_complete FAILED on the staging apply (1 row,
    // harvest_log|disposition) because this bundle's watched list was authored pre-disposition.
    // It is WATCHED in 0b, not ignored — see the rationale there.
    'disposition',
  ],
};

/** Watched columns, read out of the real CREATE TRIGGER call in 0b rather than re-listed here. */
function watchedFrom0b(triggerName) {
  const block = SQL_0B.split(`CREATE TRIGGER ${triggerName}`)[1];
  expect(block, `${triggerName} is not created in 0b`).toBeTruthy();
  const args = block.split('audit_stmt_update(')[1].split(');')[0];
  return args.match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, ''));
}

/** The ignored list, read out of the completeness gate's SQL. */
function ignoredFromGates(table) {
  const g = GATES.post.find((x) => x.name === 'post_column_classification_is_complete');
  expect(g, 'post_column_classification_is_complete is missing').toBeTruthy();
  const seg = g.sql.split(`SELECT '${table}', unnest(ARRAY[`)[1].split('])')[0];
  return seg.match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, ''));
}

describe('OPS-HARVESTAUDIT-001 — phase split and deploy safety', () => {
  it('0a attaches NO trigger; arming is entirely 0b', () => {
    expect(SQL_0A).not.toMatch(/CREATE TRIGGER/);
    expect(SQL_0A).toMatch(/CREATE OR REPLACE FUNCTION public\.audit_stmt_delete\(\)/);
    expect(SQL_0A).toMatch(/CREATE OR REPLACE FUNCTION public\.audit_stmt_update\(\)/);
    expect(SQL_0A).toMatch(/CREATE OR REPLACE FUNCTION public\.audit_watched_slice\(/);
  });

  it('0b arms exactly four triggers, two per table', () => {
    const names = [...SQL_0B.matchAll(/CREATE TRIGGER (trg_audit_\w+)/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([
      'trg_audit_event_log_del', 'trg_audit_event_log_upd',
      'trg_audit_harvest_log_del', 'trg_audit_harvest_log_upd',
    ]);
  });

  it('every armed trigger is FOR EACH STATEMENT — the write-amplification design', () => {
    // event_log takes bursts of 157 rows in one second; FOR EACH ROW would run the body 157 times
    // and open 157 subtransactions for the exception handler.
    const creates = SQL_0B.split('CREATE TRIGGER ').slice(1);
    expect(creates).toHaveLength(4);
    for (const c of creates) {
      expect(c).toMatch(/FOR EACH STATEMENT/);
      expect(c).not.toMatch(/FOR EACH ROW/);
    }
  });

  it('every armed trigger declares the transition tables its function reads', () => {
    // A statement-level trigger without REFERENCING sees no rows and writes nothing, silently.
    for (const t of ['trg_audit_event_log_del', 'trg_audit_harvest_log_del']) {
      expect(SQL_0B.split(`CREATE TRIGGER ${t}`)[1].split(';')[0])
        .toMatch(/REFERENCING OLD TABLE AS old_rows/);
    }
    for (const t of ['trg_audit_event_log_upd', 'trg_audit_harvest_log_upd']) {
      const block = SQL_0B.split(`CREATE TRIGGER ${t}`)[1].split(');')[0];
      expect(block).toMatch(/OLD TABLE AS old_rows/);
      expect(block).toMatch(/NEW TABLE AS new_rows/);
    }
  });

  it('no INSERT arm exists — the decision, pinned', () => {
    // Redundant with the live row's created_at and with the DELETE pre-image, and INSERT is where
    // 100% of the batch amplification lives. Re-adding it should be a considered change.
    expect(SQL_0B).not.toMatch(/AFTER INSERT/);
    expect(SQL_0B).not.toMatch(/AFTER INSERT OR/);
    expect(SQL_0C).toMatch(/the INSERT arm is not supposed to exist/);
  });

  it('0r reverses EVERYTHING 0a and 0b created, triggers before functions', () => {
    // Ordering alone is not enough, and this assertion originally checked only that: mutation V12
    // deleted the `DROP FUNCTION public.audit_stmt_update()` line and the test still passed, because
    // the surviving DROP FUNCTIONs kept the ordering intact. An incomplete rollback that reports
    // success is worse than none — it leaves an orphaned function behind and a false claim in the
    // runbook. Completeness is now asserted by name, per object.
    for (const t of ['trg_audit_event_log_del', 'trg_audit_event_log_upd',
      'trg_audit_harvest_log_del', 'trg_audit_harvest_log_upd']) {
      expect(SQL_0B, `${t} must be created by 0b`).toMatch(new RegExp(`CREATE TRIGGER ${t}\\b`));
      expect(SQL_0R, `${t} must be dropped by 0r`).toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${t}\\b`));
    }
    for (const f of ['audit_stmt_update', 'audit_stmt_delete', 'audit_watched_slice']) {
      expect(SQL_0A, `${f} must be created by 0a`)
        .toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${f}\\(`));
      expect(SQL_0R, `${f} must be dropped by 0r`)
        .toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${f}\\(`));
    }
    // ...and only then, the ordering: DROP FUNCTION before the last DROP TRIGGER would fail on the
    // dependency, which is a safety property rather than an inconvenience.
    expect(SQL_0R.indexOf('DROP FUNCTION')).toBeGreaterThan(SQL_0R.lastIndexOf('DROP TRIGGER'));
  });

  it('0r does NOT delete the audit rows already collected', () => {
    // Rolling back the mechanism is not a decision to destroy the evidence — and for a hard-deleted
    // row the audit row is the only surviving copy.
    expect(SQL_0R).not.toMatch(/^\s*DELETE FROM public\.audit_events/m);
    // ...and the raw file must still SAY so, with the manual command spelled out, so the omission
    // reads as a decision rather than as something forgotten.
    expect(SQL_0R_RAW).toMatch(/does not delete the audit_events rows/);
  });
});

describe('OPS-HARVESTAUDIT-001 — the audit can never abort the write it audits', () => {
  // audit_events.actor_clerk_sub is NOT NULL with no default, so an unhandled failure here kills a
  // user's write — including a V4-LOSSEVENT-001 reduction whose counter update on plants shares the
  // transaction. Gutting the handler leaves every structural check green.
  for (const fn of ['audit_stmt_delete', 'audit_stmt_update']) {
    it(`${fn} wraps its INSERT in an exception handler that degrades to a WARNING`, () => {
      const body = SQL_0A.split(`CREATE OR REPLACE FUNCTION public.${fn}()`)[1].split('COMMENT ON')[0];
      expect(body).toMatch(/EXCEPTION/);
      expect(body).toMatch(/WHEN OTHERS THEN/);
      expect(body).toMatch(/RAISE WARNING/);
    });

    it(`${fn} re-raises cancellation rather than swallowing it`, () => {
      const body = SQL_0A.split(`CREATE OR REPLACE FUNCTION public.${fn}()`)[1].split('COMMENT ON')[0];
      expect(body).toMatch(/WHEN query_canceled OR admin_shutdown THEN\s*\n\s*RAISE;/);
    });

    it(`${fn} is SECURITY DEFINER with a pinned search_path`, () => {
      const head = SQL_0A.split(`CREATE OR REPLACE FUNCTION public.${fn}()`)[1].split('AS $$')[0];
      expect(head).toMatch(/SECURITY DEFINER/);
      expect(head).toMatch(/SET search_path = pg_catalog, public/);
    });

    it(`${fn} coalesces a missing actor to 'system' via NULLIF, not a bare COALESCE`, () => {
      // current_setting(x, true) yields NULL when unset but '' when set to empty; only the first is
      // caught by a bare COALESCE, and an empty actor satisfies NOT NULL while saying nothing.
      const body = SQL_0A.split(`CREATE OR REPLACE FUNCTION public.${fn}()`)[1].split('COMMENT ON')[0];
      expect(body).toMatch(/COALESCE\(NULLIF\(current_setting\('app\.actor_clerk_sub', true\), ''\), 'system'\)/);
    });
  }

  it('audit_stmt_update tests deleted_at independently of the watched slice', () => {
    // Belt and braces: a row leaving or re-entering view stays audited even if a future edit drops
    // deleted_at from the trigger's argument list.
    const body = SQL_0A.split('CREATE OR REPLACE FUNCTION public.audit_stmt_update()')[1];
    expect(body).toMatch(/WHERE o\.deleted_at IS DISTINCT FROM n\.deleted_at/);
    expect(body).toMatch(/SOFT_DELETE/);
    expect(body).toMatch(/RESTORE/);
  });
});

describe('OPS-HARVESTAUDIT-001 — column classification parity (0b <-> gates.yml)', () => {
  // The completeness gate is watched (0b) UNION ignored (gates.yml). If the two files disagree about
  // which columns exist, that gate passes while a real column is classified nowhere.
  for (const [table, trigger] of [
    ['event_log', 'trg_audit_event_log_upd'],
    ['harvest_log', 'trg_audit_harvest_log_upd'],
  ]) {
    it(`${table}: watched + ignored covers every prod column exactly once`, () => {
      const watched = watchedFrom0b(trigger);
      const ignored = ignoredFromGates(table);
      const union = [...watched, ...ignored].sort();
      expect(new Set(union).size, `${table}: a column is in BOTH watched and ignored`)
        .toBe(union.length);
      expect(union).toEqual([...PROD_COLUMNS[table]].sort());
    });

    it(`${table}: deleted_at is watched`, () => {
      expect(watchedFrom0b(trigger)).toContain('deleted_at');
    });

    it(`${table}: updated_at is NOT watched`, () => {
      // set_updated_at moves it on every UPDATE. Watching it collapses the column-scoped design back
      // into the unfiltered one that would have audited the 11,201-row source backfill.
      expect(watchedFrom0b(trigger)).not.toContain('updated_at');
    });
  }

  it('event_log: the columns a crop total actually depends on are watched', () => {
    const w = watchedFrom0b('trg_audit_event_log_upd');
    // metadata carries V4-LOSSEVENT-001's qty_reduced/loss_reason, which drive the plants counters.
    for (const c of ['quantity', 'quantity_numeric', 'metadata', 'event_type', 'plant_id',
      'project_id', 'event_date', 'created_by', 'created_at']) {
      expect(w, `${c} must be watched`).toContain(c);
    }
  });

  it('event_log: source is ignored, and that is the whole amplification argument', () => {
    // 4.21.3-eventsource-001-backfill updated 11,201 rows in one statement at 2026-08-04 18:53:13.
    expect(watchedFrom0b('trg_audit_event_log_upd')).not.toContain('source');
    expect(ignoredFromGates('event_log')).toContain('source');
  });

  it('harvest_log: quantity and the weight triple are watched', () => {
    const w = watchedFrom0b('trg_audit_harvest_log_upd');
    for (const c of ['quantity', 'unit', 'weight_grams', 'weight_estimated', 'weight_basis']) {
      expect(w, `${c} must be watched`).toContain(c);
    }
  });
});

describe('OPS-HARVESTAUDIT-001 — gates.yml self-arming and phase hygiene', () => {
  it('EVERY post gate self-arms on a schema_version row', () => {
    // gate-invariants.yml runs `--all --phase post --continuous-only` on every push to dev, and
    // gate_runner has no skip-if-unapplied logic. A post gate without this conjunct stands red from
    // the moment the directory reaches the branch until Dave applies the migration.
    for (const g of GATES.post) {
      expect(g.sql, `${g.name} is not self-arming`)
        .toMatch(new RegExp(`schema_version WHERE version = '(${V_ARM}|${V_FN})'`));
    }
  });

  it('EVERY post gate is violation-shaped, expecting zero rows', () => {
    // The polarity trap: a bare EXISTS conjunct only self-arms correctly for gates that expect 0.
    // A presence assertion written positively FAILS exactly when it is meant to be quiet.
    for (const g of GATES.post) {
      expect(g.expect, `${g.name} must be rowcount_eq`).toBe('rowcount_eq');
      expect(g.value, `${g.name} must expect 0 rows`).toBe(0);
    }
  });

  it('sweep receipts are continuous:false; no post gate is', () => {
    for (const g of GATES.sweep) expect(g.continuous, `${g.name}`).toBe(false);
    for (const g of GATES.post) expect(g.continuous, `${g.name} should stay continuous`).toBeUndefined();
  });

  it('the named post gates are all present, anchored to end-of-name', () => {
    // Anchored, per the lossevent lane's M15: a substring match let a gate be renamed out of the
    // runbook while its assertion kept passing.
    const names = GATES.post.map((g) => g.name);
    for (const n of [
      'post_all_four_audit_triggers_present',
      'post_audit_triggers_are_statement_level',
      'post_audit_triggers_have_transition_tables',
      'post_update_triggers_have_both_transition_tables',
      'post_audit_functions_cannot_abort_the_write',
      'post_audit_functions_reraise_cancellation',
      'post_audit_functions_are_security_definer_with_pinned_path',
      'post_every_watched_column_actually_exists',
      'post_column_classification_is_complete',
      'post_deleted_at_is_watched_on_both_tables',
      'post_event_log_metadata_and_quantities_are_watched',
      'post_harvest_log_weight_and_quantity_are_watched',
      'post_no_insert_arm_was_added',
    ]) {
      expect(names, `${n} missing from gates.yml`).toContain(n);
      expect(GATES_RAW).toMatch(new RegExp(`^\\s*- name: ${n}$`, 'm'));
    }
  });

  it('the pre gate that STATES the defect is present and expects zero coverage', () => {
    const g = GATES.pre.find((x) => x.name === 'pre_targets_have_no_audit_coverage');
    expect(g).toBeTruthy();
    expect(g.value).toBe(0);
    expect(g.sql).toMatch(/audit_stmt_delete/);
  });

  it('the schema_version strings match the ones the SQL actually writes', () => {
    expect(SQL_0A).toContain(`'${V_FN}'`);
    expect(SQL_0B).toContain(`'${V_ARM}'`);
    expect(SQL_0R).toContain(V_ARM);
    expect(SQL_0R).toContain(V_FN);
  });
});

describe('OPS-HARVESTAUDIT-001 — 0c actually asserts capture', () => {
  it('asserts a hard DELETE produces exactly one audit row with a full pre-image', () => {
    expect(SQL_0C).toMatch(/hard DELETE wrote % audit rows/);
    expect(SQL_0C).toMatch(/before_jsonb\.quantity_numeric/);
    expect(SQL_0C).toMatch(/before_jsonb has no created_at/);
  });

  it('asserts the multi-row DELETE case the archive functions actually issue', () => {
    expect(SQL_0C).toMatch(/id = ANY\(ARRAY\[v_e2, v_e3\]\)/);
    expect(SQL_0C).toMatch(/transition table not per-row/);
  });

  it('asserts BOTH directions of the column scoping', () => {
    expect(SQL_0C).toMatch(/D1: watched-column UPDATE/);
    expect(SQL_0C).toMatch(/D2: ignored-column UPDATE wrote an audit row/);
  });

  it('asserts SOFT_DELETE, RESTORE, and the harvest_log arm', () => {
    for (const t of ['C1: soft delete', 'C2: restore', 'E1: harvest quantity edit',
      'E4: harvest_log hard DELETE']) {
      expect(SQL_0C).toContain(t);
    }
  });

  it('rolls back, so it is safe to run on prod', () => {
    expect(SQL_0C.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(SQL_0C).not.toMatch(/^COMMIT;/m);
  });
});
