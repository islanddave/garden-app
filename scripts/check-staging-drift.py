#!/usr/bin/env python3
"""Staging-vs-prod schema drift detector (OPS-STAGINGDRIFT-001).

WHY THIS EXISTS
---------------
Nothing keeps the staging Neon branch in sync with prod. integration-test.yml
creates an ephemeral branch off staging (br-polished-art-am12o4ue) and runs the
real Lambda handlers against it WITHOUT applying any migration, so staging
silently accumulates drift. Measured 2026-07-31 while unblocking Lane C:
10 prod-only columns, 3 prod-only constraints, and 1 staging-ONLY constraint
that made staging reject container_type values prod accepts.

The cost is not a broken deploy — it is worse. Integration tests fail for
reasons unrelated to the change under test, which trains everyone to read a red
integration run as noise. This detector names the drift so it can be fixed
instead of absorbed.

DIRECTIONALITY (the whole design)
---------------------------------
The two directions are NOT symmetric, and conflating them would make this
permanently noisy:

  PROD-ONLY (staging is BEHIND)  -> the dangerous direction. A prod column that
      staging lacks means any test touching it fails for an unrelated reason.
      This is what we warn about.

  STAGING-ONLY (staging is AHEAD) -> the NORMAL transient state. Migrations are
      applied staging-first, so between a staging apply and the prod apply
      staging legitimately leads. Reported as informational only, never a
      finding. (Exception worth reading: a staging-only CONSTRAINT is a real
      hazard even though a staging-only column is not — an extra CHECK makes
      staging REJECT writes prod accepts, which is the same false-failure class
      in the other direction. So constraints are reported in both directions.)

ADVISORY BY DESIGN
------------------
Exits 0 on drift and emits ::warning:: + a job summary, matching the posture of
schema-audit.yml. Hard-failing would red the build for the entire normal window
between a staging apply and its prod apply. Use --strict to make prod-only drift
exit 1 (intended for a manual pre-Lane-C style check, not for the default CI run).

EXIT CODES (house convention, cf. check-coverage-ratchet.py)
  0  ran successfully (drift may still be reported as a warning)
  1  --strict and prod-only drift was found
  2  script/input error — a URL missing, or either database unreachable.
     NEVER a silent pass: an unreachable prod is UNKNOWN, not "no drift".

USAGE
  python3 scripts/check-staging-drift.py [--strict]
  Reads NEON_DATABASE_URL (prod) and NEON_STAGING_URL (staging) from the
  environment. Never accepts a URL on the command line (L-067).
"""
import os
import sys
import argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ctas_* are ad-hoc CTAS snapshot tables taken during prod incidents; they are
# deliberately never mirrored to staging and would otherwise dominate the diff.
IGNORED_TABLE_PREFIXES = ('ctas_',)

COLUMN_SQL = """
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
"""

TABLE_SQL = """
SELECT table_name, table_type
  FROM information_schema.tables
 WHERE table_schema = 'public'
"""

CONSTRAINT_SQL = """
SELECT conrelid::regclass::text AS tbl, conname
  FROM pg_constraint
 WHERE connamespace = 'public'::regnamespace
"""

# Staging-only constraints need a second pass to tell a hazard from normal lead.
# contype 'c' = CHECK. A staging-only CHECK can REJECT a write prod accepts (the
# plants_container_type_domain case). A staging-only FK/UNIQUE/PK is almost always
# just the constraint that came along with a staging-only COLUMN during a normal
# staging-first apply — flagging those would make this permanently noisy.
CONSTRAINT_DETAIL_SQL = """
SELECT conrelid::regclass::text AS tbl, conname, contype::text,
       pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE connamespace = 'public'::regnamespace
"""

INDEX_SQL = """
SELECT tablename, indexname
  FROM pg_indexes
 WHERE schemaname = 'public'
"""


def _ignored(name):
    return any(name.startswith(p) for p in IGNORED_TABLE_PREFIXES)


def fetch_set(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        return {f"{a}.{b}" for a, b in cur.fetchall() if not _ignored(str(a))}


def compare(label, prod, staging, report_staging_only):
    """Returns (prod_only, staging_only). Only prod_only counts as a finding."""
    prod_only = sorted(prod - staging)
    staging_only = sorted(staging - prod)
    if prod_only:
        print(f"\n  {label} — PROD-ONLY ({len(prod_only)}) — staging is BEHIND:")
        for x in prod_only:
            print(f"      {x}")
    if staging_only:
        kind = "FINDING" if report_staging_only else "informational"
        print(f"\n  {label} — STAGING-ONLY ({len(staging_only)}) [{kind}]:")
        for x in staging_only:
            print(f"      {x}")
    if not prod_only and not staging_only:
        print(f"  {label}: in sync")
    return prod_only, staging_only


def _hazardous_staging_only_constraints(sconn, staging_only, staging_only_cols):
    """Narrow the staging-only constraint set to the genuinely dangerous ones.

    Dangerous == a CHECK that prod does not have and that does not reference a column staging
    legitimately leads on. Everything else (FK/PK/UNIQUE, or a CHECK that exists only because the
    column it guards is itself staging-only) is the normal staging-first-apply lead.
    """
    wanted = set(staging_only)
    with sconn.cursor() as cur:
        cur.execute(CONSTRAINT_DETAIL_SQL)
        rows = cur.fetchall()
    hazard = []
    for tbl, name, contype, definition in rows:
        key = f"{tbl}.{name}"
        if key not in wanted or contype != 'c':
            continue
        if any(col in (definition or '') for col in staging_only_cols):
            continue
        hazard.append(key)
    return sorted(hazard)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--strict', action='store_true',
                    help='exit 1 when staging is behind prod (manual pre-flight, not default CI)')
    args = ap.parse_args(argv)

    prod_url = os.environ.get('NEON_DATABASE_URL')
    stag_url = os.environ.get('NEON_STAGING_URL')
    missing = [n for n, v in (('NEON_DATABASE_URL', prod_url), ('NEON_STAGING_URL', stag_url)) if not v]
    if missing:
        print(f"\nFATAL: missing {', '.join(missing)} — schema drift is UNKNOWN, not absent.", file=sys.stderr)
        print("  Fix: provide both as environment variables (CI: repository secrets of the same name).", file=sys.stderr)
        print(f"::error::staging-drift check could not run — missing {', '.join(missing)}")
        return 2

    try:
        import psycopg
    except ImportError:
        print("\nFATAL: psycopg (v3) is not installed.", file=sys.stderr)
        print("  Fix: pip install 'psycopg[binary]'", file=sys.stderr)
        return 2

    try:
        with psycopg.connect(prod_url) as pconn, psycopg.connect(stag_url) as sconn:
            print("Comparing prod vs staging (public schema)")
            findings = {}
            info = {}
            behind = {}          # prod-only == staging is behind; the only --strict trigger
            staging_only_cols = set()

            for label, sql, staging_only_is_finding in (
                ('tables', TABLE_SQL, True),
                ('columns', COLUMN_SQL, False),
                ('constraints', CONSTRAINT_SQL, True),
                ('indexes', INDEX_SQL, False),
            ):
                if label == 'constraints':
                    # Re-classify staging-only constraints before reporting: keep only the ones
                    # that are genuinely hazardous (a CHECK that prod does not have, not attached
                    # to a column staging legitimately leads on).
                    staging_only_is_finding = False

                po, so = compare(label, fetch_set(pconn, sql), fetch_set(sconn, sql), staging_only_is_finding)

                if label == 'columns':
                    staging_only_cols = {c.split('.', 1)[1] for c in so}

                if po:
                    findings[f"{label} (prod-only)"] = po
                    behind[label] = po

                if label == 'constraints' and so:
                    hazard = _hazardous_staging_only_constraints(sconn, so, staging_only_cols)
                    if hazard:
                        print(f"\n  constraints — STAGING-ONLY and HAZARDOUS ({len(hazard)}): "
                              f"a CHECK staging has and prod does not will REJECT writes prod accepts.")
                        for x in hazard:
                            print(f"      {x}")
                        findings['constraints (staging-only CHECK)'] = hazard
                    benign = [c for c in so if c not in set(hazard)]
                    if benign:
                        info['constraints (staging-only, benign)'] = benign
                elif so and staging_only_is_finding:
                    findings[f"{label} (staging-only)"] = so
                elif so:
                    info[f"{label} (staging-only)"] = so
    except Exception as exc:                                   # noqa: BLE001 — any failure is UNKNOWN
        print(f"\nFATAL: could not read one of the databases: {exc}", file=sys.stderr)
        print("  Fix: check the URLs and Neon branch availability. Drift is UNKNOWN, never assumed absent.",
              file=sys.stderr)
        print("::error::staging-drift check could not reach a database — drift UNKNOWN")
        return 2

    if info:
        total = sum(len(v) for v in info.values())
        print(f"\nNOTE: {total} staging-only column/index difference(s) — expected between a staging "
              f"apply and its prod apply. Not a finding.")

    if not findings:
        print("\nOK: staging and prod agree on tables, columns, constraints and indexes.")
        return 0

    total = sum(len(v) for v in findings.values())
    detail = '; '.join(f"{k}: {len(v)}" for k, v in findings.items())
    msg = (f"staging/prod schema drift — {total} difference(s) [{detail}]. Integration tests branch off "
           f"staging without applying migrations, so anything touching these fails for an unrelated "
           f"reason. Reconcile with migrations/v4-staging-reconcile-001 as the template.")
    print(f"\n::warning title=Staging schema drift::{msg}")

    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as fh:
            fh.write("### Staging schema drift\n\n")
            for k, v in findings.items():
                fh.write(f"**{k}** ({len(v)})\n\n")
                for x in v[:25]:
                    fh.write(f"- `{x}`\n")
                if len(v) > 25:
                    fh.write(f"- …and {len(v) - 25} more\n")
                fh.write("\n")

    # --strict keys on PROD-ONLY drift only. Staging being ahead is the normal window between a
    # staging apply and its prod apply; failing on it would red the build for that entire window.
    if args.strict and behind:
        n = sum(len(v) for v in behind.values())
        print(f"\nFATAL: --strict and staging is BEHIND prod on {n} object(s).", file=sys.stderr)
        print("  Fix: apply the missing DDL to staging before trusting an integration run.", file=sys.stderr)
        return 1

    print(f"\nOK (advisory): {total} drift difference(s) reported above; not failing the build.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
