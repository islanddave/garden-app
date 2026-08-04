#!/usr/bin/env python3
"""Migration gate runner (OPS-GATERUNNER-001).

WHY THIS EXISTS
---------------
Every migration under migrations/*/ ships a gates.yml declaring pre-conditions
(must hold before applying), sweep checks (L-058: every predicate a CHECK is
about to enforce must already hold), and post-conditions (must hold after).
They are correct, carefully written, and — until this script — NOTHING EVER RAN
THEM. 34 gate files / 400 assertions were runbook prose.

The cost was measured, not hypothetical. V4-EVENTSOURCE-001 added
event_log.source, wrote a correct backfill, and the backfill never executed --
leaving the column 100% NULL across all 12,100 prod rows for weeks, while the
provenance heuristic it was meant to replace stayed 98.5% false-positive. That
migration's own gates.yml contains post_every_batch_row_classified and
post_every_status_change_row_classified, each asserting a
`WHERE source IS DISTINCT FROM ...` query returns zero rows. Either would have
caught it the instant anyone ran it. Nothing did. (The backfill was applied
2026-08-04; both gates now pass. They are the proof case for this runner: they
went from would-have-failed to green the moment the data was actually fixed.)

So the root cause was never the backfill. It was that the assertions were inert.

THE FAILURE MODE THIS SCRIPT MUST NOT RECREATE
----------------------------------------------
A runner that silently skips what it cannot parse is worse than no runner: it
prints green while the assertion is as inert as before, and it does so with the
authority of having "run". Therefore, everywhere in this file, the choice is
always LOUD ERROR over SKIP:

  * A gates.yml that does not parse            -> exit 2, named.
  * An unknown top-level key / item key        -> exit 2, named.
  * An unknown `expect` kind                   -> exit 2, named.
  * `scalar_eq` whose query returns 0 rows     -> FAIL (there is no scalar to
                                                  compare; absence is not a pass).
  * `scalar_eq` whose query returns >1 row     -> FAIL (ambiguous).
  * A `manual: true` gate                      -> reported as MANUAL and counted
                                                  in the summary, never silently
                                                  dropped and never counted as a
                                                  pass.

READ-ONLY, ENFORCED STRUCTURALLY (not by convention)
----------------------------------------------------
A gate runner that can mutate is a footgun, so read-only is enforced in two
independent layers, either of which alone would stop a write:

  1. STATIC  — each gate's SQL must be a single statement beginning SELECT or
     WITH. Multi-statement bodies and any DML/DDL leading keyword are rejected
     at load time, before a connection is opened.
  2. RUNTIME — the connection is opened with psycopg's read_only=True, so
     PostgreSQL itself refuses any write with 25006 read_only_sql_transaction.
     This holds even for a write smuggled inside a CTE, which layer 1 alone
     would not catch (WITH x AS (DELETE ... RETURNING) ...).

ENVIRONMENT SCOPING
-------------------
Gates carry an optional `env:` of prod | staging | both (default both). Today NO
gate file in the repo declares it — the prod-only scoping that exists is prose
inside `note:` strings ("PROD ONLY. Row-for-row diff vs the pre-capture."), which
no machine can honour. `env:` makes that machine-readable. --strict-env fails a
run that targets an environment a gate excludes, rather than skipping it.

EXIT CODES (house convention, cf. check-coverage-ratchet.py / check-staging-drift.py)
  0  every applicable gate passed
  1  at least one gate FAILED
  2  script/input error — unparseable or schema-invalid gates.yml, missing URL,
     unreachable database. NEVER a silent pass: an unreachable database is
     UNKNOWN, not "no failures".

USAGE
  python3 scripts/gate_runner.py --migration migrations/v4-eventsource-001 --env prod
  python3 scripts/gate_runner.py --all --env staging --phase post
  python3 scripts/gate_runner.py --all --env prod --phase post --json

  Reads NEON_DATABASE_URL (prod) and NEON_STAGING_URL (staging) from the
  environment. Never accepts a URL on the command line (L-067), and never prints
  one.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "migrations"

PHASES = ("pre", "sweep", "post")
ENVS = ("prod", "staging", "both")

# Every key the strict schema admits. Anything else is an error, not a shrug:
# a typo'd key ("expects:", "envs:") would otherwise silently disable a gate.
ITEM_KEYS = {"name", "sql", "expect", "value", "note", "env", "manual", "retired", "continuous"}
EXPECT_KINDS = {"rowcount_eq", "rowcount_gte", "scalar_eq"}

# Layer-1 read-only guard. A gate body must START with one of these.
_SQL_LEAD = re.compile(r"^\(?\s*(SELECT|WITH)\b", re.IGNORECASE)
_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


class GateSchemaError(Exception):
    """A gates.yml is unparseable or violates the schema. Always exit 2."""


def _strip_comments(sql):
    return _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql)).strip()


def validate_sql_readonly(sql, where):
    """Layer-1 structural read-only check. Raises GateSchemaError."""
    body = _strip_comments(sql)
    if not body:
        raise GateSchemaError(f"{where}: sql is empty")
    statements = [s for s in body.split(";") if s.strip()]
    if len(statements) > 1:
        raise GateSchemaError(
            f"{where}: sql contains {len(statements)} statements; gates must be a "
            "single read-only statement"
        )
    if not _SQL_LEAD.match(body):
        lead = body.split(None, 1)[0][:24]
        raise GateSchemaError(
            f"{where}: sql must begin with SELECT or WITH (found {lead!r}). "
            "The gate runner is read-only by construction."
        )
    return body


def load_gate_file(path):
    """Parse + strictly validate one gates.yml. Raises GateSchemaError.

    Returns a list of gate dicts, each carrying its phase and source path.
    """
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - environment problem
        raise GateSchemaError(f"PyYAML is required: {exc}")

    try:
        raw = yaml.safe_load(path.read_text())
    except Exception as exc:
        raise GateSchemaError(f"{path}: YAML parse failed: {exc}")

    if raw is None:
        raise GateSchemaError(f"{path}: file is empty")
    if not isinstance(raw, dict):
        raise GateSchemaError(f"{path}: top level must be a mapping, got {type(raw).__name__}")

    unknown = set(raw) - set(PHASES)
    if unknown:
        raise GateSchemaError(
            f"{path}: unknown top-level key(s) {sorted(unknown)}; expected {list(PHASES)}"
        )

    gates = []
    seen = set()
    for phase in PHASES:
        section = raw.get(phase)
        if section is None:
            continue
        if not isinstance(section, list):
            raise GateSchemaError(
                f"{path}: '{phase}' must be a list, got {type(section).__name__}"
            )
        for idx, item in enumerate(section):
            where = f"{path}:{phase}[{idx}]"
            if not isinstance(item, dict):
                raise GateSchemaError(f"{where}: gate must be a mapping, got {type(item).__name__}")

            bad = set(item) - ITEM_KEYS
            if bad:
                raise GateSchemaError(
                    f"{where}: unknown key(s) {sorted(bad)}; allowed {sorted(ITEM_KEYS)}"
                )

            name = item.get("name")
            if not name or not isinstance(name, str):
                raise GateSchemaError(f"{where}: missing or non-string 'name'")
            key = (phase, name)
            if key in seen:
                raise GateSchemaError(f"{where}: duplicate gate name {name!r} in phase {phase}")
            seen.add(key)

            env = item.get("env", "both")
            if env not in ENVS:
                raise GateSchemaError(
                    f"{where}: env must be one of {list(ENVS)}, got {env!r}"
                )

            # A retired gate is one the corpus has already superseded -- e.g.
            # v4-cal1-slicec-001 :: post_sample_tier_outranks_reference, which
            # carries "!! RETIRED 2026-08-04 ... DO NOT RE-RUN" as a COMMENT and
            # is known to fail by design. A comment cannot stop a runner, so the
            # marker has to be structural. Retired gates are reported, never run,
            # and never counted as passes; `retired` must be a non-empty string
            # giving the reason, so retiring a gate cannot be done silently.
            retired = item.get("retired")
            if retired is not None and (not isinstance(retired, str) or not retired.strip()):
                raise GateSchemaError(
                    f"{where}: 'retired' must be a non-empty string explaining why"
                )

            # `continuous: false` means "true only in the apply window" -- the
            # gate asserts something that a LATER migration or ordinary app use
            # is entitled to change. Measured on the real corpus: v1-2a-2's
            # post_no_flagged_true_rows (0 flagged rows -- V4-FLAG-001 later
            # shipped the flag feature; now 72), v4-evtcascade-001's
            # post_critter_state_untouched (NOW() - INTERVAL '1 hour'), and the
            # frozen view-column-count gates. Re-running these forever produces
            # permanent red, which trains everyone to ignore the runner -- the
            # very outcome that let the eventsource backfill sit unnoticed.
            continuous = item.get("continuous", True)
            if not isinstance(continuous, bool):
                raise GateSchemaError(f"{where}: 'continuous' must be a boolean")

            manual = bool(item.get("manual", False))
            if manual:
                # A manual gate is a human runbook step. It carries no SQL and
                # cannot pass or fail automatically -- but it MUST stay visible,
                # so it is loaded and reported rather than dropped.
                if "sql" in item:
                    raise GateSchemaError(f"{where}: manual gate must not carry 'sql'")
                if not item.get("note"):
                    raise GateSchemaError(f"{where}: manual gate requires a 'note' describing it")
                gates.append({
                    "phase": phase, "name": name, "manual": True, "retired": retired,
                    "note": item.get("note"), "env": env, "continuous": continuous,
                    "path": str(path),
                })
                continue

            sql = item.get("sql")
            if not sql or not isinstance(sql, str):
                raise GateSchemaError(
                    f"{where}: missing 'sql' (and not marked 'manual: true')"
                )
            expect = item.get("expect")
            if expect not in EXPECT_KINDS:
                raise GateSchemaError(
                    f"{where}: expect must be one of {sorted(EXPECT_KINDS)}, got {expect!r}"
                )
            if "value" not in item:
                raise GateSchemaError(f"{where}: missing 'value'")
            value = item["value"]
            if expect in ("rowcount_eq", "rowcount_gte") and not isinstance(value, int):
                raise GateSchemaError(
                    f"{where}: {expect} requires an integer 'value', got {type(value).__name__}"
                )

            body = validate_sql_readonly(sql, where)
            gates.append({
                "phase": phase, "name": name, "manual": False, "sql": body,
                "expect": expect, "value": value, "note": item.get("note"),
                "env": env, "retired": retired, "continuous": continuous,
                "path": str(path),
            })
    return gates


def normalize_scalar(actual):
    """Render a psycopg scalar for comparison against a YAML value.

    Postgres booleans arrive as Python True/False; YAML `value: true` is also a
    bool, so those compare directly. Everything else is compared as text, which
    is what the existing corpus expects (data_type names, column_default 'false'
    as a STRING, a Clerk sub).
    """
    if actual is None:
        return None
    return actual


def compare(expect, expected, rows, first_scalar):
    """Return (ok, actual_repr). Never returns 'skip' -- there is no such state."""
    if expect == "rowcount_eq":
        return (rows == expected, f"rowcount={rows}")
    if expect == "rowcount_gte":
        return (rows >= expected, f"rowcount={rows}")
    if expect == "scalar_eq":
        # Absence of a scalar is a FAILURE, not a pass. `SELECT convalidated
        # FROM pg_constraint WHERE conname='x'` returns ZERO rows when the
        # constraint does not exist -- the single most likely way a real
        # regression would present, and the easiest to mistake for "clean".
        if rows == 0:
            return (False, "no rows (scalar_eq needs exactly 1)")
        if rows > 1:
            return (False, f"{rows} rows (scalar_eq needs exactly 1)")
        actual = normalize_scalar(first_scalar)
        if isinstance(expected, bool) or isinstance(actual, bool):
            return (actual == expected, f"scalar={actual!r}")
        return (str(actual) == str(expected), f"scalar={actual!r}")
    raise GateSchemaError(f"unhandled expect kind {expect!r}")


def resolve_url(env):
    var = "NEON_DATABASE_URL" if env == "prod" else "NEON_STAGING_URL"
    url = os.environ.get(var)
    if not url:
        raise SystemExit(
            f"FATAL: {var} is not set (needed for --env {env}).\n"
            "  Never pass a database URL on the command line (L-067)."
        )
    return url, var


def connect(url):
    try:
        import psycopg
    except ImportError:
        raise SystemExit(
            "FATAL: psycopg (v3) is not installed.\n  Fix: pip install 'psycopg[binary]'"
        )
    try:
        conn = psycopg.connect(url)
    except Exception as exc:
        # An unreachable database is UNKNOWN, never "no failures".
        raise SystemExit(f"FATAL: could not connect to the target database: {type(exc).__name__}")
    # Layer-2 read-only enforcement: PostgreSQL itself now rejects any write.
    conn.read_only = True
    return conn


def run_gates(conn, gates, env, strict_env, continuous_only=False):
    results = []
    for g in gates:
        base = {k: g[k] for k in ("phase", "name", "env", "path")}
        if continuous_only and not g.get("continuous", True):
            results.append({**base, "status": "APPLY_WINDOW_ONLY",
                            "detail": "continuous: false -- valid only in the apply window"})
            continue
        if g.get("retired"):
            results.append({**base, "status": "RETIRED", "detail": g["retired"].strip()})
            continue
        if g["manual"]:
            results.append({**base, "status": "MANUAL", "detail": (g.get("note") or "").strip()})
            continue
        if g["env"] != "both" and g["env"] != env:
            status = "FAIL" if strict_env else "NOT_APPLICABLE"
            detail = f"declared env={g['env']}, running against {env}"
            results.append({**base, "status": status, "detail": detail})
            continue
        try:
            with conn.cursor() as cur:
                cur.execute(g["sql"])
                fetched = cur.fetchall()
            # Every gate is its own transaction. Without this rollback a single
            # failing query leaves the connection in 25P02 (aborted) and EVERY
            # subsequent gate reports a bogus error -- which would turn one real
            # finding into 145 fake ones and bury it.
            conn.rollback()
        except Exception as exc:
            conn.rollback()
            # A query that errors is a FAILURE (missing table/column is exactly
            # the regression these gates exist to catch), not an infrastructure
            # skip. Keep the sqlstate; drop everything else so no value leaks.
            code = getattr(exc, "sqlstate", None) or type(exc).__name__
            msg = str(exc).strip().splitlines()[0][:200]
            results.append({**base, "status": "ERROR", "detail": f"{code}: {msg}"})
            continue
        rows = len(fetched)
        first = fetched[0][0] if rows and fetched[0] else None
        ok, actual = compare(g["expect"], g["value"], rows, first)
        results.append({
            **base,
            "status": "PASS" if ok else "FAIL",
            "detail": f"expected {g['expect']}={g['value']!r}, got {actual}",
        })
    return results


def discover(migration, all_flag):
    if all_flag:
        found = sorted(MIGRATIONS_DIR.glob("*/gates.yml"))
        if not found:
            raise SystemExit(f"FATAL: no gates.yml found under {MIGRATIONS_DIR}")
        return found
    p = Path(migration)
    if not p.is_absolute():
        p = REPO_ROOT / p
    if p.is_dir():
        p = p / "gates.yml"
    if not p.exists():
        raise SystemExit(f"FATAL: no gates.yml at {p}")
    return [p]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run migration gates (read-only).")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--migration", help="migration directory or gates.yml path")
    src.add_argument("--all", action="store_true", help="every migrations/*/gates.yml")
    ap.add_argument("--env", required=True, choices=("prod", "staging"))
    ap.add_argument("--phase", default="all", choices=("all",) + PHASES)
    ap.add_argument("--json", action="store_true", help="emit JSON results to stdout")
    ap.add_argument(
        "--strict-env", action="store_true",
        help="treat a gate excluded from this environment as a FAILURE rather than "
             "reporting it NOT_APPLICABLE",
    )
    ap.add_argument(
        "--continuous-only", action="store_true",
        help="run only gates that remain true indefinitely (skip `continuous: false`). "
             "Intended for the scheduled invariant sweep, NOT for an apply.",
    )
    ap.add_argument(
        "--validate-only", action="store_true",
        help="parse and schema-check every gate file; open no connection",
    )
    args = ap.parse_args(argv)

    paths = discover(args.migration, args.all)

    # Parse EVERYTHING first. One bad file fails the whole run loudly (exit 2)
    # before any gate reports green -- a partially-parsed corpus must never be
    # presented as a clean result.
    loaded, schema_errors = [], []
    for p in paths:
        try:
            loaded.append((p, load_gate_file(p)))
        except GateSchemaError as exc:
            schema_errors.append(str(exc))
    # A schema error NEVER yields exit 0. But aborting the whole run on one bad
    # file hides the state of every other migration, so the parseable remainder
    # still runs and reports -- the exit code stays 2 regardless, so a partial
    # corpus can never be mistaken for a clean one.
    if schema_errors:
        print("SCHEMA ERRORS (these gates could not be loaded -- NOT skipped):", file=sys.stderr)
        for e in schema_errors:
            print(f"  ! {e}", file=sys.stderr)
        print(
            f"  -> {len(schema_errors)} file(s) unreadable; the run below covers only the "
            f"{len(loaded)} that parsed. Exit code is 2 regardless of their results.",
            file=sys.stderr,
        )

    if args.validate_only:
        if schema_errors:
            return 2
        total = sum(len(g) for _, g in loaded)
        print(f"OK: {len(loaded)} gate file(s), {total} gate(s) parsed and schema-valid.")
        return 0

    url, _var = resolve_url(args.env)
    conn = connect(url)

    all_results = []
    try:
        for p, gates in loaded:
            if args.phase != "all":
                gates = [g for g in gates if g["phase"] == args.phase]
            if not gates:
                continue
            all_results.extend(
                run_gates(conn, gates, args.env, args.strict_env, args.continuous_only)
            )
    finally:
        conn.close()

    if args.json:
        print(json.dumps(all_results, indent=2, default=str))
    else:
        render(all_results, args.env)

    if schema_errors:
        return 2
    bad = sum(1 for r in all_results if r["status"] in ("FAIL", "ERROR"))
    return 1 if bad else 0


SYMBOL = {
    "PASS": "ok  ", "FAIL": "FAIL", "ERROR": "ERR ", "MANUAL": "man ",
    "NOT_APPLICABLE": "n/a ", "RETIRED": "ret ", "APPLY_WINDOW_ONLY": "win ",
}


def render(results, env):
    by_file = {}
    for r in results:
        by_file.setdefault(r["path"], []).append(r)
    for path, rs in by_file.items():
        rel = Path(path).parent.name
        bad = [r for r in rs if r["status"] in ("FAIL", "ERROR")]
        head = "FAIL" if bad else "ok"
        print(f"\n[{head}] {rel}  ({env})")
        for r in rs:
            if r["status"] == "PASS":
                continue  # only non-green lines get detail; counts come in the summary
            print(f"   {SYMBOL[r['status']]} {r['phase']}/{r['name']}: {r['detail']}")
        n_pass = sum(1 for r in rs if r["status"] == "PASS")
        print(f"   -- {n_pass}/{len(rs)} passed")

    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("\n" + "=" * 64)
    print(f"SUMMARY ({env}): " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if counts.get("MANUAL"):
        print(f"  NOTE: {counts['MANUAL']} manual gate(s) were NOT executed and are NOT passes.")


if __name__ == "__main__":
    sys.exit(main())
