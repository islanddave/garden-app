#!/usr/bin/env python3
"""rehearse_local.py -- v5-wxwriterplot-001 (multi-space 3.2c) on a throwaway LOCAL PostgreSQL 17. Never a shared
database.

WHAT IT NEEDS: a local cluster holding --base-db loaded as v5-wxplotid-001/README.md "Rehearsal" says (prod's
schema-only dump; prod's spaces, plots, weather rows and stamps), in prod's state from 2026-10-20 (3.2a applied), with
the tables owned by a NOSUPERUSER CREATEROLE role as Neon's are, and no grant to garden_wx_writer. It clones the base
and never writes to it. --wn3-send names the cold-range job WITH the 3.2c patch applied (a scratch copy: the live
job is never touched); without it the job's own legs are SKIPped and said so.

WHAT IT RUNS (any miss is a FAIL line and exit 1):
   1. prod's shape: 1a as the owner (the role and its seven); this directory's pre gates PASS; C-CONV before
      (--all --phase post, prod and staging): no ERROR
   2. THE STAGING CONTROL (V204 row 3.2c), as garden_wx_writer over TCP: the switched job's exact INSERT, through its
      own send() -> refused 42501 before the grant; the deployed job's seven-column INSERT -> written
   3. 0a as the owner -> exit 0; post gates PASS; C-CONV after: newly red = EXPECTED_NEWLY_RED (empty), no ERROR
   4. the same writes after: the switched job writes its night with Plot 1, the same night again writes 0; the
      deployed job still writes (grant first, job later: safe both ways)
   5. scripts/wx-writer-role.py's probe statements as the role: the eight-column INSERT denied before and allowed
      after, its five negatives 42501 both times
   6. positive controls: each post gate red on its defect (plot_id revoked, created_at granted, table-level INSERT,
      stamp deleted); 1a from before this step (BASE_SHA, no W3b) strips plot_id, the revert floor's reason, and the
      gate reds; this tree's 1a puts it back and the gate is green
   7. staging's shape (the role holding no grant at all, read 2026-10-21): the pre gate and 0a refuse, nothing
      changed; 1a (`reassert`) restores the seven; 0a then applies
   8. scripts/wx-writer-role.py end to end on an env file made for the run: verify, grant (the keys are the one Space
      and its live default plot), verify, reassert (no new password), ungrant, grant; grant with a second Space
      refuses and writes no key
   9. 0r: refused while weather_cold_range.plot_id is NOT NULL (3.2d), nothing changed; then exit 0, the seven
      again, the stamp gone; again a no-op; 0a twice more -> the same grants

Usage:
  python3 migrations/v5-wxwriterplot-001/rehearse_local.py --port 54424 --base-db base --wn3-send <patched wn3_send.py>
"""
import argparse
import importlib.util
import os
import secrets
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import psycopg

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
STAMP = '5.3.14-wxwriterplot-001'
BASE_SHA = '3c081fa4ff2b3a411cbc6c39a6886b60957f8c8f'   # the tree before this step: 1a without W3b
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@17/bin/psql')
ROLE = 'garden_wx_writer'
ONE_A = TREE / 'migrations' / 'v5-wxcoldband-001' / '1a-writer-role.sql'
GRANT, UNGRANT = HERE / '0a-writer-plot-grant.sql', HERE / '0r-rollback.sql'
MINE = HERE.name
# C-CONV: no existing gate pins garden_wx_writer's privileges (README.md "C-CONV pre-scan"), so none reds.
EXPECTED_NEWLY_RED = set()
NIGHT = '2031-10-01'


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


R = _load('wxplotid_rehearsal', TREE / 'migrations' / 'v5-wxplotid-001' / 'rehearse_local.py')
WX = _load('wx_writer_role', TREE / 'scripts' / 'wx-writer-role.py')
check, bad, errors, newly, gate_rows, err_of, case = R.check, R.bad, R.errors, R.newly, R.gate_rows, R.err_of, R.case


class Rig:
    def __init__(self, port):
        self.port = str(port)
        self.cl = R.Cluster(port)
        self.pw = secrets.token_urlsafe(24)

    def clone(self, src, dst):
        """CREATE DATABASE ... TEMPLATE, owned like the source: on Neon the owner role owns the database, and so
        holds CREATE on schema public (CREATE INDEX needs it)."""
        owner = self.su('postgres', 'SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = %s', (src,))[0][0]
        self.cl.admin(f'DROP DATABASE IF EXISTS {dst}')
        self.cl.admin(f'CREATE DATABASE {dst} TEMPLATE {src} OWNER {owner}')

    def url(self, db, user='postgres', pw=None):
        return f'postgresql://{user}{":" + pw if pw else ""}@127.0.0.1:{self.port}/{db}'

    def owner(self, db):
        with psycopg.connect(self.url(db)) as c:
            return c.execute("SELECT pg_get_userbyid(t.relowner) FROM pg_class t JOIN pg_namespace n ON "
                             "n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'weather_cold_range'"
                             ).fetchone()[0]

    def as_owner(self, db, path):
        """psql -f as the table owner (a NOSUPERUSER role, as on Neon). Returns (exit code, stderr)."""
        r = subprocess.run([PSQL, '-X', '-q', '-h', '127.0.0.1', '-p', self.port, '-U', self.owner(db), '-d', db,
                            '-v', 'ON_ERROR_STOP=1', '-f', str(path)], capture_output=True, text=True)
        return r.returncode, (r.stderr or '').strip()

    def su(self, db, sql, params=None):
        with psycopg.connect(self.url(db), autocommit=True) as c:
            cur = c.execute(sql, params)
            return cur.fetchall() if cur.description else None

    def writer_login(self):
        self.su('postgres', f"ALTER ROLE {ROLE} PASSWORD '{self.pw}'")

    def writer_url(self, db):
        return self.url(db, ROLE, self.pw)

    def as_writer(self, db, sql, params=None):
        """(sqlstate or None, rowcount) of one statement as garden_wx_writer over TCP."""
        try:
            with psycopg.connect(self.writer_url(db), autocommit=True) as c:
                cur = c.execute(sql, params)
                return None, cur.rowcount
        except psycopg.Error as e:
            return e.sqlstate, None

    def gates(self, db, migration=None, phase='post', env='prod'):
        return R.run_gates(self.url(db), migration, phase, env)


def insert_cols(db, rig):
    """The columns of weather_cold_range garden_wx_writer may INSERT, in column order, and table-level INSERT."""
    rows = rig.su(db, "SELECT string_agg(a.attname, ',' ORDER BY a.attnum), bool_or(has_table_privilege(r.oid, "
                      "a.attrelid, 'INSERT')) FROM pg_roles r, pg_attribute a JOIN pg_class t ON t.oid = a.attrelid "
                      "JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' WHERE r.rolname = %s "
                      "AND t.relname = 'weather_cold_range' AND a.attnum > 0 AND NOT a.attisdropped AND "
                      "has_column_privilege(r.oid, a.attrelid, a.attnum, 'INSERT')", (ROLE,))
    return rows[0][0] or '', bool(rows[0][1])


SEVEN = 'space_id,night_date,init_time,p10_min_f,p50_min_f,leads_read,leads_expected'
EIGHT = SEVEN + ',plot_id'


def grant_state(db, rig):
    """Every ACL on weather_cold_range and the stamp: 'nothing changed' means this is equal."""
    return rig.su(db, "SELECT coalesce(t.relacl::text, ''), (SELECT string_agg(a.attname || '=' || "
                      "coalesce(a.attacl::text, ''), ' ' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = "
                      "t.oid AND a.attnum > 0), (SELECT count(*) FROM public.schema_version WHERE version = %s) "
                      "FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' "
                      "WHERE t.relname = 'weather_cold_range'", (STAMP,))


def space_and_plot(db, rig):
    s = rig.su(db, 'SELECT id FROM public.spaces')
    assert len(s) == 1, s
    p = rig.su(db, 'SELECT id FROM public.plots WHERE workspace_id = %s AND is_default AND deleted_at IS NULL',
               (s[0][0],))
    return str(s[0][0]), str(p[0][0])


def job_legs(rig, db, job, space, plot, when):
    """The switched job's send() and the deployed job's seven-column INSERT, as garden_wx_writer."""
    out = {}
    if job is not None:
        row = {'space_id': space, 'plot_id': plot,
               **job.build_row(NIGHT, {'p10': [30.5] * 15, 'p50': [33.0] * 15}, 15)}
        try:
            out['switched'] = ('sent', job.send(rig.writer_url(db), row))
        except job.Stop as s:
            out['switched'] = ('stop', s.code, str(s))
        try:
            out['switched_again'] = ('sent', job.send(rig.writer_url(db), row))
        except job.Stop as s:
            out['switched_again'] = ('stop', s.code, str(s))
    stmt, _ = R.wn3_statement()      # the deployed job's INSERT, copied 2026-10-19
    night = '2031-10-02' if when == 'before' else '2031-10-03'
    out['deployed'] = rig.as_writer(db, stmt, (uuid.UUID(space), night, f'{night}T00:00:00Z', 31.0, 34.0, 15, 15))
    return out


def probe_states(rig, db):
    plot = rig.as_writer(db, WX.PLOT_PROBE)[0]
    negatives = {label: rig.as_writer(db, sql)[0] for label, sql in WX.PROBES}
    return plot, negatives


def script(rig, env_file, *args):
    r = subprocess.run([sys.executable, str(TREE / 'scripts' / 'wx-writer-role.py'), *args, '--env-file', str(env_file)],
                       capture_output=True, text=True, env={k: v for k, v in os.environ.items()
                                                            if not k.startswith(('PG', 'NEON_', 'WX_WRITER_'))})
    return r.returncode, r.stdout + r.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--base-db', required=True)
    ap.add_argument('--wn3-send', help='the cold-range job with the 3.2c patch applied (a scratch copy)')
    args = ap.parse_args()
    rig = Rig(args.port)
    job = _load('wn3_send_switched', args.wn3_send) if args.wn3_send else None
    if job is not None:
        check('0 the job named by --wn3-send is the switched one: eight columns, plot_id among them, no Space literal',
              'plot_id' in job.INSERT and job.INSERT.count('%s') == 8 and not hasattr(job, 'SPACE_ID'))
    else:
        print('SKIP  the switched job\'s legs  [no --wn3-send]', flush=True)
    a, b, c, s = 'rh_wxwp_prod', 'rh_wxwp_ctl', 'rh_wxwp_staging', 'rh_wxwp_script'
    tmp = tempfile.TemporaryDirectory(prefix='rh-wxwp-')
    try:
        # 1. prod's shape
        rig.clone(args.base_db, a)
        rc, err = rig.as_owner(a, ONE_A)
        check('1 1a as the owner (NOSUPERUSER, as on Neon): exit 0, the role holds the seven', rc == 0
              and insert_cols(a, rig) == (SEVEN, False), err[-200:])
        rig.writer_login()
        space, plot = space_and_plot(a, rig)
        pre = rig.gates(a, HERE, phase='pre')
        check('1 pre gates on prod\'s shape: every gate PASS', not bad(pre), str(sorted(bad(pre))))
        before = {env: rig.gates(a, env=env) for env in ('prod', 'staging')}
        for env, g in before.items():
            check(f'1 C-CONV before ({env}): no gate ERRORs (an ERROR is a rehearsal FAULT)', not errors(g), str(errors(g)))

        # 2. the staging control, before the grant
        legs = job_legs(rig, a, job, space, plot, 'before')
        if job is not None:
            sw = legs['switched']
            check("2 STAGING CONTROL before the grant: the switched job's exact INSERT (its send()) is refused 42501 "
                  '(exit 5, DATABASE)', sw[0] == 'stop' and sw[1] == job.DATABASE and 'SQLSTATE 42501' in sw[2], str(sw))
        check("2 before the grant the deployed job's seven-column INSERT is written (1 row)", legs['deployed'] == (None, 1),
              str(legs['deployed']))
        plot_before, neg_before = probe_states(rig, a)
        check('5 probe before: the eight-column INSERT (no row) is denied 42501', plot_before == '42501', str(plot_before))

        # 3. 0a
        rc, err = rig.as_owner(a, GRANT)
        check('3 0a as the owner: exit 0, the eight, the NOTICE says so', rc == 0 and insert_cols(a, rig) == (EIGHT, False)
              and 'holds INSERT on the eight columns' in err, err[-200:])
        post = rig.gates(a, HERE)
        check('3 post gates after 0a: every gate PASS', not bad(post), str(sorted(bad(post))))
        for env in ('prod', 'staging'):
            after = rig.gates(a, env=env)
            nr, ng = newly(before[env], after), newly(after, before[env])
            check(f'3 C-CONV ({env}): newly red = expected {sorted(EXPECTED_NEWLY_RED)}, newly green = {{}}, no ERROR',
                  nr == EXPECTED_NEWLY_RED and not ng and not errors(after), str(sorted(nr | ng)))

        # 4. after the grant
        legs = job_legs(rig, a, job, space, plot, 'after')
        if job is not None:
            stored = rig.su(a, 'SELECT plot_id::text FROM public.weather_cold_range WHERE night_date = %s', (NIGHT,))
            check("4 STAGING CONTROL after the grant: the switched job's exact INSERT writes 1 row, carrying Plot 1",
                  legs['switched'] == ('sent', 1) and stored == [(plot,)], f"{legs['switched']} {stored}")
            check('4 the same night again: 0 rows (bare ON CONFLICT DO NOTHING)', legs['switched_again'] == ('sent', 0),
                  str(legs['switched_again']))
        check("4 after the grant the deployed job's seven-column INSERT still writes (the job may switch any time after)",
              legs['deployed'] == (None, 1), str(legs['deployed']))
        plot_after, neg_after = probe_states(rig, a)
        check('5 probe after: the eight-column INSERT (no row) is allowed', plot_after is None, str(plot_after))
        check('5 the five negative probes are 42501 before and after the grant',
              set(neg_before.values()) == {'42501'} and set(neg_after.values()) == {'42501'},
              str((neg_before, neg_after)))

        # 6. positive controls on a clone of the granted database
        planted = [
            ('plot_id revoked by hand', f'REVOKE INSERT (plot_id) ON public.weather_cold_range FROM {ROLE}',
             'post_writer_inserts_exactly_the_eight', ['no INSERT on plot_id']),
            ('created_at granted', f'GRANT INSERT (created_at) ON public.weather_cold_range TO {ROLE}',
             'post_writer_inserts_exactly_the_eight', ['INSERT on created_at']),
            ('table-level INSERT granted', f'GRANT INSERT ON public.weather_cold_range TO {ROLE}',
             'post_writer_inserts_exactly_the_eight', None),
            ('the stamp deleted', f"DELETE FROM public.schema_version WHERE version = '{STAMP}'",
             'post_schema_version_recorded', None),
        ]
        with psycopg.connect(rig.url(a)) as conn:
            for label, sql, gate, want in planted:
                with case(conn):
                    was = gate_rows(conn, MINE, gate)
                    conn.execute(sql)
                    got = gate_rows(conn, MINE, gate)
                    ok = was == [] and (got == want if want else len(got) >= 1)
                    check(f'6 {gate}: green, then red on [{label}]', ok, str(got))
        old_1a = Path(tmp.name) / '1a-at-base.sql'
        old_1a.write_text(subprocess.run(['git', '-C', str(TREE), 'show', f'{BASE_SHA}:migrations/v5-wxcoldband-001/'
                                          '1a-writer-role.sql'], capture_output=True, text=True, check=True).stdout)
        rig.clone(a, b)
        rc, err = rig.as_owner(b, old_1a)
        with psycopg.connect(rig.url(b)) as conn:
            red = gate_rows(conn, MINE, 'post_writer_inserts_exactly_the_eight')
        check("6 REVERT FLOOR'S REASON: 1a as it was before this step, re-run after the grant, exits 0 and strips plot_id;"
              ' post_writer_inserts_exactly_the_eight reds', rc == 0 and insert_cols(b, rig) == (SEVEN, False)
              and red == ['no INSERT on plot_id'], f'{rc} {insert_cols(b, rig)} {red}')
        rc, err = rig.as_owner(b, ONE_A)
        with psycopg.connect(rig.url(b)) as conn:
            green = gate_rows(conn, MINE, 'post_writer_inserts_exactly_the_eight')
        check("6 this tree's 1a (W3b) re-run then: exit 0, plot_id back, the gate green, NOTICE says 8 columns",
              rc == 0 and insert_cols(b, rig) == (EIGHT, False) and green == [] and 'on the 8 columns' in err, err[-160:])
        rig.cl.drop(b)

        # 7. staging's shape: the role exists, holds nothing here
        rig.clone(args.base_db, c)
        state = grant_state(c, rig)
        pre = rig.gates(c, HERE, phase='pre')
        check("7 staging's shape: pre_writer_holds_exactly_1a_seven red (no INSERT on each of the seven), the rest PASS",
              {n for (_, _, n) in bad(pre)} == {'pre_writer_holds_exactly_1a_seven'}, str(sorted(bad(pre))))
        rc, err = rig.as_owner(c, GRANT)
        check("7 staging's shape: 0a refuses, naming what the role holds, nothing changed",
              rc == 3 and 'holds INSERT on {}' in err and 'reassert' in err and grant_state(c, rig) == state, err[-220:])
        rc, err = rig.as_owner(c, ONE_A)
        check("7 1a (reassert) on staging's shape: exit 0, the seven", rc == 0 and insert_cols(c, rig) == (SEVEN, False),
              err[-160:])
        rc, err = rig.as_owner(c, GRANT)
        check('7 then 0a: exit 0, the eight', rc == 0 and insert_cols(c, rig) == (EIGHT, False), err[-160:])
        rig.cl.drop(c)

        # 8. scripts/wx-writer-role.py end to end
        rig.clone(args.base_db, s)
        rig.as_owner(s, ONE_A)
        env_file = Path(tmp.name) / 'env.local'
        writer_line = f'WX_WRITER_DATABASE_URL_STAGING={rig.writer_url(s)}'
        env_file.write_text(f'NEON_STAGING_URL={rig.url(s, rig.owner(s))}\n{writer_line}\nOTHER=1\n')
        key = lambda k: WX.read_key(env_file, k)  # noqa: E731
        rc, out = script(rig, env_file, 'verify', '--env', 'staging')
        check('8 verify before grant: exit 0, the eight-column INSERT reported denied (no key yet)', rc == 0
              and f'PASS {WX.PLOT_LABEL}: denied (42501) (until `grant`, 3.2c)' in out, out[-300:])
        rc, out = script(rig, env_file, 'grant', '--env', 'staging')
        check('8 grant: exit 0, no new password, keys = the one Space and its live default plot, plot_id allowed',
              rc == 0 and key('WX_WRITER_SPACE_ID_STAGING') == space and key('WX_WRITER_PLOT_ID_STAGING') == plot
              and writer_line in env_file.read_text() and f'PASS {WX.PLOT_LABEL} is allowed' in out
              and 'FAIL' not in out, out[-400:])
        rc, out = script(rig, env_file, 'verify', '--env', 'staging')
        check('8 verify with the job\'s keys: exit 0, the eight-column INSERT required and allowed', rc == 0
              and f'PASS {WX.PLOT_LABEL} is allowed' in out, out[-300:])
        rc, out = script(rig, env_file, 'reassert', '--env', 'staging')
        check('8 reassert: exit 0, the password line untouched, still the eight (W3b)', rc == 0
              and writer_line in env_file.read_text() and insert_cols(s, rig) == (EIGHT, False), out[-300:])
        rc, out = script(rig, env_file, 'ungrant', '--env', 'staging')
        check('8 ungrant: exit 0, the seven, both keys removed, plot_id denied', rc == 0
              and insert_cols(s, rig) == (SEVEN, False) and key('WX_WRITER_PLOT_ID_STAGING') is None
              and key('WX_WRITER_SPACE_ID_STAGING') is None and f'PASS {WX.PLOT_LABEL} is denied (42501)' in out,
              out[-300:])
        rc, out = script(rig, env_file, 'grant', '--env', 'staging')
        check('8 grant again: exit 0, the eight', rc == 0 and insert_cols(s, rig) == (EIGHT, False), out[-200:])
        with psycopg.connect(rig.url(s), autocommit=True) as conn:
            conn.execute("SELECT set_config('app.actor_clerk_sub', 'rh-wxwp', false)")
            other = conn.execute("INSERT INTO public.spaces (name, created_by) VALUES ('rh-second', 'rh-wxwp') "
                                 'RETURNING id').fetchone()[0]
            conn.execute("INSERT INTO public.plots (workspace_id, name, timezone, is_default, created_by) VALUES "
                         "(%s, 'rh-second', 'America/New_York', true, 'rh-wxwp')", (other,))
        script(rig, env_file, 'ungrant', '--env', 'staging')
        rc, out = script(rig, env_file, 'grant', '--env', 'staging')
        check('8 grant with a second Space: exit 1, "there are 2", no key written', rc == 1 and 'there are 2' in out
              and key('WX_WRITER_PLOT_ID_STAGING') is None and key('WX_WRITER_SPACE_ID_STAGING') is None, out[-300:])
        rig.cl.drop(s)

        # 9. 0r
        rig.clone(a, b)
        rig.su(b, 'UPDATE public.weather_cold_range c SET plot_id = p.id FROM public.plots p WHERE c.plot_id IS NULL '
                  'AND p.workspace_id = c.space_id AND p.is_default AND p.deleted_at IS NULL')
        rig.su(b, 'ALTER TABLE public.weather_cold_range ALTER COLUMN plot_id SET NOT NULL')
        state = grant_state(b, rig)
        rc, err = rig.as_owner(b, UNGRANT)
        check('9 0r while weather_cold_range.plot_id is NOT NULL (3.2d): refused, nothing changed', rc == 3
              and 'plot_id is NOT NULL' in err and grant_state(b, rig) == state, err[-200:])
        rig.cl.drop(b)
        rc, err = rig.as_owner(a, UNGRANT)
        check('9 0r: exit 0, the seven, the stamp gone', rc == 0 and insert_cols(a, rig) == (SEVEN, False)
              and grant_state(a, rig)[0][2] == 0, err[-200:])
        post = rig.gates(a, HERE)
        check('9 post gates after 0r: every gate PASS (vacuous)', not bad(post), str(sorted(bad(post))))
        state = grant_state(a, rig)
        rc, err = rig.as_owner(a, UNGRANT)
        check('9 0r again: exit 0, nothing changed', rc == 0 and grant_state(a, rig) == state, err[-200:])
        rc, _ = rig.as_owner(a, GRANT)
        state = grant_state(a, rig)
        rc2, _ = rig.as_owner(a, GRANT)
        check('9 0a after 0r, then again: exit 0 both, the same grants', rc == 0 and rc2 == 0
              and grant_state(a, rig) == state and insert_cols(a, rig) == (EIGHT, False))
    finally:
        for db in (a, b, c, s):
            rig.cl.drop(db)
        tmp.cleanup()

    failed = [r for r in R.results if not r[0]]
    print(f'\n{len(R.results) - len(failed)}/{len(R.results)} PASS' + (f', {len(failed)} FAIL' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
