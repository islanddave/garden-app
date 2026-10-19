#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenancykeys-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says: prod's
schema-only dump of public, gv and extensions, and prod's schema_version, spaces, spacetheme, plots, weather_daily
and weather_cold_range rows as data. The script never writes to --base-db: it clones it (CREATE DATABASE ...
TEMPLATE) and works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates on the base                     -> every gate PASS
   2. C-CONV before: --all --phase post --json  (both --env prod and --env staging) -> no ERROR (else FAULT)
   3. 0a                                        -> exit 0
   4. this directory's post gate                -> PASS
   5. C-CONV after; newly red = after - before  -> exactly EXPECTED_NEWLY_RED (empty), per env; newly green none
   6. the gate's controls, each red then green on a clone of the applied database: an unlisted global unique index
      on favorites reds naming it (and the same key with workspace_id beside it is green); deleting one class-6
      row from the gate's exemptions reds the armed post gate naming that index; a D index that leads with neither
      the key nor an FK reds; 3.2a's (plot_id, "date") key on weather_daily is green and a ("date") key reds; a
      base-capable C key WHERE is_base is green and WHERE NOT is_base reds; NULLS NOT DISTINCT reds even with
      workspace_id
   7. self-arm: without the stamp, the planted favorites index leaves the post gate green and reds the pre gate
   8. 0a refuses on the planted index, changing nothing
   9. 0r                                        -> exit 0; the stamp gone; a re-run is a no-op; 0a again exit 0

Usage:
  python3 migrations/v5-tenancykeys-001/rehearse_local.py --port 55493 --base-db base
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import psycopg
import yaml

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
STAMP = '5.3.12-tenancykeys-001'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
GATE = 'post_s_unique_indexes_carry_workspace'
PRE_GATE = 'pre_s_unique_indexes_carry_workspace'
# C-CONV: the existing gates this step turns red, by (dir, name). README.md "C-CONV pre-scan" lists why it is empty.
EXPECTED_NEWLY_RED = set()
CLASS6_ROW = "('public', 'locations', 'idx_locations_root_slug', 6),"

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


GATES_TEXT = (HERE / 'gates.yml').read_text()
GATES = yaml.safe_load(GATES_TEXT)
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'post') for g in GATES.get(phase, [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--base-db', required=True)
    a = ap.parse_args()
    pg = Cluster(a.port)
    base, work, ctl = a.base_db, 'rh_tk_work', 'rh_tk_ctl'
    me = HERE.name

    def post_status(db, migration=HERE):
        return pg.gates(db, migration)[(Path(migration).name if Path(migration).is_dir() else Path(migration).parent.name, 'post', GATE)]

    def findings(db, sql=None):
        return sorted(pg.rows(db, sql or GATE_SQL[GATE]))

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

        # 6. controls, each on a fresh clone of the applied database: red naming the index, then green.
        plants = [
            ('unlisted global unique index on favorites',
             'CREATE UNIQUE INDEX zz_favorites_entity_global ON public.favorites (entity_type, entity_id)',
             'DROP INDEX public.zz_favorites_entity_global',
             ['public.favorites.zz_favorites_entity_global (S needs key; entity_type, entity_id)']),
            ('D index leading with neither the key nor an FK',
             'CREATE UNIQUE INDEX zz_ksl_stage_kind_id ON public.kitchen_stage_log (stage_kind, id)',
             'DROP INDEX public.zz_ksl_stage_kind_id',
             ['public.kitchen_stage_log.zz_ksl_stage_kind_id (D; stage_kind, id)']),
            ('D via plot key on date alone',
             'CREATE UNIQUE INDEX zz_wd_date ON public.weather_daily ("date")',
             'DROP INDEX public.zz_wd_date',
             ['public.weather_daily.zz_wd_date (D via plot; date)']),
            ('base-capable C key WHERE NOT is_base',
             'ALTER TABLE public.plant_varieties ADD COLUMN is_base boolean NOT NULL DEFAULT true; '
             'CREATE UNIQUE INDEX zz_pv_private_name ON public.plant_varieties (lower(name)) WHERE NOT is_base AND deleted_at IS NULL',
             'DROP INDEX public.zz_pv_private_name',
             ['public.plant_varieties.zz_pv_private_name (C base + private; <expr>)']),
            ('NULLS NOT DISTINCT, even with workspace_id',
             'CREATE UNIQUE INDEX zz_gss_nnd ON public.garden_shared_state (workspace_id, kind) NULLS NOT DISTINCT',
             'DROP INDEX public.zz_gss_nnd',
             ['public.garden_shared_state.zz_gss_nnd (S has key; workspace_id, kind)']),
        ]
        for label, plant, undo, want in plants:
            pg.clone(work, ctl)
            pg.run(ctl, plant)
            got = findings(ctl)
            check(f'6 {label}: gate rows name it', got == want, str(got))
            check(f'6 {label}: post gate FAIL through gate_runner', post_status(ctl) == 'FAIL')
            pg.run(ctl, undo)
            check(f'6 {label}: green again', findings(ctl) == [] and post_status(ctl) == 'PASS', str(findings(ctl)))
            pg.drop(ctl)

        greens = [
            ('favorites key with workspace_id (the 2.1 + 5.3 shape)',
             'ALTER TABLE public.favorites ADD COLUMN workspace_id uuid; '
             'CREATE UNIQUE INDEX zz_favorites_ws ON public.favorites (workspace_id, user_id, entity_type, entity_id)'),
            ("3.2a's weather keys on plot_id",
             'ALTER TABLE public.weather_daily ADD COLUMN plot_id uuid; '
             'CREATE UNIQUE INDEX zz_wd_plot_date ON public.weather_daily (plot_id, "date"); '
             'ALTER TABLE public.weather_cold_range ADD COLUMN plot_id uuid; '
             'CREATE UNIQUE INDEX zz_wcr_plot_night_init ON public.weather_cold_range (plot_id, night_date, init_time)'),
            ('base-capable C key WHERE is_base (the §2.5 base key)',
             'ALTER TABLE public.plant_varieties ADD COLUMN is_base boolean NOT NULL DEFAULT true; '
             'CREATE UNIQUE INDEX zz_pv_base_name ON public.plant_varieties (lower(name)) WHERE is_base AND deleted_at IS NULL'),
            ('D index leading with a single-column FK into a D table (harvest_log.event_id -> event_log)',
             'CREATE UNIQUE INDEX zz_hl_event_id ON public.harvest_log (event_id, id)'),
        ]
        for label, plant in greens:
            pg.clone(work, ctl)
            pg.run(ctl, plant)
            check(f'6 {label}: green', findings(ctl) == [] and post_status(ctl) == 'PASS', str(findings(ctl)))
            pg.drop(ctl)

        # Deleting one class-6 row from the gate's exemptions reds the armed gate; the real file is green.
        with tempfile.TemporaryDirectory() as td:
            check('6 class-6 row present in gates.yml', GATES_TEXT.count(CLASS6_ROW) == 2)
            ctl_gates = Path(td) / 'ctl-class6' / 'gates.yml'
            ctl_gates.parent.mkdir()
            ctl_gates.write_text(GATES_TEXT.replace(f'{CLASS6_ROW}\n', '').replace(CLASS6_ROW, ''))
            ctl_sql = {g['name']: g['sql'] for g in yaml.safe_load(ctl_gates.read_text())['post']}[GATE]
            got = findings(work, ctl_sql)
            check('6 class-6 row deleted: armed gate rows name the index', got == ['public.locations.idx_locations_root_slug (S needs key; slug)'], str(got))
            check('6 class-6 row deleted: post gate FAIL through gate_runner', post_status(work, ctl_gates) == 'FAIL')
            check('6 class-6 row restored (the real gates.yml): green', findings(work) == [] and post_status(work) == 'PASS')

        # 7. self-arm
        pg.clone(base, ctl)
        pg.run(ctl, 'CREATE UNIQUE INDEX zz_favorites_entity_global ON public.favorites (entity_type, entity_id)')
        check('7 no stamp + planted index: post gate PASS (vacuous)', post_status(ctl) == 'PASS')
        pre = pg.gates(ctl, HERE, 'pre')
        check('7 no stamp + planted index: pre gate FAIL', pre[(me, 'pre', PRE_GATE)] == 'FAIL', str(pre))
        # 8. 0a refuses on the same predicate, changing nothing
        rc, err = pg.psql_file(ctl, HERE / '0a-stamp.sql')
        check('8 0a refuses on a planted index', rc != 0 and 'zz_favorites_entity_global' in err, err[-200:])
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
