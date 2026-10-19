#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenancyclasses-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, and prod's schema_version, spaces, spacetheme, weather_daily and
weather_cold_range rows as data. The script never writes to --base-db: it clones it (CREATE DATABASE ... TEMPLATE)
and works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates on the base                     -> every gate PASS
   2. C-CONV before: --all --phase post --json  (both --env prod and --env staging) -> no ERROR (else FAULT)
   3. 0a                                        -> exit 0
   4. this directory's post gate                -> PASS
   5. C-CONV after; newly red = after - before  -> exactly EXPECTED_NEWLY_RED (empty), per env; newly green none
   6. the gate's controls, each red then green on a clone of the applied database: a planted table, and one
      planted relation of each other relkind (p, v, m, f) in a new schema, each red naming it; copy tables by each
      anchored pattern stay green; a classed relation renamed reds twice (unclassed + stale); plottier's stamp
      without public.plots reds (stale pending row), plottier's real 0a turns it green
   7. self-arm: without the stamp, the planted table leaves the post gate green and reds the pre gate
   8. 0a refuses on a planted table, changing nothing
   9. 0r                                        -> exit 0; the stamp gone; a re-run is a no-op; 0a again exit 0

Usage:
  python3 migrations/v5-tenancyclasses-001/rehearse_local.py --port 55482 --base-db base
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
STAMP = '5.3.8-tenancyclasses-001'
PLOTTIER = TREE / 'migrations' / 'v5-plottier-001' / '0a-plots.sql'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
GATE = 'post_tenancy_classes_closed_world'
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

    def run(self, db, sql):
        with psycopg.connect(self.url(db), autocommit=True) as c:
            c.execute(sql)

    def rows(self, db, sql):
        with psycopg.connect(self.url(db)) as c:
            return [r[0] for r in c.execute(sql).fetchall()]

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


GATES = yaml.safe_load((HERE / 'gates.yml').read_text())
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'post') for g in GATES.get(phase, [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--base-db', required=True)
    a = ap.parse_args()
    pg = Cluster(a.port)
    base, work, ctl = a.base_db, 'rh_tc_work', 'rh_tc_ctl'
    me = HERE.name

    def post_status(db):
        return pg.gates(db, HERE)[(me, 'post', GATE)]

    def findings(db):
        return sorted(pg.rows(db, GATE_SQL[GATE]))

    try:
        # 1-2
        pre = pg.gates(base, HERE, 'pre')
        check('1 pre gates PASS on the base', all(v == 'PASS' for v in pre.values()), str(pre))
        before = {}
        for env in ('prod', 'staging'):
            before[env] = pg.gates(base, env=env)
            errs = sorted(k for k, v in before[env].items() if v == 'ERROR')
            check(f'2 C-CONV before ({env}): no ERROR (else FAULT)', not errs, str(errs))
        # 3-5
        pg.clone(base, work)
        rc, err = pg.psql_file(work, HERE / '0a-stamp.sql')
        check('3 0a exit 0', rc == 0, err[-300:])
        check('3 0a wrote the stamp', pg.rows(work, f"SELECT version FROM public.schema_version WHERE version = '{STAMP}'") == [STAMP])
        check('4 post gate PASS', post_status(work) == 'PASS')
        for env in ('prod', 'staging'):
            after = pg.gates(work, env=env)
            newly = {(d, n) for (d, p, n) in bad(after) - bad(before[env])}
            green = {(d, n) for (d, p, n) in bad(before[env]) - bad(after)}
            check(f'5 C-CONV newly red ({env}) = expected {sorted(EXPECTED_NEWLY_RED)}', newly == EXPECTED_NEWLY_RED, str(sorted(newly)))
            check(f'5 C-CONV newly green ({env}) = none', not green, str(sorted(green)))
            check(f'5 C-CONV after ({env}): this gate is in the --all run and PASS', after.get((me, 'post', GATE)) == 'PASS')

        # 6. controls, each on a fresh clone of the applied database: red naming the relation, then green.
        plants = [
            ('table r', 'CREATE TABLE public.zz_planted (id int)', 'DROP TABLE public.zz_planted', ['unclassed public.zz_planted (relkind r)']),
            ('partitioned p', 'CREATE SCHEMA zz; CREATE TABLE zz.zz_part (id int) PARTITION BY RANGE (id)', 'DROP SCHEMA zz CASCADE', ['unclassed zz.zz_part (relkind p)']),
            ('view v', 'CREATE SCHEMA zz; CREATE VIEW zz.zz_view AS SELECT 1 AS x', 'DROP SCHEMA zz CASCADE', ['unclassed zz.zz_view (relkind v)']),
            ('matview m', 'CREATE MATERIALIZED VIEW public.zz_mv AS SELECT 1 AS x', 'DROP MATERIALIZED VIEW public.zz_mv', ['unclassed public.zz_mv (relkind m)']),
            ('foreign f', 'CREATE FOREIGN DATA WRAPPER zz_fdw; CREATE SERVER zz_srv FOREIGN DATA WRAPPER zz_fdw; '
                          'CREATE FOREIGN TABLE public.zz_ft (id int) SERVER zz_srv',
             'DROP FOREIGN TABLE public.zz_ft; DROP SERVER zz_srv; DROP FOREIGN DATA WRAPPER zz_fdw', ['unclassed public.zz_ft (relkind f)']),
            ('renamed classed table', 'ALTER TABLE public.maintenance_flags RENAME TO zz_flags',
             'ALTER TABLE public.zz_flags RENAME TO maintenance_flags',
             ['stale public.maintenance_flags (relkind r)', 'unclassed public.zz_flags (relkind r)']),
            ('plottier stamp without plots', "INSERT INTO public.schema_version (version, description) VALUES ('5.3.6-plottier-001', 'rehearsal')",
             None, ['stale public.plots (relkind r)']),
        ]
        for label, plant, undo, want in plants:
            pg.clone(work, ctl)
            pg.run(ctl, plant)
            got = findings(ctl)
            check(f'6 {label}: gate rows name it', got == want, str(got))
            check(f'6 {label}: post gate FAIL through gate_runner', post_status(ctl) == 'FAIL')
            if undo:
                pg.run(ctl, undo)
            else:
                rc, err = pg.psql_file(ctl, PLOTTIER)
                check('6 plottier real 0a over its own stamp exit 0', rc == 0, err[-300:])
            check(f'6 {label}: green again', findings(ctl) == [] and post_status(ctl) == 'PASS', str(findings(ctl)))
            pg.drop(ctl)

        pg.clone(work, ctl)
        rc, err = pg.psql_file(ctl, PLOTTIER)
        check('6 plottier real 0a on the applied database exit 0 (pending row now required, present)', rc == 0, err[-300:])
        check('6 after plottier: green', findings(ctl) == [] and post_status(ctl) == 'PASS', str(findings(ctl)))
        pg.run(ctl, 'DROP TABLE public.plots CASCADE')
        check('6 after plottier, plots dropped: stale public.plots', findings(ctl) == ['stale public.plots (relkind r)'], str(findings(ctl)))
        pg.drop(ctl)

        pg.clone(work, ctl)
        pg.run(ctl, ' ; '.join(f'CREATE TABLE public.{p}zz (id int)' for p in ('ctas_', 'snap_', 'harvest_log_weight_snapshot_', 'plants_legacy_cols_backup_')))
        check('6 one copy table per anchored pattern: green', findings(ctl) == [] and post_status(ctl) == 'PASS', str(findings(ctl)))
        pg.run(ctl, 'CREATE TABLE public.zz_ctas_x (id int)')
        check('6 unanchored copy-like name (zz_ctas_x): red', findings(ctl) == ['unclassed public.zz_ctas_x (relkind r)'], str(findings(ctl)))
        pg.drop(ctl)

        # 7. self-arm
        pg.clone(base, ctl)
        pg.run(ctl, 'CREATE TABLE public.zz_planted (id int)')
        check('7 no stamp + planted table: post gate PASS (vacuous)', post_status(ctl) == 'PASS')
        pre = pg.gates(ctl, HERE, 'pre')
        check('7 no stamp + planted table: pre gate FAIL', pre[(me, 'pre', 'pre_tenancy_classes_closed_world')] == 'FAIL', str(pre))
        # 8. 0a refuses on the same predicate, changing nothing
        rc, err = pg.psql_file(ctl, HERE / '0a-stamp.sql')
        check('8 0a refuses on a planted table', rc != 0 and 'zz_planted' in err, err[-200:])
        check('8 refusal changed nothing (no stamp)', pg.rows(ctl, f"SELECT version FROM public.schema_version WHERE version = '{STAMP}'") == [])
        pg.drop(ctl)

        # 9. 0r
        rc, err = pg.psql_file(work, HERE / '0r-rollback.sql')
        check('9 0r exit 0', rc == 0, err[-300:])
        check('9 0r: stamp gone', pg.rows(work, f"SELECT version FROM public.schema_version WHERE version = '{STAMP}'") == [])
        rc, err = pg.psql_file(work, HERE / '0r-rollback.sql')
        check('9 0r again: no-op exit 0', rc == 0, err[-300:])
        rc, err = pg.psql_file(work, HERE / '0a-stamp.sql')
        check('9 0a again exit 0, post PASS', rc == 0 and post_status(work) == 'PASS', err[-300:])
    finally:
        for db in (work, ctl):
            pg.drop(db)

    n_ok = sum(1 for ok, _, _ in results if ok)
    print(f'\n{n_ok}/{len(results)} PASS')
    return 0 if n_ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
