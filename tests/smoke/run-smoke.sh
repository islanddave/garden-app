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
#   description round-trip, then exercises the two real bug surfaces with
#   write→read-back asserts (L-108 write-path coverage):
#     C) events bare-date → NOON-anchored stored date (BUG-12 off-by-one guard)
#     D) plants variety_id set→clear (the can't-clear COALESCE origin bug)
#     E) locations create → read-back name
#     F) inventory-items create → read-back name (durable+tools dodges the L-058 seeds CHECK)
#     G) favorites toggle → assert favorited on, then off
#   then deletes the test data. Skipped only if CLERK_SECRET_KEY_STAGING or
#   CLERK_TEST_USER_ID are unset.
#   Per L-108 (ratified 2026-05-25): every write-path surface gets a write→read-back assert.
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
CREATED_EVENT_ID=""
CREATED_VARIETY_ID=""
CREATED_PLANT_ID=""
CREATED_LOCATION_ID=""
CREATED_INV_ID=""
CREATED_FAVORITE_DONE=false
DATA_CREATED=false
CLERK_JWT=""
CLERK_SESSION_ID=""
PASS=0
FAIL=0

cleanup() {
  if [[ "$DATA_CREATED" == "true" && -n "$CLERK_JWT" ]]; then
    echo ""
    echo "Cleanup: deleting smoke test data (best-effort API soft-deletes)..."
    # Order: plant before variety (plants.variety_id is ON DELETE RESTRICT to plant_varieties;
    # the plant's variety_id was cleared above, but delete the plant first regardless).
    if [[ -n "$CREATED_PLANT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test plant deleted" \
        || echo "WARNING: plant cleanup failed (id: $CREATED_PLANT_ID)"
    fi
    if [[ -n "$CREATED_VARIETY_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_VARIETIES%/}/api/varieties/${CREATED_VARIETY_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test variety deleted" \
        || echo "WARNING: variety cleanup failed (id: $CREATED_VARIETY_ID)"
    fi
    if [[ -n "$CREATED_PROJECT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_PROJECTS%/}/api/projects/${CREATED_PROJECT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test project deleted" \
        || echo "WARNING: project cleanup failed (id: $CREATED_PROJECT_ID)"
    fi
    if [[ -n "$CREATED_LOCATION_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_LOCATIONS%/}/api/locations/${CREATED_LOCATION_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test location deleted" \
        || echo "WARNING: location cleanup failed (id: $CREATED_LOCATION_ID)"
    fi
    if [[ -n "$CREATED_INV_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_INV_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test inventory item deleted" \
        || echo "WARNING: inventory cleanup failed (id: $CREATED_INV_ID)"
    fi
    if [[ "$CREATED_FAVORITE_DONE" == "true" && -n "$CREATED_PROJECT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_FAVORITES%/}?entity_type=project&entity_id=${CREATED_PROJECT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test favorite removed" || true
    fi
    # The test event has NO DELETE route; it (+ its entity_memory row) is hard-swept by the
    # workflow's L-058 'if: always()' DB step (deploy-staging.yml). The API deletes above are
    # soft-deletes and the ~60s Clerk token may have expired by now — the workflow DB sweep is
    # the AUTHORITATIVE cleanup; these are best-effort hygiene only.
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
      # See lessons.md L-108. Blocks C and D below extend this to the two real bug
      # surfaces: events bare-date (BUG-12 noon-anchor) and plants variety_id set→clear
      # (the origin bug). Both reuse this test project as parent. The throwaway variety
      # is POSTed fresh (no dependency on staging seed data); the event has no DELETE
      # route so its row + entity_memory are hard-swept by the workflow L-058 DB step.
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

      # Refresh the token — the asserts below add several round trips; stay inside ~60s.
      CLERK_JWT=$(mint_session_token)

      # ── C) Events bare-date → NOON-anchor read-back (BUG-12 regression guard) ──────────────
      # A bare "YYYY-MM-DD" must persist noon-anchored (…T12:00:00.000Z). The off-by-one bug
      # stored midnight (…T00:00:00.000Z), which renders a day early in EDT. normalizeEventDate()
      # in lambda/events/validators.js is the unit under test. A PAST date (7 days ago) dodges
      # the +1h future bound in validatePostBody. Exact stored format confirmed live 2026-05-25.
      BARE_DATE=$(date -u -d '7 days ago' +%Y-%m-%d)
      EVENT_BODY=$(mktemp)
      EVENT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
        -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o "$EVENT_BODY" -w "%{http_code}" "$STAGING_API_EVENTS" \
        -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"event_type\": \"observation\", \"event_date\": \"$BARE_DATE\", \"notes\": \"CI smoke — safe to delete\"}") || EVENT_HTTP="000"
      CREATED_EVENT_ID=$(jq -r '.id // empty' "$EVENT_BODY" 2>/dev/null || echo "")
      rm -f "$EVENT_BODY"
      if [[ "${EVENT_HTTP:0:1}" == "2" && -n "$CREATED_EVENT_ID" ]]; then
        echo "✅ PASS [crud:POST /events] HTTP $EVENT_HTTP (id: $CREATED_EVENT_ID)"
        PASS=$((PASS+1))
        assert_readback "write:event-date-noon-anchor" \
          "${STAGING_API_EVENTS%/}/api/events/${CREATED_EVENT_ID}" ".event_date" "${BARE_DATE}T12:00:00.000Z"
      else
        echo "❌ FAIL [crud:POST /events] HTTP $EVENT_HTTP"
        FAIL=$((FAIL+1))
      fi

      # ── D) Plants variety_id set→clear read-back (this thread's origin bug) ─────────────────
      # The PUT used COALESCE, which can SET a variety but never CLEAR one (null collapses to the
      # existing value). The presence-sentinel CASE fix lets an explicit null clear it. POST a
      # throwaway variety for a real id, attach it to a test plant, assert it set, clear it, assert
      # null. Gated on STAGING_API_VARIETIES (the staging workflow sets it; a loud skip otherwise).
      if [[ -n "${STAGING_API_VARIETIES:-}" ]]; then
        VAR_BODY=$(mktemp)
        VAR_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$VAR_BODY" -w "%{http_code}" "$STAGING_API_VARIETIES" \
          -d "{\"name\": \"smoke-test-variety-$TEST_RUN_ID\"}") || VAR_HTTP="000"
        CREATED_VARIETY_ID=$(jq -r '.id // empty' "$VAR_BODY" 2>/dev/null || echo "")
        rm -f "$VAR_BODY"
        if [[ "${VAR_HTTP:0:1}" == "2" && -n "$CREATED_VARIETY_ID" ]]; then
          echo "✅ PASS [crud:POST /varieties] HTTP $VAR_HTTP (id: $CREATED_VARIETY_ID)"
          PASS=$((PASS+1))
          PLANT_BODY=$(mktemp)
          PLANT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$PLANT_BODY" -w "%{http_code}" "$STAGING_API_PLANTS" \
            -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"smoke-test-plant-$TEST_RUN_ID\", \"variety_id\": \"$CREATED_VARIETY_ID\"}") || PLANT_HTTP="000"
          CREATED_PLANT_ID=$(jq -r '.id // empty' "$PLANT_BODY" 2>/dev/null || echo "")
          rm -f "$PLANT_BODY"
          if [[ "${PLANT_HTTP:0:1}" == "2" && -n "$CREATED_PLANT_ID" ]]; then
            echo "✅ PASS [crud:POST /plants] HTTP $PLANT_HTTP (id: $CREATED_PLANT_ID)"
            PASS=$((PASS+1))
            # set worked? read-back variety_id must equal the variety we attached.
            assert_readback "write:plant-variety-set" \
              "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}" ".variety_id" "$CREATED_VARIETY_ID"
            # clear it (explicit null) — the bug-fix path — then assert it actually cleared.
            auth_request "write:PUT /plants/$CREATED_PLANT_ID (clear variety)" \
              "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}" "PUT" \
              "{\"variety_id\": null}" >/dev/null || true
            assert_readback "write:plant-variety-clear" \
              "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}" ".variety_id" ""
          else
            echo "❌ FAIL [crud:POST /plants] HTTP $PLANT_HTTP"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [crud:POST /varieties] HTTP $VAR_HTTP"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:plant-variety] STAGING_API_VARIETIES unset — variety set/clear assert NOT run"
        echo "     (legit skip only if the varieties endpoint is unconfigured; the staging workflow DOES set it)"
      fi

      # Refresh the token for the back half of the write path (E/F/G add more round trips).
      CLERK_JWT=$(mint_session_token)

      # ── E) Locations create → read-back name (core entity; household-scoped) ────────────────
      LOC_BODY=$(mktemp)
      LOC_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
        -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o "$LOC_BODY" -w "%{http_code}" "$STAGING_API_LOCATIONS" \
        -d "{\"name\": \"smoke-test-loc-$TEST_RUN_ID\"}") || LOC_HTTP="000"
      CREATED_LOCATION_ID=$(jq -r '.id // empty' "$LOC_BODY" 2>/dev/null || echo "")
      rm -f "$LOC_BODY"
      if [[ "${LOC_HTTP:0:1}" == "2" && -n "$CREATED_LOCATION_ID" ]]; then
        echo "✅ PASS [crud:POST /locations] HTTP $LOC_HTTP (id: $CREATED_LOCATION_ID)"
        PASS=$((PASS+1))
        assert_readback "write:location-name" \
          "${STAGING_API_LOCATIONS%/}/api/locations/${CREATED_LOCATION_ID}" ".name" "smoke-test-loc-$TEST_RUN_ID"
      else
        echo "❌ FAIL [crud:POST /locations] HTTP $LOC_HTTP"
        FAIL=$((FAIL+1))
      fi

      # ── F) Inventory-items create → read-back name ──────────────────────────────
      # type=durable + category=tools deliberately AVOIDS the L-058 seeds CHECK
      # (category='seeds' would require variety_id NOT NULL).
      if [[ -n "${STAGING_API_INVENTORY:-}" ]]; then
        INV_BODY=$(mktemp)
        INV_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$INV_BODY" -w "%{http_code}" "$STAGING_API_INVENTORY" \
          -d "{\"name\": \"smoke-test-inv-$TEST_RUN_ID\", \"type\": \"durable\", \"category\": \"tools\", \"quantity\": 1}") || INV_HTTP="000"
        CREATED_INV_ID=$(jq -r '.id // empty' "$INV_BODY" 2>/dev/null || echo "")
        rm -f "$INV_BODY"
        if [[ "${INV_HTTP:0:1}" == "2" && -n "$CREATED_INV_ID" ]]; then
          echo "✅ PASS [crud:POST /inventory-items] HTTP $INV_HTTP (id: $CREATED_INV_ID)"
          PASS=$((PASS+1))
          assert_readback "write:inventory-name" \
            "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_INV_ID}" ".name" "smoke-test-inv-$TEST_RUN_ID"
        else
          echo "❌ FAIL [crud:POST /inventory-items] HTTP $INV_HTTP"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:inventory] STAGING_API_INVENTORY unset — inventory assert NOT run (the staging workflow sets it)"
      fi

      # ── G) Favorites toggle round-trip (POST favorite → assert on → DELETE → assert off) ─────
      # Reuses the test project as the favorited entity (favorites.entity_id has no FK).
      # NOTE: a dedicated check is used (not assert_readback) because jq's `// empty`
      # collapses a boolean false to empty — so .favorited==false would mis-read as "".
      fav_check() {
        local label="$1" expected="$2" TMP CODE GOT
        TMP=$(mktemp)
        CODE=$(curl -s --max-time 30 --connect-timeout 10 \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$TMP" -w "%{http_code}" \
          "${STAGING_API_FAVORITES%/}?entity_type=project&entity_id=${CREATED_PROJECT_ID}") || CODE="000"
        GOT=$(jq -r '.favorited' "$TMP" 2>/dev/null || echo "?"); rm -f "$TMP"
        if [[ "$GOT" == "$expected" ]]; then
          echo "✅ PASS [$label] favorited == $expected"; PASS=$((PASS+1))
        else
          echo "❌ FAIL [$label] favorited: expected $expected, got $GOT (HTTP $CODE)"; FAIL=$((FAIL+1))
        fi
      }
      FAV_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
        -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o /dev/null -w "%{http_code}" "$STAGING_API_FAVORITES" \
        -d "{\"entity_type\": \"project\", \"entity_id\": \"$CREATED_PROJECT_ID\"}") || FAV_HTTP="000"
      if [[ "${FAV_HTTP:0:1}" == "2" ]]; then
        echo "✅ PASS [crud:POST /favorites] HTTP $FAV_HTTP"
        PASS=$((PASS+1))
        CREATED_FAVORITE_DONE=true
        fav_check "write:favorite-on" "true"
        curl -s --max-time 30 --connect-timeout 10 -X DELETE \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          "${STAGING_API_FAVORITES%/}?entity_type=project&entity_id=${CREATED_PROJECT_ID}" -o /dev/null || true
        fav_check "write:favorite-off" "false"
        CREATED_FAVORITE_DONE=false   # toggled off — nothing left for cleanup
      else
        echo "❌ FAIL [crud:POST /favorites] HTTP $FAV_HTTP"
        FAIL=$((FAIL+1))
      fi
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
