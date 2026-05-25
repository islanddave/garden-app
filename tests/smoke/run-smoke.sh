#!/usr/bin/env bash
# tests/smoke/run-smoke.sh
# Staging smoke test suite.
#
# Phase 1 — Lambda reachability (no auth required):
#   Hits each Lambda endpoint. Accepts 2xx or 4xx (auth check = Lambda running).
#   Fails on 5xx, connection timeout, or DNS error.
#
# Phase 2 — Authenticated CRUD (requires Clerk secrets):
#   Mints a REAL Clerk session JWT via the Backend API (create a session for
#   CLERK_TEST_USER_ID, then issue a short-lived ~60s session token), uses it as
#   Bearer to create a test project, ASSERT the persisted name + a PUT'd
#   description round-trip (L-108 write-path coverage), then deletes it.
#   Skipped only if CLERK_SECRET_KEY_STAGING or CLERK_TEST_USER_ID are unset.
#
# URL convention: the Lambda Function URLs route on /api/{entity} for list/create
#   and /api/{entity}/{id} for by-id GET/PUT/DELETE (matches the frontend
#   resolveUrl() in src/lib/api.js). STAGING_API_* are bare Function-URL hosts,
#   so by-id ops are built as "${BASE%/}/api/projects/${id}". A bare-base id path
#   ("${BASE}${id}") is NOT a real route — it returns empty/405. (Confirmed
#   against the live sk_test staging instance + staging Lambdas, 2026-05-25.)
#
# All test data uses TEST_RUN_ID prefix. Cleanup runs on exit (trap).

set -euo pipefail

# ── Required env (Phase 1) ────────────────────────────────────────────────────
for VAR in STAGING_API_PROJECTS STAGING_API_PLANTS STAGING_API_LOCATIONS \
           STAGING_API_EVENTS STAGING_API_FAVORITES STAGING_API_DASHBOARD; do
  [[ -n "${!VAR:-}" ]] || { echo "FATAL: $VAR unset"; exit 1; }
done

TEST_RUN_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "ci-$(date +%s)")
CREATED_PROJECT_ID=""
DATA_CREATED=false
CLERK_JWT=""
CLERK_SESSION_ID=""
PASS=0
FAIL=0

cleanup() {
  if [[ "$DATA_CREATED" == "true" && -n "$CREATED_PROJECT_ID" && -n "$CLERK_JWT" ]]; then
    echo ""
    echo "Cleanup: deleting test project $CREATED_PROJECT_ID..."
    curl -sf --max-time 30 --connect-timeout 10 \
      -X DELETE \
      -H "Authorization: Bearer $CLERK_JWT" \
      -H "Content-Type: application/json" \
      "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" \
      -o /dev/null 2>&1 && echo "✅ Cleanup: test project deleted" \
      || echo "WARNING: cleanup DELETE failed — manual cleanup may be needed (id: $CREATED_PROJECT_ID)"
  fi
  # Revoke the Clerk test session we created (best-effort hygiene).
  if [[ -n "${CLERK_SESSION_ID:-}" && -n "${CLERK_SECRET_KEY_STAGING:-}" ]]; then
    curl -s --max-time 15 --connect-timeout 10 \
      -X POST \
      -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \
      "https://api.clerk.com/v1/sessions/${CLERK_SESSION_ID}/revoke" \
      -o /dev/null 2>&1 && echo "✅ Cleanup: Clerk test session revoked" || true
  fi
}
trap cleanup INT TERM EXIT

# ── Helper: Lambda reachability check ────────────────────────────────────────
check_reachable() {
  local label="$1"
  local url="$2"
  local TMPFILE
  TMPFILE=$(mktemp)
  local HTTP_CODE
  HTTP_CODE=$(curl -s --max-time 30 --connect-timeout 10 \
    -H "Content-Type: application/json" \
    -o "$TMPFILE" -w "%{http_code}" \
    "$url") || HTTP_CODE="000"
  local BODY
  BODY=$(cat "$TMPFILE" 2>/dev/null || echo "")
  rm -f "$TMPFILE"

  local FIRST="${HTTP_CODE:0:1}"
  if [[ "$HTTP_CODE" == "000" ]]; then
    echo "❌ FAIL [$label] connection failed (timeout or DNS error)"
    FAIL=$((FAIL+1))
  elif [[ "$FIRST" == "5" ]]; then
    echo "❌ FAIL [$label] HTTP $HTTP_CODE (server error)"
    echo "   Body: ${BODY:0:200}"
    FAIL=$((FAIL+1))
  else
    # 2xx = open/working, 4xx = auth check working — both are valid smoke passes
    echo "✅ PASS [$label] HTTP $HTTP_CODE"
    PASS=$((PASS+1))
  fi
}

# ── Helper: Authenticated request ────────────────────────────────────────────
auth_request() {
  local label="$1"
  local url="$2"
  local method="${3:-GET}"
  local data="${4:-}"
  local TMPFILE
  TMPFILE=$(mktemp)
  local curl_args=(-s --max-time 30 --connect-timeout 10
    -H "Authorization: Bearer $CLERK_JWT"
    -H "Content-Type: application/json"
    -X "$method"
    -o "$TMPFILE"
    -w "%{http_code}")
  [[ -n "$data" ]] && curl_args+=(-d "$data")

  local HTTP_CODE
  HTTP_CODE=$(curl "${curl_args[@]}" "$url") || HTTP_CODE="000"
  local BODY
  BODY=$(cat "$TMPFILE" 2>/dev/null || echo "")
  rm -f "$TMPFILE"

  local FIRST="${HTTP_CODE:0:1}"
  if [[ "$HTTP_CODE" == "000" ]] || [[ "$FIRST" == "5" ]]; then
    echo "❌ FAIL [$label] HTTP $HTTP_CODE"
    echo "   Body: ${BODY:0:200}"
    FAIL=$((FAIL+1))
    echo ""
    return 1
  else
    echo "✅ PASS [$label] HTTP $HTTP_CODE"
    echo "$BODY"
    return 0
  fi
}

# ── Helper: (re)issue a fresh ~60s Clerk session token ───────────────────────
# Reuses the session created in Phase 2; emits the bare JWT on stdout (or empty).
mint_session_token() {
  curl -s --max-time 30 --connect-timeout 10 \
    -X POST \
    -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \
    -H "Content-Type: application/json" \
    -d '{}' \
    "https://api.clerk.com/v1/sessions/${CLERK_SESSION_ID}/tokens" \
    | jq -r '.jwt // empty' 2>/dev/null || echo ""
}

# ════════════════════════════════════════════════════════════════════════════
echo "=== Smoke tests — commit: ${COMMIT_SHA:-unknown} ==="
echo "=== Test run ID: $TEST_RUN_ID ==="
echo ""

# ── Phase 1: Lambda reachability ─────────────────────────────────────────────
echo "--- Phase 1: Lambda reachability (no auth) ---"
check_reachable "lambda:projects"  "$STAGING_API_PROJECTS"
check_reachable "lambda:plants"    "$STAGING_API_PLANTS"
check_reachable "lambda:locations" "$STAGING_API_LOCATIONS"
check_reachable "lambda:events"    "$STAGING_API_EVENTS"
check_reachable "lambda:favorites" "$STAGING_API_FAVORITES"
check_reachable "lambda:dashboard" "$STAGING_API_DASHBOARD"
# Photos Lambda handles multipart — skip reachability to avoid misleading error shape
echo "   (photos Lambda skipped in reachability phase — multipart-only endpoint)"
echo ""

# ── Phase 2: Authenticated CRUD ──────────────────────────────────────────────
if [[ -z "${CLERK_SECRET_KEY_STAGING:-}" ]] || [[ -z "${CLERK_TEST_USER_ID:-}" ]]; then
  echo "--- Phase 2: Authenticated CRUD --- SKIPPED"
  echo "   (Set GHA secrets CLERK_SECRET_KEY_STAGING and CLERK_TEST_USER_ID to enable)"
  echo "   See: regression-testing-plan.md → Dave Action Items"
else
  echo "--- Phase 2: Authenticated CRUD ---"

  # ── Mint a REAL Clerk session JWT (Backend API) ──────────────────────────────
  # testing_tokens / sign_in_tokens do NOT yield a Bearer-usable JWT (they issue
  # 1-part client tokens). The Backend API session-token flow does: create a
  # session for the test user, then issue a short-lived (~60s) session token.
  # The whole Phase-2 sequence completes well inside the token lifetime; we also
  # re-mint right before the CRUD write path for headroom.
  echo "Minting Clerk session JWT for $CLERK_TEST_USER_ID..."

  SESS_TMP=$(mktemp)
  SESS_CODE=$(curl -s --max-time 30 --connect-timeout 10 \
    -X POST \
    -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\": \"$CLERK_TEST_USER_ID\"}" \
    -o "$SESS_TMP" -w "%{http_code}" \
    "https://api.clerk.com/v1/sessions") || SESS_CODE="000"
  CLERK_SESSION_ID=$(jq -r '.id // empty' "$SESS_TMP" 2>/dev/null || echo "")

  if [[ -z "$CLERK_SESSION_ID" ]]; then
    # Sanitized diagnostics (no secret leak: GHA masks secret substrings; we print
    # only HTTP codes + Clerk's error code/message + a key-validity probe).
    echo "WARNING [jwt-mint]: could not create a Clerk session — skipping Phase 2 (HTTP $SESS_CODE)"
    echo "   Clerk error: $(jq -r '.errors[0].code // "?"' "$SESS_TMP" 2>/dev/null) — $(jq -r '.errors[0].message // "?"' "$SESS_TMP" 2>/dev/null)"
    KEYPROBE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 --connect-timeout 10 \
      -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" "https://api.clerk.com/v1/users?limit=1")
    echo "   secret-key probe GET /v1/users -> HTTP $KEYPROBE (200 => key valid, so check CLERK_TEST_USER_ID; 401 => key invalid/wrong instance)"
    echo "   (Verify CLERK_TEST_USER_ID is a real user in the CLERK_SECRET_KEY_STAGING instance.)"
    rm -f "$SESS_TMP"
    echo ""
    echo "=== Smoke tests: $PASS passed, $FAIL failed ==="
    [[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
  fi
  rm -f "$SESS_TMP"

  CLERK_JWT=$(mint_session_token)

  # Validate JWT format: must be three base64url parts (header.payload.signature)
  JWT_PARTS=$(echo "$CLERK_JWT" | tr '.' '\n' | wc -l)
  if [[ -z "$CLERK_JWT" ]] || [[ "$JWT_PARTS" -ne 3 ]]; then
    echo "WARNING [jwt-mint]: did not receive a valid 3-part session JWT (got ${JWT_PARTS}-part)"
    echo "   Token prefix: ${CLERK_JWT:0:20}..."
    echo "   Phase 2 skipped."
    echo ""
    echo "=== Smoke tests: $PASS passed, $FAIL failed ==="
    [[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
  fi

  echo "✅ Clerk session JWT minted (valid 3-part format, ~60s lifetime)"
  echo ""

  # Authenticated GET — list endpoints
  auth_request "auth:GET /projects"  "$STAGING_API_PROJECTS"  "GET" || true
  auth_request "auth:GET /plants"    "$STAGING_API_PLANTS"    "GET" || true
  auth_request "auth:GET /locations" "$STAGING_API_LOCATIONS" "GET" || true
  auth_request "auth:GET /events"    "$STAGING_API_EVENTS"    "GET" || true
  auth_request "auth:GET /dashboard" "$STAGING_API_DASHBOARD" "GET" || true
  echo ""

  # Refresh the session token so the write path runs on a full ~60s lifetime.
  CLERK_JWT=$(mint_session_token)

  # CRUD test: create → fetch → delete
  echo "--- CRUD: POST /projects ---"
  CREATE_BODY=$(mktemp)
  CREATE_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
    -X POST \
    -H "Authorization: Bearer $CLERK_JWT" \
    -H "Content-Type: application/json" \
    -o "$CREATE_BODY" -w "%{http_code}" \
    "$STAGING_API_PROJECTS" \
    -d "{\"name\": \"smoke-test-$TEST_RUN_ID\", \"description\": \"CI smoke test — safe to delete\"}") || CREATE_HTTP="000"
  CREATE_RESPONSE=$(cat "$CREATE_BODY" 2>/dev/null || echo "")
  rm -f "$CREATE_BODY"

  if [[ "${CREATE_HTTP:0:1}" == "2" ]]; then
    echo "✅ PASS [crud:POST /projects] HTTP $CREATE_HTTP"
    PASS=$((PASS+1))
    CREATED_PROJECT_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id // .project_id // empty' 2>/dev/null || echo "")
    if [[ -n "$CREATED_PROJECT_ID" ]]; then
      DATA_CREATED=true
      echo "   Created project id: $CREATED_PROJECT_ID"
      # Fetch it back
      auth_request "crud:GET /projects/$CREATED_PROJECT_ID" \
        "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" "GET" || true

      # ── L-108 write-path assertions: write → read-back → ASSERT the stored value ──
      # Phase-1 reachability and bare-2xx CRUD checks cannot catch SILENT write bugs
      # where the request returns 2xx but persists the wrong value — e.g. BUG-12
      # (event date stored a day early) or the plants variety_id clear-fix (PUT not
      # clearing). These steps assert the persisted value equals what was written.
      # See lessons.md L-108. NEXT EXTENSION (highest value — the actual bug surfaces):
      # add the same write→read-back→assert against events (bare-date → stored date)
      # and plants (variety_id set→clear) once a test planting/event is created here.
      # Blockers for those (open, see Task #2): varieties list endpoint returns
      # {"Message":null} (no runtime variety_id source) and the events Lambda has no
      # DELETE route (test events would orphan; L-058 hygiene sweeps plant_projects only).
      assert_readback() {
        local label="$1" url="$2" jq_path="$3" expected="$4"
        local TMP CODE BODY GOT
        TMP=$(mktemp)
        CODE=$(curl -s --max-time 30 --connect-timeout 10 \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$TMP" -w "%{http_code}" "$url") || CODE="000"
        BODY=$(cat "$TMP" 2>/dev/null || echo ""); rm -f "$TMP"
        GOT=$(echo "$BODY" | jq -r "$jq_path // empty" 2>/dev/null || echo "")
        if [[ "$GOT" == "$expected" ]]; then
          echo "✅ PASS [$label] read-back == '$expected'"
          PASS=$((PASS+1))
        else
          echo "❌ FAIL [$label] read-back mismatch: expected '$expected', got '$GOT' (HTTP $CODE)"
          echo "   Body: ${BODY:0:200}"
          FAIL=$((FAIL+1))
        fi
      }

      # A) CREATE persisted correctly — the name we POSTed must read back verbatim.
      assert_readback "write:create-name-readback" \
        "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" ".name" "smoke-test-$TEST_RUN_ID"

      # B) UPDATE write-path round-trips — PUT a sentinel, read it back, assert it took.
      #    This is the PUT surface class that BUG-12 / variety-clear live on.
      WRITE_SENTINEL="l108-write-check-$TEST_RUN_ID"
      auth_request "write:PUT /projects/$CREATED_PROJECT_ID" \
        "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" "PUT" \
        "{\"description\": \"$WRITE_SENTINEL\"}" >/dev/null || true
      assert_readback "write:update-description-readback" \
        "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" ".description" "$WRITE_SENTINEL"
    else
      echo "   WARNING: POST succeeded but no id in response — skipping fetch (response: ${CREATE_RESPONSE:0:200})"
    fi
  else
    echo "❌ FAIL [crud:POST /projects] HTTP $CREATE_HTTP"
    echo "   Body: ${CREATE_RESPONSE:0:200}"
    FAIL=$((FAIL+1))
  fi
fi

echo ""
echo "=== Smoke tests: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FATAL: Smoke suite failed — $FAIL check(s) did not pass"
  exit 1
fi
echo "✅ All smoke tests passed"
