#!/usr/bin/env python3
"""rehearse_local.py -- v5-wxplotnotnull-001 (multi-space 3.2d) on a throwaway LOCAL PostgreSQL 17. Never a shared
database.

WHAT IT NEEDS: what v5-wxwriterplot-001/rehearse_local.py needs (a prod-shaped --base-db after 3.2a, tables owned by a
NOSUPERUSER role, no grant to garden_wx_writer; --wn3-send the cold-range job WITH the 3.2c patch, a scratch copy).
It clones the base and never writes to it. 3.2c is applied on the clone first (1a, then its grant), as 3.2d needs.

WHAT IT RUNS, in the sitting's order (README.md "Sitting"; any miss is a FAIL line and exit 1):
   1. PRECONDITION (V204 row 3.2d: "the newest rows after 3.2b/c carry plot_id"), BEFORE the backfill re-run: pre
      gates red exactly on the newest cold-range row (prod's 2026-10-21 night has no plot); RED controls: the hourly
      writer as it was before 3.2b (v5.3.12) leaves the newest weather_daily row without a plot; GREEN: this tree's
      hourly writer and the switched job's send() each write a newest row that carries Plot 1; every pre gate PASS
   2. the backfill re-run (v5-wxplotid-001/0a-wxplotid.sql): sweep red before it (prod's NULL nights), green after
   3. C-CONV before: --all --phase post, prod and staging: no ERROR
   4. 0a then 0b as the owner: exit 0 each, the sweep counts printed
   5. C-CONV after: newly red = {} and newly green = {} (the set difference is empty after the file), no ERROR; this
      directory's post gates PASS
   6. 23502: an insert without plot_id into each table, the deployed (unswitched) job's seven-column INSERT as
      garden_wx_writer, and the pre-3.2b hourly writer -> each 23502 after the files; each written before them
   7. 23503: a cross-Space (plot_id, space_id) pair -> 23503 on both tables after VALIDATE; a pair planted past the
      key before the files -> sweep red, 0a and 0b refuse naming it, and with step 0 cut from 0a the VALIDATE itself
      raises 23503
   8. THE ARMING CHECK, after the files: the writer census by rule at HEAD (every deployed writer names plot_id);
      this tree's hourly writer (new day and D-1) and backfill script, the switched job, and the integration
      fixtures' own SQL (spaces-guards, season-stats), each succeeds with its Space's default plot; the fixtures'
      teardown order, the 1.3b chain (plot refuses naming the weather table, Space refuses naming plots), and
      _cleanup.js's sweep leave no residue
   9. mutants, each on a fresh clone at step 2's state: 0a / 0b with the DROP CONSTRAINT line removed -> the corpus's
      newly red set is exactly the gates that forbid the helper (v5-wxcoldband-001
      post_three_checks_validated_and_no_others for 0b; this directory's post_no_plot_id_helper_check for both);
      0b with the key's VALIDATE removed -> the key gates that tighten on NOT NULL red
  10. 0r: refused while plot_id is in a primary key (3.4's shape), nothing changed; 3.2c's 0r refused while plot_id
      is NOT NULL; then 0r exit 0, both NULLable, stamps gone, the corpus as before the files; again a no-op; 3.2c's
      0r then allowed (rolled back); 0a and 0b again, twice -> the same catalog
  11. staging's shape (no weather_daily, one cold-range row): 0a NO_EVIDENCE, exit 0

Usage:
  python3 migrations/v5-wxplotnotnull-001/rehearse_local.py --port 54424 --base-db base --wn3-send <patched wn3_send.py>
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import psycopg

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
MINE = HERE.name
STAMPS = ('5.3.14-wxplotnotnull-001-weather-daily', '5.3.14-wxplotnotnull-001-weather-cold-range')
FILE_A, FILE_B, FILE_R = HERE / '0a-weather-daily.sql', HERE / '0b-weather-cold-range.sql', HERE / '0r-rollback.sql'
BACKFILL = TREE / 'migrations' / 'v5-wxplotid-001' / '0a-wxplotid.sql'
PRE_32B = '1892b1b6b59def087be40c4aa8a30dda2e385796'   # v5.3.12: the hourly writer before 3.2b stamped plot_id
EXPECTED_NEWLY_RED = set()
MUTANT_NEWLY_RED = {
    'drop-line-0a': {(MINE, 'post_no_plot_id_helper_check')},
    'drop-line-0b': {('v5-wxcoldband-001', 'post_three_checks_validated_and_no_others'),
                     (MINE, 'post_no_plot_id_helper_check')},
    'no-validate-0b': {('v5-wxcoldband-001', 'post_exactly_one_fk_cascade_validated_to_spaces'),
                       ('v5-wxplotid-001', 'post_plot_keys_exact'), (MINE, 'post_plot_id_not_null_and_key_validated')},
}
RUN = 'int-test-1700000000000-rh32d'


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


WP = _load('wxwriterplot_rehearsal', TREE / 'migrations' / 'v5-wxwriterplot-001' / 'rehearse_local.py')
R, WX = WP.R, WP.WX
check, bad, errors, newly, gate_rows, err_of, case = R.check, R.bad, R.errors, R.newly, R.gate_rows, R.err_of, R.case


# ── SQL out of the JS that sends it ─────────────────────────────────────────────────────────────────
def _skip_template(src, k):
    """src[k] is a backtick: the index after its closing backtick, ${...} inside honoured."""
    k += 1
    while src[k] != '`':
        k = _skip_expr(src, k + 2) if src.startswith('${', k) else k + 1
    return k + 1


def _skip_expr(src, k):
    """k is just inside a ${: the index after its closing brace (nested templates and braces balanced)."""
    depth = 1
    while depth:
        ch = src[k]
        if ch == '`':
            k = _skip_template(src, k)
            continue
        depth += (ch == '{') - (ch == '}')
        k += 1
    return k


def js_templates(src, tag='directSql'):
    """Every tag`...` template literal of src as (text, [expr, ...]); the text keeps each ${expr} verbatim."""
    out, i = [], 0
    while (i := src.find(tag + '`', i)) >= 0:
        j = i + len(tag) + 1
        exprs, start = [], j
        while src[j] != '`':
            if src.startswith('${', j):
                k = _skip_expr(src, j + 2)
                exprs.append(src[j + 2:k - 1])
                j = k
            else:
                j += 1
        out.append((src[start:j], exprs))
        i = j + 1
    return out


def bind_template(text, exprs, values):
    """A template's text as psycopg named placeholders, one bind per distinct expression, valued by `values`."""
    sql = text.replace('%', '%%')
    params = {}
    for n, e in enumerate(dict.fromkeys(exprs)):
        sql = sql.replace('${' + e + '}', f'%(e{n})s')
        params[f'e{n}'] = values[e]
    return sql, params


def fixture_sql(path, needle):
    """The one directSql template of a test file whose text contains `needle`."""
    hits = [t for t in js_templates((TREE / path).read_text()) if needle in t[0]]
    assert len(hits) == 1, (path, needle, len(hits))
    return hits[0]


def handler_text(rev=None):
    path = 'lambda/daily-plan/handler.js'
    return R.at_rev(path, rev) if rev else (TREE / path).read_text()


def cleanup_steps(tmp):
    mod = Path(tmp) / '_cleanup.mjs'
    mod.write_text((TREE / 'tests' / 'integration' / '_cleanup.js').read_text())
    out = subprocess.run(['node', '--input-type=module', '-e',
                          f"import {{ STEP_SQL }} from '{mod}'; process.stdout.write(JSON.stringify(STEP_SQL))"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


# ── the clones ───────────────────────────────────────────────────────────────────────────────────────
def with_32c(rig, db):
    for f in (WP.ONE_A, WP.GRANT):
        rc, err = rig.as_owner(db, f)
        if rc:
            raise SystemExit(f'FAULT: {f.name} on {db}: {err[-300:]}')


def daily_row(conn, space, day):
    return conn.execute('SELECT plot_id::text FROM public.weather_daily WHERE space_id = %s AND "date" = %s',
                        (space, day)).fetchone()


def hourly(conn, rev, space, day):
    """The hourly writer's upsert at `rev` (None: this tree), for one day. Returns the sqlstate or None."""
    sql, n = R.handler_statement(handler_text(rev))
    return err_of(conn, sql, R.binds(R.daily_params(space, day)[:n]))[0]


def switched_send(rig, db, job, space, plot, night):
    row = {'space_id': space, 'plot_id': plot, **job.build_row(night, {'p10': [30.5] * 15, 'p50': [33.0] * 15}, 15)}
    try:
        return ('sent', job.send(rig.writer_url(db), row))
    except job.Stop as s:
        return ('stop', s.code, str(s))


def eight_col_insert(rig, db, space, plot, night):
    """The switched job's statement when no --wn3-send is given: its column list (wx-writer-role.JOB_COLUMNS)."""
    sql = (f"INSERT INTO weather_cold_range ({', '.join(WX.JOB_COLUMNS)}) VALUES (%s, %s, %s, %s, 30.5, 33, 15, 15) "
           'ON CONFLICT DO NOTHING')
    return rig.as_writer(db, sql, (uuid.UUID(space), uuid.UUID(plot), night, f'{night}T00:00:00Z'))


def corpus(rig, db):
    return {env: rig.gates(db, env=env) for env in ('prod', 'staging')}


def fp(rig, db):
    with psycopg.connect(rig.url(db)) as c:
        return R.fingerprint(c)


def apply_files(rig, db, files=(FILE_A, FILE_B)):
    return [rig.as_owner(db, f) for f in files]


def mutant(tmp, path, cut, name):
    src = path.read_text()
    assert cut in src, (path.name, cut[:60])
    out = Path(tmp) / f'{name}.sql'
    out.write_text(src.replace(cut, ''))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--base-db', required=True)
    ap.add_argument('--wn3-send', help='the cold-range job with the 3.2c patch applied (a scratch copy)')
    args = ap.parse_args()
    rig = WP.Rig(args.port)
    job = _load('wn3_send_switched', args.wn3_send) if args.wn3_send else None
    if job is None:
        print("SKIP  the switched job's own send()  [no --wn3-send: its column list is used instead]", flush=True)
    d, m, st = 'rh_wxnn_main', 'rh_wxnn_mut', 'rh_wxnn_staging'
    tmp = tempfile.TemporaryDirectory(prefix='rh-wxnn-')
    try:
        rig.clone(args.base_db, d)
        with_32c(rig, d)
        rig.writer_login()
        space, plot = WP.space_and_plot(d, rig)

        # 1. the precondition, before the backfill re-run
        pre = rig.gates(d, HERE, phase='pre')
        check('1 PRECONDITION RED on prod\'s data: pre gates red exactly {pre_newest_cold_range_row_carries_plot_id}',
              {n for (_, _, n) in bad(pre)} == {'pre_newest_cold_range_row_carries_plot_id'}, str(sorted(bad(pre))))
        with psycopg.connect(rig.url(d)) as conn:
            with case(conn):
                st0 = hourly(conn, PRE_32B, space, '2031-07-01')
                red = gate_rows(conn, MINE, 'pre_newest_weather_daily_row_carries_plot_id', 'pre')
                check('1 RED control: the hourly writer before 3.2b (v5.3.12) writes a newest row with no plot -> '
                      'pre_newest_weather_daily_row_carries_plot_id red', st0 is None and len(red) == 1, f'{st0} {red}')
        with psycopg.connect(rig.url(d), autocommit=True) as conn:
            yday = conn.execute('SELECT max("date")::text FROM public.weather_daily').fetchone()[0]
            st1 = hourly(conn, None, space, yday)
            check("1 GREEN: this tree's hourly writer (3.2b) re-upserts D-1: the newest weather_daily row carries Plot 1",
                  st1 is None and daily_row(conn, space, yday) == (plot,), f'{st1} {daily_row(conn, space, yday)}')
        night = '2031-10-01'
        sent = switched_send(rig, d, job, space, plot, night) if job else ('sent', eight_col_insert(rig, d, space, plot,
                                                                                                    night)[1])
        check("1 GREEN: the switched job (3.2c) sends a night: 1 row, the newest cold-range row, carrying Plot 1",
              sent == ('sent', 1), str(sent))
        pre = rig.gates(d, HERE, phase='pre')
        check('1 every pre gate PASS once both writers stamp (read before the backfill)', not bad(pre), str(sorted(bad(pre))))

        # 2. the backfill re-run
        sw = rig.gates(d, HERE, phase='sweep')
        check("2 sweep before the re-run: sweep_no_null_plot_id red (prod's NULL nights), the cross-Space sweep green",
              {n for (_, _, n) in bad(sw)} == {'sweep_no_null_plot_id'}, str(sorted(bad(sw))))
        rc, err = rig.as_owner(d, BACKFILL)
        m_ = re.search(r'backfill: weather_daily (\d+) row\(s\), weather_cold_range (\d+) row\(s\)', err)
        check('2 the backfill re-run (v5-wxplotid-001/0a-wxplotid.sql): exit 0, the NULL cold-range nights set to Plot 1',
              rc == 0 and m_ is not None and int(m_.group(2)) >= 1, (m_.group(0) if m_ else err[-200:]))
        sw = rig.gates(d, HERE, phase='sweep')
        check('2 sweep after the re-run: every gate PASS', not bad(sw), str(sorted(bad(sw))))

        # 3. C-CONV before
        before = corpus(rig, d)
        for env, g in before.items():
            check(f'3 C-CONV before ({env}): no gate ERRORs (an ERROR is a rehearsal FAULT)', not errors(g), str(errors(g)))

        # 4. the files
        (rca, erra), (rcb, errb) = apply_files(rig, d)
        check('4 0a-weather-daily.sql as the owner: exit 0, sweep printed', rca == 0 and 'sweep: weather_daily' in erra,
              erra[-200:])
        check('4 0b-weather-cold-range.sql as the owner: exit 0, sweep printed', rcb == 0
              and 'sweep: weather_cold_range' in errb, errb[-200:])

        # 5. C-CONV after
        after = corpus(rig, d)
        for env in ('prod', 'staging'):
            nr, ng = newly(before[env], after[env]), newly(after[env], before[env])
            check(f'5 C-CONV ({env}): the set difference is empty after the files (newly red {{}}, newly green {{}}), '
                  'no ERROR', nr == EXPECTED_NEWLY_RED and not ng and not errors(after[env]), str(sorted(nr | ng)))
        post = rig.gates(d, HERE)
        check('5 post gates after the files: every gate PASS', not bad(post), str(sorted(bad(post))))
        with psycopg.connect(rig.url(d)) as conn:
            cat = conn.execute("SELECT string_agg(t.relname || ':' || a.attnotnull, ' ' ORDER BY t.relname), "
                               "(SELECT string_agg(conname || ':' || convalidated, ' ' ORDER BY conname) FROM "
                               "pg_constraint WHERE conname LIKE 'weather_%%_plot_id_space_id_fkey'), (SELECT count(*) "
                               "FROM pg_constraint WHERE conname LIKE 'weather_%%_plot_id_not_null_chk') FROM "
                               "pg_attribute a JOIN pg_class t ON t.oid = a.attrelid WHERE t.relname IN ('weather_daily', "
                               "'weather_cold_range') AND a.attname = 'plot_id'").fetchone()
        check('5 the catalog: plot_id NOT NULL on both, both keys validated, no helper CHECK left',
              cat == ('weather_cold_range:true weather_daily:true',
                      'weather_cold_range_plot_id_space_id_fkey:true weather_daily_plot_id_space_id_fkey:true', 0),
              str(cat))

        # 6. 23502, and 7. 23503 after the files; the same statements before them, on a clone at step 2's state
        stmt7, _ = R.wn3_statement()
        rig.clone(args.base_db, m)
        with_32c(rig, m)
        rig.as_owner(m, BACKFILL)

        def no_plot_writes(db):
            with psycopg.connect(rig.url(db)) as conn:
                with case(conn):
                    a = err_of(conn, 'INSERT INTO public.weather_daily (space_id, "date") VALUES (%s, %s)',
                               (space, '2031-06-01'))[0]
                    b = err_of(conn, 'INSERT INTO public.weather_cold_range (space_id, night_date, init_time, '
                                     'p10_min_f, leads_read, leads_expected) VALUES (%s, %s, %s, 30, 15, 15)',
                               (space, '2031-06-01', '2031-06-01T00:00:00Z'))[0]
                    c = hourly(conn, PRE_32B, space, '2031-06-02')
            w = rig.as_writer(db, stmt7, (uuid.UUID(space), '2031-06-03', '2031-06-03T00:00:00Z', 30, 33, 15, 15))
            if w[0] is None:
                rig.su(db, "DELETE FROM public.weather_cold_range WHERE night_date = '2031-06-03'")
            return a, b, c, w[0]
        got = no_plot_writes(m)
        check('6 before the files: an insert without plot_id (both tables), the pre-3.2b hourly writer and the '
              "unswitched job's 7-column INSERT as garden_wx_writer are all written", got == (None,) * 4, str(got))
        got = no_plot_writes(d)
        check('6 after the files: each of the four is refused 23502', got == ('23502',) * 4, str(got))
        with psycopg.connect(rig.url(d)) as conn:
            with case(conn):
                conn.execute("SELECT set_config('app.actor_clerk_sub', 'rh-wxnn', true)")
                other = conn.execute("INSERT INTO public.spaces (name, created_by) VALUES ('rh-B', 'rh-wxnn') "
                                     'RETURNING id').fetchone()[0]
                q = conn.execute("INSERT INTO public.plots (workspace_id, name, timezone, is_default, created_by) "
                                 "VALUES (%s, 'rh-B', 'America/New_York', true, 'rh-wxnn') RETURNING id",
                                 (other,)).fetchone()[0]
                a = err_of(conn, 'INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, %s, %s)',
                           (space, q, '2031-06-04'))[0]
                b = err_of(conn, 'INSERT INTO public.weather_cold_range (space_id, plot_id, night_date, init_time, '
                                 'p10_min_f, leads_read, leads_expected) VALUES (%s, %s, %s, %s, 30, 15, 15)',
                           (space, q, '2031-06-04', '2031-06-04T00:00:00Z'))[0]
                check("7 after VALIDATE: a row of Dave's Space naming another Space's plot -> 23503 on both tables",
                      (a, b) == ('23503', '23503'), str((a, b)))
        # a pair planted past the key, before the files
        with psycopg.connect(rig.url(m), autocommit=True) as conn:
            conn.execute("SELECT set_config('app.actor_clerk_sub', 'rh-wxnn', false)")
            other = conn.execute("INSERT INTO public.spaces (name, created_by) VALUES ('rh-B', 'rh-wxnn') RETURNING id"
                                 ).fetchone()[0]
            q = conn.execute("INSERT INTO public.plots (workspace_id, name, timezone, is_default, created_by) VALUES "
                             "(%s, 'rh-B', 'America/New_York', true, 'rh-wxnn') RETURNING id", (other,)).fetchone()[0]
            conn.execute('SET session_replication_role = replica')
            conn.execute('INSERT INTO public.weather_daily (space_id, plot_id, "date") VALUES (%s, %s, %s)',
                         (space, q, '2031-06-05'))
            conn.execute('INSERT INTO public.weather_cold_range (space_id, plot_id, night_date, init_time, p10_min_f, '
                         'leads_read, leads_expected) VALUES (%s, %s, %s, %s, 30, 15, 15)',
                         (space, q, '2031-06-05', '2031-06-05T00:00:00Z'))
            conn.execute('SET session_replication_role = origin')
        sw = rig.gates(m, HERE, phase='sweep')
        check('7 a cross-Space pair planted past the key: sweep_no_cross_space_pair red (both rows), nothing else',
              {n for (_, _, n) in bad(sw)} == {'sweep_no_cross_space_pair'}, str(sorted(bad(sw))))
        before_m = fp(rig, m)
        (rca, erra), (rcb, errb) = apply_files(rig, m)
        check('7 ... 0a and 0b each refuse in step 0, naming the row, nothing changed', rca == 3 and rcb == 3
              and f'plot {q}' in erra and f'plot {q}' in errb and fp(rig, m) == before_m, (erra + ' | ' + errb)[-260:])
        cut0 = FILE_A.read_text().split('-- ── 0.')[1].split('-- ── 1.')[0]
        rc, err = rig.as_owner(m, mutant(tmp.name, FILE_A, '-- ── 0.' + cut0, 'no-step0-0a'))
        check('7 ... with step 0 cut from 0a, the VALIDATE itself raises 23503 (and nothing changed)',
              rc == 3 and 'violates foreign key constraint "weather_daily_plot_id_space_id_fkey"' in err
              and fp(rig, m) == before_m, err[-200:])
        rig.cl.drop(m)

        # 8. the arming check, on a clone of the applied database (so step 10's corpus compares like with like)
        rig.clone(d, m)
        hits = R.writer_census(None)
        deployed = [h for h in hits if h[2] and not h[0].startswith('migrations/')]
        print('      census at HEAD (writers outside migrations/): '
              + '; '.join(f'{p}:{n} {t}({",".join(c)})' for p, n, t, c in deployed), flush=True)
        print('      not writers: ' + ', '.join(f'{p}:{n}' for p, n, t, _ in hits if not t), flush=True)
        print('      rehearsal scripts (throwaway clusters, not deployed): '
              + ', '.join(sorted({p for p, n, t, _ in hits if t and p.startswith('migrations/')})), flush=True)
        check('8 census: every deployed writer of either table names plot_id (lambda, scripts, tests)',
              deployed and all('plot_id' in c for _, _, _, c in deployed),
              str([f'{p}:{n}' for p, n, _, c in deployed if 'plot_id' not in c]))
        check('8 census: the writers V204 names are all found (handler.js, backfill, season-stats, spaces-guards)',
              {'lambda/daily-plan/handler.js', 'scripts/backfill-weather-daily.mjs',
               'tests/integration/season-stats.int.test.js', 'tests/integration/spaces-guards.int.test.js'}
              <= {p for p, _, _, _ in deployed})
        with psycopg.connect(rig.url(m)) as conn:
            with case(conn):
                st_new = hourly(conn, None, space, '2031-07-02')
                st_old = hourly(conn, None, space, yday)
                check("8 this tree's hourly writer after the files: a new day and D-1 written, each on Plot 1",
                      (st_new, st_old) == (None, None) and daily_row(conn, space, '2031-07-02') == (plot,)
                      and daily_row(conn, space, yday) == (plot,), f'{st_new} {st_old}')
                sql, n = R.backfill_statement((TREE / 'scripts' / 'backfill-weather-daily.mjs').read_text())
                prm = R.daily_params(space, '2031-07-03')
                prm[6], prm[7] = 'openmeteo_archive', 'openmeteo_archive'
                st_b = err_of(conn, sql, R.binds(prm[:n]))[0]
                check("8 this tree's backfill script after the files: written on Plot 1", st_b is None
                      and daily_row(conn, space, '2031-07-03') == (plot,), str(st_b))
        sent = switched_send(rig, m, job, space, plot, '2031-10-04') if job else ('sent', eight_col_insert(
            rig, m, space, plot, '2031-10-04')[1])
        check('8 the switched job after the files: 1 row on Plot 1', sent == ('sent', 1), str(sent))
        fixture_cases(rig, m, tmp.name)
        rig.cl.drop(m)

        # 9. mutants on fresh clones at step 2's state
        for name, path, cut in (
                ('drop-line-0a', FILE_A, 'ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_plot_id_not_null_chk;\n'),
                ('drop-line-0b', FILE_B,
                 'ALTER TABLE public.weather_cold_range DROP CONSTRAINT weather_cold_range_plot_id_not_null_chk;\n'),
                ('no-validate-0b', FILE_B,
                 'ALTER TABLE public.weather_cold_range VALIDATE CONSTRAINT weather_cold_range_plot_id_space_id_fkey;\n')):
            rig.clone(args.base_db, m)
            with_32c(rig, m)
            rig.as_owner(m, BACKFILL)
            switched = switched_send(rig, m, job, space, plot, night) if job else None
            base = corpus(rig, m)
            rc, err = rig.as_owner(m, mutant(tmp.name, path, cut, name))
            got = corpus(rig, m)
            nr = newly(base['prod'], got['prod']) | newly(base['staging'], got['staging'])
            check(f'9 mutant {name}: applies (exit 0), and the corpus newly red is exactly {sorted(MUTANT_NEWLY_RED[name])}',
                  rc == 0 and nr == MUTANT_NEWLY_RED[name], f'{rc} {sorted(nr)} {switched}')
            rig.cl.drop(m)

        # 10. 0r
        rig.clone(d, m)
        rig.su(m, 'ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_pkey, ADD CONSTRAINT weather_daily_pkey '
                  'PRIMARY KEY USING INDEX weather_daily_plot_id_date_key')
        before_m = fp(rig, m)
        rc, err = rig.as_owner(m, FILE_R)
        check("10 0r with plot_id in weather_daily's primary key (3.4's shape): refused, nothing changed",
              rc == 3 and 'primary key of public.weather_daily' in err and fp(rig, m) == before_m, err[-200:])
        rig.cl.drop(m)
        state = WP.grant_state(d, rig)
        rc, err = rig.as_owner(d, WP.UNGRANT)
        check("10 3.2c's 0r while weather_cold_range.plot_id is NOT NULL: refused, nothing changed", rc == 3
              and WP.grant_state(d, rig) == state, err[-160:])
        rc, err = rig.as_owner(d, FILE_R)
        with psycopg.connect(rig.url(d)) as conn:
            nulls = conn.execute("SELECT string_agg(t.relname || ':' || a.attnotnull, ' ' ORDER BY t.relname) FROM "
                                 "pg_attribute a JOIN pg_class t ON t.oid = a.attrelid WHERE t.relname IN "
                                 "('weather_daily', 'weather_cold_range') AND a.attname = 'plot_id'").fetchone()[0]
            stamps = conn.execute('SELECT count(*) FROM public.schema_version WHERE version = ANY(%s)',
                                  (list(STAMPS),)).fetchone()[0]
        check('10 0r: exit 0, plot_id NULLable on both, both stamps gone', rc == 0
              and nulls == 'weather_cold_range:false weather_daily:false' and stamps == 0, f'{rc} {nulls} {stamps} {err[-120:]}')
        back = corpus(rig, d)
        for env in ('prod', 'staging'):
            diff = newly(before[env], back[env]) | newly(back[env], before[env])
            check(f'10 after 0r the corpus ({env}) is as before the files', not diff and not errors(back[env]),
                  str(sorted(diff)))
        fp0 = fp(rig, d)
        rc, err = rig.as_owner(d, FILE_R)
        check('10 0r again: exit 0, nothing changed', rc == 0 and fp(rig, d) == fp0, err[-120:])
        rig.clone(d, m)
        rc, err = rig.as_owner(m, WP.UNGRANT)
        check("10 3.2c's 0r after 3.2d's: allowed (exit 0)", rc == 0, err[-120:])
        rig.cl.drop(m)
        res = apply_files(rig, d)
        fp1 = fp(rig, d)
        res2 = apply_files(rig, d)
        check('10 0a and 0b after 0r, then again: exit 0 each time, the same catalog', [r for r, _ in res + res2] == [0] * 4
              and fp(rig, d) == fp1, str([e[-80:] for r, e in res + res2 if r]))
        post = rig.gates(d, HERE)
        check('10 post gates after the 0r -> 0a/0b cycle: every gate PASS', not bad(post), str(sorted(bad(post))))

        # 11. staging's shape
        rig.clone(args.base_db, st)
        with_32c(rig, st)
        rig.as_owner(st, BACKFILL)
        rig.su(st, 'DELETE FROM public.weather_daily')
        rig.su(st, 'DELETE FROM public.weather_cold_range WHERE night_date > (SELECT min(night_date) FROM '
                   'public.weather_cold_range)')
        (rca, erra), (rcb, errb) = apply_files(rig, st)
        check("11 staging's shape (no weather_daily, one cold-range row): 0a NO_EVIDENCE exit 0, 0b exit 0",
              rca == 0 and 'NO_EVIDENCE' in erra and rcb == 0 and 'weather_cold_range 1 row(s)' in errb,
              (erra + ' | ' + errb)[-200:])
    finally:
        for db in (d, m, st):
            rig.cl.drop(db)
        tmp.cleanup()

    failed = [r for r in R.results if not r[0]]
    print(f'\n{len(R.results) - len(failed)}/{len(R.results)} PASS' + (f', {len(failed)} FAIL' if failed else ''))
    return 1 if failed else 0


def fixture_cases(rig, db, tmp):
    """The integration fixtures' own SQL, read out of the test files, after the files: each writes, each row names
    its Space's default plot, and each teardown (the file's own, and _cleanup.js's sweep) leaves nothing."""
    sg = 'tests/integration/spaces-guards.int.test.js'
    ss = 'tests/integration/season-stats.int.test.js'
    user = f'user_int_spaceguard_{RUN}'
    with psycopg.connect(rig.url(db), autocommit=True) as conn:
        conn.execute("SELECT set_config('app.actor_clerk_sub', %s, false)", (user,))
        new_space = lambda label, lat=None, lng=None, z=None: conn.execute(  # noqa: E731
            'INSERT INTO public.spaces (name, created_by, weather_lat, weather_lng, postal_code) VALUES (%s, %s, %s, '
            '%s, %s) RETURNING id', (f'int-spaceguard-{label}-{RUN}', user, lat, lng, z)).fetchone()[0]

        def run(path, needle, values):
            sql, params = bind_template(*fixture_sql(path, needle), values)
            return err_of(conn, sql, params)[0]

        ens, wd, wcr = 'INSERT INTO plots', 'INSERT INTO weather_daily', 'INSERT INTO weather_cold_range'
        sa = new_space('repoint-a', 42.5, -72.6, '01373')
        sb = new_space('only-weather_cold_range')
        states = [run(sg, ens, {'spaceId': sa}), run(sg, wd, {'spaceId': sa}),
                  run(sg, ens, {'spaceId': sb}), run(sg, wcr, {'spaceId': sb}), run(sg, ens, {'spaceId': sa})]
        plots = conn.execute('SELECT workspace_id, count(*), bool_and(lat IS NOT DISTINCT FROM (SELECT weather_lat FROM '
                             'public.spaces s WHERE s.id = workspace_id)) FROM public.plots WHERE workspace_id IN (%s, '
                             '%s) GROUP BY 1 ORDER BY 1', (sa, sb)).fetchall()
        named = conn.execute('SELECT (SELECT count(*) FROM public.weather_daily w JOIN public.plots p ON p.id = '
                             'w.plot_id WHERE w.space_id = %s AND p.is_default), (SELECT count(*) FROM '
                             'public.weather_cold_range c JOIN public.plots p ON p.id = c.plot_id WHERE c.space_id = %s '
                             'AND p.is_default)', (sa, sb)).fetchone()
        check("8 spaces-guards fixture SQL after the files: ensureDefaultPlot (twice for one Space: one plot, its "
              "Space's place), addWeather, addColdRange all written, each row on its Space's default plot",
              states == [None] * 5 and [r[1] for r in plots] == [1, 1] and all(r[2] for r in plots)
              and named == (1, 1), f'{states} {plots} {named}')
        pid = conn.execute('SELECT id FROM public.plots WHERE workspace_id = %s', (sb,)).fetchone()[0]
        p = err_of(conn, 'DELETE FROM public.plots WHERE id = %s', (pid,))
        s = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (sb,))
        check('8 spaces-guards 1.3b chain: the plot refuses naming public.weather_cold_range, the Space refuses naming '
              'public.plots (P0001 both)', p[0] == 'P0001' and p[1].startswith('plots_delete_guard: ')
              and 'public.weather_cold_range' in p[1] and s[0] == 'P0001'
              and s[1].startswith('spaces_delete_guard: ') and 'public.plots' in s[1], f'{p} {s}')
        users = [f'user_int_stats_a_{RUN}']
        sid = conn.execute('INSERT INTO public.spaces (name, created_by) VALUES (%s, %s) RETURNING id',
                           (f'int-stats-space-{RUN}', users[0])).fetchone()[0]
        vals = {'ids.space': sid, '`int-stats-plot-${RUN}`': f'int-stats-plot-{RUN}', 'USER_A': users[0]}
        st_plot = run(ss, ens, vals)
        vals['ids.plot'] = conn.execute('SELECT id FROM public.plots WHERE workspace_id = %s', (sid,)).fetchone()[0]
        st_month, st_day = run(ss, 'generate_series', vals), run(ss, "'2026-07-01'::date, 95, 45", vals)
        n = conn.execute('SELECT count(*), count(*) FILTER (WHERE plot_id = %s) FROM public.weather_daily WHERE '
                         'space_id = %s', (vals['ids.plot'], sid)).fetchone()
        check('8 season-stats fixture SQL after the files: its plot, the June series and Jul 1, 31 rows on its plot',
              (st_plot, st_month, st_day) == (None, None, None) and n == (31, 31), f'{st_plot} {st_month} {st_day} {n}')
        teardown = [run(ss, 'DELETE FROM weather_daily', {'users': users}), run(ss, 'DELETE FROM plots', {'users': users}),
                    run(ss, 'DELETE FROM spaces WHERE created_by = ANY', {'users': users})]
        check("8 season-stats teardown in its file's order (weather, plots, spaces): each succeeds",
              teardown == [None] * 3, str(teardown))
        steps = dict(cleanup_steps(tmp))
        order = [t for t, _ in cleanup_steps(tmp)]
        swept = {t: err_of(conn, steps[t])[0] for t in ('weather_daily', 'weather_cold_range', 'spacetheme', 'plots',
                                                         'spaces')}
        left = conn.execute("SELECT (SELECT count(*) FROM public.spaces WHERE created_by LIKE '%%int-test-%%'), "
                            "(SELECT count(*) FROM public.plots p JOIN public.spaces s ON s.id = p.workspace_id WHERE "
                            "s.created_by LIKE '%%int-test-%%')").fetchone()
        check("8 _cleanup.js sweep (its STEP_SQL, in its order: weather, spacetheme, plots, spaces) on the spaces-guards "
              'Spaces: every step succeeds, no Space or plot left',
              order.index('weather_cold_range') < order.index('plots') < order.index('spaces')
              and set(swept.values()) == {None} and left == (0, 0), f'{swept} {left}')


if __name__ == '__main__':
    sys.exit(main())
