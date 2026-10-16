#!/usr/bin/env python3
"""rehearse_local.py -- v5-spaceguard-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster holding a database (--base-db) loaded the way README.md "Rehearsal" says:
prod's schema-only dump of public, gv and extensions, prod's schema_version rows as data, and the spaces,
spacetheme, weather_daily and weather_cold_range rows as data (plus a stub photos row for the Space's
featured photo). The script never writes to --base-db: it clones it (CREATE DATABASE ... TEMPLATE) and
works on clones, dropping them at the end.

WHAT IT RUNS, in order, and what each step must show (any miss is a FAIL line and exit 1):
   1. pre gates                                  -> every gate PASS
   2. post gates before the apply                -> every gate PASS (vacuous: nothing is armed)
   3. C-CONV before: --all --phase post --json   (this tree's corpus, and --base-corpus if given)
   4. 0a                                         -> exit 0
   5. post gates                                 -> every gate PASS, receipt included
   6. C-CONV after; newly red = after - before   -> this tree: empty; base corpus (no amendment):
                                                    exactly v5-wxcoldband-001 post_no_trigger_and_no_row_security
   7. behaviour cases and mutants (1.1 writers and actors, 1.2 cases and the DROP COLUMN control,
      1.3b only-child / SQLSTATE / TRUNCATE CASCADE / drop-the-guard, the data-gate controls, a gate-level red
      for each mutant, the tolerant v5-wxcoldband-001 gate red on any other trigger, TRUNCATE CASCADE again
      with M2-shaped foreign keys); each in a transaction that is rolled back, or on a clone that is dropped
   8. 0r                                         -> exit 0; catalog fingerprint equal to step 1's
   9. 0a twice more, then 0r -> 0a once more     -> exit 0 each; fingerprint equal to step 4's (step 1's after
                                                    the 0r); one baseline per Space throughout
  10. refusals: 0r with an M2-shaped foreign key, 0r with a foreign audit_stmt_insert trigger, 0a with a
      name collision, 0a on a spaces that has deleted_at -> each refuses and changes nothing

Usage:
  python3 migrations/v5-spaceguard-001/rehearse_local.py --port 55441 --base-db rehearsal \\
      [--base-corpus <dir holding scripts/gate_runner.py and migrations/ at the base SHA>]
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
STAMP = '5.1.5-spaceguard-001'
SENTINEL = '00000000-0000-0000-0000-000000000001'
OWNER = 'user_rehearse_spaceguard'
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

    def gates(self, db, corpus=TREE, migration=None, phase='post'):
        """Run gate_runner.py from `corpus` against `db`. Returns {(dir, phase, name): status}."""
        args = [sys.executable, str(Path(corpus) / 'scripts' / 'gate_runner.py')]
        args += ['--migration', str(migration)] if migration else ['--all']
        args += ['--env', 'prod', '--phase', phase, '--json']
        env = {**os.environ, 'NEON_DATABASE_URL': self.url(db)}
        r = subprocess.run(args, capture_output=True, text=True, env=env)
        if r.returncode not in (0, 1):
            raise SystemExit(f'gate_runner exit {r.returncode}: {r.stderr[-800:]}')
        out = {}
        for g in json.loads(r.stdout):
            out[(Path(g['path']).parent.name, g['phase'], g['name'])] = g['status']
        return out


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
    SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || coalesce(p.proconfig::text, '')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'gv')
    UNION ALL
    SELECT 'constraint ' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'stamp ' || version FROM public.schema_version
    """
    return sorted(r[0] for r in conn.execute(q).fetchall())


GATES = yaml.safe_load((HERE / 'gates.yml').read_text())
GATE_SQL = {g['name']: g['sql'] for phase in ('pre', 'post') for g in GATES.get(phase, [])}


def fn_ddl(name):
    """One CREATE OR REPLACE FUNCTION statement of 0a, verbatim, for building a mutant from it."""
    src = (HERE / '0a-guards.sql').read_text()
    start = src.index(f'CREATE OR REPLACE FUNCTION public.{name}()')
    return src[start:src.index('$$;', start) + 3]


def gate_rows(conn, name):
    """Run one of this directory's gates INSIDE the caller's transaction (sees uncommitted state)."""
    return conn.execute(GATE_SQL[name]).fetchall()


def err_of(conn, sql, params=None):
    """Run sql in a savepoint. Returns (sqlstate, message) of the error, or (None, None)."""
    try:
        with conn.transaction():
            conn.execute(sql, params)
    except psycopg.Error as e:
        return e.sqlstate, (e.diag.message_primary or '')
    return None, ''


def new_space(conn, *, name, lat=None, lng=None, zip_=None, owner=OWNER):
    return conn.execute(
        'INSERT INTO public.spaces (name, created_by, weather_lat, weather_lng, postal_code) '
        'VALUES (%s, %s, %s, %s, %s) RETURNING id', (name, owner, lat, lng, zip_)).fetchone()[0]


def new_photo(conn, space_id, path):
    return conn.execute(
        'INSERT INTO public.photos (storage_path, created_by, uploaded_by, space_id) VALUES (%s, %s, %s, %s) '
        'RETURNING id', (path, OWNER, OWNER, space_id)).fetchone()[0]


def add_weather(conn, space_id, day='2026-06-01'):
    conn.execute('INSERT INTO public.weather_daily (space_id, date, tmax_f, tmin_f, precip_in) '
                 'VALUES (%s, %s, 80, 60, 0.1)', (space_id, day))


def add_cold(conn, space_id):
    conn.execute('INSERT INTO public.weather_cold_range (space_id, night_date, init_time, p10_min_f, leads_read, '
                 'leads_expected) VALUES (%s, %s, %s, 30, 15, 15)', (space_id, '2026-10-01', '2026-10-01T00:00Z'))


def audit_count(conn, space_id, action):
    return conn.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'spaces' AND row_id = %s "
                        "AND action = %s", (space_id, action)).fetchone()[0]


def audit_ids(conn, space_id, action):
    return {r[0] for r in conn.execute("SELECT id FROM public.audit_events WHERE table_name = 'spaces' "
                                       "AND row_id = %s AND action = %s", (space_id, action)).fetchall()}


def newest_actor(conn, space_id, action, seen=frozenset()):
    """(actor, after_jsonb) of the one audit row written since `seen` (ids already there). Rows written in
    one transaction share ts, so 'newest' is decided by id set difference, never by ts."""
    rows = [r for r in conn.execute("SELECT id, actor_clerk_sub, after_jsonb FROM public.audit_events "
                                    "WHERE table_name = 'spaces' AND row_id = %s AND action = %s",
                                    (space_id, action)).fetchall() if r[0] not in seen]
    return (rows[0][1], rows[0][2]) if len(rows) == 1 else (f'{len(rows)} new rows', None)


def case(conn):
    """A transaction that is always rolled back."""
    return conn.transaction(force_rollback=True)


# ── 1.1 C-AUDIT ──────────────────────────────────────────────────────────────────────────────────
def audit_cases(conn):
    hh = [OWNER]
    # Each writer, its own transaction: photoDelete's set_config(..., true) lasts to the end of one.
    with case(conn):
        s = new_space(conn, name='rh-w1')
        p = new_photo(conn, s, 'rh/w1.jpg')
        before = audit_count(conn, s, 'UPDATE')
        conn.execute('UPDATE spaces SET featured_photo_id = %s WHERE id = %s AND created_by = ANY(%s) '
                     'AND featured_photo_id IS NULL', (p, s, hh))           # photos/index.js:180
        actor, after = newest_actor(conn, s, 'UPDATE')
        check('1.1 writer photos/index.js:180 (auto-promote): UPDATE delta 1, actor system',
              audit_count(conn, s, 'UPDATE') - before == 1 and actor == 'system'
              and after['featured_photo_id'] == str(p), f'actor={actor}')
    with case(conn):
        s = new_space(conn, name='rh-w2')
        p = new_photo(conn, s, 'rh/w2.jpg')
        before = audit_count(conn, s, 'UPDATE')
        conn.execute('UPDATE spaces SET featured_photo_id = %s, updated_at = now() WHERE id = %s '
                     'AND created_by = ANY(%s) RETURNING id AS space_id, featured_photo_id', (p, s, hh))  # :844
        actor, _ = newest_actor(conn, s, 'UPDATE')
        check('1.1 writer photos/index.js:844 (PUT space-featured): UPDATE delta 1, actor system',
              audit_count(conn, s, 'UPDATE') - before == 1 and actor == 'system', f'actor={actor}')
    with case(conn):
        s = new_space(conn, name='rh-w3')
        p = new_photo(conn, s, 'rh/w3.jpg')
        conn.execute('UPDATE spaces SET featured_photo_id = %s WHERE id = %s', (p, s))
        before, seen = audit_count(conn, s, 'UPDATE'), audit_ids(conn, s, 'UPDATE')
        # softDeletePhoto's batch, statements 0, 1 and the spaces pointer (photoDelete.js:211, :122).
        conn.execute("SELECT set_config('app.actor_clerk_sub', %s, true)", (OWNER,))
        conn.execute('UPDATE photos SET deleted_at = now() WHERE id = %s AND created_by = ANY(%s) '
                     'AND deleted_at IS NULL RETURNING id, deleted_at', (p, hh))
        conn.execute('UPDATE public.spaces SET featured_photo_id = NULL WHERE featured_photo_id = %s RETURNING id', (p,))
        actor, after = newest_actor(conn, s, 'UPDATE', seen)
        check('1.1 writer photoDelete.js:122 (soft delete clears the hero): UPDATE delta 1, actor = the user',
              audit_count(conn, s, 'UPDATE') - before == 1 and actor == OWNER
              and after['featured_photo_id'] is None, f'actor={actor}')
    with case(conn):
        s = new_space(conn, name='rh-w4')
        p = new_photo(conn, s, 'rh/w4.jpg')
        before = audit_count(conn, s, 'UPDATE')
        conn.execute('UPDATE public.spaces SET featured_photo_id = %s WHERE id = %s AND created_by = ANY(%s) '
                     'AND featured_photo_id IS NULL', (p, s, hh))           # photoDelete.js:328
        actor, _ = newest_actor(conn, s, 'UPDATE')
        check('1.1 writer photoDelete.js:328 (restore replays the hero): UPDATE delta 1, actor system',
              audit_count(conn, s, 'UPDATE') - before == 1 and actor == 'system', f'actor={actor}')
    with case(conn):
        s = new_space(conn, name='rh-w5')
        p = new_photo(conn, s, 'rh/w5.jpg')
        conn.execute('UPDATE spaces SET featured_photo_id = %s WHERE id = %s', (p, s))
        before, seen = audit_count(conn, s, 'UPDATE'), audit_ids(conn, s, 'UPDATE')
        conn.execute('DELETE FROM public.photos WHERE id = %s', (p,))     # RI ON DELETE SET NULL
        actor, after = newest_actor(conn, s, 'UPDATE', seen)
        check('1.1 writer RI SET NULL (hard photo delete): UPDATE delta 1, actor system',
              audit_count(conn, s, 'UPDATE') - before == 1 and actor == 'system'
              and after['featured_photo_id'] is None, f'actor={actor}')
    with case(conn):
        s = new_space(conn, name='rh-ins')
        actor, after = newest_actor(conn, s, 'INSERT')
        check('1.1 raw INSERT: INSERT delta 1, after_jsonb = the row, actor system',
              audit_count(conn, s, 'INSERT') == 1 and actor == 'system' and after['name'] == 'rh-ins')
        conn.execute('DELETE FROM public.spaces WHERE id = %s', (s,))
        check('1.1 raw DELETE of a childless Space: DELETE delta 1', audit_count(conn, s, 'DELETE') == 1)
    with case(conn):
        s = new_space(conn, name='rh-same')
        before = audit_count(conn, s, 'UPDATE')
        conn.execute('UPDATE public.spaces SET featured_photo_id = featured_photo_id, name = name WHERE id = %s', (s,))
        conn.execute('UPDATE public.spaces SET updated_at = now() WHERE id = %s', (s,))
        check('1.1 same-value and unwatched-only UPDATEs: delta 0', audit_count(conn, s, 'UPDATE') == before)
        s2 = new_space(conn, name='rh-multi')
        conn.execute("UPDATE public.spaces SET name = name || '-x' WHERE id IN (%s, %s)", (s, s2))
        check('1.1 one statement over two rows: one UPDATE row each',
              audit_count(conn, s, 'UPDATE') == before + 1 and audit_count(conn, s2, 'UPDATE') == 1)

    # Mutant: bound to audit_stmt_update, which reads o.deleted_at -> 42703 swallowed as a WARNING.
    notices = []
    conn.add_notice_handler(lambda d: notices.append(d.message_primary or ''))
    with case(conn):
        conn.execute('DROP TRIGGER trg_audit_spaces_upd ON public.spaces')
        conn.execute("CREATE TRIGGER trg_audit_spaces_upd AFTER UPDATE ON public.spaces REFERENCING OLD TABLE AS "
                     "old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update("
                     "'name','postal_code','weather_lat','weather_lng','featured_photo_id','created_by')")
        s = new_space(conn, name='rh-mut-upd')
        p = new_photo(conn, s, 'rh/mut.jpg')
        conn.execute('UPDATE spaces SET featured_photo_id = %s, updated_at = now() WHERE id = %s', (p, s))
        check('1.1 MUTANT bound to audit_stmt_update: UPDATE delta 0 and a swallowed 42703 WARNING (killed)',
              audit_count(conn, s, 'UPDATE') == 0 and any('42703' in n for n in notices),
              f'warnings={[n[:60] for n in notices]}')
    notices.clear()
    with case(conn):
        mutated = fn_ddl('audit_stmt_insert').replace('FROM new_rows n;', 'FROM new_rows n WHERE 1 / 0 = 1;')
        assert mutated != fn_ddl('audit_stmt_insert')
        conn.execute(mutated)
        s = new_space(conn, name='rh-mut-ins')
        ok_row = conn.execute('SELECT count(*) FROM public.spaces WHERE id = %s', (s,)).fetchone()[0] == 1
        check('1.1 MUTANT audit_stmt_insert raising: the INSERT still lands, delta 0, WARNING logged',
              ok_row and audit_count(conn, s, 'INSERT') == 0 and any('audit_stmt_insert' in n for n in notices),
              f'warnings={[n[:60] for n in notices]}')
    notices.clear()
    with case(conn):
        conn.execute('DROP TRIGGER trg_audit_spaces_ins ON public.spaces')
        conn.execute('CREATE TRIGGER trg_audit_spaces_ins AFTER INSERT ON public.spaces '
                     'FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert()')
        s = new_space(conn, name='rh-mut-noref')
        check('1.1 MUTANT INSERT trigger without REFERENCING: delta 0 and a WARNING (the transition-table gate '
              'is what sees it)', audit_count(conn, s, 'INSERT') == 0 and len(notices) > 0,
              f'warnings={[n[:60] for n in notices]}')


# ── 1.2 C-GUARD ──────────────────────────────────────────────────────────────────────────────────
GUARD = 'spaces_repoint_guard:'


def raises_guard(conn, sql, params):
    code, msg = err_of(conn, sql, params)
    return code == 'P0001' and msg.startswith(GUARD), f'{code} {msg[:70]}'


def repoint_cases(conn, label_prefix='1.2', expect=True):
    """The V102 cases. With expect=True every refusal must happen; a mutant run passes expect=False to
    count how many cases it survives."""
    outcomes = {}
    with case(conn):
        a = new_space(conn, name='rh-g-a', lat=42.5, lng=-72.6, zip_='01373')
        add_weather(conn, a)
        b = new_space(conn, name='rh-g-b')                       # NULL coordinates, with history
        add_weather(conn, b)
        c = new_space(conn, name='rh-g-c', lat=42.5, lng=-72.6, zip_='01373')
        add_cold(conn, c)                                        # cold-range history only
        d = new_space(conn, name='rh-g-d', lat=42.5, lng=-72.6, zip_='01373')
        add_weather(conn, d)
        n = new_space(conn, name='rh-g-n', lat=42.5, lng=-72.6, zip_='01373')   # no history
        outcomes['value->value with history raises'] = raises_guard(
            conn, 'UPDATE public.spaces SET weather_lat = 43.1 WHERE id = %s', (a,))
        outcomes['value->NULL raises'] = raises_guard(
            conn, 'UPDATE public.spaces SET weather_lng = NULL WHERE id = %s', (a,))
        outcomes['NULL->value with history raises'] = raises_guard(
            conn, "UPDATE public.spaces SET postal_code = '01002' WHERE id = %s", (b,))
        outcomes['cold-range-only history raises'] = raises_guard(
            conn, 'UPDATE public.spaces SET weather_lat = 40.0 WHERE id = %s', (c,))
        outcomes['INSERT ... ON CONFLICT DO UPDATE SET weather_lat raises'] = raises_guard(
            conn, "INSERT INTO public.spaces (id, name, created_by, weather_lat) VALUES (%s, 'x', %s, 41.0) "
                  "ON CONFLICT (id) DO UPDATE SET weather_lat = EXCLUDED.weather_lat", (a, OWNER))
        outcomes['multi-row UPDATE raises'] = raises_guard(
            conn, "UPDATE public.spaces SET postal_code = '01001' WHERE id IN (%s, %s)", (n, d))
        code, msg = err_of(conn, 'UPDATE public.spaces SET weather_lat = weather_lat, postal_code = postal_code '
                                 'WHERE id = %s', (a,))
        outcomes['same-value SET passes'] = (code is None, f'{code} {msg[:60]}')
        code, msg = err_of(conn, 'UPDATE public.spaces SET featured_photo_id = NULL, name = %s WHERE id = %s',
                           ('rh-g-a2', a))
        outcomes['featured_photo_id / name UPDATE passes'] = (code is None, f'{code} {msg[:60]}')
        before, seen = audit_count(conn, n, 'UPDATE'), audit_ids(conn, n, 'UPDATE')
        code, msg = err_of(conn, 'UPDATE public.spaces SET weather_lat = 44.0 WHERE id = %s', (n,))
        actor, after = newest_actor(conn, n, 'UPDATE', seen)
        outcomes['no history: the move passes and is audited'] = (
            code is None and audit_count(conn, n, 'UPDATE') == before + 1 and float(after['weather_lat']) == 44.0,
            f'{code} {msg[:60]}')
    if expect:
        for k, (ok, detail) in outcomes.items():
            check(f'{label_prefix} {k}', ok, detail)
    return outcomes


def guard_mutants(conn):
    body = fn_ddl('guard_spaces_repoint')
    for label, mutated, must_fail in [
        ('`<>` in place of IS DISTINCT FROM', body.replace('IS DISTINCT FROM', '<>'), 'value->NULL raises'),
        ('weather_cold_range EXISTS dropped',
         body.replace('\n          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.space_id = OLD.id)', ''),
         'cold-range-only history raises'),
    ]:
        assert mutated != body, label
        with case(conn):
            conn.execute(mutated)
            out = repoint_cases(conn, expect=False)
        check(f'1.2 MUTANT {label}: case "{must_fail}" fails (killed)', not out[must_fail][0], out[must_fail][1])
    with case(conn):
        conn.execute('DROP TRIGGER spaces_repoint_guard ON public.spaces')
        out = repoint_cases(conn, expect=False)
    check('1.2 MUTANT trigger dropped: case "value->value with history raises" fails (killed)',
          not out['value->value with history raises'][0])
    with case(conn):
        code, msg = err_of(conn, 'ALTER TABLE public.spaces DROP COLUMN weather_lat')
        check('1.2 ALTER TABLE spaces DROP COLUMN weather_lat refuses (the UPDATE OF dependency is recorded)',
              code == '2BP01', f'{code} {msg[:90]}')


def data_gate_cases(conn):
    name = 'post_space_coordinates_match_newest_audit'
    with case(conn):
        check('1.2 data gate green on the applied replica', gate_rows(conn, name) == [])
        conn.execute('UPDATE public.spaces SET featured_photo_id = featured_photo_id, updated_at = now() WHERE id = %s',
                     (SENTINEL,))
        whole_row = conn.execute(
            "SELECT s.id FROM public.spaces s WHERE s.id = %s AND to_jsonb(s) IS DISTINCT FROM (SELECT a.after_jsonb "
            "FROM public.audit_events a WHERE a.table_name = 'spaces' AND a.row_id = s.id ORDER BY a.ts DESC LIMIT 1)",
            (SENTINEL,)).fetchall()
        check('1.2 same-hero PUT (updated_at only): data gate stays green; a whole-row compare would red (RIA I6)',
              gate_rows(conn, name) == [] and len(whole_row) == 1)
    with case(conn):
        conn.execute('ALTER TABLE public.spaces DISABLE TRIGGER USER')
        conn.execute('UPDATE public.spaces SET weather_lat = weather_lat + 0.5 WHERE id = %s', (SENTINEL,))
        conn.execute('ALTER TABLE public.spaces ENABLE TRIGGER USER')
        rows = gate_rows(conn, name)
        check('1.2 data gate POSITIVE CONTROL: a coordinate moved with every trigger off reds it',
              [r[0] for r in rows] == [SENTINEL], str(rows))
    with case(conn):
        # The escape template from COMMENT ON FUNCTION, values filled in.
        seen = audit_ids(conn, SENTINEL, 'UPDATE')
        conn.execute("SELECT set_config('app.actor_clerk_sub', 'migration:rehearsal', true)")
        conn.execute('ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard')
        conn.execute("UPDATE public.spaces SET weather_lat = 42.6, weather_lng = -72.7, postal_code = '01373' "
                     'WHERE id = %s', (SENTINEL,))
        conn.execute('ALTER TABLE public.spaces ENABLE TRIGGER spaces_repoint_guard')
        enabled = conn.execute("SELECT tgenabled FROM pg_trigger WHERE tgname = 'spaces_repoint_guard'").fetchone()[0]
        actor, after = newest_actor(conn, SENTINEL, 'UPDATE', seen)
        check('1.2 escape template: the move lands, is audited with the migration actor, guard re-enabled, gate green',
              enabled == 'O' and actor == 'migration:rehearsal' and float(after['weather_lat']) == 42.6
              and gate_rows(conn, name) == [], f'enabled={enabled} actor={actor}')
    with case(conn):
        conn.execute("SELECT set_config('app.actor_clerk_sub', '', true)")
        conn.execute('DELETE FROM public.audit_events WHERE table_name = %s AND row_id = %s', ('spaces', SENTINEL))
        check('1.2 data gate: a Space with no audit row is a finding', [r[0] for r in gate_rows(conn, name)] == [SENTINEL])


# ── 1.3b C-BLOCK ─────────────────────────────────────────────────────────────────────────────────
def delete_cases(conn):
    def only_child(label, add):
        with case(conn):
            s = new_space(conn, name=f'rh-d-{label}')
            add(s)
            code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
            kids = conn.execute(f'SELECT count(*) FROM public.{label} WHERE space_id = %s', (s,)).fetchone()[0]
            still = conn.execute('SELECT count(*) FROM public.spaces WHERE id = %s', (s,)).fetchone()[0]
            check(f'1.3b only-child {label}: DELETE refused P0001 naming {label}; child and Space still there',
                  code == 'P0001' and msg.startswith('spaces_delete_guard:') and f'public.{label}' in msg
                  and kids == 1 and still == 1, f'{code} {msg[:90]}')

    only_child('weather_daily', lambda s: add_weather(conn, s))
    only_child('weather_cold_range', lambda s: add_cold(conn, s))
    only_child('spacetheme', lambda s: conn.execute('INSERT INTO public.spacetheme (space_id) VALUES (%s)', (s,)))
    only_child('photos', lambda s: new_photo(conn, s, 'rh/d.jpg'))
    with case(conn):
        s = new_space(conn, name='rh-d-softphoto')
        p = new_photo(conn, s, 'rh/soft.jpg')
        conn.execute('UPDATE public.photos SET deleted_at = now() WHERE id = %s', (p,))
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
        check('1.3b a SOFT-deleted child still refuses the delete (a foreign key does not know deleted_at)',
              code == 'P0001' and 'public.photos' in msg, f'{code} {msg[:80]}')
    with case(conn):
        s = new_space(conn, name='rh-d-none')
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
        check('1.3b a childless Space deletes', code is None and audit_count(conn, s, 'DELETE') == 1, f'{code} {msg}')
    with case(conn):
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (SENTINEL,))
        check('1.3b the real Space (prod copy) cannot be deleted', code == 'P0001', f'{code} {msg[:80]}')
    with case(conn):
        conn.execute('CREATE TABLE public.rh_later_child (space_id uuid REFERENCES public.spaces (id) ON DELETE CASCADE)')
        s = new_space(conn, name='rh-d-later')
        conn.execute('INSERT INTO public.rh_later_child VALUES (%s)', (s,))
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
        check('1.3b a foreign key added later is covered with no edit to the guard',
              code == 'P0001' and 'rh_later_child' in msg, f'{code} {msg[:80]}')
    with case(conn):
        conn.execute('ALTER TABLE public.spaces ADD CONSTRAINT rh_spaces_id_name_key UNIQUE (id, name)')
        conn.execute('CREATE TABLE public.rh_two_col (sid uuid, sname text, '
                     'FOREIGN KEY (sid, sname) REFERENCES public.spaces (id, name))')
        s = new_space(conn, name='rh-d-twocol')
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
        check('1.3b a two-column foreign key into spaces raises the tripwire, naming it',
              code == 'P0001' and 'has 2 column(s)' in msg, f'{code} {msg[:90]}')
    with case(conn):
        conn.execute('DROP TRIGGER spaces_delete_guard ON public.spaces')
        s = new_space(conn, name='rh-d-mut')
        add_weather(conn, s)
        code, msg = err_of(conn, 'DELETE FROM public.spaces WHERE id = %s', (s,))
        kids = conn.execute('SELECT count(*) FROM public.weather_daily WHERE space_id = %s', (s,)).fetchone()[0]
        check('1.3b MUTANT guard dropped: the DELETE succeeds and CASCADEs the weather row away (killed)',
              code is None and kids == 0, f'{code} kids={kids}')


def truncate_cases(conn, label='1.3b'):
    for stmt in ('TRUNCATE public.spaces CASCADE', 'TRUNCATE public.photos CASCADE',
                 'TRUNCATE public.weather_daily', 'TRUNCATE public.weather_cold_range'):
        with case(conn):
            code, msg = err_of(conn, stmt)
            survived = conn.execute('SELECT count(*) FROM public.weather_daily').fetchone()[0]
            check(f'{label} {stmt}: refused P0001 by a *_truncate_guard, nothing emptied',
                  code == 'P0001' and '_truncate_guard: TRUNCATE of' in msg and survived > 0, f'{code} {msg[:80]}')


def truncate_mutants(conn):
    with case(conn):
        code, msg = err_of(conn, 'TRUNCATE public.spaces')
        check('1.3b TRUNCATE spaces without CASCADE is refused by the foreign keys first (0A000), as PG orders it',
              code == '0A000', f'{code} {msg[:70]}')
    with case(conn):
        conn.execute('DROP TRIGGER spaces_truncate_guard ON public.spaces')
        code, msg = err_of(conn, 'TRUNCATE public.spaces CASCADE')
        check('1.3b spaces_truncate_guard alone dropped: the weather guards in the CASCADE set still refuse',
              code == 'P0001' and 'weather_' in msg, f'{code} {msg[:70]}')
    with case(conn):
        for t, g in (('spaces', 'spaces_truncate_guard'), ('weather_daily', 'weather_daily_truncate_guard'),
                     ('weather_cold_range', 'weather_cold_range_truncate_guard')):
            conn.execute(f'DROP TRIGGER {g} ON public.{t}')
        code, msg = err_of(conn, 'TRUNCATE public.spaces CASCADE')
        left = conn.execute('SELECT count(*) FROM public.spaces').fetchone()[0]
        check('1.3b MUTANT all three truncate guards dropped: TRUNCATE spaces CASCADE empties spaces (killed; '
              'rolled back)', code is None and left == 0, f'{code} spaces_left={left}')


def m2_shaped(conn):
    """The foreign keys v5-spacefk-001 adds (RESTRICT, NOT VALID), on a clone."""
    conn.execute('ALTER TABLE public.plants ADD CONSTRAINT rh_plants_workspace_fk FOREIGN KEY (workspace_id) '
                 'REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID')
    conn.execute('ALTER TABLE public.plant_projects ADD CONSTRAINT rh_pp_workspace_fk FOREIGN KEY (workspace_id) '
                 'REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--base-db', required=True)
    ap.add_argument('--base-corpus', help='tree at the base SHA (no amendment) for the second C-CONV corpus')
    ap.add_argument('--keep', action='store_true', help='leave the clones in place')
    a = ap.parse_args()
    cl = Cluster(a.port)
    main_db, mig = 'sg_main', HERE

    cl.clone(a.base_db, main_db)
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp0 = fingerprint(c)

    pre = cl.gates(main_db, migration=mig, phase='pre')
    check('step 1 pre gates all PASS', bad(pre) == set() and len(pre) == len(GATES['pre']), f'{len(pre)} gates')
    post0 = cl.gates(main_db, migration=mig, phase='post')
    check('step 2 post gates before the apply: none red (vacuous)', bad(post0) == set(), f'{len(post0)} gates')

    corpora = [('tree', TREE)] + ([('base', Path(a.base_corpus))] if a.base_corpus else [])
    before = {k: cl.gates(main_db, corpus=p) for k, p in corpora}

    rc, err = cl.psql_file(main_db, HERE / '0a-guards.sql')
    check('step 4 0a applies, exit 0', rc == 0, err[-200:])
    post1 = cl.gates(main_db, migration=mig, phase='post')
    check('step 5 post gates all PASS after the apply (receipt included)', bad(post1) == set(),
          str(sorted(bad(post1))))
    pre1 = cl.gates(main_db, migration=mig, phase='pre')
    check('step 5 pre gates after the apply: exactly the three continuous:false receipts red',
          {k[2] for k in bad(pre1)} == {'pre_not_already_applied', 'pre_names_free',
                                         'pre_spaces_has_only_the_ownership_trigger'}, str(sorted(bad(pre1))))

    after = {k: cl.gates(main_db, corpus=p) for k, p in corpora}
    for k, _ in corpora:
        newly = sorted('/'.join(x) for x in bad(after[k]) - bad(before[k]))
        cleared = sorted('/'.join(x) for x in bad(before[k]) - bad(after[k]))
        want = [] if k == 'tree' else ['v5-wxcoldband-001/post/post_no_trigger_and_no_row_security']
        check(f'step 6 C-CONV corpus={k}: newly red after the DDL = {want or "{}"}', newly == want,
              f'before_red={len(bad(before[k]))} after_red={len(bad(after[k]))} newly={newly} cleared={cleared}')

    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp1 = fingerprint(c)
        audit_cases(c)
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        repoint_cases(c)
        guard_mutants(c)
        data_gate_cases(c)
        delete_cases(c)
        truncate_cases(c)
        truncate_mutants(c)
        check('step 7 cases left the applied replica unchanged', fingerprint(c) == fp1)

    # Gate-level reds for the mutants, on committed clones.
    for label, ddl, gate in [
        ('audit UPD bound to audit_stmt_update',
         "DROP TRIGGER trg_audit_spaces_upd ON public.spaces; CREATE TRIGGER trg_audit_spaces_upd AFTER UPDATE ON "
         "public.spaces REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "
         "public.audit_stmt_update('name','postal_code','weather_lat','weather_lng','featured_photo_id','created_by')",
         'post_spaces_guard_and_audit_triggers_exact_and_enabled'),
        ('delete guard dropped', 'DROP TRIGGER spaces_delete_guard ON public.spaces',
         'post_spaces_guard_and_audit_triggers_exact_and_enabled'),
        ('repoint guard disabled', 'ALTER TABLE public.spaces DISABLE TRIGGER spaces_repoint_guard',
         'post_spaces_guard_and_audit_triggers_exact_and_enabled'),
        ('weather_daily truncate guard dropped', 'DROP TRIGGER weather_daily_truncate_guard ON public.weather_daily',
         'post_weather_truncate_guards_present_and_enabled'),
        ('an extra trigger on spaces',
         'CREATE TRIGGER rh_extra BEFORE UPDATE ON public.spaces FOR EACH ROW EXECUTE FUNCTION public.prevent_ownership_transfer()',
         'post_spaces_has_no_other_trigger'),
        ('guard body edited', "CREATE OR REPLACE FUNCTION public.guard_space_truncate() RETURNS trigger LANGUAGE plpgsql "
         "SET search_path TO 'pg_catalog', 'public' AS $$ BEGIN RETURN NULL; END; $$",
         'post_new_functions_pinned'),
        ('a watched column dropped from the list',
         "DROP TRIGGER trg_audit_spaces_upd ON public.spaces; CREATE TRIGGER trg_audit_spaces_upd AFTER UPDATE ON "
         "public.spaces REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "
         "public.audit_stmt_update_no_soft_delete('name','postal_code','weather_lat','weather_lng','featured_photo_id')",
         'post_spaces_column_classification_is_complete'),
        ('a weather_daily row deleted', f"DELETE FROM public.weather_daily WHERE space_id = '{SENTINEL}' "
         "AND date = (SELECT min(date) FROM public.weather_daily)", 'post_weather_daily_kept_prod'),
        ('a cold-range row deleted', 'DELETE FROM public.weather_cold_range WHERE ctid IN '
         '(SELECT ctid FROM public.weather_cold_range LIMIT 1)', 'post_weather_cold_range_kept_prod'),
        ('stamp deleted with the objects in place', f"DELETE FROM public.schema_version WHERE version = '{STAMP}'",
         'post_schema_version_recorded'),
    ]:
        cl.clone(main_db, 'sg_mut')
        with psycopg.connect(cl.url('sg_mut'), autocommit=True) as c:
            c.execute(ddl)
        red = {k[2] for k in bad(cl.gates('sg_mut', migration=mig, phase='post'))}
        check(f'gate MUTANT {label}: {gate} reds', gate in red, str(sorted(red)))
        cl.drop('sg_mut')

    # The tolerant v5-wxcoldband-001 gate: green with exactly the named guard (step 6), red on anything else.
    wx = TREE / 'migrations' / 'v5-wxcoldband-001'
    for label, ddl in [
        ('a second, unnamed trigger', 'CREATE TRIGGER rh_other BEFORE TRUNCATE ON public.weather_cold_range '
         'FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate()'),
        ('the guard renamed', 'ALTER TRIGGER weather_cold_range_truncate_guard ON public.weather_cold_range '
         'RENAME TO weather_cold_range_guard'),
        ('the guard re-typed (BEFORE INSERT)', 'DROP TRIGGER weather_cold_range_truncate_guard ON '
         'public.weather_cold_range; CREATE TRIGGER weather_cold_range_truncate_guard BEFORE INSERT ON '
         'public.weather_cold_range FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate()'),
        ('the guard re-pointed at another function', 'DROP TRIGGER weather_cold_range_truncate_guard ON '
         'public.weather_cold_range; CREATE TRIGGER weather_cold_range_truncate_guard BEFORE TRUNCATE ON '
         'public.weather_cold_range FOR EACH STATEMENT EXECUTE FUNCTION public.set_updated_at()'),
    ]:
        cl.clone(main_db, 'sg_mut')
        with psycopg.connect(cl.url('sg_mut'), autocommit=True) as c:
            c.execute(ddl)
        red = {k[2] for k in bad(cl.gates('sg_mut', migration=wx, phase='post'))}
        check(f'wxcoldband tolerant gate MUTANT {label}: post_no_trigger_and_no_row_security reds',
              'post_no_trigger_and_no_row_security' in red, str(sorted(red)))
        cl.drop('sg_mut')

    # After v5-spacefk-001 (M2-shaped keys): TRUNCATE CASCADE re-run, delete guard names plants, 0r refuses.
    cl.clone(main_db, 'sg_m2')
    with psycopg.connect(cl.url('sg_m2'), autocommit=True) as c:
        m2_shaped(c)
        truncate_cases(c, label='1.3b after M2-shaped FKs:')
        fp_m2 = fingerprint(c)
    rc, err = cl.psql_file('sg_m2', HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url('sg_m2'), autocommit=True) as c:
        check('step 10 0r REFUSES while a plants/plant_projects foreign key to spaces exists, nothing dropped',
              rc != 0 and 'rh_plants_workspace_fk' in err and fingerprint(c) == fp_m2, err[-160:])
    cl.drop('sg_m2')

    cl.clone(main_db, 'sg_m3')
    with psycopg.connect(cl.url('sg_m3'), autocommit=True) as c:
        c.execute('CREATE TABLE public.rh_operators (id uuid PRIMARY KEY DEFAULT gen_random_uuid())')
        c.execute('CREATE TRIGGER trg_audit_rh_operators_ins AFTER INSERT ON public.rh_operators REFERENCING NEW TABLE '
                  'AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert()')
        c.execute('INSERT INTO public.rh_operators DEFAULT VALUES')
        n = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'rh_operators'").fetchone()[0]
        check('audit_stmt_insert on another table with a uuid id: one INSERT row', n == 1)
        fp_m3 = fingerprint(c)
    rc, err = cl.psql_file('sg_m3', HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url('sg_m3'), autocommit=True) as c:
        check('step 10 0r REFUSES while another trigger calls audit_stmt_insert, nothing dropped',
              rc != 0 and 'trg_audit_rh_operators_ins' in err and fingerprint(c) == fp_m3, err[-160:])
    cl.drop('sg_m3')

    # 0r, then 0a twice.
    rc, err = cl.psql_file(main_db, HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp_r = fingerprint(c)
    check('step 8 0r exit 0; catalog identical to before the apply', rc == 0 and fp_r == fp0,
          f'{err[-120:]} diff={sorted(set(fp_r) ^ set(fp0))[:6]}')
    check('step 8 post gates after 0r: none red (vacuous again)', bad(cl.gates(main_db, migration=mig)) == set())
    for i in (1, 2):
        rc, err = cl.psql_file(main_db, HERE / '0a-guards.sql')
        with psycopg.connect(cl.url(main_db), autocommit=True) as c:
            fp = fingerprint(c)
            baselines = c.execute("SELECT count(*) FROM public.audit_events WHERE table_name = 'spaces' "
                                  "AND actor_clerk_sub = 'migration:v5-spaceguard-001'").fetchone()[0]
            spaces_n = c.execute('SELECT count(*) FROM public.spaces').fetchone()[0]
        post = cl.gates(main_db, migration=mig, phase='post')
        check(f'step 9 re-apply #{i}: exit 0, catalog = first apply, still one baseline per Space, post green',
              rc == 0 and fp == fp1 and baselines == spaces_n and bad(post) == set(),
              f'{err[-100:]} baselines={baselines} red={sorted(bad(post))}')
    # And the cycle once more, with Spaces made in between: one while the triggers are on (an INSERT row), one
    # while 0r has them off (no audit row at all). The re-apply writes a baseline for the second only, and every
    # standing gate stays green (the receipt is apply-window only and is false here by design).
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        between = new_space(c, name='rh-between')
    rc_r, _ = cl.psql_file(main_db, HERE / '0r-rollback.sql')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp_r2 = fingerprint(c)
        unaudited = new_space(c, name='rh-unaudited')
    rc_a, _ = cl.psql_file(main_db, HERE / '0a-guards.sql')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        fp_a2 = fingerprint(c)
        base_between = audit_count(c, between, 'UPDATE')
        base_unaudited = audit_count(c, unaudited, 'UPDATE')
    red = {k[2] for k in bad(cl.gates(main_db, migration=mig))}
    check('step 9 0r -> 0a with Spaces made in between: catalogs as before, a baseline only for the unaudited '
          'Space, standing gates green',
          rc_r == 0 and rc_a == 0 and fp_r2 == fp0 and fp_a2 == fp1 and base_between == 0 and base_unaudited == 1
          and red <= {'post_receipt_newest_spaces_audit_is_the_baseline'},
          f'baselines between={base_between} unaudited={base_unaudited} red={sorted(red)}')
    with psycopg.connect(cl.url(main_db), autocommit=True) as c:
        c.execute('DELETE FROM public.spaces WHERE id IN (%s, %s)', (between, unaudited))

    # 0a refusals.
    cl.clone(a.base_db, 'sg_ref')
    with psycopg.connect(cl.url('sg_ref'), autocommit=True) as c:
        c.execute('CREATE FUNCTION public.audit_stmt_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$')
        fpr = fingerprint(c)
    rc, err = cl.psql_file('sg_ref', HERE / '0a-guards.sql')
    with psycopg.connect(cl.url('sg_ref'), autocommit=True) as c:
        check('step 10 0a REFUSES a name it does not own (audit_stmt_insert without the stamp), nothing changed',
              rc != 0 and 'audit_stmt_insert' in err and fingerprint(c) == fpr, err[-120:])
    cl.drop('sg_ref')
    cl.clone(a.base_db, 'sg_ref')
    with psycopg.connect(cl.url('sg_ref'), autocommit=True) as c:
        c.execute('ALTER TABLE public.spaces ADD COLUMN deleted_at timestamptz')
        fpr = fingerprint(c)
    rc, err = cl.psql_file('sg_ref', HERE / '0a-guards.sql')
    with psycopg.connect(cl.url('sg_ref'), autocommit=True) as c:
        check('step 10 0a REFUSES on a spaces that has deleted_at, nothing changed',
              rc != 0 and 'deleted_at' in err and fingerprint(c) == fpr, err[-120:])
    cl.drop('sg_ref')

    if not a.keep:
        cl.drop(main_db)
    n_fail = sum(1 for ok, _, _ in results if not ok)
    print(f'\n{len(results) - n_fail}/{len(results)} PASS' + (f', {n_fail} FAIL' if n_fail else ''))
    return 1 if n_fail else 0


if __name__ == '__main__':
    sys.exit(main())
