#!/usr/bin/env bash
# tests/schema/check-schema.sh
# Staging DB schema integrity check.
# Verifies: required tables exist, RLS enabled on all tables, RLS policies present,
# and required columns present.
# Runs against NEON_STAGING_URL — isolated Neon staging branch (br-damp-frog-amdfxwrr).
# Never touches prod DB. Safe to re-run.

set -euo pipefail

[[ -n "${NEON_STAGING_URL:-}" ]] || { echo "FATAL: NEON_STAGING_URL unset"; exit 1; }

PASS=0
FAIL=0

psql_q() { psql "$NEON_STAGING_URL" -tAc "$1" 2>&1; }
pass() { echo "PASS [$1]"; ((PASS++)); }
fail() { echo "FAIL [$1]: $2"; ((FAIL++)); }

check_eq() {
  local label="$1" query="$2" expected="$3"
  local result
  result=$(psql_q "$query") || { fail "$label" "psql error: ${result:0:150}"; return; }
  result=$(echo "$result" | tr -d '[:space:]')
  [[ "$result" == "$expected" ]] && pass "$label" || fail "$label" "expected '$expected', got '$result'"
}

check_gt0() {
  local label="$1" query="$2"
  local result
  result=$(psql_q "$query") || { fail "$label" "psql error: ${result:0:150}"; return; }
  result=$(echo "$result" | tr -d '[:space:]')
  [[ "$result" =~ ^[0-9]+$ ]] && [[ "$result" -gt 0 ]] && pass "$label ($result found)" || fail "$label" "expected >0, got '$result'"
}

# Canonical table names as they exist in the Neon schema
EXPECTED_TABLES=(plant_projects plants locations event_log favorites photos)

echo "=== Schema integrity check: staging Neon branch ==="
echo ""

echo "--- Table presence ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_eq "table:$tbl" \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$tbl'" \
    "1"
done

echo ""
echo "--- Row Level Security: enabled ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_eq "rls-enabled:$tbl" \
    "SELECT relrowsecurity::text FROM pg_class WHERE relname='$tbl' AND relkind='r'" \
    "t"
done

echo ""
echo "--- Row Level Security: policies defined ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_gt0 "rls-policies:$tbl" \
    "SELECT COUNT(*) FROM pg_policies WHERE tablename='$tbl'"
done

echo ""
echo "--- Column presence ---"
col_check() {
  check_eq "col:$1.$2" \
    "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2'" \
    "1"
}
# plant_projects: created_by (Clerk user_id as text), name
col_check plant_projects created_by
col_check plant_projects name
# plants: project_id FK, created_by
col_check plants project_id
col_check plants created_by
# locations: created_by
col_check locations created_by
# event_log: created_by, project_id FK
col_check event_log created_by
col_check event_log project_id
# favorites: user_id, entity_id (generic favorites — entity_type+entity_id pattern)
col_check favorites user_id
col_check favorites entity_id
# photos: plant_id FK, created_by
col_check photos plant_id
col_check photos created_by

echo ""
echo "=== Schema check: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FATAL: Schema check failed — $FAIL assertion(s) did not pass"
  exit 1
fi
echo "All schema checks passed"
