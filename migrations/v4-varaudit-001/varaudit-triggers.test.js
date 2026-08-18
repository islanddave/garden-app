// OPS-VARAUDIT-001 — artifact guards for the hardened plant_varieties audit triggers.
//
// These guard the SHIPPED SQL, not a database. gates.yml checks a live catalog and 0c checks live
// behaviour; this file is what fails in CI on a branch before anything is applied anywhere, which is
// the only place a bad edit to these files can be caught early.
//
// EVERY assertion runs against a COMMENT-STRIPPED copy of the file. The comment blocks in 0a and 0b
// deliberately quote the things being guarded against — the old bare COALESCE, `TG_ARGV`, the words
// EXCEPTION and SECURITY INVOKER — so an assertion over the raw text would match prose and pass
// while the executable SQL said the opposite. That is the exact vacuity shape this header exists to
// prevent, and V14/V15 below mutate the code to prove the stripping works.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

// Strip `-- ...` line comments, preserving line structure so failures stay locatable. The bundle
// contains no /* */ blocks and no `--` inside a string literal, both asserted below so this stays
// true if the files grow.
const strip = (s) => s.replace(/--.*$/gm, '');

const RAW = {
  a: read('0a-additive-ddl.sql'),
  b: read('0b-swap-triggers.sql'),
  c: read('0c-verify-triggers.sql'),
  r: read('0r-rollback.sql'),
};
const SQL = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, strip(v)]));
const GATES = yaml.load(read('gates.yml'));

const FUNCS = ['audit_pv_stmt_insert', 'audit_pv_stmt_update', 'audit_pv_stmt_delete'];
const TRIGGERS = [
  'trg_audit_plant_varieties_ins',
  'trg_audit_plant_varieties_upd',
  'trg_audit_plant_varieties_del',
];

// Isolate one CREATE FUNCTION body so a property can be asserted PER FUNCTION. Asserting over the
// whole file would let two correct functions cover for a third that lost its handler.
function bodyOf(name) {
  const start = SQL.a.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  expect(start, `0a must define ${name}`).toBeGreaterThan(-1);
  const end = SQL.a.indexOf('$$;', start);
  expect(end, `${name} must be terminated`).toBeGreaterThan(start);
  return SQL.a.slice(start, end);
}

describe('OPS-VARAUDIT-001 — the comment-stripping the other assertions depend on', () => {
  it('V0a strips line comments but leaves executable SQL', () => {
    expect(strip("SELECT 1; -- SECURITY INVOKER\n")).toBe('SELECT 1; \n');
  });

  it('V0b the bundle contains no block comments and no -- inside a string literal', () => {
    for (const [k, v] of Object.entries(RAW)) {
      expect(v, `${k}: /* */ blocks would defeat the line-comment stripper`).not.toContain('/*');
      // A `--` inside a quoted literal would be stripped too, silently truncating real SQL.
      const literals = v.match(/'[^'\n]*'/g) ?? [];
      for (const lit of literals) expect(lit, `${k}: -- inside a string literal`).not.toContain('--');
    }
  });

  it('V0c the raw files DO mention the guarded-against forms, so stripping is load-bearing', () => {
    // If this ever fails, the assertions below stopped being meaningful tests of the stripper.
    expect(RAW.a).toContain('TG_ARGV');
    expect(RAW.a).toContain('SECURITY INVOKER');
    expect(SQL.a).not.toContain('TG_ARGV');
    expect(SQL.a).not.toContain('SECURITY INVOKER');
  });
});

describe('OPS-VARAUDIT-001 — the safety property, per function', () => {
  it('V1 every audit INSERT is inside an exception handler that warns', () => {
    for (const f of FUNCS) {
      const body = bodyOf(f);
      expect(body, `${f}: no WHEN OTHERS arm`).toContain('WHEN OTHERS THEN');
      expect(body, `${f}: handler must degrade to a WARNING`).toContain('RAISE WARNING');
    }
  });

  it('V2 cancellation and shutdown are re-raised, and BEFORE the catch-all', () => {
    for (const f of FUNCS) {
      const body = bodyOf(f);
      const cancel = body.indexOf('WHEN query_canceled OR admin_shutdown THEN');
      const others = body.indexOf('WHEN OTHERS THEN');
      expect(cancel, `${f}: no cancellation arm`).toBeGreaterThan(-1);
      // Ordering is not cosmetic: WHEN OTHERS placed first would swallow query_canceled, and the
      // cancellation arm below it would be dead code that still satisfies a presence-only check.
      expect(cancel, `${f}: cancellation arm must precede WHEN OTHERS`).toBeLessThan(others);
      expect(body.slice(cancel, others), `${f}: cancellation arm must RAISE`).toContain('RAISE;');
    }
  });

  it('V3 every function is SECURITY DEFINER with a pinned search_path', () => {
    for (const f of FUNCS) {
      const body = bodyOf(f);
      expect(body, `${f}: not SECURITY DEFINER`).toContain('SECURITY DEFINER');
      expect(body, `${f}: search_path not pinned`).toContain('SET search_path = pg_catalog, public');
    }
  });

  it('V4 the actor idiom is NULLIF-hardened in every function', () => {
    for (const f of FUNCS) {
      expect(
        bodyOf(f),
        `${f}: bare COALESCE lets an empty GUC through as an empty actor`,
      ).toContain("COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system')");
    }
  });

  it('V5 table_name comes from TG_TABLE_NAME, not a hardcoded literal', () => {
    for (const f of FUNCS) {
      const body = bodyOf(f);
      expect(body, `${f}: table_name must be TG_TABLE_NAME`).toContain('TG_TABLE_NAME');
      expect(body, `${f}: table name must not be hardcoded`).not.toContain("'plant_varieties'");
    }
  });
});

describe('OPS-VARAUDIT-001 — the recorded trail is unchanged', () => {
  it('V6 the UPDATE function is NOT column-scoped', () => {
    const body = bodyOf('audit_pv_stmt_update');
    expect(body, 'a TG_ARGV watched list would silently drop rows the trail has always held').not.toContain('TG_ARGV');
    expect(body, 'the sibling lane\'s watched-slice helper must not appear').not.toContain('audit_watched_slice');
    // A WHERE clause is the other way to scope. The SELECT must end at the FROM/JOIN.
    expect(body, 'no WHERE clause may filter which updated rows are audited').not.toMatch(/\bWHERE\b/);
  });

  it('V7 all five historical action values are still produced', () => {
    const all = FUNCS.map(bodyOf).join('\n');
    for (const action of ['INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE']) {
      expect(all, `${action} is in the existing trail and must still be written`).toContain(`'${action}'`);
    }
  });

  it('V8 the INSERT arm is present — 426 existing audit rows depend on it', () => {
    expect(SQL.b).toContain('AFTER INSERT ON public.plant_varieties');
    expect(SQL.b).toContain('EXECUTE FUNCTION public.audit_pv_stmt_insert()');
  });

  it('V9 the UPDATE trigger carries no arguments', () => {
    // A watched list would appear as arguments to the function in the CREATE TRIGGER.
    expect(SQL.b).toContain('EXECUTE FUNCTION public.audit_pv_stmt_update();');
  });

  it('V10 no trigger carries a WHEN clause', () => {
    expect(SQL.b, 'a WHEN clause filters rows before the function runs — scoping by another name')
      .not.toMatch(/\bWHEN\s*\(/);
  });
});

describe('OPS-VARAUDIT-001 — the swap', () => {
  it('V11 0b drops the old row-level trigger and creates exactly the three new ones', () => {
    expect(SQL.b).toContain('DROP TRIGGER IF EXISTS trg_audit_plant_varieties ON public.plant_varieties;');
    for (const t of TRIGGERS) expect(SQL.b, `0b must create ${t}`).toContain(`CREATE TRIGGER ${t}`);
    const creates = SQL.b.match(/CREATE TRIGGER/g) ?? [];
    expect(creates.length, '0b must create three triggers and no more').toBe(3);
  });

  it('V12 every new trigger is FOR EACH STATEMENT with the right transition tables', () => {
    for (const t of TRIGGERS) {
      const start = SQL.b.indexOf(`CREATE TRIGGER ${t}`);
      const def = SQL.b.slice(start, SQL.b.indexOf(';', start));
      expect(def, `${t} must be statement-level`).toContain('FOR EACH STATEMENT');
      expect(def, `${t} must not be row-level`).not.toContain('FOR EACH ROW');
      // Without a transition table a statement-level trigger sees no rows and writes nothing.
      if (t.endsWith('_ins')) {
        expect(def).toContain('REFERENCING NEW TABLE AS new_rows');
      } else if (t.endsWith('_del')) {
        expect(def).toContain('REFERENCING OLD TABLE AS old_rows');
      } else {
        expect(def).toContain('REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows');
      }
    }
  });

  it('V13 0b bounds its ACCESS EXCLUSIVE lock wait', () => {
    // Without lock_timeout the DROP queues behind any open transaction on plant_varieties and every
    // later statement — including plain SELECTs from the app — queues behind it.
    expect(SQL.b).toMatch(/SET LOCAL lock_timeout\s*=/);
  });

  it('V14 the swap is one transaction, so no window exists in which the table is unaudited', () => {
    const begin = SQL.b.indexOf('BEGIN;');
    const drop = SQL.b.indexOf('DROP TRIGGER IF EXISTS trg_audit_plant_varieties ON');
    const lastCreate = SQL.b.lastIndexOf('CREATE TRIGGER');
    const commit = SQL.b.indexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(drop, 'the DROP must be inside the transaction').toBeGreaterThan(begin);
    expect(lastCreate, 'every CREATE must precede the COMMIT').toBeLessThan(commit);
    expect(SQL.b.slice(begin, commit), 'no intermediate COMMIT may split the swap')
      .not.toMatch(/COMMIT;[\s\S]*CREATE TRIGGER/);
  });

  it('V15 0b does not drop the original function, which 0r re-attaches', () => {
    expect(SQL.b).not.toContain('DROP FUNCTION');
    expect(SQL.b).not.toContain('audit_plant_varieties_trigger');
  });

  it('V16 the function names do not collide with the sibling harvestaudit lane', () => {
    // Both bundles use CREATE OR REPLACE. A shared name means whichever applies second silently
    // rewrites the other lane's trigger bodies.
    for (const stolen of ['audit_stmt_delete', 'audit_stmt_update', 'audit_watched_slice']) {
      expect(SQL.a, `${stolen} belongs to OPS-HARVESTAUDIT-001`).not.toContain(`FUNCTION public.${stolen}`);
    }
  });
});

describe('OPS-VARAUDIT-001 — rollback completeness', () => {
  it('V17 0r drops every object 0a and 0b created, by name', () => {
    // Completeness per object, not ordering. An ordering-only assertion passes while a drop is
    // missing entirely, leaving an orphan and a false claim in the runbook.
    for (const t of TRIGGERS) expect(SQL.r, `0r must drop ${t}`).toContain(`DROP TRIGGER IF EXISTS ${t}`);
    for (const f of FUNCS) expect(SQL.r, `0r must drop ${f}`).toContain(`DROP FUNCTION IF EXISTS public.${f}()`);
  });

  it('V18 0r re-attaches the original row-level trigger', () => {
    expect(SQL.r).toContain('CREATE TRIGGER trg_audit_plant_varieties');
    expect(SQL.r).toContain('AFTER INSERT OR DELETE OR UPDATE ON public.plant_varieties');
    expect(SQL.r).toContain('FOR EACH ROW');
    expect(SQL.r).toContain('EXECUTE FUNCTION public.audit_plant_varieties_trigger()');
  });

  it('V19 0r drops triggers before functions', () => {
    expect(SQL.r.lastIndexOf('DROP TRIGGER')).toBeLessThan(SQL.r.indexOf('DROP FUNCTION'));
  });

  it('V20 0r removes both schema_version receipts', () => {
    expect(SQL.r).toContain("'4.38.0-varaudit-001'");
    expect(SQL.r).toContain("'4.38.0-varaudit-001-fn'");
  });
});

describe('OPS-VARAUDIT-001 — 0c is safe to run on prod', () => {
  it('V21 0c ends in ROLLBACK and never commits', () => {
    expect(SQL.c, '0c must not commit — it is runnable on prod').not.toContain('COMMIT;');
    expect(SQL.c.trim().endsWith('ROLLBACK;')).toBe(true);
  });

  it('V22 0c refuses to run against an unarmed database', () => {
    // Without the precondition, running 0c before 0b exercises the OLD trigger and reports success.
    expect(SQL.c).toContain('0c precondition');
    expect(SQL.c).toContain('trg_audit_plant_varieties_ins');
  });

  it('V23 0c proves the three safety properties, not just capture', () => {
    for (const marker of ['S1 PASS', 'S1b PASS', 'S2 PASS', 'S3 PASS']) {
      expect(RAW.c, `0c must assert ${marker}`).toContain(marker);
    }
    // Injecting a failure is what makes S1 non-vacuous; without it S1 asserts nothing.
    expect(SQL.c).toContain('_v0c_break');
  });

  it('V24 0c exercises the real production write path — the cultivar view', () => {
    expect(SQL.c, 'the Lambda writes public.cultivar, never the base table').toContain('UPDATE public.cultivar');
  });
});

describe('OPS-VARAUDIT-001 — gates.yml', () => {
  const post = GATES.post ?? [];
  const sweep = GATES.sweep ?? [];

  it('V25 every post gate is self-armed on a schema_version row', () => {
    // gate-invariants.yml runs post gates on every push to dev. A gate that is not self-armed goes
    // red the moment this branch lands and stays red until Dave applies the migration.
    for (const g of post) {
      expect(g.sql, `${g.name} is not self-armed`).toMatch(
        /schema_version WHERE version = '4\.38\.0-varaudit-001(-fn)?'/,
      );
    }
    expect(post.length).toBeGreaterThan(0);
  });

  it('V26 every post gate is violation-shaped', () => {
    // A bare `AND EXISTS (schema_version ...)` conjunct only self-arms correctly when the gate
    // expects ZERO rows. A presence-shaped gate self-armed the same way is simply always-failing.
    for (const g of post) {
      expect(g.expect, `${g.name}`).toBe('rowcount_eq');
      expect(g.value, `${g.name} must expect 0 rows to self-arm correctly`).toBe(0);
    }
  });

  it('V27 sweep gates are apply-window only', () => {
    for (const g of sweep) expect(g.continuous, `${g.name}`).toBe(false);
    expect(sweep.length).toBe(2);
  });

  it('V28 gate names are phase-anchored', () => {
    for (const phase of ['pre', 'sweep', 'post']) {
      for (const g of GATES[phase] ?? []) {
        expect(g.name, `${g.name} must start with ${phase}_`).toMatch(new RegExp(`^${phase}_`));
      }
    }
  });

  it('V29 the no-scoping decision is pinned by a gate, not only by prose', () => {
    const names = post.map((g) => g.name);
    expect(names).toContain('post_update_audit_is_not_column_scoped');
    expect(names).toContain('post_update_trigger_takes_no_watched_column_arguments');
    expect(names).toContain('post_audit_triggers_have_no_when_clause');
  });

  it('V30 the safety property is pinned per function, not in aggregate', () => {
    const g = post.find((x) => x.name === 'post_audit_functions_cannot_abort_the_write');
    expect(g).toBeDefined();
    // Selecting proname rather than a constant is what makes the gate report WHICH function lost
    // its handler, and what stops one healthy function covering for a broken one.
    expect(g.sql).toContain('SELECT p.proname');
    for (const f of FUNCS) expect(g.sql, `${f} must be named in the gate`).toContain(f);
  });

  it('V31 the pre phase states the defect it is fixing', () => {
    const g = (GATES.pre ?? []).find((x) => x.name === 'pre_live_audit_trigger_is_row_level_and_unguarded');
    expect(g, 'the defect must be gated, so it is confirmed live rather than asserted').toBeDefined();
    expect(g.value).toBe(1);
    expect(g.sql).toContain('tgtype & 1');
    expect(g.sql).toContain('EXCEPTION');
  });
});
