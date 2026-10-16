#!/usr/bin/env python3
"""rehearse_local.py -- v5-platformoperators-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, prod's schema_version and spaces rows as data, and
v5-spaceguard-001's 0a applied. The script never writes to --base-db: it clones it (CREATE DATABASE ... TEMPLATE)
and works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates -> all PASS; post gates before the apply -> all PASS (vacuous, and no 42P01 on the absent table)
   2. C-CONV before: --all --phase post --json over this tree's corpus
   3. 0a -> exit 0; post gates all PASS (receipt included); pre: exactly the two continuous:false receipts red
   4. C-CONV after; newly red = after - before -> empty
   5. behaviour (each in a rolled-back transaction): the seeded set = {the original Space's owner}, its INSERT audit
      row carries the migration actor; a planted second operator shows in audit_events with the actor that wrote
      it; UPDATE of clerk_user_id and of id refused (P0001); UPDATE of added_by audited with its actor, a same-value
      UPDATE not; DELETE audited; the user_ CHECK and the UNIQUE hold
   6. gate-level mutants on committed clones, each reds its gate: UPDATE audit bound to audit_stmt_update (and it
      audits nothing: 42703 WARNING), identity guard dropped, an extra trigger, the guard body edited, a watched
      column dropped, a deleted_at column, the UNIQUE dropped, a broken INSERT writer (a grant with no trail), the
      stamp deleted, the receipt with a planted second operator; the uuid-id gate on a planted audited table keyed by
      text and on one with a bigint id (and that table's UPDATE audits nothing)
   7. refusals: 0r with a non-seed grant; v5-spaceguard-001's 0r while this is applied; 0a without v5-spaceguard-001;
      0a with a name collision; 0a with the original Space ownerless (0 would be seeded) -> each refuses and changes
      nothing
   8. 0r -> exit 0, catalog fingerprint equal to step 1's, post gates vacuous; 0a twice more -> exit 0, catalog equal
      to step 3's, exactly one operator, the seed's INSERT audit row present for the current row

Usage:
  python3 migrations/v5-platformoperators-001/rehearse_local.py --port 55443 --base-db rh_base
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import psycopg
import yaml

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
STAMP = '5.1.5-platformoperators-001'
ACTOR = 'migration:v5-platformoperators-001'
SPACE = '00000000-0000-0000-0000-000000000001'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')

results = []


def check(label, ok, detail=''):
    results.append((bool(ok), label, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ''), flush=True)
    return ok


class Cluster:
    def __init__(self, port):
        self.port = str(port)

    def url(self, db):
        return f'postgresql://postgres@127.0.0.1:{self.port}/{db}'

    def admin(self, sql):
        with psycopg.connect(self.url('postgres'), autocommit=True) as c:
            c.execute(sql)

    def clone(self, src, dst):
        self.admin(f'DROP DATABASE IF EXISTS {dst}')
        self.admin(f'CREATE DATABASE {dst} TEMPLATE {src}')

    def drop(self, db):
        self.admin(f'DROP DATABASE IF EXISTS {db}')

    def psql_file(self, db, path):
        r = subprocess.run([PSQL, '-X', '-q', '-h', '127.0.0.1', '-p', self.port, '-U', 'postgres', '-d', db,
                            '-v', 'ON_ERROR_STOP=1', '-f', str(path)], capture_output=True, text=True)
        return r.returncode, (r.stderr or '').strip()

    def gates(self, db, migration=None, phase='post'):
        """Run this tree's gate_runner.py against `db`. Returns {(dir, phase, name): status}."""
        args = [sys.executable, str(TREE / 'scripts' / 'gate_runner.py')]
        args += ['--migration', str(migration)] if migration else ['--all']
        args += ['--env', 'prod', '--phase', phase, '--json']
        env = {**os.environ, 'NEON_DATABASE_URL': self.url(db)}
        r = subprocess.run(args, capture_output=True, text=True, env=env)
        if r.returncode not in (0, 1):
            raise SystemExit(f'gate_runner exit {r.returncode}: {r.stderr[-800:]}')
        return {(Path(g['path']).parent.name, g['phase'], g['name']): g['status'] for g in json.loads(r.stdout)}

    def red_after(self, db, ddl, migration=HERE):
        """Commit `ddl` on a clone of `db`; return the names of this directory's red post gates there."""
        self.clone(db, 'po_mut')
        with psycopg.connect(self.url('po_mut'), autocommit=True) as c:
            c.execute(ddl)
        red = {k[2] for k in bad(self.gates('po_mut', migration=migration))}
        self.drop('po_mut')
        return red


def bad(gates):
    return {k for k, v in gates.items() if v in ('FAIL', 'ERROR')}


def fingerprint(conn):
    """The catalog this migration could touch, as sorted text lines (data rows excluded, stamps included)."""
    q = """
    SELECT 'trigger ' || t.relname || '.' || g.tgname || ' ' || g.tgtype::text || ' ' || g.tgenabled::text || ' '
           || p.proname
      FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE n.nspname IN ('public', 'gv') AND NOT g.tgisinternal
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || coalesce(p.proconfig::text, '')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'gv')
    UNION ALL
    SELECT 'constraint ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '')
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'stamp ' || version FROM public.schema_version
    """
    return sorted(r[0] for r in conn.execute(q).fetchall())


GATES = yaml.safe_load((HERE / 'gates.yml').read_text())
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'post') for g in GATES.get(phase, [])}


def gate_rows(conn, name):
    """Run one of this directory's gates INSIDE the caller's transaction (sees uncommitted state)."""
    return conn.execute(GATE_SQL[name]).fetchall()


def err_of(conn, sql, params=None):
    """Run sql in a savepoint. Returns (sqlstate, message) of the error, or (None, '')."""
    try:
        with conn.transaction():
            conn.execute(sql, params)
    except psycopg.Error as e:
        return e.sqlstate, (e.diag.message_primary or '')
    return None, ''


def case(conn):
    """A transaction that is always rolled back."""
    return conn.transaction(force_rollback=True)


def audit(conn, op_id, action):
    return conn.execute("SELECT actor_clerk_sub, before_jsonb, after_jsonb FROM public.audit_events "
                        "WHERE table_name = 'platform_operators' AND row_id = %s AND action = %s ORDER BY ts",
                        (op_id, action)).fetchall()


def as_actor(conn, actor):
    conn.execute("SELECT set_config('app.actor_clerk_sub', %s, true)", (actor,))


def behaviour(conn):
    owner = conn.execute('SELECT created_by FROM public.spaces WHERE id = %s', (SPACE,)).fetchone()[0]
    ops = conn.execute('SELECT id, clerk_user_id, added_by FROM public.platform_operators').fetchall()
    check('1.16 seeded set = {created_by of the original Space}, added_by = the migration',
          [(o[1], o[2]) for o in ops] == [(owner, ACTOR)], f'{len(ops)} row(s)')
    seed_id = ops[0][0] if ops else None
    rows = audit(conn, seed_id, 'INSERT')
    check('1.16 the seed has one INSERT audit row, actor = the migration, after = the row',
          len(rows) == 1 and rows[0][0] == ACTOR and rows[0][2]['clerk_user_id'] == owner, str(len(rows)))

    # POSITIVE CONTROL: a planted second operator appears in its C-AUDIT trail with the actor.
    with case(conn):
        as_actor(conn, 'user_RehearsalActor1')
        op2 = conn.execute("INSERT INTO public.platform_operators (clerk_user_id, added_by) "
                           "VALUES ('user_RehearsalSecond', 'user_RehearsalActor1') RETURNING id").fetchone()[0]
        rows = audit(conn, op2, 'INSERT')
        check('1.16 planted second operator: one INSERT audit row with the actor and the row',
              len(rows) == 1 and rows[0][0] == 'user_RehearsalActor1' and rows[0][1] is None
              and rows[0][2]['clerk_user_id'] == 'user_RehearsalSecond', str(rows[:1]))
        check('1.16 planted second operator: the apply-window receipt reds (continuous: false by design)',
              len(gate_rows(conn, 'post_receipt_seeded_set_is_the_space_owner')) == 1)
        check('1.16 planted second operator: post_every_operator_has_its_insert_audit_row stays green',
              gate_rows(conn, 'post_every_operator_has_its_insert_audit_row') == [])

    with case(conn):
        st, msg = err_of(conn, "UPDATE public.platform_operators SET clerk_user_id = 'user_SomeoneElse' WHERE id = %s",
                         (seed_id,))
        check('1.16 UPDATE of clerk_user_id refused (P0001 platform_operators_identity_guard)',
              st == 'P0001' and 'platform_operators_identity_guard' in msg, f'{st} {msg[:80]}')
        st, msg = err_of(conn, 'UPDATE public.platform_operators SET id = gen_random_uuid() WHERE id = %s', (seed_id,))
        check('1.16 UPDATE of id refused (P0001)', st == 'P0001', f'{st} {msg[:80]}')
        st, _ = err_of(conn, 'UPDATE public.platform_operators SET clerk_user_id = clerk_user_id WHERE id = %s',
                       (seed_id,))
        check('1.16 a same-value SET of clerk_user_id is not a change and passes', st is None, str(st))

    with case(conn):
        as_actor(conn, 'user_RehearsalActor2')
        conn.execute("UPDATE public.platform_operators SET added_by = 'user_RehearsalActor2' WHERE id = %s", (seed_id,))
        rows = audit(conn, seed_id, 'UPDATE')
        check('1.16 UPDATE of added_by: one UPDATE audit row with the actor, before and after',
              len(rows) == 1 and rows[0][0] == 'user_RehearsalActor2' and rows[0][1]['added_by'] == ACTOR
              and rows[0][2]['added_by'] == 'user_RehearsalActor2', str(len(rows)))
    with case(conn):
        conn.execute('UPDATE public.platform_operators SET added_by = added_by WHERE id = %s', (seed_id,))
        check('1.16 same-value UPDATE: no audit row', audit(conn, seed_id, 'UPDATE') == [])

    with case(conn):
        as_actor(conn, 'user_RehearsalActor3')
        conn.execute('DELETE FROM public.platform_operators WHERE id = %s', (seed_id,))
        rows = audit(conn, seed_id, 'DELETE')
        check('1.16 DELETE (the hard delete a grant removal is): one DELETE audit row with the actor and the row',
              len(rows) == 1 and rows[0][0] == 'user_RehearsalActor3' and rows[0][1]['clerk_user_id'] == owner
              and rows[0][2] is None, str(len(rows)))

    with case(conn):
        st, _ = err_of(conn, "INSERT INTO public.platform_operators (clerk_user_id, added_by) VALUES ('dave', 'x')")
        check('1.16 a clerk_user_id that is not user_... refused (23514)', st == '23514', str(st))
        st, _ = err_of(conn, "INSERT INTO public.platform_operators (clerk_user_id, added_by) "
                             "SELECT created_by, 'x' FROM public.spaces WHERE id = %s", (SPACE,))
        check('1.16 a second grant for the same person refused (23505)', st == '23505', str(st))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--base-db', required=True, help='prod-shaped replica with v5-spaceguard-001 0a applied')
    ap.add_argument('--keep', action='store_true', help='leave the clones in place')
    a = ap.parse_args()
    cl = Cluster(a.port)
    main_db, mig, a0 = 'po_main', HERE, HERE / '0a-platform-operators.sql'

    cl.clone(a.base_db, main_db)
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp0 = fingerprint(c)

    pre = cl.gates(main_db, migration=mig, phase='pre')
    check('step 1 pre gates all PASS', bad(pre) == set() and len(pre) == len(GATES['pre']), f'{len(pre)} gates')
    post0 = cl.gates(main_db, migration=mig, phase='post')
    check('step 1 post gates before the apply: none red, none ERROR (vacuous)', bad(post0) == set(),
          f'{len(post0)} gates {sorted(bad(post0))}')

    before = cl.gates(main_db)

    rc, err = cl.psql_file(main_db, a0)
    check('step 3 0a applies, exit 0', rc == 0, err[-200:])
    post1 = cl.gates(main_db, migration=mig, phase='post')
    check('step 3 post gates all PASS after the apply (receipt included)', bad(post1) == set(), str(sorted(bad(post1))))
    pre1 = cl.gates(main_db, migration=mig, phase='pre')
    check('step 3 pre gates after the apply: exactly the two continuous:false receipts red',
          {k[2] for k in bad(pre1)} == {'pre_not_already_applied', 'pre_names_free'}, str(sorted(bad(pre1))))

    after = cl.gates(main_db)
    newly = sorted('/'.join(x) for x in bad(after) - bad(before))
    cleared = sorted('/'.join(x) for x in bad(before) - bad(after))
    check('step 4 C-CONV: newly red after the DDL = {}', newly == [],
          f'gates={len(after)} before_red={len(bad(before))} after_red={len(bad(after))} newly={newly} '
          f'cleared={cleared}')

    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp1 = fingerprint(c)
        behaviour(c)
        check('step 5 cases left the applied replica unchanged', fingerprint(c) == fp1)

    # Step 6: gate-level reds, each on a committed clone.
    upd_bound_wrong = ("DROP TRIGGER trg_audit_platform_operators_upd ON public.platform_operators; "
                       "CREATE TRIGGER trg_audit_platform_operators_upd AFTER UPDATE ON public.platform_operators "
                       "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "
                       "public.audit_stmt_update('clerk_user_id', 'added_by')")
    for label, ddl, gate in [
        ('UPDATE audit bound to audit_stmt_update', upd_bound_wrong,
         'post_platform_operators_triggers_exact_and_enabled'),
        ('identity guard dropped', 'DROP TRIGGER platform_operators_identity_guard ON public.platform_operators',
         'post_platform_operators_triggers_exact_and_enabled'),
        ('identity guard disabled', 'ALTER TABLE public.platform_operators DISABLE TRIGGER platform_operators_identity_guard',
         'post_platform_operators_triggers_exact_and_enabled'),
        ('an extra trigger', 'CREATE TRIGGER rh_extra BEFORE INSERT ON public.platform_operators FOR EACH ROW '
         'EXECUTE FUNCTION public.guard_platform_operators_identity()', 'post_platform_operators_has_no_other_trigger'),
        ('INSERT audit without its transition table',
         'DROP TRIGGER trg_audit_platform_operators_ins ON public.platform_operators; CREATE TRIGGER '
         'trg_audit_platform_operators_ins AFTER INSERT ON public.platform_operators FOR EACH STATEMENT EXECUTE '
         'FUNCTION public.audit_stmt_insert()', 'post_platform_operators_audit_triggers_have_transition_tables'),
        ('guard body edited', "CREATE OR REPLACE FUNCTION public.guard_platform_operators_identity() RETURNS trigger "
         "LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public' AS $$ BEGIN RETURN NEW; END; $$",
         'post_identity_guard_pinned'),
        ('added_by dropped from the watched list',
         "DROP TRIGGER trg_audit_platform_operators_upd ON public.platform_operators; CREATE TRIGGER "
         "trg_audit_platform_operators_upd AFTER UPDATE ON public.platform_operators REFERENCING OLD TABLE AS old_rows "
         "NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete("
         "'clerk_user_id')", 'post_platform_operators_column_classification_is_complete'),
        ('a typo in the watched list',
         "DROP TRIGGER trg_audit_platform_operators_upd ON public.platform_operators; CREATE TRIGGER "
         "trg_audit_platform_operators_upd AFTER UPDATE ON public.platform_operators REFERENCING OLD TABLE AS old_rows "
         "NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete("
         "'clerk_user_id', 'added_by', 'adedd_by')", 'post_platform_operators_column_classification_is_complete'),
        ('a deleted_at column added', 'ALTER TABLE public.platform_operators ADD COLUMN deleted_at timestamptz',
         'post_platform_operators_columns_exact'),
        ('the UNIQUE dropped', 'ALTER TABLE public.platform_operators DROP CONSTRAINT platform_operators_clerk_user_id_key',
         'post_platform_operators_constraints_exact'),
        ('the user_ CHECK dropped', 'ALTER TABLE public.platform_operators DROP CONSTRAINT '
         'chk_platform_operators_clerk_user_id_shape', 'post_platform_operators_constraints_exact'),
        ('a grant written while the INSERT audit was off',
         "ALTER TABLE public.platform_operators DISABLE TRIGGER trg_audit_platform_operators_ins; "
         "INSERT INTO public.platform_operators (clerk_user_id, added_by) VALUES ('user_NoTrail', 'user_X'); "
         "ALTER TABLE public.platform_operators ENABLE TRIGGER trg_audit_platform_operators_ins",
         'post_every_operator_has_its_insert_audit_row'),
        ('the seed INSERT audit row deleted', "DELETE FROM public.audit_events WHERE table_name = 'platform_operators'",
         'post_every_operator_has_its_insert_audit_row'),
        ('stamp deleted with the objects in place', f"DELETE FROM public.schema_version WHERE version = '{STAMP}'",
         'post_schema_version_recorded'),
    ]:
        red = cl.red_after(main_db, ddl)
        check(f'step 6 MUTANT {label}: {gate} reds', gate in red, str(sorted(red)))

    # The receipt is continuous: false because a later grant makes it false; shown red at gate level too.
    cl.clone(main_db, 'po_mut')
    with psycopg.connect(cl.url('po_mut'), autocommit=True) as c:
        c.execute("INSERT INTO public.platform_operators (clerk_user_id, added_by) VALUES ('user_Second', 'user_X')")
    g = cl.gates('po_mut', migration=mig)
    check('step 6 receipt reds on a planted second operator; every continuous gate stays green',
          {k[2] for k in bad(g)} == {'post_receipt_seeded_set_is_the_space_owner'}, str(sorted(bad(g))))
    cl.drop('po_mut')

    # The new uuid-id gate (DSA BLOCKING): a planted audited table without a uuid id reds it.
    for label, ddl in [
        ('a text-keyed table with an UPDATE audit trigger',
         "CREATE TABLE public.rh_textkey (slug text PRIMARY KEY, label text); "
         "CREATE TRIGGER trg_audit_rh_textkey_upd AFTER UPDATE ON public.rh_textkey REFERENCING OLD TABLE AS old_rows "
         "NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update_no_soft_delete('label')"),
        ('a bigint id with an INSERT audit trigger',
         "CREATE TABLE public.rh_bigid (id bigint PRIMARY KEY); "
         "CREATE TRIGGER trg_audit_rh_bigid_ins AFTER INSERT ON public.rh_bigid REFERENCING NEW TABLE AS new_rows "
         "FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert()"),
        ('a nullable uuid id with a DELETE audit trigger',
         "CREATE TABLE public.rh_nullid (id uuid, x int); "
         "CREATE TRIGGER trg_audit_rh_nullid_del AFTER DELETE ON public.rh_nullid REFERENCING OLD TABLE AS old_rows "
         "FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_delete()"),
    ]:
        red = cl.red_after(main_db, ddl)
        check(f'step 6 uuid-id gate MUTANT {label}: post_audited_tables_have_a_uuid_id reds',
              'post_audited_tables_have_a_uuid_id' in red, str(sorted(red)))
    cl.clone(main_db, 'po_mut')
    with psycopg.connect(cl.url('po_mut'), autocommit=True) as c:
        c.execute("CREATE TABLE public.rh_textkey (slug text PRIMARY KEY, label text)")
        c.execute("CREATE TRIGGER trg_audit_rh_textkey_upd AFTER UPDATE ON public.rh_textkey REFERENCING OLD TABLE AS "
                  "old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "
                  "public.audit_stmt_update_no_soft_delete('label')")
        c.execute("INSERT INTO public.rh_textkey VALUES ('a', 'one')")
        notices = []
        c.add_notice_handler(lambda d: notices.append(d.message_primary or ''))
        c.execute("UPDATE public.rh_textkey SET label = 'two'")
        n = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'rh_textkey'").fetchone()[0]
        check('step 6 why: that text-keyed table looks audited and records nothing (0 rows, 42703 WARNING)',
              n == 0 and any('42703' in m for m in notices), f'rows={n} {notices[:1]}')
        # And the mutant UPDATE writer on platform_operators audits nothing the same way.
        c.execute(upd_bound_wrong)
        notices.clear()
        c.execute("UPDATE public.platform_operators SET added_by = 'user_Y'")
        n = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'platform_operators' "
                      "AND action = 'UPDATE'").fetchone()[0]
        check('step 6 why: the audit_stmt_update-bound mutant audits nothing on this table (0 rows, 42703 WARNING)',
              n == 0 and any('42703' in m for m in notices), f'rows={n} {notices[:1]}')
    cl.drop('po_mut')

    # Step 7: refusals, each changing nothing.
    cl.clone(main_db, 'po_ref')
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        c.execute("INSERT INTO public.platform_operators (clerk_user_id, added_by) VALUES ('user_Later', 'user_X')")
        fpr = fingerprint(c)
    rc, err = cl.psql_file('po_ref', HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        check('step 7 0r REFUSES while a grant made after the seed exists, nothing dropped',
              rc != 0 and 'made after the seed' in err and fingerprint(c) == fpr, err[-140:])
    rc, err = cl.psql_file('po_ref', TREE / 'migrations' / 'v5-spaceguard-001' / '0r-rollback.sql')
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        check('step 7 v5-spaceguard-001 0r REFUSES while trg_audit_platform_operators_ins calls audit_stmt_insert '
              '(Phase 1 0r order M3 -> M2 -> M1), nothing dropped',
              rc != 0 and 'trg_audit_platform_operators_ins' in err and fingerprint(c) == fpr, err[-160:])
    cl.drop('po_ref')

    cl.clone(a.base_db, 'po_ref')
    rc, err = cl.psql_file('po_ref', TREE / 'migrations' / 'v5-spaceguard-001' / '0r-rollback.sql')
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        fpr = fingerprint(c)
    rc2, err2 = cl.psql_file('po_ref', a0)
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        check('step 7 0a REFUSES without v5-spaceguard-001, nothing changed',
              rc == 0 and rc2 != 0 and 'v5-spaceguard-001 is not applied' in err2 and fingerprint(c) == fpr,
              err2[-140:])
    cl.drop('po_ref')

    for label, ddl, needle in [
        ('a name it does not own (platform_operators without the stamp)',
         'CREATE TABLE public.platform_operators (clerk_user_id text PRIMARY KEY)', 'relation platform_operators'),
        ('the original Space ownerless: 0 rows would be seeded',
         "SET session_replication_role = replica; UPDATE public.spaces SET created_by = NULL "
         f"WHERE id = '{SPACE}'; SET session_replication_role = origin", 'absent or its created_by'),
        ('the original Space absent: 0 rows would be seeded',
         "SET session_replication_role = replica; UPDATE public.photos SET space_id = NULL "
         f"WHERE space_id = '{SPACE}'; DELETE FROM public.spaces WHERE id = '{SPACE}'; "
         "SET session_replication_role = origin", 'absent or its created_by'),
    ]:
        cl.clone(a.base_db, 'po_ref')
        with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
            c.execute(ddl)
            fpr = fingerprint(c)
        rc, err = cl.psql_file('po_ref', a0)
        with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
            check(f'step 7 0a REFUSES on {label}, nothing changed', rc != 0 and needle in err and fingerprint(c) == fpr,
                  err[-140:])
        cl.drop('po_ref')

    # The seed's own count assertion (step 3 of 0a), with step 0's source check cut out of a scratch copy of 0a:
    # the original Space absent, the INSERT ... SELECT writes 0 rows, and 0a still refuses.
    src = a0.read_text()
    cut_from = src.index("  -- The seed's source, on the first apply")
    cut_to = src.index('END $$;', cut_from)
    mutant = Path(os.environ.get('TMPDIR', '/tmp')) / 'rh_po_0a_no_source_check.sql'
    mutant.write_text(src[:cut_from] + src[cut_to:])
    cl.clone(a.base_db, 'po_ref')
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        c.execute("SET session_replication_role = replica")
        c.execute(f"UPDATE public.photos SET space_id = NULL WHERE space_id = '{SPACE}'")
        c.execute(f"DELETE FROM public.spaces WHERE id = '{SPACE}'")
        c.execute("SET session_replication_role = origin")
        fpr = fingerprint(c)
    rc, err = cl.psql_file('po_ref', mutant)
    with psycopg.connect(cl.url('po_ref'), autocommit=True) as c:
        check('step 7 0a with step 0 cut out: the seed wrote 0 rows and 0a REFUSES (exactly 1 required), nothing changed',
              rc != 0 and 'the seed wrote 0 row(s), expected exactly 1' in err and fingerprint(c) == fpr, err[-140:])
    cl.drop('po_ref')
    mutant.unlink()

    # Step 8: 0r, then 0a twice.
    rc, err = cl.psql_file(main_db, HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp_r = fingerprint(c)
        left = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'platform_operators'").fetchone()[0]
    check('step 8 0r exit 0; catalog identical to before the apply; audit history kept',
          rc == 0 and fp_r == fp0 and left >= 1, f'{err[-120:]} diff={sorted(set(fp_r) ^ set(fp0))[:6]} audit={left}')
    post_r = cl.gates(main_db, migration=mig, phase='post')
    check('step 8 post gates after 0r: none red, none ERROR (vacuous again)', bad(post_r) == set(),
          str(sorted(bad(post_r))))
    rc, err = cl.psql_file(main_db, HERE / '0r-rollback.sql')
    check('step 8 0r again: a no-op, exit 0', rc == 0, err[-120:])
    for i in (1, 2):
        rc, err = cl.psql_file(main_db, a0)
        with psycopg.connect(cl.url(main_db), autocommit=True) as c:
            fp = fingerprint(c)
            n_ops = c.execute('SELECT count(*) FROM public.platform_operators').fetchone()[0]
        post = cl.gates(main_db, migration=mig, phase='post')
        check(f'step 8 re-apply #{i}: exit 0, catalog = first apply, one operator, every post gate green',
              rc == 0 and fp == fp1 and n_ops == 1 and bad(post) == set(),
              f'{err[-100:]} ops={n_ops} red={sorted(bad(post))}')

    if not a.keep:
        cl.drop(main_db)
    n_fail = sum(1 for ok, _, _ in results if not ok)
    print(f'\n{len(results) - n_fail}/{len(results)} PASS' + (f', {n_fail} FAIL' if n_fail else ''))
    return 1 if n_fail else 0


if __name__ == '__main__':
    sys.exit(main())
