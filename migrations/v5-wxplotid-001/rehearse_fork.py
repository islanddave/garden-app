#!/usr/bin/env python3
"""rehearse_fork.py -- v5-wxplotid-001 on a PROD FORK: a Neon branch of prod that the session creates. Never prod,
never staging, never a branch anything else uses.

V204 §2.8 has the weather steps 3.2a-3.2d rehearse on a prod fork (a harness pair A side or a neon_safety_branch.py
copy). The lane that wrote this file may not create Neon branches, so the session runs it.

HOW TO RUN (from a garden-app checkout holding this directory and BASE_SHA in its history):
  1. Create the fork of prod (inside the fleet budget: `harness.py fleet` first). Write its OWNER connection string
     into a scratch env file by key name, e.g. a line `WXPLOTID_FORK_URL=postgresql://...` in <scratch>/fork.env.
     Never on a command line.
  2. python3 migrations/v5-wxplotid-001/rehearse_fork.py \\
         --fork-env-file <scratch>/fork.env --fork-key WXPLOTID_FORK_URL \\
         --prod-env-file /Users/davenichols/AI/Claude/Projects/Gardening/garden-app/.env.local
     --prod-env-file is read for NEON_DATABASE_URL and NEON_STAGING_URL by key name, only to refuse a target whose
     Neon endpoint is prod's or staging's. Needs psql on PATH (or PSQL=...), psycopg 3 and PyYAML.
  3. PASS means the last line reads `VERDICT: PASS (n/n)` and the exit status is 0. Exit 1 = at least one FAIL line
     (read them); exit 2 = FAULT (the script could not prove where it was pointed, or the fork was not a fresh prod
     copy): never a pass. SKIP lines are cases a non-superuser cannot plant (a row written past the key); they are
     not counted, and rehearse_local.py runs them.
  WHAT IT LEAVES: the fork with 0a applied (after a 0r -> 0a cycle). Nothing else is touched. Let the fork expire.

WHAT IT RUNS, in order:
   0. safety: the fork's endpoint is neither prod's nor staging's; it carries 5.3.6-plottier-001 and not this stamp
      (a fresh prod copy); a read-only preflight prints the backfill counts per Space and the guard body's md5
   1. this directory's pre gates                      -> every gate PASS
   2. C-CONV before, --all --phase post --env prod, the BASE_SHA corpus and this tree's -> no ERROR; they agree
   3. POSITIVE CONTROL, rolled back: a planted second Space (with its default plot and weather rows), then 0a's
      statements in the same transaction            -> refused, naming it; the fork unchanged afterwards
   4. 0a, the real file through psql -v ON_ERROR_STOP=1, committed -> exit 0; its NOTICE counts = the preflight's
   5. this directory's post gates                     -> every gate PASS, receipt included
   6. C-CONV after: each listed gate red before its edit (BASE_SHA corpus newly red = EXPECTED_NEWLY_RED) and green
      after it (this tree's corpus: newly red = newly green = {}); no ERROR
   7. on prod's real rows, every case rolled back: the arming test (the writer census by rule, the hourly writer's
      and the backfill script's exact statements, wn3_send.py's INSERT as garden_wx_writer when the owner may become
      it, else as a probe role with the same seven grants, else SKIP), the keys, the new C-GUARD body and its
      mutants, every tightened arm red on a planted violation, the self-arm, and what 3.2b/3.2d/3.3a/3.4 build on
   8. 0r through psql, committed -> exit 0; catalog fingerprint = step 0's; 3.1's body back; post gates vacuous
   9. 0a again                                        -> exit 0; fingerprint = step 4's; post gates PASS
"""
import argparse
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import psycopg

HERE = Path(__file__).resolve().parent


def load_local():
    spec = importlib.util.spec_from_file_location('rehearse_local', HERE / 'rehearse_local.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rl = load_local()
check = rl.check


def fault(msg):
    print(f'FAULT  {msg}', flush=True)
    sys.exit(2)


def env_value(path, key):
    """KEY=value from an env file, by key name; the value is never printed. None when absent."""
    if not path:
        return os.environ.get(key)
    for line in Path(path).read_text().splitlines():
        if line.startswith(f'{key}='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    return None


def endpoint(url):
    """The Neon endpoint id of a connection string (host's first label, pooler suffix dropped)."""
    host = (urlparse(url).hostname or '').lower()
    return host.split('.')[0].removesuffix('-pooler')


def pg_env(url):
    """libpq environment for psql, so the connection string never appears on a command line."""
    u = urlparse(url)
    env = {**os.environ, 'PGHOST': u.hostname or '', 'PGPORT': str(u.port or 5432),
           'PGUSER': unquote(u.username or ''), 'PGPASSWORD': unquote(u.password or ''),
           'PGDATABASE': unquote(u.path.lstrip('/'))}
    q = {k: v[-1] for k, v in parse_qs(u.query).items()}
    for k, var in (('sslmode', 'PGSSLMODE'), ('channel_binding', 'PGCHANNELBINDING'), ('options', 'PGOPTIONS'),
                   ('sslrootcert', 'PGSSLROOTCERT')):
        if k in q:
            env[var] = q[k]
    return env


def psql_file(url, path):
    exe = os.environ.get('PSQL') or shutil.which('psql') or rl.PSQL
    r = subprocess.run([exe, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', str(path)], capture_output=True, text=True,
                       env=pg_env(url))
    return r.returncode, (r.stderr or '').strip()


def counts_by_space(conn):
    return conn.execute(
        "SELECT s.id::text, (SELECT count(*) FROM public.weather_daily w WHERE w.space_id = s.id), "
        "(SELECT count(*) FROM public.weather_cold_range c WHERE c.space_id = s.id) FROM public.spaces s ORDER BY 1"
    ).fetchall()


def rolled_back_control(url):
    """Step 3: plant a second Space with weather, run 0a's statements in the same transaction, roll it all back."""
    body = (HERE / '0a-wxplotid.sql').read_text()
    n_begin, n_commit = len(re.findall(r'^BEGIN;$', body, re.M)), len(re.findall(r'^COMMIT;$', body, re.M))
    if (n_begin, n_commit) != (1, 1):
        fault(f'0a has {n_begin} BEGIN; and {n_commit} COMMIT; lines (expected one each); not rehearsing around it')
    body = re.sub(r'^(BEGIN|COMMIT);$', '', body, flags=re.M)
    with psycopg.connect(url) as c:
        fp = rl.fingerprint(c)
        c.rollback()
        b = rl.new_space(c, 'rh-fork-second-space')
        rl.new_plot(c, b, 'rh-fork-second-plot', default=True)
        rl.add_daily(c, b, '2031-01-01')
        rl.add_daily(c, b, '2031-01-02')
        rl.add_cold(c, b, '2031-01-01')
        try:
            c.execute(body)
            err, ok = 'no error', False
        except psycopg.Error as e:
            err = e.diag.message_primary or str(e)
            ok = ('refused, nothing changed' in err and 'there are 2' in err
                  and f'{b}: weather_daily 2 row(s)' in err and f'{b}: weather_cold_range 1 row(s)' in err)
        c.rollback()
        check('3 POSITIVE CONTROL: a planted second Space with weather -> 0a refuses, naming it and its counts',
              ok, err[:220])
        left = c.execute('SELECT count(*) FROM public.spaces WHERE id = %s', (b,)).fetchone()[0]
        check('3 the control left nothing behind (Space gone, catalog unchanged)', left == 0 and rl.fingerprint(c) == fp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fork-env-file', help='env file holding the fork DSN (default: the process environment)')
    ap.add_argument('--fork-key', default='WXPLOTID_FORK_URL')
    ap.add_argument('--prod-env-file', required=True, help='env file holding NEON_DATABASE_URL / NEON_STAGING_URL')
    args = ap.parse_args()

    url = env_value(args.fork_env_file, args.fork_key)
    if not url:
        fault(f'{args.fork_key} not found (env file or environment)')
    prod, stg = env_value(args.prod_env_file, 'NEON_DATABASE_URL'), env_value(args.prod_env_file, 'NEON_STAGING_URL')
    if not prod or not stg:
        fault('NEON_DATABASE_URL and NEON_STAGING_URL must both be readable: without them nothing proves the target '
              'is not prod or staging')
    if endpoint(url) in (endpoint(prod), endpoint(stg)) or not endpoint(url):
        fault('the target is prod\'s or staging\'s endpoint (or has none): refusing')

    # 0. a fresh prod copy, and the preflight
    with psycopg.connect(url) as c:
        stamps = {r[0] for r in c.execute("SELECT version FROM public.schema_version WHERE version IN "
                                          "('5.3.6-plottier-001', %s)", (rl.STAMP,)).fetchall()}
        if stamps != {'5.3.6-plottier-001'}:
            fault(f'the target carries {sorted(stamps)}: it must be a prod copy with 3.1 and without this step')
        by_space = counts_by_space(c)
        md5 = rl.md5_of_guard(c)
        su = c.execute("SELECT current_setting('is_superuser')").fetchone()[0]
        fp_base = rl.fingerprint(c)
    print(f'      target endpoint {endpoint(url)} (not prod {endpoint(prod)}, not staging {endpoint(stg)}); '
          f'superuser={su}', flush=True)
    print('      preflight weather by Space: ' + '; '.join(f'{s}: weather_daily {d}, weather_cold_range {w}'
                                                     for s, d, w in by_space), flush=True)
    check('0 preflight: one Space (Dave\'s) and 3.1\'s guard body', len(by_space) == 1 and md5 == rl.OLD_MD5,
          f'{len(by_space)} Space(s), md5 {md5}')

    tmp = tempfile.TemporaryDirectory(prefix='rh-wxplotid-fork-corpus-')
    try:
        base_runner = rl.base_corpus(tmp.name)
        # 1. pre gates
        pre = rl.run_gates(url, HERE, phase='pre')
        check('1 pre gates on the fork: every gate PASS', not rl.bad(pre), str(sorted(rl.bad(pre))))

        # 2. C-CONV before
        before = {r: rl.run_gates(url, env='prod', runner=r) for r in (None, base_runner)}
        for r, g in before.items():
            check(f'2 C-CONV before ({"base-SHA" if r else "edited"} corpus): no gate ERRORs (else a FAULT)',
                  not rl.errors(g), str(rl.errors(g)))
        diff = rl.newly(before[base_runner], before[None]) | rl.newly(before[None], before[base_runner])
        check('2 tolerant before the DDL: both corpora agree on the fork', not diff, str(sorted(diff)))

        # 3. the positive control, rolled back
        rolled_back_control(url)

        # 4. 0a for real
        rc, err = psql_file(url, HERE / '0a-wxplotid.sql')
        check('4 0a applies through psql: exit 0', rc == 0, err[-300:])
        m = re.search(r'backfill pre-gate: (.*?)\n', err + '\n')
        print(f'      {m.group(1) if m else err[-200:]}', flush=True)
        (space, n_wd, n_wcr), = by_space
        check('4 the pre-gate counts equal the preflight', bool(m) and f'weather_daily {n_wd} row(s)' in m.group(1)
              and f'weather_cold_range {n_wcr} row(s)' in m.group(1), m.group(1)[:200] if m else '')

        # 5. post gates
        post = rl.run_gates(url, HERE)
        check('5 post gates after 0a: every gate PASS, receipt included', not rl.bad(post), str(sorted(rl.bad(post))))

        # 6. C-CONV after
        after_b, after_e = rl.run_gates(url, env='prod', runner=base_runner), rl.run_gates(url, env='prod')
        nb = rl.newly(before[base_runner], after_b)
        check(f'6 each listed gate red before its edit: base-SHA corpus newly red = the {len(rl.EXPECTED_NEWLY_RED)} '
              'expected', nb == rl.EXPECTED_NEWLY_RED, str(sorted(nb)))
        ne, ng = rl.newly(before[None], after_e), rl.newly(after_e, before[None])
        check('6 ... and green after it: edited corpus newly red = newly green = {}', not ne and not ng,
              str(sorted(ne | ng)))
        check('6 C-CONV after: no gate ERRORs', not rl.errors(after_e) and not rl.errors(after_b),
              str(rl.errors(after_e) + rl.errors(after_b)))

        # 7. behaviour on prod's rows, every case rolled back
        with psycopg.connect(url) as c:
            space = rl.the_space(c)
            c.commit()
            n = c.execute('SELECT (SELECT count(*) FROM public.weather_daily WHERE plot_id IS NULL) + '
                          '(SELECT count(*) FROM public.weather_cold_range WHERE plot_id IS NULL)').fetchone()[0]
            check("4 every weather row of Dave's Space carries its default plot after 0a", n == 0, str(n))
            c.commit()
            for fn in (rl.arming_cases, rl.key_cases, rl.guard_cases, rl.tightened_arm_cases, rl.later_step_cases):
                try:
                    fn(c, space)
                except psycopg.Error as e:
                    c.rollback()
                    check(f'7 {fn.__name__} ran to the end', False, f'{e.sqlstate} {(e.diag.message_primary or "")[:120]}')
            fp_after = rl.fingerprint(c)
        post = rl.run_gates(url, HERE)
        check('7 post gates after every case (all rolled back): every gate PASS', not rl.bad(post),
              str(sorted(rl.bad(post))))

        # 8. 0r for real
        rc, err = psql_file(url, HERE / '0r-rollback.sql')
        check('8 0r applies through psql: exit 0', rc == 0, err[-300:])
        with psycopg.connect(url) as c:
            check('8 after 0r the catalog equals the preflight (fingerprint)', rl.fingerprint(c) == fp_base)
            check("8 after 0r guard_plots_repoint is 3.1's body", rl.md5_of_guard(c) == rl.OLD_MD5)
        post = rl.run_gates(url, HERE)
        check('8 post gates after 0r: every gate PASS (vacuous, no 42703)', not rl.bad(post), str(sorted(rl.bad(post))))

        # 9. 0a again
        rc, err = psql_file(url, HERE / '0a-wxplotid.sql')
        check('9 0a again after 0r: exit 0', rc == 0, err[-300:])
        with psycopg.connect(url) as c:
            check('9 the catalog equals the first apply (fingerprint)', rl.fingerprint(c) == fp_after)
        post = rl.run_gates(url, HERE)
        check('9 post gates: every gate PASS, receipt included', not rl.bad(post), str(sorted(rl.bad(post))))
    finally:
        tmp.cleanup()

    failed = [r for r in rl.results if not r[0]]
    n = len(rl.results)
    print(f'\nVERDICT: {"PASS" if not failed else "FAIL"} ({n - len(failed)}/{n})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
