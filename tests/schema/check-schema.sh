#!/usr/bin/env bash
# tests/schema/check-schema.sh
# Staging DB schema integrity check.
# Verifies: required tables exist, RLS enabled on all tables, RLS policies present,
# and required FK columns present.
# Runs against NEON_STAGING_URL — isolated Neon staging branch (br-damp-frog-amdfxwrr).
# Never touches prod DB. Safe to re-run.

set -euo pipefail

[[ -n "${NEON_STAGING_URL:-}" ]] || { echo "FATAL: NEON_STAGING_URL unset"; exit 1; }

PASS=0
FAIL=0

# ── Helpers ───────────────────────────────────────────────────────────────────
psql_q() { psql "$NEON_STAGING_URL" -tAc "$1" 2>&1; }

pass() { echo "✅ PASS [$1]"; ((PASS++)); }
fail() { echo "❌ FAIL [$1]: $2"; ((FAIL++)); }

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

EXPECTED_TABLES=(projects plants locations events favorites plant_photos)

echo "=== Schema integrity check: staging Neon branch ==="
echo ""

# ── Table presence ────────────────────────────────────────────────────────────
echo "--- Table presence ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_eq "table:$tbl" \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$tbl'" \
    "1"
done

echo ""

# ── RLS enabled ───────────────────────────────────────────────────────────────
echo "--- Row Level Security: enabled ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_eq "rls-enabled:$tbl" \
    "SELECT relrowsecurity::text FROM pg_class WHERE relname='$tbl' AND relkind='r'" \
    "t"
done

echo ""

# ── RLS policies present ──────────────────────────────────────────────────────
echo "--- Row Level Security: policies defined ---"
for tbl in "${EXPECTED_TABLES[@]}"; do
  check_gt0 "rls-policies:$tbl" \
    "SELECT COUNT(*) FROM pg_policies WHERE tablename='$tbl'"
done

echo ""

# ── Required columns spot-check ───────────────────────────────────────────────
echo "--- Column presence ---"
col_check() {
  check_eq "col:$1.$2" \
    "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2'" \
    "1"
}
col_check projects user_id
col_check projects name
col_check plants    project_id
col_check plants    user_id
col_check locations user_id
col_check events    user_id
col_check favorites plant_id
col_check favorites user_id

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "=== Schema check: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FATAL: Schema check failed — $FAIL assertion(s) did not pass"
  exit 1
fi
echo "✅ All schema checks passed"
