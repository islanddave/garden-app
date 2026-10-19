#!/usr/bin/env python3
"""rehearse_local.py -- v5-plottier-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, prod's schema_version rows as data, and the spaces, spacetheme,
weather_daily, weather_cold_range and spaces audit_events rows as data. The script never writes to --base-db: it
clones it (CREATE DATABASE ... TEMPLATE) and works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates on the base                     -> every gate PASS
   2. C-CONV before: --all --phase post --json  (both --env prod and --env staging) -> no ERROR (else FAULT)
   3. 0a                                        -> exit 0
   4. this directory's post gates               -> every gate PASS, receipt included
   5. C-CONV after; newly red = after - before  -> exactly EXPECTED_NEWLY_RED (empty), per env
   6. behaviour cases and mutants: C-AUDIT writers and actors; C-GUARD cases, the DROP COLUMN control and three
      body mutants; C-BLOCK (a Space with a plot, composite and single-column keys into plots, NULL key, TRUNCATE,
      drop-the-guard); the one-default index; NOT NULL (DSA-35); every data gate's positive control, red then
      green; the self-arm of each standing gate; a gate-level red for each structural mutant. Each in a
      transaction that is rolled back.
   7. the staging shape (the Space has no place): pre gate red, 0a refuses naming the Space, nothing changed
   8. 0a refusals: a name collision                                 -> refuses, nothing changed
   9. 0r refusals: an added plot, a changed Plot 1, a key into plots -> each refuses, nothing dropped
  10. 0r                                        -> exit 0; catalog fingerprint equal to the base's
  11. 0a twice more, then 0r -> 0a once more    -> exit 0 each; fingerprint equal to step 3's; one Plot 1 per Space

Usage:
  python3 migrations/v5-plottier-001/rehearse_local.py --port 55471 --base-db base
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
STAMP = '5.3.6-plottier-001'
OWNER = 'user_rehearse_plottier'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
# C-CONV: the existing gates this step turns red, by (dir, name). README.md "C-CONV pre-scan" lists why it is empty.
EXPECTED_NEWLY_RED = set()

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

    def gates(self, db, migration=None, phase='post', env='prod'):
        """Run gate_runner.py against `db`. Returns {(dir, phase, name): status}."""
        args = [sys.executable, str(TREE / 'scripts' / 'gate_runner.py')]
        args += ['--migration', str(migration)] if migration else ['--all']
        args += ['--env', env, '--phase', phase, '--json']
        url = self.url(db)
        r = subprocess.run(args, capture_output=True, text=True,
                           env={**os.environ, 'NEON_DATABASE_URL': url, 'NEON_STAGING_URL': url})
        if r.returncode not in (0, 1):
            raise SystemExit(f'gate_runner exit {r.returncode}: {r.stderr[-800:]}')
        return {(Path(g['path']).parent.name, g['phase'], g['name']): g['status'] for g in json.loads(r.stdout)}


def bad(gates):
    return {k for k, v in gates.items() if v in ('FAIL', 'ERROR')}


def fingerprint(conn):
    """The catalog this migration could touch, as sorted text lines (data rows excluded)."""
    q = """
    SELECT 'trigger ' || t.relname || '.' || g.tgname || ' ' || g.tgtype::text || ' ' || g.tgenabled::text || ' '
           || p.proname
      FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_proc p ON p.oid = g.tgfoid
     WHERE n.nspname IN ('public', 'gv') AND NOT g.tgisinternal
    UNION ALL
    SELECT 'function '|| n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || coalesce(p.proconfig::text, '')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'gv')
    UNION ALL
    SELECT 'constraint ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'index ' || pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'stamp ' || version FROM public.schema_version
    """
    return sorted(r[0] for r in conn.execute(q).fetchall())


GATES = yaml.safe_load((HERE / 'gates.yml').read_text())
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'post') for g in GATES.get(phase, [])}
POST_GATES = [g['name'] for g in GATES['post']]


def fn_ddl(name):
    """One CREATE OR REPLACE FUNCTION statement of 0a, verbatim, for building a mutant from it."""
    src = (HERE / '0a-plots.sql').read_text()
    start = src.index(f'CREATE OR REPLACE FUNCTION public.{name}()')
    return src[start:src.index('$$;', start) + 3]


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


def the_space(conn):
    """The one Space the replica holds (read from the data: no literal Space here)."""
    rows = conn.execute('SELECT id FROM public.spaces').fetchall()
    assert len(rows) == 1, rows
    return rows[0][0]


def plot1(conn, space):
    return conn.execute('SELECT id FROM public.plots WHERE workspace_id = %s AND is_default AND deleted_at IS NULL',
                        (space,)).fetchone()[0]


def new_space(conn, name, lat=None, lng=None, zip_=None):
    return conn.execute('INSERT INTO public.spaces (name, created_by, weather_lat, weather_lng, postal_code) '
                        'VALUES (%s, %s, %s, %s, %s) RETURNING id', (name, OWNER, lat, lng, zip_)).fetchone()[0]


def new_plot(conn, space, name, *, default=False, lat=41.5, lng=-71.5, zip_='02800', tz='America/New_York'):
    return conn.execute('INSERT INTO public.plots (workspace_id, name, postal_code, lat, lng, timezone, is_default, '
                        'created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id',
                        (space, name, zip_, lat, lng, tz, default, OWNER)).fetchone()[0]


def add_weather(conn, space, day='2026-06-01'):
    conn.execute('INSERT INTO public.weather_daily (space_id, date, tmax_f, tmin_f, precip_in) '
                 'VALUES (%s, %s, 80, 60, 0.1)', (space, day))


def add_cold(conn, space):
    conn.execute('INSERT INTO public.weather_cold_range (space_id, night_date, init_time, p10_min_f, leads_read, '
                 'leads_expected) VALUES (%s, %s, %s, 30, 15, 15)', (space, '2026-10-01', '2026-10-01T00:00Z'))


def audit_rows(conn, plot, action):
    return conn.execute("SELECT actor_clerk_sub, after_jsonb FROM public.audit_events WHERE table_name = 'plots' "
                        "AND row_id = %s AND action = %s ORDER BY id", (plot, action)).fetchall()


# ── C-AUDIT ──────────────────────────────────────────────────────────────────────────────────────
def audit_cases(conn, space):
    with case(conn):
        conn.execute("SELECT set_config('app.actor_clerk_sub', %s, true)", (OWNER,))
        p = new_plot(conn, space, 'rh-a1')
        ins = audit_rows(conn, p, 'INSERT')
        check('C-AUDIT INSERT: one INSERT row, actor = app.actor_clerk_sub, after = the row',
              len(ins) == 1 and ins[0][0] == OWNER and ins[0][1]['name'] == 'rh-a1', f'{len(ins)} rows')
        conn.execute("UPDATE public.plots SET name = 'rh-a1b' WHERE id = %s", (p,))
        check('C-AUDIT UPDATE of a watched column (name): one UPDATE row', len(audit_rows(conn, p, 'UPDATE')) == 1)
        conn.execute("UPDATE public.plots SET updated_at = now() + interval '1 minute' WHERE id = %s", (p,))
        check('C-AUDIT UPDATE of updated_at only: no new row', len(audit_rows(conn, p, 'UPDATE')) == 1)
        conn.execute('UPDATE public.plots SET deleted_at = now() WHERE id = %s', (p,))
        check('C-AUDIT soft delete: one SOFT_DELETE row', len(audit_rows(conn, p, 'SOFT_DELETE')) == 1)
        conn.execute('UPDATE public.plots SET deleted_at = NULL WHERE id = %s', (p,))
        check('C-AUDIT restore: one RESTORE row', len(audit_rows(conn, p, 'RESTORE')) == 1)
        conn.execute('DELETE FROM public.plots WHERE id = %s', (p,))
        dl = audit_rows(conn, p, 'DELETE')
        check('C-AUDIT hard DELETE: one DELETE row', len(dl) == 1)
    with case(conn):
        n = conn.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'plots' "
                         "AND action = 'INSERT'").fetchone()[0]
        conn.execute("INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, created_by) "
                     "SELECT %s, 'rh-multi-' || g, 41, -71, 'America/New_York', %s FROM generate_series(1, 3) g",
                     (space, OWNER))
        m = conn.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'plots' "
                         "AND action = 'INSERT'").fetchone()[0]
        check('C-AUDIT multi-row INSERT: one INSERT row per plot (3)', m - n == 3, f'delta {m - n}')
    with case(conn):
        conn.execute('ALTER TABLE public.plots DISABLE TRIGGER trg_audit_plots_ins')
        new_plot(conn, space, 'rh-noaudit')
        conn.execute('ALTER TABLE public.plots ENABLE TRIGGER trg_audit_plots_ins')
        r = gate_rows(conn, 'post_every_plot_has_its_insert_audit_row')
        check('gate post_every_plot_has_its_insert_audit_row: red on a plot inserted with the audit off', len(r) == 1)
    check('gate post_every_plot_has_its_insert_audit_row: green on the applied replica',
          gate_rows(conn, 'post_every_plot_has_its_insert_audit_row') == [])


# ── C-GUARD ──────────────────────────────────────────────────────────────────────────────────────
def guard_cases(conn, space):
    p1 = plot1(conn, space)
    refused = [
        ('lat moved', 'UPDATE public.plots SET lat = lat + 0.001 WHERE id = %s'),
        ('lng moved', 'UPDATE public.plots SET lng = lng + 0.001 WHERE id = %s'),
        ('postal_code -> NULL', 'UPDATE public.plots SET postal_code = NULL WHERE id = %s'),
        ('postal_code changed', "UPDATE public.plots SET postal_code = '99999' WHERE id = %s"),
        ('timezone changed', "UPDATE public.plots SET timezone = 'America/Chicago' WHERE id = %s"),
        ('ON CONFLICT DO UPDATE', "INSERT INTO public.plots (id, workspace_id, name, lat, lng, timezone, created_by) "
                                  "SELECT id, workspace_id, name, lat + 1, lng, timezone, created_by "
                                  "FROM public.plots WHERE id = %s "
                                  "ON CONFLICT (id) DO UPDATE SET lat = excluded.lat"),
    ]
    for label, sql in refused:
        with case(conn):
            st, msg = err_of(conn, sql, (p1,))
            check(f'C-GUARD Plot 1 of the real Space (weather recorded): {label} -> P0001 plots_repoint_guard',
                  st == 'P0001' and msg.startswith('plots_repoint_guard'), f'{st} {msg[:60]}')
    with case(conn):
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat, lng = lng, postal_code = postal_code, '
                             'timezone = timezone WHERE id = %s', (p1,))
        check('C-GUARD same-value SET of all four: passes', st is None, str(st))
    with case(conn):
        st, _ = err_of(conn, "UPDATE public.plots SET name = 'renamed', updated_at = now() WHERE id = %s", (p1,))
        check('C-GUARD a column outside the OF list (name): passes', st is None, str(st))
    with case(conn):
        p2 = new_plot(conn, space, 'rh-g2')
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = 40, timezone = %s WHERE id = %s', ('America/Denver', p2))
        check('C-GUARD a non-default plot of the same Space moves freely', st is None, str(st))
        st, msg = err_of(conn, 'UPDATE public.plots SET lat = lat - 1, is_default = true WHERE id = %s', (p2,))
        check('C-GUARD a plot that becomes the default while moving -> P0001 (the index would 23505 next)',
              st == 'P0001', f'{st} {msg[:50]}')
        st, msg = err_of(conn, 'UPDATE public.plots SET lat = lat + 0.5 WHERE id IN (%s, %s)', (p1, p2))
        check('C-GUARD multi-row UPDATE naming Plot 1 -> P0001', st == 'P0001', str(st))
    with case(conn):
        s2 = new_space(conn, 'rh-g-noweather', 41, -71, '02800')
        q = new_plot(conn, s2, 'rh-g-noweather', default=True, lat=41, lng=-71)
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = 41.2 WHERE id = %s', (q,))
        check('C-GUARD default plot of a Space with no weather: moves', st is None, str(st))
    for label, adder in (('weather_daily only', add_weather), ('weather_cold_range only', add_cold)):
        with case(conn):
            s3 = new_space(conn, f'rh-g-{label}', 41, -71, '02800')
            q = new_plot(conn, s3, 'rh', default=True, lat=41, lng=-71)
            adder(conn, s3)
            st, _ = err_of(conn, 'UPDATE public.plots SET lat = 41.2 WHERE id = %s', (q,))
            check(f'C-GUARD default plot of a Space with {label}: P0001', st == 'P0001', str(st))
    with case(conn):
        st, _ = err_of(conn, 'ALTER TABLE public.plots DROP COLUMN lat')
        check('C-GUARD DROP COLUMN lat refuses (the OF list is a recorded dependency): 2BP01', st == '2BP01', str(st))
    # Mutants: each must let through a case the real guard refuses (killed), or refuse one it lets through.
    body = fn_ddl('guard_plots_repoint')
    mutants = [
        ("'<>' for IS DISTINCT FROM (postal_code -> NULL slips through)",
         body.replace('IS DISTINCT FROM', '<>'), 'UPDATE public.plots SET postal_code = NULL WHERE id = %s', (p1,), None),
        ('cold-range EXISTS dropped (a cold-range-only Space moves)',
         body.replace("\n          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.space_id IN (OLD.workspace_id, NEW.workspace_id))", ''),
         'cold', None, None),
        ('the default arm dropped (a non-default plot is refused)',
         body.replace('AND (OLD.is_default OR NEW.is_default)\n', ''), 'nondefault', None, 'P0001'),
    ]
    for label, ddl, sql, params, want in mutants:
        with case(conn):
            check(f'mutant built: {label}', ddl != body)
            conn.execute(ddl)
            if sql == 'cold':
                s3 = new_space(conn, 'rh-m-cold', 41, -71, '02800')
                q = new_plot(conn, s3, 'rh', default=True, lat=41, lng=-71)
                add_cold(conn, s3)
                st, _ = err_of(conn, 'UPDATE public.plots SET lat = 41.2 WHERE id = %s', (q,))
            elif sql == 'nondefault':
                p2 = new_plot(conn, space, 'rh-m-nd')
                st, _ = err_of(conn, 'UPDATE public.plots SET lat = 40 WHERE id = %s', (p2,))
            else:
                st, _ = err_of(conn, sql, params)
            check(f'mutant killed: {label}', st == want, str(st))
            check(f'mutant reds post_plots_guard_functions_pinned: {label}',
                  len(gate_rows(conn, 'post_plots_guard_functions_pinned')) == 1)
    with case(conn):
        conn.execute('DROP TRIGGER plots_repoint_guard ON public.plots')
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat + 1 WHERE id = %s', (p1,))
        check('mutant killed: plots_repoint_guard dropped (Plot 1 moves)', st is None, str(st))
        check('mutant reds post_plots_triggers_exact_and_enabled: guard dropped',
              gate_rows(conn, 'post_plots_triggers_exact_and_enabled') == [('plots_repoint_guard',)])


# ── C-BLOCK ──────────────────────────────────────────────────────────────────────────────────────
def block_cases(conn, space):
    with case(conn):
        st, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (space,))
        check('C-BLOCK the real Space (it has Plot 1) refuses delete: P0001 spaces_delete_guard',
              st == 'P0001' and 'spaces_delete_guard' in msg, f'{st} {msg[:70]}')
    with case(conn):
        s2 = new_space(conn, 'rh-b-only', 41, -71)
        q = new_plot(conn, s2, 'rh', default=True)
        conn.execute('UPDATE public.plots SET deleted_at = now() WHERE id = %s', (q,))
        st, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s2,))
        check('C-BLOCK a Space whose only child is a SOFT-DELETED plot refuses delete, naming plots',
              st == 'P0001' and 'public.plots' in msg, f'{st} {msg[:80]}')
        conn.execute('DELETE FROM public.plots WHERE id = %s', (q,))
        st, _ = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s2,))
        check('C-BLOCK children first (the _cleanup.js order), then the Space: deletes', st is None, str(st))
    with case(conn):
        q = new_plot(conn, space, 'rh-b-childless')
        st, _ = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (q,))
        check('C-BLOCK a childless plot hard-deletes (nothing references plots today)', st is None, str(st))
    # 3.2a-shaped composite key with ON DELETE CASCADE: the guard makes the effective behaviour RESTRICT.
    with case(conn):
        q = new_plot(conn, space, 'rh-b-composite')
        conn.execute('CREATE TABLE public.zz_plot_child (plot_id uuid, space_id uuid, '
                     'FOREIGN KEY (plot_id, space_id) REFERENCES public.plots (id, workspace_id) ON DELETE CASCADE)')
        conn.execute('INSERT INTO public.zz_plot_child VALUES (%s, %s)', (q, space))
        st, msg = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (q,))
        check('C-BLOCK composite key (plot_id, space_id) -> plots(id, workspace_id), CASCADE: refused, child kept',
              st == 'P0001' and 'zz_plot_child' in msg
              and conn.execute('SELECT count(*) FROM public.zz_plot_child').fetchone()[0] == 1, f'{st} {msg[:70]}')
        conn.execute('UPDATE public.zz_plot_child SET plot_id = NULL')
        st, _ = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (q,))
        check('C-BLOCK a child with a NULL key names no plot (MATCH SIMPLE): delete passes', st is None, str(st))
    with case(conn):
        q = new_plot(conn, space, 'rh-b-single')
        conn.execute('CREATE TABLE public.zz_plot_child1 (plot_id uuid REFERENCES public.plots (id) ON DELETE CASCADE)')
        conn.execute('INSERT INTO public.zz_plot_child1 VALUES (%s)', (q,))
        st, msg = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (q,))
        check('C-BLOCK single-column key into plots, CASCADE: refused', st == 'P0001' and 'zz_plot_child1' in msg,
              f'{st} {msg[:70]}')
        conn.execute('DROP TRIGGER plots_delete_guard ON public.plots')
        st, _ = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (q,))
        n = conn.execute('SELECT count(*) FROM public.zz_plot_child1').fetchone()[0]
        check('mutant killed: plots_delete_guard dropped -> CASCADE takes the child', st is None and n == 0, f'{st} {n}')
    with case(conn):
        st, msg = err_of(conn, 'TRUNCATE public.plots')
        check('C-BLOCK TRUNCATE plots: P0001 plots_truncate_guard', st == 'P0001' and 'plots_truncate_guard' in msg,
              f'{st} {msg[:50]}')
        st, msg = err_of(conn, 'TRUNCATE public.spaces CASCADE')
        check('C-BLOCK TRUNCATE spaces CASCADE (reaches plots): P0001', st == 'P0001', f'{st} {msg[:50]}')
    with case(conn):
        conn.execute('DROP TRIGGER plots_truncate_guard ON public.plots')
        st, _ = err_of(conn, 'TRUNCATE public.plots')
        n = conn.execute('SELECT count(*) FROM public.plots').fetchone()[0]
        check('mutant killed: plots_truncate_guard dropped -> TRUNCATE empties plots', st is None and n == 0, f'{st} {n}')


# ── Table shape, the one-default rule and the data gates ─────────────────────────────────────────
def shape_and_gate_cases(conn, space):
    p1 = plot1(conn, space)
    with case(conn):
        st, _ = err_of(conn, 'INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, is_default, created_by) '
                             "VALUES (%s, 'rh', NULL, -71, 'America/New_York', true, %s)", (space, OWNER))
        check('DSA-35: a NULL-lat default-plot insert raises 23502', st == '23502', str(st))
    for col in ('name', 'lng', 'timezone', 'created_by'):
        with case(conn):
            vals = {'name': "'rh'", 'lng': '-71', 'timezone': "'America/New_York'", 'created_by': f"'{OWNER}'"}
            vals[col] = 'NULL'
            st, _ = err_of(conn, f"INSERT INTO public.plots (workspace_id, lat, name, lng, timezone, created_by) "
                                 f"VALUES (%s, 41, {vals['name']}, {vals['lng']}, {vals['timezone']}, {vals['created_by']})",
                           (space,))
            check(f'DSA-35: NULL {col} raises 23502', st == '23502', str(st))
    with case(conn):
        st, _ = err_of(conn, 'INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, created_by) '
                             "VALUES (gen_random_uuid(), 'rh', 41, -71, 'America/New_York', %s)", (OWNER,))
        check('FK: a plot for an unknown Space raises 23503', st == '23503', str(st))
    with case(conn):
        st, _ = err_of(conn, 'INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, is_default, created_by) '
                             "VALUES (%s, 'rh-2nd-default', 41, -71, 'America/New_York', true, %s)", (space, OWNER))
        check('index: a second live default plot in one Space raises 23505', st == '23505', str(st))
    with case(conn):
        conn.execute('UPDATE public.plots SET deleted_at = now() WHERE id = %s', (p1,))
        r = gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot')
        check('gate one-default: red when Plot 1 is soft-deleted (0 live defaults)', len(r) == 1 and ': 0 ' in r[0][0],
              str(r))
        st, _ = err_of(conn, 'INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, is_default, created_by) '
                             'SELECT workspace_id, name, lat, lng, timezone, true, created_by FROM public.plots WHERE id = %s',
                       (p1,))
        check('index: a new live default beside a soft-deleted one is admitted', st is None, str(st))
        check('gate one-default: green again with the replacement',
              gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot') == [])
    # THE ROW'S POSITIVE CONTROL: a planted Space with no plot reds the default-plot gate.
    with case(conn):
        s2 = new_space(conn, 'rh-planted-no-plot', 41, -71)
        r = gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot')
        check('POSITIVE CONTROL gate one-default: a planted Space with no plot reds it, naming that Space',
              len(r) == 1 and r[0][0].startswith(str(s2)), str(r))
        new_plot(conn, s2, 'rh', default=False, lat=41, lng=-71)
        check('gate one-default: a non-default plot alone does not satisfy it',
              len(gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot')) == 1)
        new_plot(conn, s2, 'rh-default', default=True, lat=41, lng=-71, zip_=None)
        check('gate one-default: green once the Space has its default plot',
              gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot') == [])
        conn.execute("DELETE FROM public.schema_version WHERE version = %s", (STAMP,))
        conn.execute('DELETE FROM public.plots WHERE workspace_id = %s', (s2,))
        check('self-arm: with the stamp absent the planted Space does not red the gate (vacuous before the apply)',
              gate_rows(conn, 'post_every_live_space_has_exactly_one_live_default_plot') == [])
        check('self-arm: post_schema_version_recorded reds on the objects without the stamp',
              len(gate_rows(conn, 'post_schema_version_recorded')) == 1)
    # Plot 1 coords = spaces coords, and the C-GUARD data gate, through the escape templates.
    with case(conn):
        conn.execute("SELECT set_config('app.actor_clerk_sub', 'migration:rh-escape', true)")
        conn.execute('ALTER TABLE public.plots DISABLE TRIGGER plots_repoint_guard')
        conn.execute('UPDATE public.plots SET lat = lat + 0.01 WHERE id = %s', (p1,))
        conn.execute('ALTER TABLE public.plots ENABLE TRIGGER plots_repoint_guard')
        r = gate_rows(conn, 'post_default_plot_place_equals_space_place')
        check('POSITIVE CONTROL gate Plot 1 = Space place: red when Plot 1 moves alone (escape on plots only)',
              len(r) == 1, str(r))
        check('gate place-matches-audit: green (the escape template keeps the audit on)',
              gate_rows(conn, 'post_plot_place_matches_newest_audit') == [])
        conn.execute('ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard')
        conn.execute('UPDATE public.spaces s SET weather_lat = p.lat FROM public.plots p '
                     'WHERE p.id = %s AND s.id = p.workspace_id', (p1,))
        conn.execute('ALTER TABLE public.spaces ENABLE TRIGGER spaces_repoint_guard')
        check('gate Plot 1 = Space place: green once the Space moves with it (both templates, one transaction)',
              gate_rows(conn, 'post_default_plot_place_equals_space_place') == [])
    with case(conn):
        s2 = new_space(conn, 'rh-moved-default', 41, -71, '02800')
        new_plot(conn, s2, 'rh-p1', default=True, lat=41, lng=-71, zip_='02800')
        q = new_plot(conn, s2, 'rh-p2', default=False, lat=42, lng=-72, zip_='01000')
        check('gate Plot 1 = Space place: green on a fresh Space whose default matches',
              gate_rows(conn, 'post_default_plot_place_equals_space_place') == [])
        conn.execute('UPDATE public.plots SET is_default = false WHERE workspace_id = %s AND is_default', (s2,))
        conn.execute('UPDATE public.plots SET is_default = true WHERE id = %s', (q,))
        check('gate Plot 1 = Space place: red when the default flag moves to a plot elsewhere',
              len(gate_rows(conn, 'post_default_plot_place_equals_space_place')) == 1)
    with case(conn):
        conn.execute('ALTER TABLE public.plots DISABLE TRIGGER USER')
        conn.execute('UPDATE public.plots SET lat = lat + 0.01 WHERE id = %s', (p1,))
        conn.execute('ALTER TABLE public.plots ENABLE TRIGGER USER')
        check('POSITIVE CONTROL gate place-matches-audit: red when Plot 1 moves with every trigger off',
              len(gate_rows(conn, 'post_plot_place_matches_newest_audit')) == 1)
    with case(conn):
        new_plot(conn, space, 'rh-tz', tz='America/New_Yrok')
        r = gate_rows(conn, 'post_plot_timezones_are_known')
        check('POSITIVE CONTROL gate timezones: red on an unknown zone', len(r) == 1 and 'New_Yrok' in r[0][0], str(r))
    with case(conn):
        new_plot(conn, space, 'rh-receipt')
        check('receipt: false once anyone adds a plot (continuous: false by design)',
              len(gate_rows(conn, 'post_receipt_every_plot_is_a_plot_1_this_migration_wrote')) == 1)
    # Structural gates: one planted mutant each.
    structural = [
        ('post_plots_columns_exact', 'ALTER TABLE public.plots ADD COLUMN zz text'),
        ('post_plots_columns_exact', 'ALTER TABLE public.plots ALTER COLUMN timezone SET DEFAULT \'UTC\''),
        ('post_plots_columns_exact', 'ALTER TABLE public.plots ALTER COLUMN lat DROP NOT NULL'),
        ('post_plots_column_classification_is_complete', 'ALTER TABLE public.plots ADD COLUMN zz text'),
        ('post_plots_constraints_exact', 'ALTER TABLE public.plots DROP CONSTRAINT plots_id_workspace_id_key'),
        ('post_plots_constraints_exact',
         'ALTER TABLE public.plots DROP CONSTRAINT plots_workspace_id_fkey, ADD CONSTRAINT plots_workspace_id_fkey '
         'FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE CASCADE'),
        ('post_plots_indexes_exact',
         'DROP INDEX public.plots_one_default_per_space; CREATE UNIQUE INDEX plots_one_default_per_space '
         'ON public.plots (workspace_id) WHERE is_default'),
        ('post_plots_triggers_exact_and_enabled',
         'DROP TRIGGER trg_audit_plots_upd ON public.plots; CREATE TRIGGER trg_audit_plots_upd AFTER UPDATE ON '
         'public.plots REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION '
         "public.audit_stmt_update_no_soft_delete('workspace_id', 'name', 'postal_code', 'lat', 'lng', 'timezone', "
         "'is_default', 'created_by')"),
        ('post_plots_triggers_exact_and_enabled', 'ALTER TABLE public.plots DISABLE TRIGGER plots_delete_guard'),
        ('post_plots_has_no_other_trigger',
         'CREATE TRIGGER zz_plots_extra BEFORE UPDATE ON public.plots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()'),
        ('post_plots_audit_triggers_have_transition_tables',
         'DROP TRIGGER trg_audit_plots_del ON public.plots; CREATE TRIGGER trg_audit_plots_del AFTER DELETE ON '
         'public.plots FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_delete()'),
        ('post_plots_column_classification_is_complete',
         'DROP TRIGGER trg_audit_plots_upd ON public.plots; CREATE TRIGGER trg_audit_plots_upd AFTER UPDATE ON '
         'public.plots REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION '
         "public.audit_stmt_update('workspace_id', 'name', 'postal_code', 'lat', 'lgn', 'timezone', 'is_default', "
         "'created_by')"),
        ('post_plots_rls_off_or_policied', 'ALTER TABLE public.plots ENABLE ROW LEVEL SECURITY'),
    ]
    for gate, ddl in structural:
        with case(conn):
            conn.execute(ddl)
            r = gate_rows(conn, gate)
            check(f'gate-level red: {gate} on [{ddl[:70]}]', len(r) >= 1, str(r)[:90])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--base-db', required=True)
    args = ap.parse_args()
    cl = Cluster(args.port)
    a0, a1, stg = 'rh_plottier_after', 'rh_plottier_cycle', 'rh_plottier_staging'
    try:
        # 1. pre gates on the base
        pre = cl.gates(args.base_db, HERE, phase='pre')
        check('1 pre gates on the base: every gate PASS', not bad(pre), str(sorted(bad(pre))))
        with psycopg.connect(cl.url(args.base_db)) as c:
            fp_base = fingerprint(c)

        # 2. C-CONV before
        before = {env: cl.gates(args.base_db, env=env) for env in ('prod', 'staging')}
        for env, g in before.items():
            errs = sorted(k for k, v in g.items() if v == 'ERROR')
            check(f'2 C-CONV before ({env}): no gate ERRORs (an ERROR here is a rehearsal FAULT)', not errs, str(errs))

        # 3. 0a
        cl.clone(args.base_db, a0)
        rc, err = cl.psql_file(a0, HERE / '0a-plots.sql')
        check('3 0a applies: exit 0', rc == 0, err[-300:])

        # 4. this directory's post gates
        post = cl.gates(a0, HERE)
        check('4 post gates after 0a: every gate PASS, receipt included', not bad(post), str(sorted(bad(post))))

        # 5. C-CONV after
        for env in ('prod', 'staging'):
            after = cl.gates(a0, env=env)
            newly = {(d, n) for (d, p, n) in bad(after) - bad(before[env])}
            green = {(d, n) for (d, p, n) in bad(before[env]) - bad(after)}
            check(f'5 C-CONV newly red ({env}) = expected {sorted(EXPECTED_NEWLY_RED)}', newly == EXPECTED_NEWLY_RED,
                  str(sorted(newly)))
            check(f'5 C-CONV newly green ({env}) = none', not green, str(sorted(green)))
            errs = sorted(k for k, v in after.items() if v == 'ERROR')
            check(f'5 C-CONV after ({env}): no gate ERRORs', not errs, str(errs))

        # 6. behaviour cases and mutants
        with psycopg.connect(cl.url(a0)) as c:
            space = the_space(c)
            c.commit()
            audit_cases(c, space)
            guard_cases(c, space)
            block_cases(c, space)
            shape_and_gate_cases(c, space)
            fp_after = fingerprint(c)
            row = c.execute('SELECT name, lat, lng, postal_code, created_by, timezone FROM public.plots').fetchall()
            src = c.execute('SELECT name, weather_lat, weather_lng, postal_code, created_by FROM public.spaces').fetchall()
            check('6 Plot 1 equals its Space (name, lat, lng, postal_code, created_by), zone America/New_York',
                  [r[:5] for r in row] == src and row[0][5] == 'America/New_York', str(row)[:120])
        post = cl.gates(a0, HERE)
        check('6 post gates after every case (all rolled back): every gate PASS', not bad(post), str(sorted(bad(post))))

        # 7. the staging shape: the Space has no place
        cl.clone(args.base_db, stg)
        with psycopg.connect(cl.url(stg), autocommit=True) as c:
            c.execute('ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard')
            c.execute('UPDATE public.spaces SET weather_lat = NULL, weather_lng = NULL, postal_code = NULL')
            c.execute('ALTER TABLE public.spaces ENABLE TRIGGER spaces_repoint_guard')
            space = the_space(c)
            fp_stg = fingerprint(c)
        pre = cl.gates(stg, HERE, phase='pre')
        check('7 staging shape: pre_every_space_has_a_place_and_an_owner is red (and only it)',
              {n for (_, _, n) in bad(pre)} == {'pre_every_space_has_a_place_and_an_owner'}, str(sorted(bad(pre))))
        rc, err = cl.psql_file(stg, HERE / '0a-plots.sql')
        check('7 staging shape: 0a refuses, naming the Space and its NULL columns',
              rc != 0 and f'{space} (weather_lat, weather_lng NULL)' in err, err[-200:])
        with psycopg.connect(cl.url(stg)) as c:
            check('7 staging shape: nothing changed (fingerprint equal)', fingerprint(c) == fp_stg)

        # 8. 0a refusal: a name collision
        cl.clone(args.base_db, a1)
        with psycopg.connect(cl.url(a1), autocommit=True) as c:
            c.execute('CREATE FUNCTION public.guard_plots_delete() RETURNS trigger LANGUAGE plpgsql '
                      'AS $$ BEGIN RETURN OLD; END $$')
            fp = fingerprint(c)
        rc, err = cl.psql_file(a1, HERE / '0a-plots.sql')
        with psycopg.connect(cl.url(a1)) as c:
            check('8 0a refuses on a name collision, nothing changed',
                  rc != 0 and 'function guard_plots_delete' in err and fingerprint(c) == fp, err[-150:])
        cl.drop(a1)

        # 9. 0r refusals, each on a fresh clone of the applied database
        refusals = [
            ('a plot added after the apply', "INSERT INTO public.plots (workspace_id, name, lat, lng, timezone, "
             f"created_by) SELECT id, 'second', 41, -71, 'America/New_York', '{OWNER}' FROM public.spaces",
             'added or changed after the apply'),
            ('Plot 1 renamed after the apply', "UPDATE public.plots SET name = 'Front bed'", 'added or changed'),
            ('Plot 1 soft-deleted after the apply', 'UPDATE public.plots SET deleted_at = now()', 'added or changed'),
            ('a foreign key into plots', 'CREATE TABLE public.zz_wx (plot_id uuid, space_id uuid, FOREIGN KEY '
             '(plot_id, space_id) REFERENCES public.plots (id, workspace_id))', 'foreign key(s) into plots exist'),
        ]
        for label, sql, needle in refusals:
            cl.clone(a0, a1)
            with psycopg.connect(cl.url(a1), autocommit=True) as c:
                c.execute(sql)
                fp = fingerprint(c)
                n = c.execute('SELECT count(*) FROM public.plots').fetchone()[0]
            rc, err = cl.psql_file(a1, HERE / '0r-rollback.sql')
            with psycopg.connect(cl.url(a1)) as c:
                kept = fingerprint(c) == fp and c.execute('SELECT count(*) FROM public.plots').fetchone()[0] == n
            check(f'9 0r refuses ({label}), nothing dropped', rc != 0 and needle in err and kept, err[-120:])
            cl.drop(a1)

        # 10. 0r
        rc, err = cl.psql_file(a0, HERE / '0r-rollback.sql')
        check('10 0r applies: exit 0', rc == 0, err[-300:])
        with psycopg.connect(cl.url(a0)) as c:
            check('10 after 0r the catalog equals the base (fingerprint)', fingerprint(c) == fp_base)
            n = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'plots'").fetchone()[0]
            check('10 audit history is kept (the Plot 1 INSERT rows remain)', n >= 1, str(n))
        post = cl.gates(a0, HERE)
        check('10 post gates after 0r: every gate PASS (vacuous again, no 42P01)', not bad(post), str(sorted(bad(post))))
        rc, err = cl.psql_file(a0, HERE / '0r-rollback.sql')
        check('10 0r a second time: exit 0 (no-op)', rc == 0, err[-200:])

        # 11. re-apply, idempotency, 0r -> 0a cycle
        rc, err = cl.psql_file(a0, HERE / '0a-plots.sql')
        check('11 0a again after 0r: exit 0', rc == 0, err[-200:])
        with psycopg.connect(cl.url(a0)) as c:
            fp1 = fingerprint(c)
            ids1 = c.execute('SELECT id FROM public.plots ORDER BY id').fetchall()
        for i in (2, 3):
            rc, err = cl.psql_file(a0, HERE / '0a-plots.sql')
            with psycopg.connect(cl.url(a0)) as c:
                same = fingerprint(c) == fp1 and c.execute('SELECT id FROM public.plots ORDER BY id').fetchall() == ids1
            check(f'11 0a apply #{i} on an applied database: exit 0, catalog and plots unchanged', rc == 0 and same,
                  err[-150:])
        check('11 the applied catalog equals the first apply (fingerprint)', fp1 == fp_after)
        post = cl.gates(a0, HERE)
        check('11 post gates after the 0r -> 0a cycle: every gate PASS, receipt included', not bad(post),
              str(sorted(bad(post))))
    finally:
        for db in (a0, a1, stg):
            cl.drop(db)

    failed = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(failed)}/{len(results)} PASS' + (f', {len(failed)} FAIL' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
