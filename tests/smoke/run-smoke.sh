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
if [[ -n "${STAGING_API_UX_EVENTS:-}" && "$STAGING_API_UX_EVENTS" != *placeholder* ]]; then
  check_reachable "lambda:ux-events" "$STAGING_API_UX_EVENTS"
else
  echo "   (ux-events reachability skipped — STAGING_API_UX_EVENTS unset/placeholder)"
fi
# Photos Lambda handles multipart — skip reachability to avoid misleading error shape
echo "   (photos Lambda skipped in reachability phase — multipart-only endpoint)"

# V4-HARVESTSURF-001 / V4-HARVESTQTY-001 sub-route reachability.
# Both shipped to prod in v3.56.0 with ZERO smoke coverage — this closes that gap.
# These are LITERAL sub-routes that must match BEFORE the /api/events/:id regex, so a
# precedence regression makes them fall through to the id branch and 404 rather than 401.
# They also SELECT columns added by migration v4-harvattr-001; if the Lambda ships ahead of
# the migration (or a column is renamed), the query throws and the route 500s. check_reachable
# accepts 2xx/4xx and FAILS on 5xx, which is exactly the signal that matters here — an
# unauthenticated call proves the route is routed and its module loads.
check_reachable "lambda:events:harvest-ready"   "${STAGING_API_EVENTS%/}/api/events/harvest-ready"
check_reachable "lambda:events:harvest-summary" "${STAGING_API_EVENTS%/}/api/events/harvest-summary"
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

      # ── D2) Seen-contract write→read-back (V3-SEEN-001; L-108 write-path coverage) ─────────
      # POST /api/plants/:id/seen with {} must persist a seen_event row and the AFTER-INSERT
      # trigger must stamp plants.last_seen_at (= GREATEST(prev, NEW.seen_at)). Assert HTTP 2xx
      # AND .last_seen_at is a non-empty ISO timestamp; capture it; POST again and assert the
      # second last_seen_at >= the first (monotone GREATEST). Gated on the test plant from block D.
      # NOTE: seen_event.leaf_id is FK ON DELETE CASCADE on plants, so the workflow's existing
      # L-058 plant sweep already removes any seen_event rows — no new cleanup line is needed here.
      if [[ -n "$CREATED_PLANT_ID" ]]; then
        CLERK_JWT=$(mint_session_token)
        SEEN1_BODY=$(mktemp)
        SEEN1_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$SEEN1_BODY" -w "%{http_code}" \
          "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}/seen" -d '{}') || SEEN1_HTTP="000"
        SEEN1_TS=$(jq -r '.last_seen_at // empty' "$SEEN1_BODY" 2>/dev/null || echo "")
        rm -f "$SEEN1_BODY"
        if [[ "${SEEN1_HTTP:0:1}" == "2" && -n "$SEEN1_TS" ]]; then
          echo "✅ PASS [write:seen-first] HTTP $SEEN1_HTTP last_seen_at='$SEEN1_TS'"
          PASS=$((PASS+1))
          SEEN2_BODY=$(mktemp)
          SEEN2_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$SEEN2_BODY" -w "%{http_code}" \
            "${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}/seen" -d '{}') || SEEN2_HTTP="000"
          SEEN2_TS=$(jq -r '.last_seen_at // empty' "$SEEN2_BODY" 2>/dev/null || echo "")
          rm -f "$SEEN2_BODY"
          # String compare is valid for ISO-8601 timestamptz (lexicographic == chronological).
          if [[ "${SEEN2_HTTP:0:1}" == "2" && -n "$SEEN2_TS" && ! "$SEEN2_TS" < "$SEEN1_TS" ]]; then
            echo "✅ PASS [write:seen-monotone] HTTP $SEEN2_HTTP second last_seen_at='$SEEN2_TS' >= first='$SEEN1_TS'"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [write:seen-monotone] HTTP $SEEN2_HTTP second='$SEEN2_TS' first='$SEEN1_TS' (expected second >= first)"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [write:seen-first] HTTP $SEEN1_HTTP last_seen_at='$SEEN1_TS' (expected 2xx + non-empty ISO timestamp)"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:seen] no test planting (block D skipped) — seen-contract assert NOT run"
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

      # ── H) Bulk Quick-Log batch (/api/events/batch) write→read-back (riskiest write path) ─────
      # The batch path dual-writes event_log (INSERT…SELECT over resolved plantings) + entity_memory;
      # it threw a prod 42804 (two bare NULLs) once. POST a project-scoped batch (resolves the test
      # plant from D), assert it persisted (count + read-back in the batches list), then UNDO via the
      # batch DELETE route (also cleans the events it wrote). Gated on the test plant existing.
      if [[ -n "$CREATED_PLANT_ID" ]]; then
        CLERK_JWT=$(mint_session_token)
        BATCH_BODY=$(mktemp)
        BATCH_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$BATCH_BODY" -w "%{http_code}" "${STAGING_API_EVENTS%/}/api/events/batch" \
          -d "{\"idempotency_key\": \"smoke-batch-$TEST_RUN_ID\", \"event_type\": \"watering\", \"scope\": {\"type\": \"project\", \"project_id\": \"$CREATED_PROJECT_ID\"}}") || BATCH_HTTP="000"
        BATCH_ID=$(jq -r '.batch_id // empty' "$BATCH_BODY" 2>/dev/null || echo "")
        BATCH_COUNT=$(jq -r '.count // 0' "$BATCH_BODY" 2>/dev/null || echo "0")
        rm -f "$BATCH_BODY"
        if [[ "${BATCH_HTTP:0:1}" == "2" && -n "$BATCH_ID" && "$BATCH_COUNT" -ge 1 ]]; then
          echo "✅ PASS [crud:POST /events/batch] HTTP $BATCH_HTTP (batch_id: $BATCH_ID, count: $BATCH_COUNT)"
          PASS=$((PASS+1))
          # read-back: the batch must appear in the recent-batches list under its id.
          assert_readback "write:batch-readback" \
            "${STAGING_API_EVENTS%/}/api/events/batches" "([.batches[] | select(.id==\"$BATCH_ID\")] | length | tostring)" "1"
          # undo (also cleans the batch's event_log rows) and assert it took.
          UNDO_BODY=$(mktemp)
          UNDO_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X DELETE \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$UNDO_BODY" -w "%{http_code}" "${STAGING_API_EVENTS%/}/api/events/batch/${BATCH_ID}") || UNDO_HTTP="000"
          UNDONE=$(jq -r '.undone // false' "$UNDO_BODY" 2>/dev/null || echo "false"); rm -f "$UNDO_BODY"
          if [[ "${UNDO_HTTP:0:1}" == "2" && "$UNDONE" == "true" ]]; then
            echo "✅ PASS [crud:DELETE /events/batch (undo)] HTTP $UNDO_HTTP"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [crud:DELETE /events/batch (undo)] HTTP $UNDO_HTTP undone=$UNDONE"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [crud:POST /events/batch] HTTP $BATCH_HTTP (count=$BATCH_COUNT)"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:batch] no test planting (block D skipped) — batch assert NOT run"
      fi

      # ── I) ux-events (Inc 0 M1 telemetry sink) write → read-back (L-108) ─────────
      # POST appends a row; the server confirms via INSERT…RETURNING id (which exercises
      # the ::jsonb / ::timestamptz casts — the real silent-bug risk on this append-only
      # table). Then the admin GET reads it back (the staging test user is in
      # garden-ux-events-staging ADMIN_CLERK_SUBS). Independent of the test project.
      if [[ -n "${STAGING_API_UX_EVENTS:-}" && "$STAGING_API_UX_EVENTS" != *placeholder* ]]; then
        CLERK_JWT=$(mint_session_token)
        UX_BODY=$(mktemp)
        UX_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X POST \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$UX_BODY" -w "%{http_code}" "${STAGING_API_UX_EVENTS%/}/api/ux-events" \
          -d "{\"flow_id\":\"create_project\",\"session_id\":\"smoke-ux-$TEST_RUN_ID\",\"step_name\":\"complete\",\"tap_count\":2}") || UX_HTTP="000"
        UX_ID=$(jq -r '.id // empty' "$UX_BODY" 2>/dev/null || echo ""); rm -f "$UX_BODY"
        if [[ "${UX_HTTP:0:1}" == "2" && -n "$UX_ID" ]]; then
          echo "✅ PASS [crud:POST /ux-events] HTTP $UX_HTTP (id: $UX_ID)"
          PASS=$((PASS+1))
          assert_readback "write:ux-events-admin-readback" \
            "${STAGING_API_UX_EVENTS%/}/api/ux-events?admin=1" "(.m1 | type)" "object"
        else
          echo "❌ FAIL [crud:POST /ux-events] HTTP $UX_HTTP (id=$UX_ID)"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:ux-events] STAGING_API_UX_EVENTS unset/placeholder — ux-events assert NOT run"
      fi

      # ── J) Critter award flow (write→read-back + idempotency) ─────────────────────
      # POST /api/critters awards a critter row anchored to a plant-bearing event.
      # Per mvp-critter-pre-build-revision-V001-20260528 §2 (Lambda) + §3.27 (UNIQUE INDEX
      # idempotency). species_id=255 is the SMOKE_SENTINEL (revision §2.6) — out of the
      # MVP 1-8 pool so future CHECK constraints catch leakage. L-058 sweep below also
      # nukes species_id=255 rows.
      # Gating per revision §2.6 / L-109: HARD-FAIL once Lambda is deployed; graceful skip
      # only on first-deploy (placeholder URL) so the wiring round-trip can complete.
      if [[ -n "${STAGING_API_CRITTERS:-}" && "$STAGING_API_CRITTERS" != *placeholder* ]]; then
        if [[ -n "$CREATED_PLANT_ID" ]]; then
          CLERK_JWT=$(mint_session_token)
          # Step 1: create a plant-anchored event (the critter\'s source_event_id must have plant_id != NULL).
          C_EV_BODY=$(mktemp)
          C_EV_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$C_EV_BODY" -w "%{http_code}" "$STAGING_API_EVENTS" \
            -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"plant_id\": \"$CREATED_PLANT_ID\", \"event_type\": \"watering\", \"notes\": \"smoke critter source\"}") || C_EV_HTTP="000"
          CRITTER_SRC_EVENT_ID=$(jq -r '.id // empty' "$C_EV_BODY" 2>/dev/null || echo "")
          rm -f "$C_EV_BODY"
          if [[ "${C_EV_HTTP:0:1}" == "2" && -n "$CRITTER_SRC_EVENT_ID" ]]; then
            echo "✅ PASS [crud:POST /events (critter source)] HTTP $C_EV_HTTP"
            PASS=$((PASS+1))

            # Step 2: POST /api/critters — first call should 201.
            C_BODY=$(mktemp)
            C_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
              -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
              -o "$C_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters" \
              -d "{\"source_event_id\": \"$CRITTER_SRC_EVENT_ID\", \"plant_id\": \"$CREATED_PLANT_ID\", \"species_id\": 255}") || C_HTTP="000"
            CRITTER_ID=$(jq -r '.critter.id // empty' "$C_BODY" 2>/dev/null || echo "")
            CRITTER_FIRST_IDEM=$(jq -r '.idempotent // false' "$C_BODY" 2>/dev/null || echo "false")
            rm -f "$C_BODY"
            # Phase B++ (2026-05-30) added a server-side critter-award hook on POST /events
            # with plant_id. Result: the events POST above already created the critter row,
            # so this explicit POST hits the UNIQUE-INDEX idempotency path → HTTP 200 +
            # .idempotent=true. Accept either shape; downstream species_id/target_id
            # readback + second-POST same-row idempotency assertions still cover the contract.
            if [[ "$C_HTTP" == "201" && -n "$CRITTER_ID" ]]                || [[ "$C_HTTP" == "200" && "$CRITTER_FIRST_IDEM" == "true" && -n "$CRITTER_ID" ]]; then
              echo "✅ PASS [crud:POST /critters] HTTP $C_HTTP (id: $CRITTER_ID, idempotent=$CRITTER_FIRST_IDEM)"
              PASS=$((PASS+1))

              # Step 3: GET /api/critters/:id → assert target_id == plant.
              # Per Phase B++ (2026-05-30): if the first POST returned 200+idempotent=true the
              # row was created by the server-side events-Lambda hook, which calls pickSpecies()
              # and ignores caller-supplied species_id. Only assert species_id == 255 (smoke
              # sentinel) on the legacy 201 path. The target_id assertion is the load-bearing
              # check either way — verifies the critter is anchored to our smoke plant.
              if [[ "$C_HTTP" == "201" ]]; then
                assert_readback "write:critter-species-readback" \
                  "${STAGING_API_CRITTERS%/}/api/critters/${CRITTER_ID}" ".critter.species_id" "255"
              else
                echo "ℹ️  SKIP [write:critter-species-readback] hook-created row uses pickSpecies — sentinel 255 not applicable"
              fi
              assert_readback "write:critter-target-readback" \
                "${STAGING_API_CRITTERS%/}/api/critters/${CRITTER_ID}" ".critter.target_id" "$CREATED_PLANT_ID"

              # Step 4: idempotency — POST again with SAME source_event_id → 200 + idempotent flag.
              # Per revision §3.27 + Lambda 23505 catch path. Closes the multi-user concurrent-write race surface.
              C_IDEM_BODY=$(mktemp)
              C_IDEM_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
                -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                -o "$C_IDEM_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters" \
                -d "{\"source_event_id\": \"$CRITTER_SRC_EVENT_ID\", \"plant_id\": \"$CREATED_PLANT_ID\", \"species_id\": 255}") || C_IDEM_HTTP="000"
              IDEM=$(jq -r '.idempotent // false' "$C_IDEM_BODY" 2>/dev/null || echo "false")
              IDEM_ID=$(jq -r '.critter.id // empty' "$C_IDEM_BODY" 2>/dev/null || echo "")
              rm -f "$C_IDEM_BODY"
              if [[ "$C_IDEM_HTTP" == "200" && "$IDEM" == "true" && "$IDEM_ID" == "$CRITTER_ID" ]]; then
                echo "✅ PASS [write:critter-idempotency] same source_event_id returns SAME row (id=$IDEM_ID, idempotent=true)"
                PASS=$((PASS+1))
              else
                echo "❌ FAIL [write:critter-idempotency] HTTP $C_IDEM_HTTP idempotent=$IDEM id=$IDEM_ID (expected $CRITTER_ID)"
                FAIL=$((FAIL+1))
              fi

              # Step 5: collection readback — GET /api/critters/collection.
              # Stickerbook Phase 2 (laughing-sleepy-gauss 2026-05-31). Per-USER scope
              # per Dave's directive. Asserts: HTTP 200 + species[] is an array + the
              # species_id we just wrote appears in the response with count >= 1.
              # Defensive: every jq is wrapped (route 400/empty body would make .species[]
              # iterate-null with exit-5 under set -e + pipefail without these guards).
              C_OUR_SP_BODY=$(mktemp)
              C_OUR_SP_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
                -X GET -H "Authorization: Bearer $CLERK_JWT" \
                -o "$C_OUR_SP_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters/${CRITTER_ID}") || C_OUR_SP_HTTP="000"
              C_OUR_SPECIES=$(jq -r '.critter.species_id // empty' "$C_OUR_SP_BODY" 2>/dev/null || echo "")
              rm -f "$C_OUR_SP_BODY"
              C_COL_BODY=$(mktemp)
              C_COL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
                -X GET -H "Authorization: Bearer $CLERK_JWT" \
                -o "$C_COL_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters/collection") || C_COL_HTTP="000"
              C_COL_SHAPE=$(jq -r '(.species | type) // "missing"' "$C_COL_BODY" 2>/dev/null || echo "missing")
              C_COL_LEN=$(jq -r '(.species | length) // 0' "$C_COL_BODY" 2>/dev/null || echo "0")
              C_COL_OUR_COUNT="0"
              if [[ -n "$C_OUR_SPECIES" && "$C_COL_SHAPE" == "array" ]]; then
                FOUND=$(jq -r --argjson sid "$C_OUR_SPECIES" '(.species // []) | map(select(.species_id == $sid)) | .[0].count // 0' "$C_COL_BODY" 2>/dev/null || echo "0")
                C_COL_OUR_COUNT="${FOUND:-0}"
              fi
              rm -f "$C_COL_BODY"
              if [[ "$C_COL_HTTP" == "200" && "$C_COL_SHAPE" == "array" && "${C_COL_OUR_COUNT:-0}" -ge 1 ]]; then
                echo "✅ PASS [write:critter-collection-readback] HTTP $C_COL_HTTP species[]=array len=$C_COL_LEN our_species=$C_OUR_SPECIES count=$C_COL_OUR_COUNT"
                PASS=$((PASS+1))
              else
                echo "❌ FAIL [write:critter-collection-readback] HTTP $C_COL_HTTP shape=$C_COL_SHAPE len=$C_COL_LEN our_species=$C_OUR_SPECIES count=${C_COL_OUR_COUNT:-0}"
                FAIL=$((FAIL+1))
              fi
            else
              echo "❌ FAIL [crud:POST /critters] HTTP $C_HTTP (id=$CRITTER_ID)"
              FAIL=$((FAIL+1))
            fi
          else
            echo "❌ FAIL [crud:POST /events (critter source)] HTTP $C_EV_HTTP"
            FAIL=$((FAIL+1))
          fi
        else
          echo "⚠️  WARN [write:critter] no test planting (block D failed) — critter assert NOT run"
        fi
      else
        echo "⚠️  WARN [write:critter] STAGING_API_CRITTERS unset/placeholder — critter assert NOT run (first-deploy graceful skip)"
      fi
      # ── K) DELETE soft-delete read-back (Soft-Delete-Only rule; Bundle 2 logging-loop reliability) ──
      # Proves the planting + event DELETE routes SOFT-delete (deleted_at, never hard-delete):
      # after DELETE the by-id GET must 404 (handler filters deleted_at IS NULL) — the row is
      # tombstoned, not gone. Uses OWN throwaway fixtures so it never tombstones the shared
      # $CREATED_PLANT_ID that blocks H/J depend on. Both rows are '%smoke%' → swept by the
      # workflow L-058 hard-delete hygiene step (no new cleanup line needed).
      assert_status() {                   # assert a bare-GET returns an exact HTTP status
        local label="$1" url="$2" expected="$3" TMP CODE
        TMP=$(mktemp)
        CODE=$(curl -s --max-time 30 --connect-timeout 10 \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$TMP" -w "%{http_code}" "$url") || CODE="000"
        rm -f "$TMP"
        if [[ "$CODE" == "$expected" ]]; then
          echo "✅ PASS [$label] HTTP $CODE == $expected"; PASS=$((PASS+1))
        else
          echo "❌ FAIL [$label] HTTP $CODE (expected $expected)"; FAIL=$((FAIL+1))
        fi
      }
      CLERK_JWT=$(mint_session_token)
      # K1) planting soft-delete: create throwaway plant → DELETE → GET must 404
      DEL_PLANT_BODY=$(mktemp)
      DEL_PLANT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
        -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o "$DEL_PLANT_BODY" -w "%{http_code}" "$STAGING_API_PLANTS" \
        -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"smoke-test-delplant-$TEST_RUN_ID\"}") || DEL_PLANT_HTTP="000"
      DEL_PLANT_ID=$(jq -r '.id // empty' "$DEL_PLANT_BODY" 2>/dev/null || echo ""); rm -f "$DEL_PLANT_BODY"
      if [[ "${DEL_PLANT_HTTP:0:1}" == "2" && -n "$DEL_PLANT_ID" ]]; then
        echo "✅ PASS [crud:POST /plants (del fixture)] HTTP $DEL_PLANT_HTTP (id: $DEL_PLANT_ID)"; PASS=$((PASS+1))
        DEL_PLANT_DEL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X DELETE \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o /dev/null -w "%{http_code}" "${STAGING_API_PLANTS%/}/api/plants/${DEL_PLANT_ID}") || DEL_PLANT_DEL_HTTP="000"
        if [[ "${DEL_PLANT_DEL_HTTP:0:1}" == "2" ]]; then
          echo "✅ PASS [delete:DELETE /plants/$DEL_PLANT_ID] HTTP $DEL_PLANT_DEL_HTTP"; PASS=$((PASS+1))
          assert_status "delete:plant-soft-delete-404" \
            "${STAGING_API_PLANTS%/}/api/plants/${DEL_PLANT_ID}" "404"
        else
          echo "❌ FAIL [delete:DELETE /plants] HTTP $DEL_PLANT_DEL_HTTP"; FAIL=$((FAIL+1))
        fi
      else
        echo "❌ FAIL [crud:POST /plants (del fixture)] HTTP $DEL_PLANT_HTTP"; FAIL=$((FAIL+1))
      fi
      # K2) event soft-delete: create throwaway event → DELETE → GET must 404
      CLERK_JWT=$(mint_session_token)
      DEL_EV_BODY=$(mktemp)
      DEL_EV_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
        -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o "$DEL_EV_BODY" -w "%{http_code}" "$STAGING_API_EVENTS" \
        -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"event_type\": \"observation\", \"event_date\": \"$(date -u +%Y-%m-%d)\", \"notes\": \"smoke delete-soft-delete — safe to delete\"}") || DEL_EV_HTTP="000"
      DEL_EV_ID=$(jq -r '.id // empty' "$DEL_EV_BODY" 2>/dev/null || echo ""); rm -f "$DEL_EV_BODY"
      if [[ "${DEL_EV_HTTP:0:1}" == "2" && -n "$DEL_EV_ID" ]]; then
        echo "✅ PASS [crud:POST /events (del fixture)] HTTP $DEL_EV_HTTP (id: $DEL_EV_ID)"; PASS=$((PASS+1))
        DEL_EV_DEL_BODY=$(mktemp)
        DEL_EV_DEL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X DELETE \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$DEL_EV_DEL_BODY" -w "%{http_code}" "${STAGING_API_EVENTS%/}/api/events/${DEL_EV_ID}") || DEL_EV_DEL_HTTP="000"
        DEL_EV_UNDONE=$(jq -r '.undone // false' "$DEL_EV_DEL_BODY" 2>/dev/null || echo "false"); rm -f "$DEL_EV_DEL_BODY"
        if [[ "${DEL_EV_DEL_HTTP:0:1}" == "2" && "$DEL_EV_UNDONE" == "true" ]]; then
          echo "✅ PASS [delete:DELETE /events/$DEL_EV_ID] HTTP $DEL_EV_DEL_HTTP undone=true"; PASS=$((PASS+1))
          assert_status "delete:event-soft-delete-404" \
            "${STAGING_API_EVENTS%/}/api/events/${DEL_EV_ID}" "404"
        else
          echo "❌ FAIL [delete:DELETE /events] HTTP $DEL_EV_DEL_HTTP undone=$DEL_EV_UNDONE"; FAIL=$((FAIL+1))
        fi
      else
        echo "❌ FAIL [crud:POST /events (del fixture)] HTTP $DEL_EV_HTTP"; FAIL=$((FAIL+1))
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


# ── Shared-state tally write->read-back (V3-REWARDSTATE-001; L-108 write-path coverage) ──
# Independent of the test project. Hits the deployed garden-shared-state Lambda via its real
# Function URL: proves deploy + Function URL + CORS + Clerk auth + the atomic-increment SQL
# end-to-end. natural_key carries 'smoke' so the workflow L-058 DB sweep hard-deletes it.
# Graceful skip (L-109) when the URL is unset/placeholder or Phase 2 minted no JWT.
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_SHARED_STATE:-}" && "$STAGING_API_SHARED_STATE" != *placeholder* ]]; then
  CLERK_JWT=$(mint_session_token)
  SS_KEY="smoke-tally-$TEST_RUN_ID"
  SS_INC=$(mktemp)
  SS_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X POST \
    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
    -o "$SS_INC" -w "%{http_code}" \
    "${STAGING_API_SHARED_STATE%/}/api/shared-state/tally/${SS_KEY}/increment" -d '{"by":3}') || SS_HTTP="000"
  SS_CTR=$(jq -r '.counter // empty' "$SS_INC" 2>/dev/null || echo ""); rm -f "$SS_INC"
  if [[ "${SS_HTTP:0:1}" == "2" && "$SS_CTR" == "3" ]]; then
    echo "✅ PASS [crud:POST /shared-state tally increment] HTTP $SS_HTTP counter=$SS_CTR"
    PASS=$((PASS+1))
    SS_GET=$(mktemp)
    SS_GHTTP=$(curl -s --max-time 30 --connect-timeout 10 \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o "$SS_GET" -w "%{http_code}" \
      "${STAGING_API_SHARED_STATE%/}/api/shared-state/tally/${SS_KEY}") || SS_GHTTP="000"
    SS_GCTR=$(jq -r '.counter // empty' "$SS_GET" 2>/dev/null || echo ""); rm -f "$SS_GET"
    if [[ "${SS_GHTTP:0:1}" == "2" && "$SS_GCTR" == "3" ]]; then
      echo "✅ PASS [write:shared-state-tally-readback] read-back counter == 3"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [write:shared-state-tally-readback] HTTP $SS_GHTTP counter='$SS_GCTR' (expected 3)"
      FAIL=$((FAIL+1))
    fi
  else
    echo "❌ FAIL [crud:POST /shared-state tally increment] HTTP $SS_HTTP counter='$SS_CTR' (expected 2xx + 3)"
    FAIL=$((FAIL+1))
  fi
else
  echo "⚠️  WARN [write:shared-state] STAGING_API_SHARED_STATE unset/placeholder or no JWT — shared-state assert NOT run"
fi

# == D2 contract: the EXACT prod sighting-tally key end-to-end (V3-DELIGHT-001 D2) ==
# Locks the precise natural_key the prod events-Lambda hook + frontend TallyDisplay depend on
# ('tally:sightings'): baseline GET -> POST increment by 1 -> GET-via-increment-return -> assert
# exactly +1. Proves deploy + Function URL + CORS + auth + atomic-increment SQL for the REAL key.
# The events-hook -> increment COUPLING is covered deterministically by
# lambda/events/critterAward.test.js (it can't be HTTP-smoked: the award is probabilistic AND the
# increment is non-fatal/swallowed). Increments staging's real counter +1/run -- harmless
# (staging Neon isolated from prod). Graceful skip (L-109) when URL unset/placeholder or no JWT.
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_SHARED_STATE:-}" && "$STAGING_API_SHARED_STATE" != *placeholder* ]]; then
  CLERK_JWT=$(mint_session_token)
  D2_KEY="tally:sightings"
  D2_B=$(mktemp)
  curl -s --max-time 30 --connect-timeout 10 \
    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
    -o "$D2_B" "${STAGING_API_SHARED_STATE%/}/api/shared-state/tally/${D2_KEY}" >/dev/null 2>&1 || true
  D2_BASE=$(jq -r '.counter // 0' "$D2_B" 2>/dev/null || echo "0"); rm -f "$D2_B"
  [[ "$D2_BASE" =~ ^[0-9]+$ ]] || D2_BASE=0
  D2_I=$(mktemp)
  D2_IHTTP=$(curl -s --max-time 30 --connect-timeout 10 -X POST \
    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
    -o "$D2_I" -w "%{http_code}" \
    "${STAGING_API_SHARED_STATE%/}/api/shared-state/tally/${D2_KEY}/increment" -d '{"by":1}') || D2_IHTTP="000"
  D2_AFTER=$(jq -r '.counter // empty' "$D2_I" 2>/dev/null || echo ""); rm -f "$D2_I"
  if [[ "${D2_IHTTP:0:1}" == "2" && "$D2_AFTER" =~ ^[0-9]+$ && "$D2_AFTER" -eq $((D2_BASE + 1)) ]]; then
    echo "PASS [write:d2-sighting-tally-key] 'tally:sightings' +1 ($D2_BASE -> $D2_AFTER)"
    PASS=$((PASS+1))
  else
    echo "FAIL [write:d2-sighting-tally-key] HTTP $D2_IHTTP base=$D2_BASE after='$D2_AFTER' (expected $((D2_BASE+1)))"
    FAIL=$((FAIL+1))
  fi
else
  echo "WARN [write:d2-sighting-tally] STAGING_API_SHARED_STATE unset/placeholder or no JWT -- D2 key assert NOT run"
fi


# ── DRG-WATERRECON-002: alert bar ≡ Today equality (durable bar==Today regression guard) ──────
# The dashboard alert bar's water_due planting-set MUST equal the Today page's pending (not-done)
# water set — both now derive from the SAME daily_plan engine verdict (DRG-WATERRECON-001). This
# asserts set-equality on whatever real plan exists for the smoke user, catching a future silent
# re-divergence. Graceful skip (L-109) when STAGING_API_DAILY_PLAN is unset/placeholder, no JWT, or
# no plan row exists for today (engine-skip; staging has no nightly engine yet so the bar serves the
# legacy fallback and equality is genuinely N/A — a WARN, never a silent PASS).
if [[ -n "$CLERK_JWT" && -n "${STAGING_API_DAILY_PLAN:-}" && "$STAGING_API_DAILY_PLAN" != *placeholder* ]]; then
  CLERK_JWT=$(mint_session_token)
  WR_DASH=$(mktemp); WR_PLAN=$(mktemp)
  curl -s --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
    -o "$WR_DASH" "$STAGING_API_DASHBOARD" >/dev/null 2>&1 || true
  curl -s --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
    -o "$WR_PLAN" "${STAGING_API_DAILY_PLAN%/}/api/daily-plan" >/dev/null 2>&1 || true
  WR_HASPLAN=$(jq -r '.has_plan // false' "$WR_PLAN" 2>/dev/null || echo "false")
  if [[ "$WR_HASPLAN" == "true" ]]; then
    # bar set = every planting id under water_due[].plantings[]; Today set = plan.water_due[] not done.
    BAR_IDS=$(jq -S -c '[.water_due[].plantings[].id] | sort | unique' "$WR_DASH" 2>/dev/null || echo "null")
    TODAY_IDS=$(jq -S -c '[.plan.water_due[] | select(.done != true) | .id] | sort | unique' "$WR_PLAN" 2>/dev/null || echo "null")
    if [[ "$BAR_IDS" != "null" && "$TODAY_IDS" != "null" && "$BAR_IDS" == "$TODAY_IDS" ]]; then
      echo "✅ PASS [recon:bar==today] water planting-sets equal ($BAR_IDS)"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [recon:bar==today] DIVERGED — bar=$BAR_IDS today=$TODAY_IDS"
      FAIL=$((FAIL+1))
    fi
  else
    echo "⚠️  WARN [recon:bar==today] no daily_plan for smoke user today (engine-skip / staging has no nightly engine) — equality N/A"
  fi
  rm -f "$WR_DASH" "$WR_PLAN"
else
  echo "⚠️  WARN [recon:bar==today] STAGING_API_DAILY_PLAN unset/placeholder or no JWT — bar==Today equality NOT run (set repo var STAGING_API_DAILY_PLAN_READ to activate)"
fi

echo ""
echo "=== Smoke tests: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FATAL: Smoke suite failed — $FAIL check(s) did not pass"
  exit 1
fi
echo "✅ All smoke tests passed"
