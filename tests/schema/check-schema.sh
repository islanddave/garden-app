#!/usr/bin/env bash
# tests/schema/check-schema.sh
# Staging DB schema integrity check — uses Python+psycopg2 (no psql binary needed).
# Verifies: required tables exist, RLS enabled, RLS policies present, required columns.
# Runs against NEON_STAGING_URL — isolated staging branch, never touches prod.

set -euo pipefail

[[ -n "${NEON_STAGING_URL:-}" ]] || { echo "FATAL: NEON_STAGING_URL unset"; exit 1; }

pip install psycopg2-binary --quiet --break-system-packages 2>/dev/null || \
  pip install psycopg2-binary --quiet 2>/dev/null || true

python3 << PYEOF
import sys, psycopg2, os

url = os.environ['NEON_STAGING_URL']
try:
    conn = psycopg2.connect(url)
    cur = conn.cursor()
except Exception as e:
    print(f"FATAL: Cannot connect to staging DB: {e}")
    sys.exit(1)

PASS = 0
FAIL = 0

def pass_check(label):
    global PASS
    print(f"PASS [{label}]")
    PASS += 1

def fail_check(label, reason):
    global FAIL
    print(f"FAIL [{label}]: {reason}")
    FAIL += 1

def check_eq(label, query, expected):
    try:
        cur.execute(query)
        result = str(cur.fetchone()[0]).strip()
        if result == expected:
            pass_check(label)
        else:
            fail_check(label, f"expected '{expected}', got '{result}'")
    except Exception as e:
        fail_check(label, str(e))

def check_gt0(label, query):
    try:
        cur.execute(query)
        result = int(cur.fetchone()[0])
        if result > 0:
            pass_check(f"{label} ({result} found)")
        else:
            fail_check(label, f"expected >0, got {result}")
    except Exception as e:
        fail_check(label, str(e))

# Canonical table names as they exist in the Neon schema
TABLES = ['plant_projects', 'plants', 'locations', 'event_log', 'favorites', 'photos']

print("=== Schema integrity check: staging Neon branch ===")
print()

print("--- Table presence ---")
for t in TABLES:
    check_eq(f"table:{t}",
        f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='{t}'",
        "1")

print()
print("--- RLS enabled ---")
for t in TABLES:
    check_eq(f"rls-enabled:{t}",
        f"SELECT relrowsecurity::text FROM pg_class WHERE relname='{t}' AND relkind='r'",
        "true")

print()
print("--- RLS policies defined ---")
for t in TABLES:
    check_gt0(f"rls-policies:{t}",
        f"SELECT COUNT(*) FROM pg_policies WHERE tablename='{t}'")

print()
print("--- Column presence ---")
cols = [
    ('plant_projects','created_by'), ('plant_projects','name'),
    ('plants','project_id'), ('plants','created_by'),
    ('locations','created_by'),
    ('event_log','created_by'), ('event_log','project_id'),
    ('favorites','user_id'), ('favorites','entity_id'),
    ('photos','plant_id'), ('photos','created_by'),
]
for tbl, col in cols:
    check_eq(f"col:{tbl}.{col}",
        f"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='{tbl}' AND column_name='{col}'",
        "1")

conn.close()
print()
print(f"=== Schema check: {PASS} passed, {FAIL} failed ===")
if FAIL > 0:
    print(f"FATAL: Schema check failed — {FAIL} assertion(s) did not pass")
    sys.exit(1)
print("All schema checks passed")
PYEOF
