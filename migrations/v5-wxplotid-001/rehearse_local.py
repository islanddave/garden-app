#!/usr/bin/env python3
"""rehearse_local.py -- v5-wxplotid-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, and a read-only data copy of prod's schema_version, spaces, plots,
spacetheme, weather_daily and weather_cold_range rows and the audit_events rows of spaces and plots. The script never
writes to --base-db: it clones it (CREATE DATABASE ... TEMPLATE) and works on clones, dropping them at the end. It
runs the gate corpus twice per read: as it is at BASE_SHA (before this step's tolerant edits, from `git archive`) and
as it is in this tree.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates on the base                     -> every gate PASS
   2. C-CONV before, --all --phase post --json, --env prod and staging, base corpus and edited corpus -> no ERROR
      (else FAULT); the edited corpus reds nothing the base corpus does not (tolerant before the DDL)
   3. 0a                                        -> exit 0; the pre-gate counts printed
   4. this directory's post gates               -> every gate PASS, receipt included
   5. C-CONV after: base corpus newly red = EXPECTED_NEWLY_RED; edited corpus newly red = newly green = {} (both envs)
   6. the arming test: the writer census by rule, each hit's column list written after 0a (and refused by a mutant
      with a NOT VALID CHECK, so the test can red); the hourly writer's and the backfill script's exact statements,
      new day and existing day; wn3_send.py's INSERT as a role holding only its seven column grants
   7. keys, indexes and the new C-GUARD body: cases and mutants; every tightened arm red on a planted violation
      after the stamp; each of this directory's post gates red on its defect; the self-arm
   8. later steps can build on it: 3.2b's healing upsert, 3.3a's arbiters, 3.2d's VALIDATE and NOT NULL (and its
      23503 on a planted cross-Space row), 3.4's ADD PRIMARY KEY USING INDEX
   9. 0a refusals (positive controls of the backfill pre-gate and the definition pre-gate): a second Space with
      weather, a second Space without, a weather row naming another Space, no live default plot, a changed guard
      body, a name collision -> each refuses, nothing changed
  10. the staging shape (coordinate-less Plot 1, no weather_daily, one cold-range row) and a weather-less shape:
      NO_EVIDENCE printed, 0a exit 0, post gates PASS, C-CONV as in step 5
  11. 0r refusals: a row on a non-default plot, plot_id NOT NULL, an index backing a key -> refuses, nothing dropped
  12. 0r                                        -> exit 0; catalog fingerprint equal to the base's; 3.1's body back
  13. 0a again, twice more                      -> exit 0 each; fingerprint equal to step 3's

Usage:
  python3 migrations/v5-wxplotid-001/rehearse_local.py --port 55491 --base-db base

HISTORICAL FROM 3.2b ON (amended 2026-10-21, multi-space 3.2c/3.2d lane; pre-promote v5.3.13 MINOR-1). This rehearses
3.2a against the writers deployed when 3.2a ran, so it reads them AT BASE_SHA, not from this tree: the census by rule
(`git grep ... BASE_SHA`), handler.js, backfill-weather-daily.mjs, and wn3_send.py's INSERT as copied 2026-10-19
(WN3_SEND=<path> reads a file instead). From 3.2b the tree's writers stamp plot_id and re-read their Space bind, and
from 3.2c the job names plot_id, so the tree's text would fail its "plot_id NULL" cases by design. --base-db must be a
pre-3.2a database (a post-3.2a one with this directory's 0r applied will do). The extractor (_to_psycopg) now maps a
repeated $n, or a repeated ${expr}, to ONE named bind (binds() makes the mapping), which is what lets a later step's
rehearsal (v5-wxplotnotnull-001/rehearse_local.py) run the tree's current statements.
"""
import argparse
import ast
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import psycopg
import yaml

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
STAMP = '5.3.12-wxplotid-001'
BASE_SHA = 'a2083805064eba187b1135fb90d491ff15cdc466'   # v5.3.11, the corpus before this step's edits
OLD_MD5 = '0845482dfbb48a94ec3cd81bddd6d62f'            # 3.1's guard_plots_repoint body
NEW_MD5 = '467a31ca4b105064f4996442d900c7e3'            # this step's
OWNER = 'user_rehearse_wxplotid'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
# Historical (docstring): the 2026-10-19 copy below, unless WN3_SEND names a file to read instead.
WN3_SEND = Path(os.environ['WN3_SEND']) if os.environ.get('WN3_SEND') else None
# C-CONV: the existing gates this step turns red in their BASE_SHA form, by (dir, name). README.md "C-CONV pre-scan".
# Each ships edited, in the tolerant form, so the edited corpus's newly-red set is empty.
EXPECTED_NEWLY_RED = {
    ('v4-weatherdaily-001', 'post_no_extra_columns'),
    ('v5-wxcoldband-001', 'post_no_column_outside_the_eight'),
    ('v5-wxcoldband-001', 'post_primary_key_is_the_only_unique_index'),
    ('v5-wxcoldband-001', 'post_exactly_one_fk_cascade_validated_to_spaces'),
    ('v5-plottier-001', 'post_plots_guard_functions_pinned'),
}
# V204 row 3.2a's positive control for the census (a6f06ae6): every one of these files must be found by the rule.
PLAN_NAMED_WRITERS = {'lambda/daily-plan/handler.js', 'scripts/backfill-weather-daily.mjs',
                      'tests/integration/season-stats.int.test.js', 'tests/integration/spaces-guards.int.test.js',
                      'migrations/v5-wxcoldband-001/rehearse_local.py'}
CENSUS_RULE = r'insert into (public\.)?weather_(daily|cold_range)'
# wn3_send.py's statement as read 2026-10-19 (project-state/tools/wn3_send.py:81-83), used when the file is not here.
WN3_INSERT_COPY = ("INSERT INTO weather_cold_range "
                   "(space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read, leads_expected) "
                   "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING")
SEVEN = ('space_id', 'night_date', 'init_time', 'p10_min_f', 'p50_min_f', 'leads_read', 'leads_expected')
PROBE_ROLE = 'rh_wxplotid_writer'

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

    def gates(self, db, migration=None, phase='post', env='prod', runner=None):
        return run_gates(self.url(db), migration, phase, env, runner)


def run_gates(url, migration=None, phase='post', env='prod', runner=None):
    """Run gate_runner.py (this tree's, or `runner`) against `url`. Returns {(dir, phase, name): status}."""
    args = [sys.executable, str(runner or TREE / 'scripts' / 'gate_runner.py')]
    args += ['--migration', str(migration)] if migration else ['--all']
    args += ['--env', env, '--phase', phase, '--json']
    r = subprocess.run(args, capture_output=True, text=True,
                       env={**os.environ, 'NEON_DATABASE_URL': url, 'NEON_STAGING_URL': url})
    if r.returncode not in (0, 1):
        raise SystemExit(f'gate_runner exit {r.returncode}: {r.stderr[-800:]}')
    return {(Path(g['path']).parent.name, g['phase'], g['name']): g['status'] for g in json.loads(r.stdout)}


def bad(gates):
    return {k for k, v in gates.items() if v in ('FAIL', 'ERROR')}


def errors(gates):
    return sorted(k for k, v in gates.items() if v == 'ERROR')


def newly(before, after):
    return {(d, n) for (d, p, n) in bad(after) - bad(before)}


def base_corpus(tmp):
    """The gate corpus and runner as they are at BASE_SHA, extracted into tmp. Returns the runner's path."""
    out = subprocess.run(['git', '-C', str(TREE), 'archive', BASE_SHA, 'scripts/gate_runner.py', 'migrations'],
                         capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(out)) as tf:
        try:
            tf.extractall(tmp, filter='data')
        except TypeError:
            tf.extractall(tmp)
    return Path(tmp) / 'scripts' / 'gate_runner.py'


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
           || ' ' || coalesce(obj_description(p.oid, 'pg_proc'), '')
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
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' '
           || coalesce(column_default, '')
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'stamp ' || version FROM public.schema_version
    """
    return sorted(r[0] for r in conn.execute(q).fetchall())


# ── This tree's gate SQL, run inside the caller's transaction (sees uncommitted state). ─────────────
_GATES = {}


def gate_sql(dir_, name, phase='post'):
    if dir_ not in _GATES:
        _GATES[dir_] = yaml.safe_load((TREE / 'migrations' / dir_ / 'gates.yml').read_text())
    for g in _GATES[dir_].get(phase) or []:
        if g['name'] == name:
            return g['sql']
    raise KeyError((dir_, phase, name))


def gate_rows(conn, dir_, name, phase='post'):
    return [r[0] for r in conn.execute(gate_sql(dir_, name, phase)).fetchall()]


MINE = HERE.name
POST_GATES = [g['name'] for g in yaml.safe_load((HERE / 'gates.yml').read_text())['post']]


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


def superuser(conn, label):
    """Planting a row past a key needs session_replication_role = replica, which only a superuser may set (Neon's
    owner is not one: rehearse_fork.py skips these, and says so; this script runs them)."""
    if conn.execute("SELECT current_setting('is_superuser')").fetchone()[0] == 'on':
        return True
    print(f'SKIP  {label}  [needs a superuser to plant a row past the key; rehearse_local.py covers it]', flush=True)
    return False


def fn_ddl(path, name='guard_plots_repoint'):
    """One CREATE OR REPLACE FUNCTION statement of a file, verbatim, for installing it or building a mutant."""
    src = Path(path).read_text()
    start = src.index(f'CREATE OR REPLACE FUNCTION public.{name}()')
    return src[start:src.index('$$;', start) + 3]


NEW_BODY = fn_ddl(HERE / '0a-wxplotid.sql')
OLD_BODY = fn_ddl(HERE / '0r-rollback.sql')


def md5_of_guard(conn):
    return conn.execute("SELECT md5(prosrc) FROM pg_proc WHERE proname = 'guard_plots_repoint'").fetchone()[0]


def the_space(conn):
    """The one Space the replica holds (read from the data: no literal Space here)."""
    rows = conn.execute('SELECT id FROM public.spaces').fetchall()
    assert len(rows) == 1, rows
    return rows[0][0]


def plot1(conn, space):
    return conn.execute('SELECT id FROM public.plots WHERE workspace_id = %s AND is_default AND deleted_at IS NULL',
                        (space,)).fetchone()[0]


def new_space(conn, name):
    return conn.execute('INSERT INTO public.spaces (name, created_by) VALUES (%s, %s) RETURNING id',
                        (name, OWNER)).fetchone()[0]


def new_plot(conn, space, name, *, default=False, lat=41.5, lng=-71.5):
    return conn.execute('INSERT INTO public.plots (workspace_id, name, postal_code, lat, lng, timezone, is_default, '
                        "created_by) VALUES (%s, %s, '02800', %s, %s, 'America/New_York', %s, %s) RETURNING id",
                        (space, name, lat, lng, default, OWNER)).fetchone()[0]


def add_daily(conn, space, day, plot=None):
    """A weather_daily row; with no plot the statement does not name plot_id (it works before 0a too)."""
    if plot is None:
        conn.execute('INSERT INTO public.weather_daily (space_id, "date", tmax_f, tmin_f, precip_in) '
                     'VALUES (%s, %s, 80, 60, 0.1)', (space, day))
    else:
        conn.execute('INSERT INTO public.weather_daily (space_id, plot_id, "date", tmax_f, tmin_f, precip_in) '
                     'VALUES (%s, %s, %s, 80, 60, 0.1)', (space, plot, day))


def add_cold(conn, space, night, plot=None):
    if plot is None:
        conn.execute('INSERT INTO public.weather_cold_range (space_id, night_date, init_time, p10_min_f, '
                     'leads_read, leads_expected) VALUES (%s, %s, %s, 30, 15, 15)', (space, night, f'{night}T00:00Z'))
    else:
        conn.execute('INSERT INTO public.weather_cold_range (space_id, plot_id, night_date, init_time, p10_min_f, '
                     'leads_read, leads_expected) VALUES (%s, %s, %s, %s, 30, 15, 15)',
                     (space, plot, night, f'{night}T00:00Z'))


def plot_of_daily(conn, space, day):
    return conn.execute('SELECT plot_id FROM public.weather_daily WHERE space_id = %s AND "date" = %s',
                        (space, day)).fetchone()


# ── The writers, by rule (RIA-B4) ─────────────────────────────────────────────────────────────────
def at_rev(path, rev=BASE_SHA):
    """A file's text at `rev` (the writers this rehearsal is about: docstring, HISTORICAL)."""
    return subprocess.run(['git', '-C', str(TREE), 'show', f'{rev}:{path}'], capture_output=True, text=True,
                          check=True).stdout


def writer_census(rev=BASE_SHA):
    """git grep the rule over lambda scripts tests migrations at `rev` (None: the working tree).
    Returns [(path, line, table|None, [cols]|None)]."""
    r = subprocess.run(['git', '-C', str(TREE), 'grep', '-n', '-i', '-E', CENSUS_RULE] + ([rev] if rev else [])
                       + ['--', 'lambda', 'scripts', 'tests', 'migrations'], capture_output=True, text=True)
    hits = []
    for row in r.stdout.splitlines():
        if rev:
            row = row.split(':', 1)[1]   # git grep <rev> prefixes each hit with "<rev>:"
        path, lineno, _ = row.split(':', 2)
        lines = (at_rev(path, rev) if rev else (TREE / path).read_text()).splitlines()
        tail = '\n'.join(lines[int(lineno) - 1:int(lineno) + 3])
        tail = re.sub(r"""['"]\s*\n\s*f?['"]""", '', tail)   # adjacent string literals across a line break
        m = re.search(r'insert\s+into\s+(?:public\.)?(weather_daily|weather_cold_range)\s*\(([^)]*)\)', tail, re.I)
        if not m:
            hits.append((path, int(lineno), None, None))
            continue
        cols = [c.strip().replace('\\', '').strip('"') for c in m.group(2).split(',')]
        hits.append((path, int(lineno), m.group(1).lower(), cols))
    return hits


DAILY_VALUES = {'space_id': None, 'plot_id': None, 'date': None, 'et0_in': 0.1, 'tmax_f': 80, 'tmin_f': 60,
                'precip_in': 0.1, 'precip_source': 'openmeteo_live', 'et0_source': 'openmeteo_live',
                'daylight_s': 50000, 'sunshine_s': 30000, 'solar_mj_m2': 20, 'wind_max_mph': 10, 'precip_hours': 2}
COLD_VALUES = {'space_id': None, 'plot_id': None, 'night_date': None, 'init_time': None, 'p10_min_f': 30,
               'p50_min_f': 32, 'leads_read': 15, 'leads_expected': 15}


def census_insert(table, cols, space, i):
    """An INSERT naming exactly `cols`, with values by column name; the day is 1990-01-01 + i (no collision)."""
    day = f'1990-01-{i + 1:02d}' if i < 28 else f'1990-02-{i - 27:02d}'
    vals = []
    for c in cols:
        if c == 'space_id':
            vals.append(space)
        elif c in ('date', 'night_date'):
            vals.append(day)
        elif c == 'init_time':
            vals.append(f'{day}T00:00:00Z')
        else:
            vals.append((DAILY_VALUES if table == 'weather_daily' else COLD_VALUES).get(c))
    names = ', '.join('"date"' if c == 'date' else c for c in cols)
    return f'INSERT INTO public.{table} ({names}) VALUES ({", ".join(["%s"] * len(cols))})', vals


def _to_psycopg(sql, dollar):
    """A driver's SQL text as psycopg named placeholders. dollar: $1..$n (a node-postgres query), each number one
    bind however often it appears (3.2b's stamp re-reads $1: MINOR-1). Otherwise ${expr} interpolations (a neon
    tagged template), one bind per distinct expression text, numbered in order of first appearance (the backfill's
    stamp repeats ${s.id}). Returns (sql, number of distinct binds); pass the values through binds()."""
    sql = sql.replace('%', '%%')
    if dollar:
        nums = sorted({int(n) for n in re.findall(r'\$(\d+)', sql)})
        assert nums == list(range(1, len(nums) + 1)), nums
        return re.sub(r'\$(\d+)', r'%(p\1)s', sql), len(nums)
    order = []

    def name(m):
        if m.group(0) not in order:
            order.append(m.group(0))
        return f'%(p{order.index(m.group(0)) + 1})s'
    return re.sub(r'\$\{[^}]*\}', name, sql), len(set(re.findall(r'\$\{[^}]*\}', sql)))


def binds(values):
    """Positional values (bind 1, 2, ...) as the named binds _to_psycopg writes."""
    return {f'p{i + 1}': v for i, v in enumerate(values)}


def handler_statement(src=None):
    """lambda/daily-plan/handler.js's hourly upsert, exactly as the Lambda sends it (conflict set spliced in).
    src: the file's text (default: at BASE_SHA, docstring HISTORICAL)."""
    src = src if src is not None else at_rev('lambda/daily-plan/handler.js')
    conflict = re.search(r'const WEATHER_DAILY_CONFLICT_SET =\s*`(.*?)`;', src, re.S).group(1)
    insert = re.search(r'`(insert into weather_daily \(.*?)\$\{WEATHER_DAILY_CONFLICT_SET\}`', src, re.S).group(1)
    return _to_psycopg(insert + conflict, dollar=True)


def backfill_statement(src=None):
    """scripts/backfill-weather-daily.mjs's upsert, its distinct ${...} interpolations as binds in order.
    src: the file's text (default: at BASE_SHA)."""
    src = src if src is not None else at_rev('scripts/backfill-weather-daily.mjs')
    return _to_psycopg(re.search(r'const out = await sql`(.*?)`;', src, re.S).group(1), dollar=False)


def wn3_statement(path=None):
    """wn3_send.py's INSERT (off-repo): from `path` or WN3_SEND when given, else the copy read 2026-10-19."""
    path = path or WN3_SEND
    if path and Path(path).exists():
        m = re.search(r'^INSERT = (\(.*?\))\n', Path(path).read_text(), re.S | re.M)
        return ast.literal_eval(m.group(1)), str(path)
    return WN3_INSERT_COPY, 'copy read 2026-10-19 (3.2a\'s deployed job)'


def daily_params(space, day):
    """The 13 values both weather_daily writers bind, in their column order."""
    return [space, day, 0.12, 81, 59, 0.2, 'openmeteo_live', 'openmeteo_live', 50000, 30000, 20.5, 9, 2]


def arming_cases(conn, space):
    p1 = plot1(conn, space)
    hits = writer_census()
    paths = {h[0] for h in hits}
    check('6 census by rule finds every writer V204 row 3.2a names', PLAN_NAMED_WRITERS <= paths,
          str(sorted(PLAN_NAMED_WRITERS - paths)))
    writers = [h for h in hits if h[2]]
    others = [f'{p}:{n}' for p, n, t, _ in hits if not t]
    print('      census hits: ' + '; '.join(f'{p}:{n} {t}({",".join(c)})' for p, n, t, c in writers)
          + (f'; not a writer (no column list): {", ".join(others)}' if others else ''), flush=True)
    named = [f'{p}:{n}' for p, n, _, c in writers if 'plot_id' in c and not p.startswith(f'migrations/{MINE}/')]
    check('6 census: no writer outside this directory names plot_id (the deployed code is unchanged by this step)',
          not named, str(named))
    fixture = None
    with case(conn):
        fixture = new_space(conn, 'rh-arm-fixture')   # an integration-test Space: no plot, as tests make them
        for i, (path, line, table, cols) in enumerate(writers):
            if 'plot_id' in cols:
                continue
            for label, sp in (('Dave\'s Space', space), ('a plot-less fixture Space', fixture)):
                sql, vals = census_insert(table, cols, sp, i)
                st, msg = err_of(conn, sql, vals)
                check(f'6 arming: {path}:{line} {table}({len(cols)} cols) into {label} succeeds after 0a',
                      st is None, f'{st} {msg[:60]}')
        n_null = conn.execute("SELECT count(*) FROM public.weather_daily WHERE \"date\" < '1991-01-01' "
                              'AND plot_id IS NULL').fetchone()[0]
        check('6 arming: those rows carry plot_id NULL (no default stamps a plot)', n_null > 0, str(n_null))
    # The test can red: the same writes against a mutant that arms a NOT VALID CHECK on plot_id.
    with case(conn):
        for t in ('weather_daily', 'weather_cold_range'):
            conn.execute(f'ALTER TABLE public.{t} ADD CONSTRAINT zz_plot_required CHECK (plot_id IS NOT NULL) NOT VALID')
        refused = 0
        for i, (path, line, table, cols) in enumerate(writers):
            if 'plot_id' in cols:
                continue
            sql, vals = census_insert(table, cols, space, i)
            refused += err_of(conn, sql, vals)[0] == '23514'
        check('6 arming control: a mutant with CHECK (plot_id IS NOT NULL) NOT VALID refuses every census writer '
              '(23514)', refused == len([w for w in writers if 'plot_id' not in w[3]]), str(refused))

    sql, n = handler_statement()
    check('6 handler.js upsert extracted: 13 parameters, arbiter on conflict (space_id, "date")',
          n == 13 and 'on conflict (space_id, "date") do update set' in sql, str(n))
    old_day = conn.execute('SELECT max("date")::text FROM public.weather_daily WHERE space_id = %s',
                           (space,)).fetchone()[0]
    with case(conn):
        st, msg = err_of(conn, sql, binds(daily_params(space, '2031-07-01')))
        check('6 handler.js upsert, a new day: succeeds after 0a, plot_id NULL', st is None
              and plot_of_daily(conn, space, '2031-07-01') == (None,), f'{st} {msg[:60]}')
        st, msg = err_of(conn, sql, binds(daily_params(space, old_day)))
        check('6 handler.js upsert, a backfilled day (DO UPDATE): succeeds, the row keeps Plot 1',
              st is None and plot_of_daily(conn, space, old_day) == (p1,), f'{st} {msg[:60]}')
    sql, n = backfill_statement()
    check('6 backfill-weather-daily.mjs upsert extracted: 13 parameters', n == 13, str(n))
    with case(conn):
        prm = daily_params(space, '2031-07-02')
        prm[6], prm[7] = 'openmeteo_archive', 'openmeteo_archive'
        st, msg = err_of(conn, sql, binds(prm))
        check('6 backfill-weather-daily.mjs upsert, a new day: succeeds, plot_id NULL', st is None
              and plot_of_daily(conn, space, '2031-07-02') == (None,), f'{st} {msg[:60]}')
        prm = daily_params(space, old_day)
        prm[6], prm[7] = 'openmeteo_archive', 'openmeteo_archive'
        st, msg = err_of(conn, sql, binds(prm))
        check('6 backfill-weather-daily.mjs upsert, a backfilled day: succeeds, the row keeps Plot 1',
              st is None and plot_of_daily(conn, space, old_day) == (p1,), f'{st} {msg[:60]}')
    stmt, src = wn3_statement()
    check(f'6 wn3_send.py INSERT read ({src}): seven columns, bare ON CONFLICT DO NOTHING',
          stmt.rstrip().endswith('ON CONFLICT DO NOTHING') and all(c in stmt for c in SEVEN) and 'plot_id' not in stmt)
    old_night = conn.execute('SELECT night_date, init_time FROM public.weather_cold_range WHERE space_id = %s '
                             'ORDER BY night_date DESC LIMIT 1', (space,)).fetchone()
    with case(conn):
        # The real role when this session may become it (a prod fork whose owner holds SET on it), else a probe
        # role made here with exactly the seven column grants 1a-writer-role.sql gives garden_wx_writer.
        role = 'garden_wx_writer'
        if err_of(conn, f'SET LOCAL ROLE {role}')[0] is None:
            conn.execute('RESET ROLE')
        else:
            role = PROBE_ROLE
            st, msg = err_of(conn, f'CREATE ROLE {role} NOLOGIN; GRANT USAGE ON SCHEMA public TO {role}; '
                                   f'GRANT INSERT ({", ".join(SEVEN)}) ON public.weather_cold_range TO {role}; '
                                   f'GRANT {role} TO CURRENT_USER WITH SET TRUE')
            if st is not None:
                print(f'SKIP  6 wn3_send.py INSERT as a seven-column role  [no role available: {st} {msg[:60]}]')
                return
        conn.execute(f'SET LOCAL ROLE {role}')
        print(f'      wn3_send.py leg runs as {role}', flush=True)
        cur = conn.cursor()
        try:
            with conn.transaction():
                cur.execute(stmt, (space, '2031-10-01', '2031-10-01T12:00:00Z', 30.5, 33.0, 15, 15))
            new_rc, st = cur.rowcount, None
            with conn.transaction():
                cur.execute(stmt, (space, '2031-10-01', '2031-10-01T12:00:00Z', 30.5, 33.0, 15, 15))
            dup_rc = cur.rowcount
            with conn.transaction():
                cur.execute(stmt, (space, old_night[0], old_night[1], 30.5, 33.0, 15, 15))
            old_rc = cur.rowcount
        except psycopg.Error as e:
            new_rc = dup_rc = old_rc = None
            st = e.sqlstate
        conn.execute('RESET ROLE')
        check('6 wn3_send.py INSERT as a role holding only its seven column grants: a new night writes 1 row, '
              'the same night again 0, a backfilled night 0 (DO NOTHING)', (st, new_rc, dup_rc, old_rc) ==
              (None, 1, 0, 0), str((st, new_rc, dup_rc, old_rc)))
        row = conn.execute("SELECT plot_id FROM public.weather_cold_range WHERE night_date = '2031-10-01'").fetchone()
        check('6 wn3_send.py row carries plot_id NULL until 3.2c sends it', row == (None,), str(row))


# ── Keys, indexes, the C-GUARD body, tightened arms ─────────────────────────────────────────────────
def key_cases(conn, space):
    p1 = plot1(conn, space)
    with case(conn):
        other = new_space(conn, 'rh-k-other')
        q = new_plot(conn, other, 'rh-k-other', default=True)
        st, _ = err_of(conn, 'INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, %s, %s)',
                       (space, q, '2031-01-01'))
        check("7 key: a row of Dave's Space naming another Space's plot -> 23503 (NOT VALID still checks new rows)",
              st == '23503', str(st))
        st, _ = err_of(conn, 'UPDATE public.weather_cold_range SET plot_id = %s WHERE space_id = %s', (q, space))
        check('7 key: a backfilled row moved to another Space\'s plot -> 23503', st == '23503', str(st))
        st, _ = err_of(conn, 'INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, NULL, %s)',
                       (space, '2031-01-01'))
        check('7 key: a row with plot_id NULL is not checked (MATCH SIMPLE)', st is None, str(st))
        st, msg = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (p1,))
        check('7 key: Plot 1 with weather refuses delete: P0001 plots_delete_guard', st == 'P0001'
              and msg.startswith('plots_delete_guard'), f'{st} {msg[:60]}')
        bare = new_space(conn, 'rh-k-bare')   # no plot, so the one-default index does not answer first
        st, msg = err_of(conn, 'UPDATE public.plots SET workspace_id = %s WHERE id = %s', (bare, p1))
        check("7 key: Plot 1 moved to another Space while weather names it -> 23503 (ON UPDATE NO ACTION)",
              st == '23503' and 'plot_id_space_id_fkey' in msg, f'{st} {msg[:90]}')
    with case(conn):
        conn.execute('DROP TRIGGER plots_delete_guard ON public.plots')
        st, msg = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (p1,))
        check('7 key: with plots_delete_guard dropped, the key itself refuses: 23503 naming a plot key '
              '(ON DELETE RESTRICT)', st == '23503' and 'plot_id_space_id_fkey' in msg, f'{st} {msg[:90]}')


def guard_cases(conn, space):
    p1 = plot1(conn, space)
    check('7 C-GUARD body after 0a is this step\'s (md5)', md5_of_guard(conn) == NEW_MD5, md5_of_guard(conn))
    for label, sql in (('lat moved', 'UPDATE public.plots SET lat = lat + 0.001 WHERE id = %s'),
                       ('postal_code -> NULL', 'UPDATE public.plots SET postal_code = NULL WHERE id = %s'),
                       ('timezone changed', "UPDATE public.plots SET timezone = 'America/Chicago' WHERE id = %s")):
        with case(conn):
            st, msg = err_of(conn, sql, (p1,))
            check(f'7 C-GUARD Plot 1 (backfilled weather names it): {label} -> P0001 plots_repoint_guard',
                  st == 'P0001' and msg.startswith('plots_repoint_guard'), f'{st} {msg[:50]}')
    with case(conn):
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat, lng = lng, postal_code = postal_code, '
                             'timezone = timezone, name = name WHERE id = %s', (p1,))
        check('7 C-GUARD same-value SET and name: pass', st is None, str(st))

    def scenario(conn, kind):
        """Returns the plot to move, in a Space shaped for `kind`."""
        if kind == 'nondefault-with-weather':
            p2 = new_plot(conn, space, 'rh-g-p2')
            add_daily(conn, space, '2031-02-01', p2)
            return p2
        if kind == 'nondefault-with-cold':
            p2 = new_plot(conn, space, 'rh-g-p2c')
            add_cold(conn, space, '2031-02-01', p2)
            return p2
        s = new_space(conn, f'rh-g-{kind}')
        q = new_plot(conn, s, 'rh-g-default', default=True, lat=41, lng=-71)
        r = new_plot(conn, s, 'rh-g-second', lat=42, lng=-72)
        if kind == 'default-null-rows':
            add_daily(conn, s, '2031-03-01', None)
        elif kind == 'default-null-cold':
            add_cold(conn, s, '2031-03-01', None)
        elif kind == 'default-rows-elsewhere':
            add_daily(conn, s, '2031-03-01', r)
            add_cold(conn, s, '2031-03-01', r)
        elif kind == 'second-with-null-rows':
            add_daily(conn, s, '2031-03-01', None)
            return r
        return q

    expect = [
        ('nondefault-with-weather', 'P0001', 'a non-default plot that weather_daily names'),
        ('nondefault-with-cold', 'P0001', 'a non-default plot that weather_cold_range names'),
        ('default-null-rows', 'P0001', 'a default plot whose Space has weather_daily rows with no plot yet'),
        ('default-null-cold', 'P0001', 'a default plot whose Space has a cold-range row with no plot yet'),
        ('default-rows-elsewhere', None, "a default plot whose Space's weather all names its second plot"),
        ('second-with-null-rows', None, 'a non-default plot while the Space has rows with no plot (the default\'s)'),
    ]
    for kind, want, label in expect:
        with case(conn):
            q = scenario(conn, kind)
            st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat + 0.5 WHERE id = %s', (q,))
            check(f'7 C-GUARD {label}: {"P0001" if want else "moves"}', st == want, str(st))
    with case(conn):
        s = new_space(conn, 'rh-g-becomes')
        new_plot(conn, s, 'rh-g-old-default', default=True)
        r = new_plot(conn, s, 'rh-g-r', lat=42, lng=-72)
        add_daily(conn, s, '2031-03-01', None)
        conn.execute('UPDATE public.plots SET is_default = false WHERE workspace_id = %s', (s,))
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = 40, is_default = true WHERE id = %s', (r,))
        check('7 C-GUARD a plot that becomes default while moving, Space has rows with no plot: P0001',
              st == 'P0001', str(st))
    # 3.1's body, put back after the stamp: what the replacement fixes, and it reds the md5 pin.
    with case(conn):
        conn.execute(OLD_BODY)
        q = scenario(conn, 'nondefault-with-weather')
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat + 0.5 WHERE id = %s', (q,))
        check("7 C-GUARD 3.1's body would let a non-default plot with weather move (what 3.2a fixes)", st is None,
              str(st))
        q = scenario(conn, 'default-rows-elsewhere')
        st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat + 0.5 WHERE id = %s', (q,))
        check("7 C-GUARD 3.1's body would freeze a default plot for another plot's weather (what 3.2a fixes)",
              st == 'P0001', str(st))
        check("7 tightened arm: 3.1's body after the stamp reds v5-plottier-001 post_plots_guard_functions_pinned",
              gate_rows(conn, 'v5-plottier-001', 'post_plots_guard_functions_pinned') == ['guard_plots_repoint'])
    mutants = [
        ("weather_daily plot arm dropped", NEW_BODY.replace(
            '(EXISTS (SELECT 1 FROM public.weather_daily w WHERE w.plot_id = OLD.id)\n          OR ', '('),
         'nondefault-with-weather', None),
        ("cold-range plot arm dropped", NEW_BODY.replace(
            '\n          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.plot_id = OLD.id)', ''),
         'nondefault-with-cold', None),
        ("NULL-plot arm's default condition dropped (a non-default plot frozen by the default's rows)",
         NEW_BODY.replace('(OLD.is_default OR NEW.is_default)\n              AND ', ''),
         'second-with-null-rows', 'P0001'),
        ("weather_daily NULL arm dropped", NEW_BODY.replace(
            "(EXISTS (SELECT 1 FROM public.weather_daily w\n                            WHERE w.plot_id IS NULL AND "
            "w.space_id IN (OLD.workspace_id, NEW.workspace_id))\n                   OR ", '('),
         'default-null-rows', None),
        ("'<>' for IS DISTINCT FROM (postal_code -> NULL slips through)", NEW_BODY.replace('IS DISTINCT FROM', '<>'),
         'p1-postal-null', None),
    ]
    for label, ddl, kind, want in mutants:
        with case(conn):
            check(f'mutant built: {label}', ddl != NEW_BODY)
            conn.execute(ddl)
            if kind == 'p1-postal-null':
                st, _ = err_of(conn, 'UPDATE public.plots SET postal_code = NULL WHERE id = %s', (p1,))
            else:
                q = scenario(conn, kind)
                st, _ = err_of(conn, 'UPDATE public.plots SET lat = lat + 0.5 WHERE id = %s', (q,))
            check(f'mutant killed: {label}', st == want, str(st))
            check(f'mutant reds post_plots_guard_functions_pinned: {label}',
                  gate_rows(conn, 'v5-plottier-001', 'post_plots_guard_functions_pinned') == ['guard_plots_repoint'])


def tightened_arm_cases(conn, space):
    """Every edited gate, and each of this directory's post gates, red on a planted violation after the stamp."""
    wd, wcr = 'v4-weatherdaily-001', 'v5-wxcoldband-001'
    planted = [
        (wd, 'post_no_extra_columns', 'ALTER TABLE public.weather_daily ADD COLUMN zz int', ['zz']),
        (wcr, 'post_no_column_outside_the_eight', 'ALTER TABLE public.weather_cold_range ADD COLUMN zz int', ['zz']),
        (wcr, 'post_primary_key_is_the_only_unique_index',
         'CREATE UNIQUE INDEX zz_cold ON public.weather_cold_range (space_id, night_date)', ['zz_cold']),
        (wcr, 'post_primary_key_is_the_only_unique_index',
         'DROP INDEX public.weather_cold_range_plot_id_night_date_init_time_key',
         ['missing: weather_cold_range_plot_id_night_date_init_time_key']),
        (wcr, 'post_primary_key_is_the_only_unique_index',
         'DROP INDEX public.weather_cold_range_plot_id_night_date_init_time_key; CREATE UNIQUE INDEX '
         'weather_cold_range_plot_id_night_date_init_time_key ON public.weather_cold_range (plot_id, night_date, '
         'init_time) NULLS NOT DISTINCT', ['weather_cold_range_plot_id_night_date_init_time_key']),
        (wcr, 'post_primary_key_is_the_only_unique_index',
         'DROP INDEX public.weather_cold_range_plot_id_night_date_init_time_key; CREATE UNIQUE INDEX '
         'weather_cold_range_plot_id_night_date_init_time_key ON public.weather_cold_range (plot_id, night_date, '
         'init_time) WHERE plot_id IS NOT NULL', ['weather_cold_range_plot_id_night_date_init_time_key']),
        (wcr, 'post_exactly_one_fk_cascade_validated_to_spaces',
         'ALTER TABLE public.weather_cold_range DROP CONSTRAINT weather_cold_range_plot_id_space_id_fkey',
         ['missing or different: weather_cold_range_plot_id_space_id_fkey']),
        (wcr, 'post_exactly_one_fk_cascade_validated_to_spaces',
         'ALTER TABLE public.weather_cold_range DROP CONSTRAINT weather_cold_range_plot_id_space_id_fkey; '
         'ALTER TABLE public.weather_cold_range ADD CONSTRAINT weather_cold_range_plot_id_space_id_fkey FOREIGN KEY '
         '(plot_id, space_id) REFERENCES public.plots (id, workspace_id) ON DELETE CASCADE NOT VALID',
         ['missing or different: weather_cold_range_plot_id_space_id_fkey']),
        (wcr, 'post_exactly_one_fk_cascade_validated_to_spaces',
         'ALTER TABLE public.weather_cold_range ALTER COLUMN plot_id SET NOT NULL',
         ['missing or different: weather_cold_range_plot_id_space_id_fkey']),
        (wcr, 'post_exactly_one_fk_cascade_validated_to_spaces',
         'ALTER TABLE public.weather_cold_range ADD CONSTRAINT zz_fk FOREIGN KEY (space_id) REFERENCES '
         'public.spaces (id)', ['other foreign key: zz_fk']),
        (MINE, 'post_plot_id_columns_uuid_without_default',
         'ALTER TABLE public.weather_daily ALTER COLUMN plot_id SET DEFAULT gen_random_uuid()', ['weather_daily']),
        (MINE, 'post_plot_keys_exact',
         'ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_plot_id_space_id_fkey; ALTER TABLE '
         'public.weather_daily ADD CONSTRAINT weather_daily_plot_id_space_id_fkey FOREIGN KEY (plot_id, space_id) '
         'REFERENCES public.plots (id, workspace_id) ON DELETE CASCADE NOT VALID',
         ['weather_daily_plot_id_space_id_fkey']),
        (MINE, 'post_plot_keys_exact', 'ALTER TABLE public.weather_daily ALTER COLUMN plot_id SET NOT NULL',
         ['weather_daily_plot_id_space_id_fkey']),
        (MINE, 'post_plot_keys_exact',
         'ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_plot_id_space_id_fkey; ALTER TABLE '
         'public.weather_daily ADD CONSTRAINT weather_daily_plot_id_space_id_fkey FOREIGN KEY (plot_id, space_id) '
         'REFERENCES public.plots (id, workspace_id) MATCH FULL ON DELETE RESTRICT NOT VALID',
         ['weather_daily_plot_id_space_id_fkey']),
        (MINE, 'post_plot_unique_indexes_exact', 'DROP INDEX public.weather_daily_plot_id_date_key',
         ['weather_daily_plot_id_date_key']),
    ]
    for dir_, name, ddl, want in planted:
        with case(conn):
            before = gate_rows(conn, dir_, name)
            for stmt in ddl.split('; '):
                conn.execute(stmt)
            got = gate_rows(conn, dir_, name)
            check(f'7 tightened arm {dir_} {name}: green, then red on [{ddl[:70]}...]', before == [] and got == want,
                  str(got))
    with case(conn):
        conn.execute('ALTER TABLE public.weather_cold_range ALTER COLUMN plot_id SET NOT NULL')
        conn.execute('ALTER TABLE public.weather_cold_range VALIDATE CONSTRAINT weather_cold_range_plot_id_space_id_fkey')
        conn.execute('ALTER TABLE public.weather_daily ALTER COLUMN plot_id SET NOT NULL')
        conn.execute('ALTER TABLE public.weather_daily VALIDATE CONSTRAINT weather_daily_plot_id_space_id_fkey')
        check("7 3.2d's end state (NOT NULL + VALIDATE): both key gates green",
              gate_rows(conn, wcr, 'post_exactly_one_fk_cascade_validated_to_spaces') == []
              and gate_rows(conn, MINE, 'post_plot_keys_exact') == [])
    # Data gates.
    label = '7 post_weather_plot_is_of_the_rows_own_space: a cross-Space pair planted past the key reds'
    if superuser(conn, label):
        with case(conn):
            other = new_space(conn, 'rh-d-other')
            q = new_plot(conn, other, 'rh-d-other', default=True)
            conn.execute('SET LOCAL session_replication_role = replica')
            add_daily(conn, space, '2031-04-01', q)
            add_cold(conn, space, '2031-04-01', q)
            conn.execute('SET LOCAL session_replication_role = origin')
            got = gate_rows(conn, MINE, 'post_weather_plot_is_of_the_rows_own_space')
            check(f'{label}, naming both rows', len(got) == 2 and all(f'plot {q}' in g for g in got), str(got)[:120])
    with case(conn):
        check('7 receipt green after 0a', gate_rows(conn, MINE,
                                                     'post_receipt_daves_space_weather_carries_its_default_plot') == [])
        add_daily(conn, space, '2031-04-02', None)
        check("7 receipt: a deployed writer's NULL-plot row after the apply makes it false (continuous: false)",
              len(gate_rows(conn, MINE, 'post_receipt_daves_space_weather_carries_its_default_plot')) == 1)
    # Self-arm: with the stamp gone every standing gate here is vacuous, the recorder reds, and every edited gate's
    # tolerant arm closes again (plot_id, the index, the key and the new body are each a row).
    with case(conn):
        conn.execute('DELETE FROM public.schema_version WHERE version = %s', (STAMP,))
        reds = {n for n in POST_GATES if gate_rows(conn, MINE, n)}
        check('7 self-arm: stamp deleted -> only post_schema_version_recorded reds here',
              reds == {'post_schema_version_recorded'}, str(sorted(reds)))
        edited = {(d, n): gate_rows(conn, d, n) for d, n in EXPECTED_NEWLY_RED}
        check('7 self-arm: stamp deleted -> every edited gate reds on this step\'s objects (tight without the stamp)',
              all(edited.values()), str({k[1]: v for k, v in edited.items()})[:200])


def later_step_cases(conn, space):
    p1 = plot1(conn, space)
    with case(conn):
        add_daily(conn, space, '2031-05-01', None)
        conn.execute('INSERT INTO public.weather_daily (space_id, plot_id, "date", tmax_f) VALUES (%s, %s, %s, 70) '
                     'ON CONFLICT (space_id, "date") DO UPDATE SET plot_id = coalesce(weather_daily.plot_id, '
                     'excluded.plot_id), tmax_f = excluded.tmax_f', (space, p1, '2031-05-01'))
        check("8 3.2b's upsert heals a NULL-plot row onto Plot 1", plot_of_daily(conn, space, '2031-05-01') == (p1,))
        st, _ = err_of(conn, 'INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, %s, %s) '
                             'ON CONFLICT (space_id, "date") DO UPDATE SET plot_id = coalesce(weather_daily.plot_id, '
                             'excluded.plot_id)', (space, None, '2031-05-01'))
        check("8 3.2b's upsert with no plot keeps a stamped row's plot", st is None
              and plot_of_daily(conn, space, '2031-05-01') == (p1,), str(st))
    with case(conn):
        d = conn.execute('SELECT "date" FROM public.weather_daily WHERE space_id = %s LIMIT 1', (space,)).fetchone()[0]
        cur = conn.execute('INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, %s, %s) '
                           'ON CONFLICT (plot_id, "date") DO NOTHING', (space, p1, d))
        n = conn.execute('SELECT night_date, init_time FROM public.weather_cold_range WHERE space_id = %s LIMIT 1',
                         (space,)).fetchone()
        cur2 = conn.execute('INSERT INTO public.weather_cold_range (space_id, plot_id, night_date, init_time, '
                            'p10_min_f, leads_read, leads_expected) VALUES (%s, %s, %s, %s, 30, 15, 15) '
                            'ON CONFLICT (plot_id, night_date, init_time) DO NOTHING', (space, p1, n[0], n[1]))
        check("8 3.3a's arbiters: ON CONFLICT (plot_id, \"date\") and (plot_id, night_date, init_time) infer the "
              'indexes (0 rows on a backfilled key)', cur.rowcount == 0 and cur2.rowcount == 0,
              f'{cur.rowcount} {cur2.rowcount}')
    with case(conn):
        for t, k in (('weather_daily', 'weather_daily_plot_id_space_id_fkey'),
                     ('weather_cold_range', 'weather_cold_range_plot_id_space_id_fkey')):
            conn.execute(f'ALTER TABLE public.{t} VALIDATE CONSTRAINT {k}')
            conn.execute(f'ALTER TABLE public.{t} ALTER COLUMN plot_id SET NOT NULL')
        check("8 3.2d: both keys VALIDATE and plot_id takes NOT NULL after the backfill", True)
        st, _ = err_of(conn, 'INSERT INTO public.weather_daily (space_id, "date") VALUES (%s, %s)', (space, '2031-06-01'))
        check("8 3.2d: then an insert without plot_id -> 23502", st == '23502', str(st))
        st1, m1 = err_of(conn, 'ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_pkey, '
                               'ADD CONSTRAINT weather_daily_pkey PRIMARY KEY USING INDEX weather_daily_plot_id_date_key')
        st2, m2 = err_of(conn, 'ALTER TABLE public.weather_cold_range DROP CONSTRAINT weather_cold_range_pkey, '
                               'ADD CONSTRAINT weather_cold_range_pkey PRIMARY KEY USING INDEX '
                               'weather_cold_range_plot_id_night_date_init_time_key')
        check("8 3.4: ADD PRIMARY KEY USING INDEX takes both plot indexes", st1 is None and st2 is None,
              f'{st1} {m1[:60]} {st2} {m2[:60]}')
    label = "8 3.2d: a cross-Space (plot_id, space_id) pair planted past the key makes VALIDATE raise 23503"
    if superuser(conn, label):
        with case(conn):
            other = new_space(conn, 'rh-v-other')
            q = new_plot(conn, other, 'rh-v-other', default=True)
            conn.execute('SET LOCAL session_replication_role = replica')
            add_daily(conn, space, '2031-06-02', q)
            conn.execute('SET LOCAL session_replication_role = origin')
            st, _ = err_of(conn, 'ALTER TABLE public.weather_daily VALIDATE CONSTRAINT '
                                 'weather_daily_plot_id_space_id_fkey')
            check(label, st == '23503', str(st))


# ── The backfill pre-gate and the definition pre-gate: 0a refusals ────────────────────────────────
def refusal_cases(cl, base):
    db = 'rh_wxplotid_refuse'
    cases = [
        ('a second Space with its plot and weather rows',
         lambda c: (lambda s: (new_plot(c, s, 'B', default=True), add_daily(c, s, '2031-01-01'),
                               add_daily(c, s, '2031-01-02'), add_cold(c, s, '2031-01-01'), s))(new_space(c, 'rh-B'))[-1],
         lambda s: ['there are 2', f'{s}: weather_daily 2 row(s)', f'{s}: weather_cold_range 1 row(s)'],
         {'pre_daves_space_is_the_one_spaces_row', 'pre_weather_rows_name_only_daves_space'}),
        ('a second Space with its plot and no weather',
         lambda c: (lambda s: (new_plot(c, s, 'B', default=True), s))(new_space(c, 'rh-B0'))[-1],
         lambda s: ['there are 2', str(s)],
         {'pre_daves_space_is_the_one_spaces_row', 'pre_weather_rows_name_only_daves_space'}),
        ('a weather row naming a Space other than Dave\'s (planted past the key)',
         lambda c: (c.execute('SET session_replication_role = replica'),
                    c.execute("INSERT INTO public.weather_daily (space_id, \"date\") VALUES "
                              "('11111111-2222-3333-4444-555555555555', '2031-01-01')"),
                    c.execute('SET session_replication_role = origin'))[-1] and '11111111-2222-3333-4444-555555555555',
         lambda s: ["name a Space other than Dave's", '11111111-2222-3333-4444-555555555555: weather_daily 1 row(s)'],
         {'pre_weather_rows_name_only_daves_space'}),
        ("Dave's Space has no live default plot (Plot 1 soft-deleted)",
         lambda c: c.execute('UPDATE public.plots SET deleted_at = now()') and None,
         lambda s: ['no single live default plot'], {'pre_daves_space_has_one_live_default_plot'}),
        ('the C-GUARD body changed since 3.1 (definition pre-gate)',
         lambda c: c.execute(OLD_BODY.replace('IS DISTINCT FROM', '<>')) and None,
         lambda s: ['body md5 is', 'not the one this file was written from'], {'pre_guard_plots_repoint_is_the_3_1_body'}),
        ('a plot_id column made by something else (name collision)',
         lambda c: c.execute('ALTER TABLE public.weather_cold_range ADD COLUMN plot_id uuid') and None,
         lambda s: ['column weather_cold_range.plot_id', 'has no stamp'], {'pre_names_free'}),
    ]
    for label, plant, needles, pre_red in cases:
        cl.clone(base, db)
        with psycopg.connect(cl.url(db), autocommit=True) as c:
            c.execute("SELECT set_config('app.actor_clerk_sub', %s, false)", (OWNER,))
            s = plant(c)
            fp = fingerprint(c)
            counts = c.execute('SELECT (SELECT count(*) FROM public.weather_daily), '
                               '(SELECT count(*) FROM public.weather_cold_range)').fetchone()
        pre = cl.gates(db, HERE, phase='pre')
        got = {n for (_, _, n) in bad(pre)}
        check(f'9 {label}: pre gates red exactly {sorted(pre_red)}', got == pre_red, str(sorted(got)))
        rc, err = cl.psql_file(db, HERE / '0a-wxplotid.sql')
        with psycopg.connect(cl.url(db)) as c:
            same = fingerprint(c) == fp and c.execute(
                'SELECT (SELECT count(*) FROM public.weather_daily), '
                '(SELECT count(*) FROM public.weather_cold_range)').fetchone() == counts
        want = needles(s)
        check(f'9 0a refuses ({label}), nothing changed', rc != 0 and 'refused, nothing changed' in err
              and all(w in err for w in want) and same, err.splitlines()[-1][-220:] if err else '')
        cl.drop(db)


def shape_case(cl, base, label, prepare, expect_notice, base_runner):
    db = 'rh_wxplotid_shape'
    cl.clone(base, db)
    with psycopg.connect(cl.url(db), autocommit=True) as c:
        c.execute('SET session_replication_role = replica')
        prepare(c)
        c.execute('SET session_replication_role = origin')
    pre = cl.gates(db, HERE, phase='pre')
    check(f'10 {label}: every pre gate PASS', not bad(pre), str(sorted(bad(pre))))
    before = {(env, r): cl.gates(db, env=env, runner=r) for env in ('prod', 'staging') for r in (None, base_runner)}
    rc, err = cl.psql_file(db, HERE / '0a-wxplotid.sql')
    check(f'10 {label}: 0a exit 0, NOTICE says {expect_notice}', rc == 0 and all(n in err for n in expect_notice),
          err[-200:])
    post = cl.gates(db, HERE)
    check(f'10 {label}: post gates PASS, receipt included', not bad(post), str(sorted(bad(post))))
    for env in ('prod', 'staging'):
        after_e, after_b = cl.gates(db, env=env), cl.gates(db, env=env, runner=base_runner)
        check(f'10 {label} C-CONV ({env}): edited corpus newly red = newly green = {{}}, base corpus newly red = '
              'expected, no ERROR', not newly(before[(env, None)], after_e) and not newly(after_e, before[(env, None)])
              and newly(before[(env, base_runner)], after_b) == EXPECTED_NEWLY_RED and not errors(after_e),
              str(sorted(newly(before[(env, None)], after_e))))
    with psycopg.connect(cl.url(db)) as c:
        rows = c.execute('SELECT (SELECT count(*) FROM public.weather_daily), '
                         '(SELECT count(*) FROM public.weather_cold_range), '
                         '(SELECT count(*) FROM public.weather_cold_range c JOIN public.plots p ON p.id = c.plot_id '
                         '  WHERE p.is_default AND p.lat IS NULL)').fetchone()
    cl.drop(db)
    return rows


def unrefused_0r(cl, db, label, plant, needle):
    with psycopg.connect(cl.url(db), autocommit=True) as c:
        plant(c)
        fp = fingerprint(c)
    rc, err = cl.psql_file(db, HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url(db)) as c:
        kept = fingerprint(c) == fp
    check(f'11 0r refuses ({label}), nothing dropped', rc != 0 and needle in err and kept, err[-160:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--base-db', required=True)
    args = ap.parse_args()
    cl = Cluster(args.port)
    a0, a1 = 'rh_wxplotid_after', 'rh_wxplotid_cycle'
    tmp = tempfile.TemporaryDirectory(prefix='rh-wxplotid-corpus-')
    try:
        base_runner = base_corpus(tmp.name)
        # 1. pre gates on the base
        pre = cl.gates(args.base_db, HERE, phase='pre')
        check('1 pre gates on the base: every gate PASS', not bad(pre), str(sorted(bad(pre))))
        with psycopg.connect(cl.url(args.base_db)) as c:
            fp_base = fingerprint(c)
            check('1 base: guard_plots_repoint is 3.1\'s body', md5_of_guard(c) == OLD_MD5)

        # 2. C-CONV before, both corpora, both envs
        before = {(env, r): cl.gates(args.base_db, env=env, runner=r)
                  for env in ('prod', 'staging') for r in (None, base_runner)}
        for (env, r), g in before.items():
            corpus = 'base-SHA corpus' if r else 'edited corpus'
            check(f'2 C-CONV before ({env}, {corpus}): no gate ERRORs (an ERROR here is a rehearsal FAULT)',
                  not errors(g), str(errors(g)))
        for env in ('prod', 'staging'):
            diff = newly(before[(env, base_runner)], before[(env, None)]) | newly(before[(env, None)],
                                                                                 before[(env, base_runner)])
            check(f'2 tolerant before the DDL ({env}): edited and base-SHA corpora agree on the base', not diff,
                  str(sorted(diff)))

        # 3. 0a
        cl.clone(args.base_db, a0)
        rc, err = cl.psql_file(a0, HERE / '0a-wxplotid.sql')
        check('3 0a applies: exit 0', rc == 0, err[-300:])
        m = re.search(r'backfill pre-gate: (.*?)\n', err + '\n')
        check('3 the backfill pre-gate printed its counts', bool(m) and 'weather_daily' in m.group(1)
              and 'rows naming any other Space: 0' in m.group(1), m.group(1)[:220] if m else err[-200:])
        print(f'      {m.group(1) if m else ""}', flush=True)

        # 4. this directory's post gates
        post = cl.gates(a0, HERE)
        check('4 post gates after 0a: every gate PASS, receipt included', not bad(post), str(sorted(bad(post))))

        # 5. C-CONV after
        for env in ('prod', 'staging'):
            after_b, after_e = cl.gates(a0, env=env, runner=base_runner), cl.gates(a0, env=env)
            nb = newly(before[(env, base_runner)], after_b)
            check(f'5 C-CONV base-SHA corpus newly red ({env}) = expected {len(EXPECTED_NEWLY_RED)}',
                  nb == EXPECTED_NEWLY_RED, str(sorted(nb)))
            ne, ng = newly(before[(env, None)], after_e), newly(after_e, before[(env, None)])
            check(f'5 C-CONV edited corpus ({env}): newly red = {{}} and newly green = {{}}', not ne and not ng,
                  str(sorted(ne | ng)))
            check(f'5 C-CONV after ({env}): no gate ERRORs', not errors(after_e) and not errors(after_b),
                  str(errors(after_e) + errors(after_b)))

        # 6-8. behaviour on the applied database, each case rolled back
        with psycopg.connect(cl.url(a0)) as c:
            c.execute("SELECT set_config('app.actor_clerk_sub', %s, false)", (OWNER,))
            space = the_space(c)
            c.commit()
            n = c.execute('SELECT (SELECT count(*) FROM public.weather_daily WHERE plot_id IS NULL) + '
                          '(SELECT count(*) FROM public.weather_cold_range WHERE plot_id IS NULL)').fetchone()[0]
            check("3 every weather row of Dave's Space carries Plot 1 after 0a", n == 0, str(n))
            arming_cases(c, space)
            key_cases(c, space)
            guard_cases(c, space)
            tightened_arm_cases(c, space)
            later_step_cases(c, space)
            fp_after = fingerprint(c)
        post = cl.gates(a0, HERE)
        check('8 post gates after every case (all rolled back): every gate PASS', not bad(post), str(sorted(bad(post))))

        # 9. 0a refusals
        refusal_cases(cl, args.base_db)

        # 10. NO_EVIDENCE shapes
        def staging_shape(c):
            c.execute('UPDATE public.spaces SET weather_lat = NULL, weather_lng = NULL, postal_code = NULL')
            c.execute('UPDATE public.plots SET lat = NULL, lng = NULL, postal_code = NULL')
            c.execute('DELETE FROM public.weather_daily')
            c.execute('DELETE FROM public.weather_cold_range WHERE night_date > (SELECT min(night_date) '
                      'FROM public.weather_cold_range)')
        rows = shape_case(cl, args.base_db, "staging's shape (no coordinates, no weather_daily, one cold-range row)",
                          staging_shape, ['weather_daily NO_EVIDENCE'], base_runner)
        check("10 staging's shape: weather_daily 0, the one cold-range row on the coordinate-less Plot 1",
              rows == (0, 1, 1), str(rows))
        rows = shape_case(cl, args.base_db, 'no weather at all',
                          lambda c: (c.execute('DELETE FROM public.weather_daily'),
                                     c.execute('DELETE FROM public.weather_cold_range')),
                          ['weather_daily NO_EVIDENCE', 'weather_cold_range NO_EVIDENCE'], base_runner)
        check('10 no weather at all: both tables still empty', rows == (0, 0, 0), str(rows))

        # 11. 0r refusals, each on a fresh clone of the applied database
        refusals = [
            ('a row recorded at a non-default plot',
             lambda c: (lambda q: c.execute('UPDATE public.weather_daily SET plot_id = %s WHERE "date" = '
                                            '(SELECT max("date") FROM public.weather_daily)', (q,)))(
                 new_plot(c, the_space(c), 'rh-0r-second')),
             '1 weather row(s) name a plot that is not'),
            ('plot_id NOT NULL (3.2d applied)',
             lambda c: c.execute('ALTER TABLE public.weather_cold_range ALTER COLUMN plot_id SET NOT NULL'),
             'plot_id is NOT NULL on weather_cold_range'),
            ('a later key built on plot_id (a plot index taken by a constraint, as 3.4 does)',
             lambda c: c.execute('ALTER TABLE public.weather_daily ADD CONSTRAINT zz_plot_key UNIQUE USING INDEX '
                                 'weather_daily_plot_id_date_key'),
             'weather_daily constraint zz_plot_key'),
            ("a C-GUARD body neither 3.2a's nor 3.1's", lambda c: c.execute(NEW_BODY.replace('IS DISTINCT FROM', '<>')),
             "neither 3.2a's nor 3.1's"),
        ]
        for label, plant, needle in refusals:
            cl.clone(a0, a1)
            unrefused_0r(cl, a1, label, plant, needle)
            cl.drop(a1)

        # 12. 0r
        rc, err = cl.psql_file(a0, HERE / '0r-rollback.sql')
        check('12 0r applies: exit 0', rc == 0, err[-300:])
        with psycopg.connect(cl.url(a0)) as c:
            check('12 after 0r the catalog equals the base (fingerprint, comments included)', fingerprint(c) == fp_base)
            check("12 after 0r guard_plots_repoint is 3.1's body again", md5_of_guard(c) == OLD_MD5)
        post = cl.gates(a0, HERE)
        check('12 post gates after 0r: every gate PASS (vacuous again, no 42703)', not bad(post), str(sorted(bad(post))))
        for env in ('prod', 'staging'):
            g = cl.gates(a0, env=env)
            diff = newly(before[(env, None)], g) | newly(g, before[(env, None)])
            check(f'12 after 0r the edited corpus ({env}) is as on the base', not diff and not errors(g),
                  str(sorted(diff)))
        rc, err = cl.psql_file(a0, HERE / '0r-rollback.sql')
        check('12 0r a second time: exit 0 (no-op)', rc == 0, err[-200:])

        # 13. re-apply, idempotency
        rc, err = cl.psql_file(a0, HERE / '0a-wxplotid.sql')
        check('13 0a again after 0r: exit 0', rc == 0, err[-200:])
        with psycopg.connect(cl.url(a0)) as c:
            fp1 = fingerprint(c)
        for i in (2, 3):
            rc, err = cl.psql_file(a0, HERE / '0a-wxplotid.sql')
            with psycopg.connect(cl.url(a0)) as c:
                same = fingerprint(c) == fp1
            check(f'13 0a apply #{i} on an applied database: exit 0, catalog unchanged', rc == 0 and same, err[-150:])
        check('13 the applied catalog equals the first apply (fingerprint)', fp1 == fp_after)
        post = cl.gates(a0, HERE)
        check('13 post gates after the 0r -> 0a cycle: every gate PASS, receipt included', not bad(post),
              str(sorted(bad(post))))
    finally:
        for db in (a0, a1, 'rh_wxplotid_refuse', 'rh_wxplotid_shape'):
            cl.drop(db)
        tmp.cleanup()

    failed = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(failed)}/{len(results)} PASS' + (f', {len(failed)} FAIL' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
