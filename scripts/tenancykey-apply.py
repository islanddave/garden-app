#!/usr/bin/env python3
"""
tenancykey-apply.py — applies migrations/v5-tenancykey-001 (multi-space step 2.1, V5-SPACETENANCYKEY-001) or, with
--dir v5-tenancyvalidate-001, migrations/v5-tenancyvalidate-001 (step 2.3: the all-row sweep and VALIDATE of 2.1's
25 keys) to staging or prod, one file at a time, in order.

WHAT IT DOES
  --env staging|prod [--dir DIR] [--dry-run] [--env-file PATH] [--i-have-daves-ok] [--rehearsal]

  --dir names one of MIGRATIONS (default v5-tenancykey-001). Both directories share the contract below: numbered
  files 01..NN, one stamp each, psql -v env, and a $pregate$ guard block that sets nothing (the env reaches it
  through the directory's own setting, MIGRATIONS[dir]).

  1. Finds the directory's numbered files (01-*.sql .. NN-*.sql, contiguous) and the one stamp each writes.
  2. Reads which of those stamps public.schema_version already holds.
  3. Applies each file whose stamp is missing, in order, with psql ON_ERROR_STOP and -v env=<env>, and reads
     its stamp back. A file whose stamp is present is skipped. It STOPS at the first file that refuses or fails
     (each file is one transaction, so a refused file changed nothing); run it again and it resumes at the
     first file whose stamp is missing.
  --dry-run reads only. Inside BEGIN TRANSACTION READ ONLY it runs each pending file's guard block ($pregate$:
     env, fingerprint, the owner pre-gate) and reports PASS or REFUSED per file, then ROLLBACK. This is the
     sitting's step 0, "read 45": the owner census re-run with the exact SQL the files carry. For
     v5-tenancyvalidate-001 the guard is the key check and the all-row sweep, so the dry run is the sweep.

REFUSALS, before anything is read or run:
  --env prod without --i-have-daves-ok (applying is a prod database change: Dave's first-hand OK names this
     directory and both envs). --dry-run needs no OK: it is a read.
  The DDL windows (plan V204 §2.8): :58-:02 of every hour (the hourly writers) and 07:00-08:00 UTC. Checked
     again before each file; a run that reaches a window stops there and resumes on the next run.
     --rehearsal lifts this, and the prod OK, for a loopback host (127.0.0.1, ::1, localhost) only: a local
     rehearsal copy is never prod. On any other host it refuses before running anything.

SECRETS. The URL is read from the env file by KEY NAME (NEON_STAGING_URL / NEON_DATABASE_URL; the env file is
never sourced) and reaches psql only as libpq environment variables, never argv. Nothing prints a URL, host,
password or database name; psql's messages are shown with those replaced.

Exit codes: 0 every file applied or already applied (dry run: every pending guard PASS), 1 a refusal or a
failure, 2 usage.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MIGRATION = REPO / "migrations" / "v5-tenancykey-001"
# directory -> the setting its files read the env from (each file's first statement sets it from psql -v env).
MIGRATIONS = {"v5-tenancykey-001": "tenancykey.env", "v5-tenancyvalidate-001": "tenancyvalidate.env"}
OWNER_KEY = {"staging": "NEON_STAGING_URL", "prod": "NEON_DATABASE_URL"}
FILE_RE = re.compile(r"^(\d\d)-[a-z0-9-]+\.sql$")
STAMP_RE = re.compile(r"INSERT INTO public\.schema_version \(version, description\)\s*VALUES \('([^']+)'")
PREGATE_RE = re.compile(r"^DO \$pregate\$\n.*?^END \$pregate\$;", re.S | re.M)
LOOPBACK = ("127.0.0.1", "::1", "localhost")

QUERY_ENV = {
    "sslmode": "PGSSLMODE", "channel_binding": "PGCHANNELBINDING", "options": "PGOPTIONS",
    "sslrootcert": "PGSSLROOTCERT", "sslnegotiation": "PGSSLNEGOTIATION", "connect_timeout": "PGCONNECT_TIMEOUT",
    "application_name": "PGAPPNAME", "target_session_attrs": "PGTARGETSESSIONATTRS", "gssencmode": "PGGSSENCMODE",
}


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def ddl_window(now):
    """The reason `now` (UTC) is inside a DDL window, or None. :58:00-:01:59 of every hour, 07:00-07:59."""
    if now.minute >= 58 or now.minute < 2:
        return f"{now:%H:%M} UTC is within 2 minutes of the hour (hourly writers)"
    if now.hour == 7:
        return f"{now:%H:%M} UTC is inside 07:00-08:00 UTC"
    return None


def read_key(path, key):
    """The value of KEY=VALUE in an env file, by key name, quotes stripped; None if absent. Never echoed."""
    with open(path) as fh:
        for line in fh:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) == key:
                return m.group(2).strip("'\"")
    return None


def libpq_env(url, key):
    """A postgresql:// URL as libpq environment variables. A ValueError names the key and at most a parameter
    name: never a value."""
    u = urlsplit(url)
    if u.scheme not in ("postgres", "postgresql"):
        raise ValueError(f"{key} is not a postgresql:// URL")
    if "," in u.netloc:
        raise ValueError(f"{key} names more than one host")
    try:
        port = u.port
    except ValueError:
        raise ValueError(f"{key} has a malformed port") from None
    if not u.hostname or not u.username:
        raise ValueError(f"{key} has no host or no user")
    env = {"PGHOST": u.hostname, "PGUSER": unquote(u.username)}
    if u.password is not None:
        env["PGPASSWORD"] = unquote(u.password)
    if port:
        env["PGPORT"] = str(port)
    if u.path.lstrip("/"):
        env["PGDATABASE"] = unquote(u.path.lstrip("/"))
    for name, value in parse_qsl(u.query, keep_blank_values=True):
        if name not in QUERY_ENV:
            raise ValueError(f"{key} carries a parameter this script does not pass on: {name}")
        env[QUERY_ENV[name]] = value
    return env


def child_env(pg, read_only=False):
    """This process's environment without any PG*, NEON_* or DATABASE_URL variable, plus the libpq variables for
    ONE connection. read_only adds default_transaction_read_only=on to PGOPTIONS."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PG", "NEON_")) and k != "DATABASE_URL"}
    env.update(pg)
    if read_only:
        env["PGOPTIONS"] = (env.get("PGOPTIONS", "") + " -c default_transaction_read_only=on").strip()
    env.setdefault("PGCONNECT_TIMEOUT", "15")
    env.setdefault("PGAPPNAME", "tenancykey-apply")
    return env


def psql(pg, *, file=None, sql=None, variables=(), read_only=False):
    """Run psql on the connection in pg (environment only). Returns (exit code, stdout, stderr)."""
    args = ["psql", "-X", "-q", "-At", "-w", "-v", "ON_ERROR_STOP=1"]
    for name, value in variables:
        args += ["-v", f"{name}={value}"]
    stdin = ""
    if file is not None:
        args += ["-f", str(file)]
    else:
        stdin = sql
    r = subprocess.run(args, env=child_env(pg, read_only), input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def scrub(text, pg):
    """text with the connection's host, password, database name and options replaced, and any IP address."""
    for var, mark in (("PGPASSWORD", "<password>"), ("PGHOST", "<host>"), ("PGDATABASE", "<database>"),
                      ("PGOPTIONS", "<options>")):
        if len(pg.get(var) or "") >= 3:
            text = text.replace(pg[var], mark)
    text = re.sub(r"\((?:[0-9a-fA-F]*:[0-9a-fA-F:.]*)\)", "(<ip>)", text)
    return re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>", text)


def psql_lines(err, pg):
    return [scrub(re.sub(r"^psql:[^:]*:\d+: ", "", ln), pg) for ln in err.splitlines() if ln.strip()]


def say(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {label}" + (f": {detail}" if detail else ""), flush=True)
    return ok


def migration_files(directory=MIGRATION):
    """[(path, stamp)] in order. Raises ValueError unless the numbered files run 01..N with no gap and each writes
    exactly one stamp."""
    files = sorted(p for p in Path(directory).iterdir() if FILE_RE.match(p.name))
    if not files:
        raise ValueError(f"no numbered SQL files in {directory}")
    out = []
    for i, p in enumerate(files, start=1):
        if int(FILE_RE.match(p.name).group(1)) != i:
            raise ValueError(f"{p.name}: expected file number {i:02d} (the files must run 01..N with no gap)")
        stamps = STAMP_RE.findall(p.read_text())
        if len(stamps) != 1:
            raise ValueError(f"{p.name}: writes {len(stamps)} schema_version stamps, expected exactly 1")
        out.append((p, stamps[0]))
    if len({s for _, s in out}) != len(out):
        raise ValueError("two files write the same stamp")
    return out


def pregate_block(path):
    """The file's guard block ($pregate$ ... $pregate$;), the only part --dry-run runs."""
    m = PREGATE_RE.search(Path(path).read_text())
    if not m:
        raise ValueError(f"{Path(path).name}: no $pregate$ block")
    return m.group(0)


def applied_stamps(pg, stamps):
    """The subset of stamps present in public.schema_version, or None after a FAIL line."""
    arr = ", ".join("'" + s.replace("'", "''") + "'" for s in stamps)
    code, out, err = psql(pg, sql=f"SELECT version FROM public.schema_version WHERE version = ANY (ARRAY[{arr}]);",
                          read_only=True)
    if code:
        say(False, "read public.schema_version", f"psql exit {code}")
        for ln in psql_lines(err, pg):
            print(f"     {ln}")
        return None
    return {ln for ln in out.splitlines() if ln}


def dry_run(pg, env, pending, setting="tenancykey.env"):
    good = True
    for path, stamp in pending:
        sql = ("BEGIN TRANSACTION READ ONLY;\n"
               f"SELECT set_config('{setting}', '{env}', true) \\gset tk_\n"
               f"{pregate_block(path)}\n"
               "ROLLBACK;\n")
        code, _, err = psql(pg, sql=sql, read_only=True)
        good &= say(code == 0, f"{path.name} guard ({env})", "" if code == 0 else "REFUSED")
        for ln in psql_lines(err, pg):
            print(f"     {ln}")
    return good


def apply(pg, env, files, done, rehearsal, clock):
    for path, stamp in files:
        if stamp in done:
            print(f"SKIP {path.name}: stamp {stamp} present", flush=True)
            continue
        why = None if rehearsal else ddl_window(clock())
        if why:
            say(False, f"{path.name} not started", f"{why}; run again outside the window to resume here")
            return False
        code, _, err = psql(pg, file=path, variables=(("env", env),))
        lines = psql_lines(err, pg)
        if code:
            say(False, f"{path.name}", f"psql exit {code}; this file changed nothing; the run stops here")
            for ln in lines:
                print(f"     {ln}")
            return False
        for ln in lines:
            print(f"     {ln}")
        now = applied_stamps(pg, [stamp])
        if not say(bool(now), f"{path.name} applied", f"stamp {stamp}" if now else f"stamp {stamp} NOT found"):
            return False
    return True


def main(argv=None, clock=utcnow):
    ap = argparse.ArgumentParser(description="apply migrations/v5-tenancykey-001 (or --dir) in order "
                                             "(V5-SPACETENANCYKEY-001)")
    ap.add_argument("--env", required=True, choices=("staging", "prod"))
    ap.add_argument("--dir", default="v5-tenancykey-001", choices=sorted(MIGRATIONS),
                    help="the migration directory (default v5-tenancykey-001)")
    ap.add_argument("--env-file", default=str(REPO / ".env.local"),
                    help="KEY=VALUE file the URL is read from, by key name (default: the repo's .env.local)")
    ap.add_argument("--dry-run", action="store_true", help="read only: report each pending file's guard")
    ap.add_argument("--i-have-daves-ok", action="store_true", help="required to apply on --env prod")
    ap.add_argument("--rehearsal", action="store_true",
                    help="local rehearsal: lifts the DDL-window refusal and the prod OK; loopback hosts only")
    args = ap.parse_args(argv)
    if args.env == "prod" and not args.dry_run and not args.i_have_daves_ok and not args.rehearsal:
        print("REFUSED: applying on --env prod needs Dave's first-hand OK, then --i-have-daves-ok. "
              "Nothing was read or run.", file=sys.stderr)
        return 1
    if not args.dry_run and not args.rehearsal:
        why = ddl_window(clock())
        if why:
            print(f"REFUSED: {why} (a DDL window, plan V204 §2.8). Nothing was read or run.", file=sys.stderr)
            return 1
    if not shutil.which("psql"):
        say(False, "psql is not on PATH")
        return 1
    try:
        files = migration_files(REPO / "migrations" / args.dir)
    except ValueError as exc:
        say(False, "the migration files", str(exc))
        return 1
    key = OWNER_KEY[args.env]
    try:
        url = read_key(args.env_file, key)
    except OSError as exc:
        say(False, f"read {args.env_file}", type(exc).__name__)
        return 1
    if not url:
        say(False, f"{key} is not in {args.env_file}")
        return 1
    try:
        pg = libpq_env(url, key)
    except ValueError as exc:
        say(False, str(exc))
        return 1
    if args.rehearsal and pg["PGHOST"] not in LOOPBACK:
        print("REFUSED: --rehearsal is for a loopback host only. Nothing was run.", file=sys.stderr)
        return 1
    print(f"{args.dir}, --env {args.env} ({key}), {len(files)} files"
          + (", dry run (read only)" if args.dry_run else "") + (", rehearsal" if args.rehearsal else ""), flush=True)
    done = applied_stamps(pg, [s for _, s in files])
    if done is None:
        return 1
    pending = [(p, s) for p, s in files if s not in done]
    print(f"{len(done)} of {len(files)} stamps present; "
          + (f"resumes at {pending[0][0].name}" if pending else "nothing to apply"), flush=True)
    if args.dry_run:
        return 0 if dry_run(pg, args.env, pending, MIGRATIONS[args.dir]) else 1
    return 0 if apply(pg, args.env, files, done, args.rehearsal, clock) else 1


if __name__ == "__main__":
    sys.exit(main())
