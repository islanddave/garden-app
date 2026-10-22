#!/usr/bin/env python3
"""
wx-writer-role.py — garden_wx_writer, the cold-range writer's own login, on staging or prod.

WHY THIS EXISTS (V5-WXCOLDBAND-001). A job on Dave's Mac writes tonight's forecast cold range to
public.weather_cold_range each morning. Dave, 2026-10-13: the Mac writer gets its own narrow login, "a
database role that can add rows to weather_cold_range and nothing else, created from a re-runnable setup
file that he OKs before it is applied once". The file is
migrations/v5-wxcoldband-001/1a-writer-role.sql; this script runs it, gives the role a password, puts the
writer's URL where the job can read it, and proves over the wire that the role is as narrow as the file
says.

VERBS
  apply --env staging|prod
      1. Run 1a-writer-role.sql as the owner (NEON_STAGING_URL / NEON_DATABASE_URL), psql ON_ERROR_STOP.
      2. Set a new random password on garden_wx_writer: 32 random bytes, url-safe.
      3. Write the writer's URL into the env file as WX_WRITER_DATABASE_URL_STAGING / _PROD, replacing the
         line if there is one: the owner URL's host, port, database and parameters, with the role and the
         new password in place of the owner's.
      4. Connect AS garden_wx_writer and run the probes below.
      Run again, it re-asserts the role and ROTATES the password: the job must read the new line.
  verify --env staging|prod
      The probes only, as garden_wx_writer, from WX_WRITER_DATABASE_URL_<ENV>.
  reassert --env staging|prod
      Run 1a-writer-role.sql as the owner, then the probes. NO new password: the job's line is left as it
      is. For a role whose grant drifted or was lost (a restore), when its password still works.
  grant --env staging|prod                      (V5-SPACEPLOTTIER-001, multi-space 3.2c)
      1. Run migrations/v5-wxwriterplot-001/0a-writer-plot-grant.sql as the owner: INSERT on plot_id too.
      2. As the owner, read the job's Space (the one public.spaces row) and that Space's live default plot,
         and write them as WX_WRITER_SPACE_ID_<ENV> and WX_WRITER_PLOT_ID_<ENV>: the keys the cold-range job
         reads, so no person copies a UUID. Refuses unless there is exactly one Space with exactly one live
         default plot.
      3. The probes, expecting INSERT naming plot_id to be allowed. NO new password.
  ungrant --env staging|prod
      Run migrations/v5-wxwriterplot-001/0r-rollback.sql as the owner (switch the job back to its
      seven-column text first), remove the two keys, then the probes, expecting plot_id to be denied.
  rollback --env staging|prod
      Run 1r-writer-role-rollback.sql as the owner (stop the Mac job first), then remove the
      WX_WRITER_DATABASE_URL_<ENV> line and the two keys.

  --env prod refuses, for every verb, unless --i-have-daves-ok is given. Creating the role on prod,
  rotating its password and dropping it are prod database changes and need Dave's first-hand OK.

THE PROBES, as garden_wx_writer over the same connection path the job will use (Neon's pooler, if the
owner URL names it):
  - it is connected as garden_wx_writer, has_column_privilege INSERT is true on the seven columns and
    false on created_at, and table-level INSERT is false (catalog functions only; no row is written);
  - SELECT on weather_cold_range, SELECT on plants, UPDATE and DELETE on weather_cold_range (WHERE false),
    and an INSERT naming created_at (INSERT ... SELECT ... WHERE false: the privilege is checked before any
    row, so none is written) each answer 42501 permission denied. Any other answer, success included, is a
    FAIL.
  - the job's own column list (3.2c: the seven and plot_id) as INSERT ... SELECT ... WHERE false ON CONFLICT
    DO NOTHING: allowed once 3.2c's grant is made. `grant` requires it allowed, `ungrant` denied; the
    other verbs require it allowed when WX_WRITER_PLOT_ID_<ENV> is in the env file (the job then sends
    plot_id) and otherwise report which it is.

SECRETS. A URL is read from the env file by KEY NAME (default: the repo's .env.local; it cannot be sourced
by a shell) and reaches psql only through the child's environment, split into PGHOST, PGPASSWORD and the
rest. Never argv, so never in ps or pgrep output (L-067, L-543). The password is made here, sent to the
server once on psql's stdin, and written only to the env file (its mode kept, replaced atomically).
Nothing prints a URL, a password, a host or a database name: output is PASS / FAIL lines and the role
name, and any psql message is shown with those values replaced. The ALTER ROLE carries the password to
the server in plain text, as Neon's documentation does it; a statement log or pg_stat_statements there
could keep it, and both are readable only by roles that already hold far more than this one.

Exit codes: 0 every step PASS, 1 a FAIL or a refusal, 2 usage.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote, urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MIGRATION = REPO / "migrations" / "v5-wxcoldband-001"
APPLY_SQL = MIGRATION / "1a-writer-role.sql"
ROLLBACK_SQL = MIGRATION / "1r-writer-role-rollback.sql"
PLOT_MIGRATION = REPO / "migrations" / "v5-wxwriterplot-001"
GRANT_SQL = PLOT_MIGRATION / "0a-writer-plot-grant.sql"
UNGRANT_SQL = PLOT_MIGRATION / "0r-rollback.sql"

ROLE = "garden_wx_writer"
OWNER_KEY = {"staging": "NEON_STAGING_URL", "prod": "NEON_DATABASE_URL"}
WRITER_KEY = {"staging": "WX_WRITER_DATABASE_URL_STAGING", "prod": "WX_WRITER_DATABASE_URL_PROD"}
# The cold-range job's Space and plot, by key name (3.2c). Written by `grant`, read by wn3_send.py.
SPACE_KEY = {"staging": "WX_WRITER_SPACE_ID_STAGING", "prod": "WX_WRITER_SPACE_ID_PROD"}
PLOT_KEY = {"staging": "WX_WRITER_PLOT_ID_STAGING", "prod": "WX_WRITER_PLOT_ID_PROD"}
TABLE = "public.weather_cold_range"
SEVEN = ("space_id", "night_date", "init_time", "p10_min_f", "p50_min_f", "leads_read", "leads_expected")
# The job's INSERT column list from 3.2c on (wn3_send.py), in its order.
JOB_COLUMNS = ("space_id", "plot_id", "night_date", "init_time", "p10_min_f", "p50_min_f", "leads_read",
               "leads_expected")
_TYPES = {"space_id": "uuid", "plot_id": "uuid", "night_date": "date", "init_time": "timestamptz",
          "p10_min_f": "numeric", "p50_min_f": "numeric", "leads_read": "smallint", "leads_expected": "smallint",
          "created_at": "timestamptz"}


def insert_probe(cols, tail=""):
    """INSERT naming exactly `cols`, from a SELECT of typed NULLs WHERE false: PostgreSQL checks the column
    privileges when the statement starts, so it answers 42501 or succeeds without writing a row."""
    nulls = ", ".join(f"NULL::{_TYPES[c]}" for c in cols)
    return f"INSERT INTO {TABLE} ({', '.join(cols)}) SELECT {nulls} WHERE false" + tail

# The URL query parameters passed on, each as the libpq environment variable that means the same thing.
# Anything else in a URL is refused by name rather than silently dropped.
QUERY_ENV = {
    "sslmode": "PGSSLMODE", "channel_binding": "PGCHANNELBINDING", "options": "PGOPTIONS",
    "sslrootcert": "PGSSLROOTCERT", "sslnegotiation": "PGSSLNEGOTIATION", "connect_timeout": "PGCONNECT_TIMEOUT",
    "application_name": "PGAPPNAME", "target_session_attrs": "PGTARGETSESSIONATTRS", "gssencmode": "PGGSSENCMODE",
}

IDENTITY = (f"SELECT current_user, has_table_privilege('{TABLE}', 'INSERT'), "
            f"has_column_privilege('{TABLE}', 'created_at', 'INSERT'), "
            f"(SELECT bool_and(has_column_privilege('{TABLE}', c, 'INSERT')) "
            f"FROM unnest(ARRAY[{', '.join(repr(c) for c in SEVEN)}]) AS c)")
IDENTITY_OK = f"{ROLE}|f|f|t"
PROBES = (
    (f"SELECT on {TABLE}", f"SELECT 1 FROM {TABLE} LIMIT 0"),
    ("SELECT on public.plants", "SELECT 1 FROM public.plants LIMIT 0"),
    (f"UPDATE on {TABLE}", f"UPDATE {TABLE} SET p10_min_f = p10_min_f WHERE false"),
    (f"DELETE on {TABLE}", f"DELETE FROM {TABLE} WHERE false"),
    (f"INSERT naming created_at on {TABLE}", insert_probe(
        ("space_id", "night_date", "init_time", "p10_min_f", "leads_read", "leads_expected", "created_at"))),
)
PLOT_PROBE = insert_probe(JOB_COLUMNS, " ON CONFLICT DO NOTHING")
PLOT_LABEL = "INSERT naming plot_id (the job's eight columns, bare ON CONFLICT DO NOTHING; no row written)"
# Read as the OWNER by `grant`: the job's Space is the one spaces row, its plot that Space's live default plot.
# One row per Space; the counts let the script refuse anything but exactly one of each.
SPACE_PLOT_SQL = ("SELECT s.id, (SELECT count(*) FROM public.spaces), "
                  "(SELECT count(*) FROM public.plots p WHERE p.workspace_id = s.id AND p.is_default "
                  "AND p.deleted_at IS NULL), "
                  "(SELECT p.id FROM public.plots p WHERE p.workspace_id = s.id AND p.is_default "
                  "AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1) "
                  "FROM public.spaces s ORDER BY s.id")
# Seconds to wait before each further try of the first login after a new password. Neon's proxy may
# answer from what it knew of the role a moment ago (unverified); a local server never needs these.
LOGIN_RETRY_WAITS = (2, 4, 8, 16)


def read_key(path, key):
    """The value of KEY=VALUE in an env file, by key name, quotes stripped; None if absent. As
    neon_safety_branch.load_env_file reads one: the first line for the key wins. Never echoed."""
    with open(path) as fh:
        for line in fh:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) == key:
                return m.group(2).strip("'\"")
    return None


def rewrite_key(path, key, value):
    """Keep every line of the env file except KEY's, which becomes one KEY=value line (where the first one
    was, else at the end) or, with value None, goes. Returns whether the key was there. Written to a
    temporary file beside it with the same mode and renamed over it, so a crash leaves one whole file."""
    path = Path(os.path.realpath(path))
    mode = stat.S_IMODE(path.stat().st_mode)
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
    out, found, placed = [], False, False
    for line in path.read_text().splitlines(keepends=True):
        if pattern.match(line):
            found = True
            if value is not None and not placed:
                out.append(f"{key}={value}\n")
                placed = True
            continue
        out.append(line)
    if value is None and not found:
        return False
    if value is not None and not placed:
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        out.append(f"{key}={value}\n")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as fh:
            fh.write("".join(out))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return found


def libpq_env(url, key):
    """A postgresql:// URL as libpq environment variables. A ValueError names the key and, at most, a
    parameter name: never a value."""
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


def writer_url(owner_url, password):
    """The owner URL with garden_wx_writer and its password in place of the owner's: same host, port,
    database and parameters."""
    u = urlsplit(owner_url)
    hostport = u.netloc.rpartition("@")[2]
    return urlunsplit((u.scheme, f"{quote(ROLE, safe='')}:{quote(password, safe='')}@{hostport}", u.path, u.query, ""))


def new_password():
    """32 random bytes, url-safe base64: 43 characters from [A-Za-z0-9_-], so it needs no escaping in a
    SQL literal or a URL. Checked, not assumed."""
    pw = secrets.token_urlsafe(32)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", pw):
        raise RuntimeError("token_urlsafe(32) returned an unexpected shape")
    return pw


def password_sql(pw):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", pw):
        raise ValueError("refusing a password that is not 43 url-safe characters")
    return f"ALTER ROLE {ROLE} PASSWORD '{pw}';\n"


def child_env(pg):
    """This process's environment without any PG*, NEON_*, WX_WRITER_* or DATABASE_URL variable, plus
    the libpq variables for ONE connection."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("PG", "NEON_", "WX_WRITER_")) and k != "DATABASE_URL"}
    env.update(pg)
    env.setdefault("PGCONNECT_TIMEOUT", "15")
    env.setdefault("PGAPPNAME", "wx-writer-role")
    return env


def psql(pg, *, file=None, sql=None, stdin=None, verbosity="default"):
    """Run psql on the connection in pg (environment only). SQL comes from a file, from -c (no secret is
    ever in it) or from stdin. Returns (exit code, stdout, stderr)."""
    args = ["psql", "-X", "-q", "-At", "-w", "-v", "ON_ERROR_STOP=1", "-v", "ECHO=none", "-v", f"VERBOSITY={verbosity}"]
    if file is not None:
        args += ["-f", str(file)]
    elif sql is not None:
        args += ["-c", sql]
    r = subprocess.run(args, env=child_env(pg), input=stdin if stdin is not None else "",
                       capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def scrub(text, *pgs):
    """text with every host, password, database name and options value of the given connections, and
    any IP address, replaced by a placeholder."""
    for pg in pgs:
        for var, mark in (("PGPASSWORD", "<password>"), ("PGHOST", "<host>"), ("PGDATABASE", "<database>"),
                          ("PGOPTIONS", "<options>")):
            if len(pg.get(var) or "") >= 3:
                text = text.replace(pg[var], mark)
    # libpq prints the address it tried in brackets after the host: "(2600:1f18::1), port 5432".
    text = re.sub(r"\((?:[0-9a-fA-F]*:[0-9a-fA-F:.]*)\)", "(<ip>)", text)
    return re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>", text)


def psql_lines(err, *pgs):
    """psql's stderr, scrubbed, without its 'psql:<file>:<line>: ' prefixes."""
    return [scrub(re.sub(r"^psql:[^:]*:\d+: ", "", ln), *pgs) for ln in err.splitlines() if ln.strip()]


def sqlstate(err):
    m = re.search(r"\b(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b", err)
    return m.group(1) if m else None


def say(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {label}" + (f": {detail}" if detail else ""))
    return ok


def load_url(env_file, key):
    """(url, libpq env) for KEY in the env file, or None after a FAIL line naming the key."""
    try:
        url = read_key(env_file, key)
    except OSError as exc:
        say(False, f"read {env_file}", type(exc).__name__)
        return None
    if not url:
        say(False, f"{key} is not in {env_file}")
        return None
    try:
        return url, libpq_env(url, key)
    except ValueError as exc:
        say(False, str(exc))
        return None


def plot_probe(pg, want):
    """The job's eight-column INSERT (no row). want True: must be allowed; False: must be denied (42501);
    None: either, reported. Returns whether it held."""
    code, _, err = psql(pg, sql=PLOT_PROBE, verbosity="sqlstate")
    state = sqlstate(err)
    got = "allowed" if code == 0 else ("denied (42501)" if state == "42501" else
                                       "no plot_id column (42703)" if state == "42703" else
                                       f"psql exit {code}, SQLSTATE {state or 'none'}")
    if want is True:
        return say(code == 0, f"{PLOT_LABEL} is allowed", "" if code == 0 else got)
    if want is False:
        return say(code != 0 and state == "42501", f"{PLOT_LABEL} is denied (42501)",
                   "" if state == "42501" else ("it SUCCEEDED" if code == 0 else got))
    ok = code == 0 or state in ("42501", "42703")
    return say(ok, f"{PLOT_LABEL}: {got}" + ("" if code == 0 else " (until `grant`, 3.2c)"), "" if ok else got)


def want_plot(env, env_file):
    """True when the env file carries the job's plot key (the job then names plot_id), else None."""
    try:
        return True if read_key(env_file, PLOT_KEY[env]) else None
    except OSError:
        return None


def probe(pg, retry_login=False, want_plot_insert=None):
    """Connect as garden_wx_writer and prove what it can and cannot do. True if every probe holds."""
    waits = list(LOGIN_RETRY_WAITS) if retry_login else []
    tries = 1
    code, out, err = psql(pg, sql=IDENTITY, verbosity="sqlstate")
    while code == 2 and waits:
        time.sleep(waits.pop(0))
        tries += 1
        code, out, err = psql(pg, sql=IDENTITY, verbosity="sqlstate")
    if code:
        say(False, f"log in as {ROLE}", f"psql exit {code}" + (f" after {tries} tries" if tries > 1 else ""))
        for ln in psql_lines(err, pg):
            print(f"     {ln}")
        return False
    good = say(out == IDENTITY_OK, f"logged in as {ROLE}; INSERT on the seven columns, not on created_at, not table-level"
               + (f" (login took {tries} tries)" if tries > 1 else ""),
               "" if out == IDENTITY_OK else f"got {scrub(out, pg)!r}, want {IDENTITY_OK!r}")
    good &= plot_probe(pg, want_plot_insert)
    for label, sql in PROBES:
        code, out, err = psql(pg, sql=sql, verbosity="sqlstate")
        state = sqlstate(err)
        ok = code != 0 and state == "42501"
        good &= say(ok, f"{label} is denied (42501)",
                    "" if ok else ("it SUCCEEDED" if code == 0 else f"psql exit {code}, SQLSTATE {state or 'none'}"))
    return good


def cmd_apply(env, env_file):
    owner = load_url(env_file, OWNER_KEY[env])
    if not owner:
        return 1
    owner_url, owner_pg = owner
    code, _, err = psql(owner_pg, file=APPLY_SQL)
    if not say(code == 0, f"{APPLY_SQL.name} as the owner", "" if code == 0 else f"psql exit {code}, nothing changed"):
        for ln in psql_lines(err, owner_pg):
            print(f"     {ln}")
        return 1
    for ln in psql_lines(err, owner_pg):
        print(f"     {ln}")
    pw = new_password()
    code, _, err = psql(owner_pg, stdin=password_sql(pw), verbosity="sqlstate")
    if not say(code == 0, f"new password on {ROLE} (not shown)",
               "" if code == 0 else f"psql exit {code}, SQLSTATE {sqlstate(err) or 'none'}"):
        return 1
    url = writer_url(owner_url, pw)
    rewrite_key(env_file, WRITER_KEY[env], url)
    if not say(read_key(env_file, WRITER_KEY[env]) == url,
               f"{WRITER_KEY[env]} written to {Path(env_file).name} (value not shown)"):
        return 1
    return 0 if probe(libpq_env(url, WRITER_KEY[env]), retry_login=True,
                      want_plot_insert=want_plot(env, env_file)) else 1


def cmd_verify(env, env_file):
    writer = load_url(env_file, WRITER_KEY[env])
    if not writer:
        return 1
    return 0 if probe(writer[1], want_plot_insert=want_plot(env, env_file)) else 1


def run_owner_file(owner_pg, path, what):
    """psql -f `path` as the owner. Prints a PASS/FAIL line and psql's scrubbed messages; True on exit 0."""
    code, _, err = psql(owner_pg, file=path)
    ok = say(code == 0, f"{path.name} as the owner{what}", "" if code == 0 else f"psql exit {code}, nothing changed")
    for ln in psql_lines(err, owner_pg):
        print(f"     {ln}")
    return ok


def cmd_reassert(env, env_file):
    """1a again, then the probes. The password is not touched: the job's line stays valid."""
    owner = load_url(env_file, OWNER_KEY[env])
    writer = load_url(env_file, WRITER_KEY[env]) if owner else None
    if not (owner and writer):
        return 1
    if not run_owner_file(owner[1], APPLY_SQL, " (no new password)"):
        return 1
    return 0 if probe(writer[1], want_plot_insert=want_plot(env, env_file)) else 1


def read_space_and_plot(owner_pg):
    """(space id, plot id) as the owner reads them, or None after a FAIL line. Exactly one Space, and exactly
    one live default plot of it; anything else is a decision for a person, not for this script."""
    code, out, err = psql(owner_pg, sql=SPACE_PLOT_SQL, verbosity="sqlstate")
    if code:
        say(False, "read the job's Space and plot as the owner", f"psql exit {code}, SQLSTATE {sqlstate(err) or 'none'}")
        return None
    rows = [ln.split("|") for ln in out.splitlines() if ln.strip()]
    if len(rows) != 1:
        say(False, "the job's Space is the one public.spaces row", f"there are {len(rows)}: choose on purpose (V204 5.x)")
        return None
    space, _, n_default, plot = rows[0]
    if n_default != "1" or not plot:
        say(False, "the Space has exactly one live default plot", f"it has {n_default}")
        return None
    try:
        return str(uuid.UUID(space)), str(uuid.UUID(plot))
    except ValueError:
        say(False, "the Space and plot ids are uuids", "")
        return None


def cmd_grant(env, env_file):
    """3.2c: INSERT on plot_id, the job's Space and plot keys, then the probes (plot_id allowed)."""
    owner = load_url(env_file, OWNER_KEY[env])
    writer = load_url(env_file, WRITER_KEY[env]) if owner else None
    if not (owner and writer):
        return 1
    if not run_owner_file(owner[1], GRANT_SQL, ": INSERT on plot_id (no new password)"):
        return 1
    ids = read_space_and_plot(owner[1])
    if not ids:
        return 1
    for key, value in ((SPACE_KEY[env], ids[0]), (PLOT_KEY[env], ids[1])):
        rewrite_key(env_file, key, value)
        if not say(read_key(env_file, key) == value, f"{key}={value} written to {Path(env_file).name}"):
            return 1
    return 0 if probe(writer[1], want_plot_insert=True) else 1


def cmd_ungrant(env, env_file):
    """3.2c rollback: plot_id revoked, the two keys removed, then the probes (plot_id denied)."""
    owner = load_url(env_file, OWNER_KEY[env])
    writer = load_url(env_file, WRITER_KEY[env]) if owner else None
    if not (owner and writer):
        return 1
    if not run_owner_file(owner[1], UNGRANT_SQL, ": INSERT on plot_id revoked"):
        return 1
    remove_job_keys(env, env_file)
    return 0 if probe(writer[1], want_plot_insert=False) else 1


def remove_job_keys(env, env_file):
    for key in (SPACE_KEY[env], PLOT_KEY[env]):
        found = rewrite_key(env_file, key, None)
        say(read_key(env_file, key) is None, f"{key} {'removed from' if found else 'was not in'} {Path(env_file).name}")


def cmd_rollback(env, env_file):
    owner = load_url(env_file, OWNER_KEY[env])
    if not owner:
        return 1
    code, _, err = psql(owner[1], file=ROLLBACK_SQL)
    lines = psql_lines(err, owner[1])
    if not say(code == 0, f"{ROLLBACK_SQL.name} as the owner: {ROLE} dropped or already absent",
               "" if code == 0 else f"psql exit {code}, nothing dropped"):
        for ln in lines:
            print(f"     {ln}")
        return 1
    for ln in lines:
        print(f"     {ln}")
    found = rewrite_key(env_file, WRITER_KEY[env], None)
    say(read_key(env_file, WRITER_KEY[env]) is None,
        f"{WRITER_KEY[env]} {'removed from' if found else 'was not in'} {Path(env_file).name}")
    remove_job_keys(env, env_file)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="garden_wx_writer, the cold-range writer's own login (V5-WXCOLDBAND-001)")
    ap.add_argument("verb", choices=("apply", "verify", "reassert", "grant", "ungrant", "rollback"))
    ap.add_argument("--env", required=True, choices=("staging", "prod"))
    ap.add_argument("--env-file", default=str(REPO / ".env.local"),
                    help="KEY=VALUE file the URLs are read from and the writer's URL is written to (default: the repo's .env.local)")
    ap.add_argument("--i-have-daves-ok", action="store_true", help="required for --env prod")
    args = ap.parse_args(argv)
    if args.env == "prod" and not args.i_have_daves_ok:
        print("REFUSED: --env prod needs Dave's first-hand OK, then --i-have-daves-ok. Nothing was read or run.",
              file=sys.stderr)
        return 1
    if not shutil.which("psql"):
        say(False, "psql is not on PATH")
        return 1
    print(f"role {ROLE}, --env {args.env}, {args.verb}")
    verb = {"apply": cmd_apply, "verify": cmd_verify, "reassert": cmd_reassert, "grant": cmd_grant,
            "ungrant": cmd_ungrant, "rollback": cmd_rollback}[args.verb]
    return verb(args.env, args.env_file)


if __name__ == "__main__":
    sys.exit(main())
