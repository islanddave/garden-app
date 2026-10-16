#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenantgates-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, prod's schema_version and spaces rows as data, the photo parent graph
(photos, plants, plant_projects, and the event_log rows photos point at) as data, and v5-spaceguard-001's 0a applied.
And v5-spacefk-001's SQL (--m2-dir; defaults to migrations/v5-spacefk-001 once it is in the tree). The script never
writes to --base-db: it clones it and works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates -> all PASS; post gates before the apply -> all PASS (vacuous); sweep records read the pre-fold
      buckets (7 conflicts on prod's graph)
   2. C-CONV before: --all --phase post --json over this tree's corpus
   3. 0a -> exit 0; post gates all PASS, post_photo_tenancy_no_conflict included although the graph holds 7
      conflicts (1.11 is vacuous without the fold stamp); pre: exactly the continuous:false receipt red
   4. C-CONV after; newly red = after - before -> empty
   5. 1.17 on committed clones, through gate_runner: a second Space reds; the same with a phase7-approved-* row is
      green; a NULL-owner Space reds and the approval turns it green; the original Space deleted reds and the approval
      does not help; the original Space ownerless reds. v4-spaceowner's two gates red alongside where expected.
   6. 1.14: a planted function calling gv.sentinel_workspace() reds; one holding the literal reds; an overload of the
      listed function reds; the listed function rewritten without the call reds (stale entry); the definer edited
      reds; each green again when removed
   7. 1.11: the fold stamp alone (no fold) reds with the 7 pre-fold conflicts; v5-spacefk-001's real 0a-fold.sql makes
      the same graph green (0 conflicts, buckets unchanged); a planted two-parent photo on the folded graph reds
      (two shapes); the full v5-spacefk-001 0a-0d leaves it green
   8. refusals: 0a with a second Space, with an unlisted caller, with a stale entry, with the fold stamp and the
      unfolded graph -> each refuses and changes nothing
   9. 0r -> exit 0, catalog fingerprint equal to step 1's, post vacuous; 0r again a no-op; 0a twice -> exit 0, same
      catalog as step 3
  10. the Phase 1 order end to end on one clone: v5-spacefk-001 0a-0d, v5-platformoperators-001 0a, this 0a -> every
      post gate of all four directories green; C-CONV newly red {}; rollback in order M3 -> M2 -> M1 (both M3 0r,
      then v5-spacefk-001's, then v5-spaceguard-001's) -> each exit 0, the catalog back to a pre-M1 clone's; the wrong
      order (v5-spaceguard-001's 0r first) refuses

Usage:
  python3 migrations/v5-tenantgates-001/rehearse_local.py --port 55443 --base-db rh_base [--m2-dir <dir>]
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg
import yaml

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
STAMP = '5.1.5-tenantgates-001'
FOLD = '5.1.5-spacefk-001-fold'
SPACE = '00000000-0000-0000-0000-000000000001'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
SPACEGUARD = TREE / 'migrations' / 'v5-spaceguard-001'
PLATFORMOPS = TREE / 'migrations' / 'v5-platformoperators-001'
SPACEOWNER = TREE / 'migrations' / 'v4-spaceowner'

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
        """Run this tree's gate_runner.py against `db`. Returns {(dir, phase, name): (status, detail)}."""
        args = [sys.executable, str(TREE / 'scripts' / 'gate_runner.py')]
        args += ['--migration', str(migration)] if migration else ['--all']
        args += ['--env', 'prod', '--phase', phase, '--json']
        env = {**os.environ, 'NEON_DATABASE_URL': self.url(db)}
        r = subprocess.run(args, capture_output=True, text=True, env=env)
        if r.returncode not in (0, 1) or not r.stdout.strip():
            raise SystemExit(f'gate_runner exit {r.returncode}: {(r.stderr or r.stdout)[-800:]}')
        return {(Path(g['path']).parent.name, g['phase'], g['name']): (g['status'], g.get('detail', ''))
                for g in json.loads(r.stdout)}

    def committed(self, src, ddl, dst='tg_mut'):
        self.clone(src, dst)
        with psycopg.connect(self.url(dst), autocommit=True) as c:
            for stmt in ddl if isinstance(ddl, list) else [ddl]:
                c.execute(stmt)
        return dst


def bad(gates):
    return {k for k, v in gates.items() if v[0] in ('FAIL', 'ERROR')}


def red_names(gates):
    return {k[2] for k in bad(gates)}


def got(gates, name):
    """The row count gate_runner reported for one gate (its detail ends 'got rowcount=N')."""
    for k, v in gates.items():
        if k[2] == name:
            m = re.search(r'rowcount=(\d+)', v[1] or '')
            return int(m.group(1)) if m else None
    return None


def fingerprint(conn):
    """The catalog the four Phase 1 directories could touch, as sorted text lines (stamps included)."""
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
    SELECT 'constraint ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) || ' '
           || c.convalidated::text
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
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'sweep', 'post') for g in GATES.get(phase, [])}


def rows(conn, name):
    return conn.execute(GATE_SQL[name]).fetchall()


def buckets(conn):
    return {n: len(rows(conn, f'sweep_record_photo_tenancy_{n}'))
            for n in ('conflicts', 'person_bound', 'location_only', 'unresolved')} | {
        'resolved': sum(r[1] for r in rows(conn, 'sweep_record_photo_tenancy_resolved_per_space'))}


def a_project(conn, workspace=SPACE):
    return conn.execute('SELECT id FROM public.plant_projects WHERE workspace_id = %s AND deleted_at IS NULL '
                        'ORDER BY id LIMIT 1', (workspace,)).fetchone()[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--base-db', required=True, help='prod-shaped replica with v5-spaceguard-001 0a applied')
    ap.add_argument('--m2-dir', default=str(TREE / 'migrations' / 'v5-spacefk-001'),
                    help="v5-spacefk-001's files (0a-fold.sql .. 0d-validate.sql, 0r-rollback.sql, gates.yml)")
    ap.add_argument('--keep', action='store_true', help='leave the clones in place')
    a = ap.parse_args()
    m2 = Path(a.m2_dir)
    m2_files = ('0a-fold.sql', '0b-fk-plants.sql', '0c-fk-plant-projects.sql', '0d-validate.sql', '0r-rollback.sql',
                'gates.yml')
    missing = [f for f in m2_files if not (m2 / f).exists()]
    if missing:
        raise SystemExit(f'v5-spacefk-001 file(s) {missing} not at {m2} '
                         '(git show t3-ms1-m2:migrations/v5-spacefk-001/<file>)')
    cl = Cluster(a.port)
    main_db, mig, a0, r0 = 'tg_main', HERE, HERE / '0a-tenantgates.sql', HERE / '0r-rollback.sql'

    cl.clone(a.base_db, main_db)
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp0 = fingerprint(c)
        b0 = buckets(c)
    check('step 1 sweep records on the pre-fold graph: 7 conflicts, 331 person_bound, 156 location_only, '
          '0 unresolved, 1584 resolved (prod 2026-10-16)',
          b0 == {'conflicts': 7, 'person_bound': 331, 'location_only': 156, 'unresolved': 0, 'resolved': 1584}, str(b0))

    pre = cl.gates(main_db, migration=mig, phase='pre')
    check('step 1 pre gates all PASS', bad(pre) == set() and len(pre) == len(GATES['pre']), f'{len(pre)} gates')
    sweep = cl.gates(main_db, migration=mig, phase='sweep')
    check('step 1 sweep records all PASS (records never red); conflicts record reads 7',
          bad(sweep) == set() and got(sweep, 'sweep_record_photo_tenancy_conflicts') == 7,
          f"conflicts={got(sweep, 'sweep_record_photo_tenancy_conflicts')}")
    post0 = cl.gates(main_db, migration=mig, phase='post')
    check('step 1 post gates before the apply: none red (vacuous)', bad(post0) == set(), str(sorted(bad(post0))))

    before = cl.gates(main_db)
    rc, err = cl.psql_file(main_db, a0)
    check('step 3 0a applies, exit 0', rc == 0, err[-200:])
    post1 = cl.gates(main_db, migration=mig, phase='post')
    check('step 3 post gates all PASS after the apply; 1.11 vacuous without the fold stamp although the graph holds '
          '7 conflicts', bad(post1) == set() and got(post1, 'post_photo_tenancy_no_conflict') == 0,
          str(sorted(bad(post1))))
    pre1 = cl.gates(main_db, migration=mig, phase='pre')
    check('step 3 pre gates after the apply: exactly the continuous:false receipt red',
          red_names(pre1) == {'pre_not_already_applied'}, str(sorted(red_names(pre1))))
    after = cl.gates(main_db)
    newly = sorted('/'.join(x) for x in bad(after) - bad(before))
    cleared = sorted('/'.join(x) for x in bad(before) - bad(after))
    check('step 4 C-CONV: newly red after the stamp = {}', newly == [],
          f'gates={len(after)} before_red={len(bad(before))} after_red={len(bad(after))} newly={newly} '
          f'cleared={cleared}')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp1 = fingerprint(c)

    # ── step 5: 1.17 ──────────────────────────────────────────────────────────────────────────────
    G17 = 'post_no_second_owner_until_approved'
    approve = "INSERT INTO public.schema_version (version, description) VALUES ('phase7-approved-rehearsal', 'rehearsal')"
    detach = [f"UPDATE public.photos SET space_id = NULL WHERE space_id = '{SPACE}'"] + [
        f"DELETE FROM public.{t} WHERE space_id = '{SPACE}'" for t in ('weather_daily', 'weather_cold_range', 'spacetheme')]
    for label, ddl, want_red, want_red_approved, v4_red in [
        ('a second Space owned by someone else',
         "INSERT INTO public.spaces (name, created_by) VALUES ('rh second', 'user_RehearsalOther')", True, False, set()),
        ('a second Space owned by the same person',
         f"INSERT INTO public.spaces (name, created_by) SELECT 'rh second', created_by FROM public.spaces "
         f"WHERE id = '{SPACE}'", True, False, set()),
        ('a NULL-owner Space', "INSERT INTO public.spaces (name, created_by) VALUES ('rh ownerless', NULL)",
         True, False, {'no_space_left_without_an_owner'}),
        ('the original Space deleted (children detached first; through spaces_delete_guard)',
         detach + [f"DELETE FROM public.spaces WHERE id = '{SPACE}'"], True, True,
         {'sentinel_space_owned_by_expected_sub'}),
        ('the original Space ownerless (owner trigger bypassed)',
         ["SET session_replication_role = replica", f"UPDATE public.spaces SET created_by = NULL WHERE id = '{SPACE}'",
          "SET session_replication_role = origin"], True, True,
         {'no_space_left_without_an_owner', 'sentinel_space_owned_by_expected_sub'}),
    ]:
        db = cl.committed(main_db, ddl)
        g = cl.gates(db, migration=mig)
        v4 = red_names(cl.gates(db, migration=SPACEOWNER))
        check(f'step 5 1.17 {label}: {G17} {"reds" if want_red else "green"}; v4-spaceowner red = {sorted(v4_red) or "{}"}',
              (G17 in red_names(g)) == want_red and red_names(g) <= {G17} and v4 == v4_red,
              f'red={sorted(red_names(g))} v4={sorted(v4)}')
        with psycopg.connect(cl.url(db), autocommit=True) as c:
            c.execute(approve)
        g = cl.gates(db, migration=mig)
        check(f'step 5 1.17 {label} + a phase7-approved-* row: {G17} {"still reds" if want_red_approved else "green"}',
              (G17 in red_names(g)) == want_red_approved, str(sorted(red_names(g))))
        cl.drop(db)

    # ── step 6: 1.14 ──────────────────────────────────────────────────────────────────────────────
    G14 = 'post_sentinel_callers'
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        cultivar_def = c.execute("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON "
                                 "n.oid = p.pronamespace WHERE n.nspname = 'gv' AND p.proname = 'entity_cultivar_ins'"
                                 ).fetchone()[0]
        definer_def = c.execute("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON "
                                "n.oid = p.pronamespace WHERE n.nspname = 'gv' AND p.proname = 'sentinel_workspace'"
                                ).fetchone()[0]
    no_call = cultivar_def.replace('gv.sentinel_workspace()', "'00000000-0000-0000-0000-00000000000f'::uuid")
    edited_definer = definer_def.replace('$function$', '$function$ ', 1)
    for label, ddl, finding in [
        ('a planted function calling gv.sentinel_workspace()',
         "CREATE FUNCTION public.rh_caller() RETURNS uuid LANGUAGE sql AS $$ SELECT gv.sentinel_workspace() $$",
         'unlisted caller public.rh_caller'),
        ('a planted function holding the original Space id',
         f"CREATE FUNCTION public.rh_literal() RETURNS uuid LANGUAGE sql AS $$ SELECT '{SPACE}'::uuid $$",
         'unlisted caller public.rh_literal'),
        ('an overload of the listed function calling it',
         "CREATE FUNCTION gv.entity_cultivar_ins(x int) RETURNS uuid LANGUAGE sql AS $$ SELECT gv.sentinel_workspace() $$",
         'unlisted caller gv.entity_cultivar_ins'),
        ('the listed function rewritten without the call (stale entry)', no_call, 'stale entry gv.entity_cultivar_ins'),
        ('the excluded definer edited', edited_definer, 'excluded definer'),
    ]:
        db = cl.committed(main_db, ddl)
        g = cl.gates(db, migration=mig)
        with psycopg.connect(cl.url(db), autocommit=True) as c:
            found = [r[0] for r in rows(c, G14)]
        check(f'step 6 1.14 {label}: {G14} reds naming it', red_names(g) == {G14} and any(finding in f for f in found),
              f'red={sorted(red_names(g))} rows={found}')
        cl.drop(db)
    check('step 6 1.14 the unplanted replica: post_sentinel_callers green', G14 not in red_names(post1))

    # ── step 7: 1.11 ──────────────────────────────────────────────────────────────────────────────
    G11 = 'post_photo_tenancy_no_conflict'
    stamp_only = f"INSERT INTO public.schema_version (version, description) VALUES ('{FOLD}', 'rehearsal: stamp only')"
    db = cl.committed(main_db, stamp_only)
    g = cl.gates(db, migration=mig)
    check('step 7 1.11 the fold stamp without the fold: reds with the 7 pre-fold two-parent conflicts',
          red_names(g) == {G11} and got(g, G11) == 7, f'red={sorted(red_names(g))} rows={got(g, G11)}')
    cl.drop(db)

    cl.clone(main_db, 'tg_fold')
    rc, err = cl.psql_file('tg_fold', m2 / '0a-fold.sql')
    with psycopg.connect(cl.url('tg_fold'), autocommit=True) as c:
        b1 = buckets(c)
    g = cl.gates('tg_fold', migration=mig)
    check("step 7 1.11 v5-spacefk-001's real 0a-fold.sql: exit 0, stamp armed, the gate green on the folded graph",
          rc == 0 and bad(g) == set() and got(g, G11) == 0, f'{err[-120:]} red={sorted(bad(g))}')
    check('step 7 1.11 folded graph: 0 conflicts, the 7 now resolved, buckets otherwise unchanged',
          b1 == {**b0, 'conflicts': 0, 'resolved': b0['resolved'] + 7}, str(b1))

    with psycopg.connect(cl.url('tg_fold'), autocommit=True) as c:
        proj = a_project(c)
    for label, ddl in [
        ('a photo on a project in the original Space and on a second Space (space_id)',
         ["INSERT INTO public.spaces (id, name, created_by) VALUES ('5eed0000-0000-4000-8000-000000000002', 'rh two', "
          "'user_RehearsalOther')",
          f"INSERT INTO public.photos (storage_path, created_by, project_id, space_id) VALUES ('rh/two-parent-a', "
          f"'user_RehearsalOther', '{proj}', '5eed0000-0000-4000-8000-000000000002')"]),
        ('a photo on a project in the original Space and on a planting in a second Space',
         ["INSERT INTO public.spaces (id, name, created_by) VALUES ('5eed0000-0000-4000-8000-000000000002', 'rh two', "
          "'user_RehearsalOther')",
          f"INSERT INTO public.plants (id, name, created_by, project_id, workspace_id) VALUES "
          f"('5eed0000-0000-4000-8000-0000000000a1', 'rh other planting', 'user_RehearsalOther', '{proj}', "
          f"'5eed0000-0000-4000-8000-000000000002')",
          f"INSERT INTO public.photos (storage_path, created_by, plant_id, project_id) VALUES ('rh/two-parent-b', "
          f"'user_RehearsalOther', '5eed0000-0000-4000-8000-0000000000a1', '{proj}')"]),
    ]:
        db = cl.committed('tg_fold', ddl)
        g = cl.gates(db, migration=mig)
        check(f'step 7 1.11 two-parent MUTANT on the folded graph, {label}: {G11} reds (1 photo)',
              G11 in red_names(g) and got(g, G11) == 1, f'red={sorted(red_names(g))} rows={got(g, G11)}')
        cl.drop(db)
    g = cl.gates('tg_fold', migration=mig)
    check('step 7 1.11 mutants removed (clones dropped): green again', bad(g) == set())

    rcs = [cl.psql_file('tg_fold', m2 / f)[0] for f in ('0b-fk-plants.sql', '0c-fk-plant-projects.sql', '0d-validate.sql')]
    g = cl.gates('tg_fold', migration=mig)
    g2 = cl.gates('tg_fold', migration=m2)
    check('step 7 1.11 with the rest of v5-spacefk-001 (0b-0d): exit 0 each; this directory and v5-spacefk-001 post green',
          rcs == [0, 0, 0] and bad(g) == set() and bad(g2) == set(), f'rcs={rcs} red={sorted(bad(g) | bad(g2))}')
    cl.drop('tg_fold')

    # ── step 8: 0a refusals ───────────────────────────────────────────────────────────────────────
    for label, ddl, needle in [
        ('a second Space', "INSERT INTO public.spaces (name, created_by) VALUES ('rh second', 'user_RehearsalOther')",
         'would red post_no_second_owner_until_approved'),
        ('an unlisted sentinel caller',
         "CREATE FUNCTION public.rh_caller() RETURNS uuid LANGUAGE sql AS $$ SELECT gv.sentinel_workspace() $$",
         'unlisted sentinel caller(s) public.rh_caller'),
        ('a stale list entry', no_call, 'no longer holds the id or calls'),
        ('the fold stamp with the unfolded graph', stamp_only, 'have parents in two workspaces'),
    ]:
        db = cl.committed(a.base_db, ddl, dst='tg_ref')
        with psycopg.connect(cl.url(db), autocommit=True) as c:
            fpr = fingerprint(c)
        rc, err = cl.psql_file(db, a0)
        with psycopg.connect(cl.url(db), autocommit=True) as c:
            check(f'step 8 0a REFUSES with {label}, nothing changed',
                  rc != 0 and needle in err and fingerprint(c) == fpr, err[-150:])
        cl.drop(db)

    # ── step 9: 0r, then 0a twice ─────────────────────────────────────────────────────────────────
    rc, err = cl.psql_file(main_db, r0)
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp_r = fingerprint(c)
    check('step 9 0r exit 0; catalog identical to before the apply', rc == 0 and fp_r == fp0,
          f'{err[-120:]} diff={sorted(set(fp_r) ^ set(fp0))[:6]}')
    check('step 9 post gates after 0r: none red (vacuous again)', bad(cl.gates(main_db, migration=mig)) == set())
    rc, err = cl.psql_file(main_db, r0)
    check('step 9 0r again: a no-op, exit 0', rc == 0, err[-120:])
    for i in (1, 2):
        rc, err = cl.psql_file(main_db, a0)
        with psycopg.connect(cl.url(main_db), autocommit=True) as c:
            fp = fingerprint(c)
        check(f'step 9 re-apply #{i}: exit 0, catalog = first apply, post green',
              rc == 0 and fp == fp1 and bad(cl.gates(main_db, migration=mig)) == set(), err[-120:])

    # ── step 10: the Phase 1 order end to end ─────────────────────────────────────────────────────
    cl.clone(a.base_db, 'tg_prem1')
    rc, err = cl.psql_file('tg_prem1', SPACEGUARD / '0r-rollback.sql')
    with psycopg.connect(cl.url('tg_prem1'), autocommit=True) as c:
        fp_prem1 = fingerprint(c)
    check('step 10 a pre-M1 reference: v5-spaceguard-001 0r on a clone of the base, exit 0', rc == 0, err[-120:])
    cl.drop('tg_prem1')

    cl.clone(a.base_db, 'tg_full')
    before_full = cl.gates('tg_full')
    seq = [m2 / '0a-fold.sql', m2 / '0b-fk-plants.sql', m2 / '0c-fk-plant-projects.sql', m2 / '0d-validate.sql',
           PLATFORMOPS / '0a-platform-operators.sql', a0]
    rcs = [cl.psql_file('tg_full', f)[0] for f in seq]
    per_dir = {d.name: bad(cl.gates('tg_full', migration=d)) for d in (SPACEGUARD, m2, PLATFORMOPS, HERE)}
    check('step 10 M1 (base) -> M2 0a-0d -> M3 both 0a: exit 0 each; every post gate of the four directories green',
          rcs == [0] * len(seq) and all(v == set() for v in per_dir.values()),
          f'rcs={rcs} red={ {k: sorted(v) for k, v in per_dir.items() if v} }')
    after_full = cl.gates('tg_full')
    newly = sorted('/'.join(x) for x in bad(after_full) - bad(before_full))
    check('step 10 C-CONV over this tree, M1 base -> M2 + M3 applied: newly red = {}', newly == [],
          f'before_red={len(bad(before_full))} after_red={len(bad(after_full))} newly={newly}')
    with psycopg.connect(cl.url('tg_full'), autocommit=True) as c:
        fp_full = fingerprint(c)
    rc, err = cl.psql_file('tg_full', SPACEGUARD / '0r-rollback.sql')
    with psycopg.connect(cl.url('tg_full'), autocommit=True) as c:
        check('step 10 wrong order: v5-spaceguard-001 0r first REFUSES, nothing dropped',
              rc != 0 and fingerprint(c) == fp_full, err[-150:])
    order = [r0, PLATFORMOPS / '0r-rollback.sql', m2 / '0r-rollback.sql', SPACEGUARD / '0r-rollback.sql']
    rcs = []
    for f in order:
        rc, err = cl.psql_file('tg_full', f)
        rcs.append(rc)
        if rc:
            print(f'      {f.parent.name}/{f.name}: {err[-200:]}')
    with psycopg.connect(cl.url('tg_full'), autocommit=True) as c:
        fp_back = fingerprint(c)
    check('step 10 rollback M3 -> M2 -> M1: exit 0 each; catalog equal to the pre-M1 reference',
          rcs == [0, 0, 0, 0] and fp_back == fp_prem1,
          f'rcs={rcs} diff={sorted(set(fp_back) ^ set(fp_prem1))[:6]}')
    cl.drop('tg_full')

    if not a.keep:
        cl.drop(main_db)
    n_fail = sum(1 for ok, _, _ in results if not ok)
    print(f'\n{len(results) - n_fail}/{len(results)} PASS' + (f', {n_fail} FAIL' if n_fail else ''))
    return 1 if n_fail else 0


if __name__ == '__main__':
    sys.exit(main())
