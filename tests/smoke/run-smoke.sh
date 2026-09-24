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
#     D) plants variety_id set→clear (the can't-clear COALESCE origin bug), plus the variety
#        POST's cultivar care_profile, read back through SQL (needs NEON_STAGING_URL + psql), and
#        a variety PUT of origin_country read back through GET /api/varieties/:id
#     E) locations create → read-back name
#     F) inventory-items create → read-back name (durable+tools dodges the L-058 seeds CHECK)
#     F3) a seed packet (on block D's variety) → a planting sown from it → the packet's detail GET
#        answers 200 with that planting inside sown_from (V5-SEEDSTAB-001 slice 3); then that planting
#        archived through PATCH /api/plants/:id/archive → the packet's sown_from no longer lists it
#        (F3b, Archive-Hiding on the deployed stack); then DELETE on the packet → 409 with the
#        "1 archived planting was sown from it" sentence, and the packet still reads back 200
#        (F3c, BUG-INVREFSTRAND-001: archived plantings still block a delete); then the planting
#        deleted → the packet's DELETE answers 200 {"ok":true} and the packet reads back 404
#        (F3d, the allowed half of the same DELETE)
#     G) favorites toggle → assert favorited on, then off
#     L) (after the project blocks, independent of them) the smoke account's own nav prefs
#        (V5-NAVCUSTOM-001): PATCH more_pins, then bar_layout, on the critter Lambda, each read back
#        through GET, which must also carry a boolean can_edit_bar; then restored to [] and the shipped bar
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
CREATED_SEEDPKT_ID=""
CREATED_SOWN_PLANT_ID=""
CREATED_FAVORITE_DONE=false
NAVP_DIRTY=false
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
    # F3's pair: the planting before the packet it was sown from (plants.source_inventory_item_id is
    # ON DELETE RESTRICT; these are soft-deletes, the workflow's L-058 sweep hard-deletes in the same order).
    if [[ -n "$CREATED_SOWN_PLANT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_PLANTS%/}/api/plants/${CREATED_SOWN_PLANT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test sown planting deleted" \
        || echo "WARNING: sown planting cleanup failed (id: $CREATED_SOWN_PLANT_ID)"
    fi
    if [[ -n "$CREATED_SEEDPKT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test seed packet deleted" \
        || echo "WARNING: seed packet cleanup failed (id: $CREATED_SEEDPKT_ID)"
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
  # Block L (V5-NAVCUSTOM-001): the run died between its first nav-prefs PATCH and its restore. Put the
  # smoke account's own pins and bar back, best-effort, before the session is revoked below (the next
  # run's block L restores them anyway). Fresh token: the one in hand may have expired.
  if [[ "$NAVP_DIRTY" == "true" && -n "${CLERK_SESSION_ID:-}" && -n "${NAVP_URL:-}" ]]; then
    local navp_jwt
    navp_jwt=$(mint_session_token)
    curl -s --max-time 15 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $navp_jwt" -H "Content-Type: application/json" -o /dev/null \
      "$NAVP_URL" -d '{"more_pins": [], "bar_layout": {"order": ["today","garden","create","harvests","put-up"], "hidden": []}}' \
      && echo "✅ Cleanup: smoke account nav prefs restored" || true
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

# ── Helper: a UTC calendar date N days back, on GNU date (the ubuntu runner) and BSD date (macOS) ──
# `date -d '7 days ago'` is GNU-only: on a Mac it errors, and under set -e the run dies there.
utc_days_ago() {
  if date --version >/dev/null 2>&1; then
    date -u -d "$1 days ago" +%Y-%m-%d
  else
    date -u -v-"$1"d +%Y-%m-%d
  fi
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

# Put-Up (V4-HARVESTCENTER-001). Both staging Lambdas existed but were never referenced by
# deploy-staging.yml, so staging builds baked VITE_API_PRESERVATION="" and the surface was dead on
# staging while healthy in prod — invisible precisely because nothing checked it. Guarded so this
# stays a graceful skip if the vars are ever unset, matching the ux-events pattern above.
if [[ -n "${STAGING_API_PRESERVATION:-}" ]]; then
  check_reachable "lambda:preservation" "$STAGING_API_PRESERVATION"
else
  echo "   (preservation reachability skipped — STAGING_API_PRESERVATION unset)"
fi
if [[ -n "${STAGING_API_STORAGE_LOCATIONS:-}" ]]; then
  check_reachable "lambda:storage-locations" "$STAGING_API_STORAGE_LOCATIONS"
else
  echo "   (storage-locations reachability skipped — STAGING_API_STORAGE_LOCATIONS unset)"
fi
echo ""

# ── Phase 2: Authenticated CRUD ──────────────────────────────────────────────
if [[ -z "${CLERK_SECRET_KEY_STAGING:-}" ]] || [[ -z "${CLERK_TEST_USER_ID:-}" ]]; then
  echo "--- Phase 2: Authenticated CRUD --- SKIPPED"
  echo "   (Set GHA secrets CLERK_SECRET_KEY_STAGING and CLERK_TEST_USER_ID to enable)"
  echo "   See: regression-testing-plan.md → Dave Action Items"
  # WS-B M3 (fail-closed): when the CI smoke job requires auth (SMOKE_REQUIRE_AUTH=1), a
  # missing staging Clerk secret must FAIL, not vacuously pass on Phase-1 reachability
  # alone. Local/dev runs (flag unset) keep the graceful skip.
  if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
    echo "FATAL [fail-closed, WS-B M3]: SMOKE_REQUIRE_AUTH=1 but a Clerk staging secret is unset — the write-path gate cannot pass on reachability alone."
    exit 1
  fi
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
    if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
      echo "FATAL [fail-closed, WS-B M3]: SMOKE_REQUIRE_AUTH=1 but the Clerk session could not be minted (HTTP $SESS_CODE) — write-path unverified."
      exit 1
    fi
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
    if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
      echo "FATAL [fail-closed, WS-B M3]: SMOKE_REQUIRE_AUTH=1 but no valid 3-part session JWT (got ${JWT_PARTS}-part) — write-path unverified."
      exit 1
    fi
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
      BARE_DATE=$(utc_days_ago 7)
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

      # ── E) Events PUT metadata has-key round-trip (V4-WATERMATH-001 F0 edit half, L-108) ────
      # The PUT metadata arm landed 2026-08-12: an explicit object REPLACES the column, an ABSENT
      # key PRESERVES it (the stale-PWA-bundle clobber class, cf. BUG-EVENTEDITFIELDS-001), and
      # the stored value reads back on GET. Reuses block C's event. NOTE: notes is full-replace
      # legacy grammar on PUT, so both PUTs re-send it deliberately. water_depth vocabulary is
      # the edge whitelist in lambda/events/validators.js ('light'|'normal'|'deep' / 'user'|'default');
      # the l108_marker key rides the historic pass-through and gives a run-unique preserve assert.
      # The PUT contract REQUIRES event_type on every body (full-replace legacy grammar — real
      # callers always send the full set; a body without it 400s before the metadata arm runs).
      # First version of this block omitted it AND redirected auth_request to /dev/null, so the
      # 400s were invisible and the read-backs failed with no evidence — hence: event_type present,
      # and the PUT result lines left VISIBLE in the log.
      if [[ -n "${CREATED_EVENT_ID:-}" ]]; then
        CLERK_JWT=$(mint_session_token)
        auth_request "write:PUT /events/$CREATED_EVENT_ID metadata" \
          "${STAGING_API_EVENTS%/}/api/events/${CREATED_EVENT_ID}" "PUT" \
          "{\"event_type\": \"observation\", \"notes\": \"CI smoke — safe to delete\", \"metadata\": {\"water_depth\": \"deep\", \"water_depth_source\": \"user\", \"l108_marker\": \"$TEST_RUN_ID\"}}" || true
        assert_readback "write:event-metadata-readback" \
          "${STAGING_API_EVENTS%/}/api/events/${CREATED_EVENT_ID}" ".metadata.water_depth" "deep"
        # Metadata-FREE PUT must NOT clobber the stored object (has-key: absent preserves).
        auth_request "write:PUT /events/$CREATED_EVENT_ID no-metadata" \
          "${STAGING_API_EVENTS%/}/api/events/${CREATED_EVENT_ID}" "PUT" \
          "{\"event_type\": \"observation\", \"notes\": \"CI smoke — metadata-free edit\"}" || true
        assert_readback "write:event-metadata-preserved-on-absent-key" \
          "${STAGING_API_EVENTS%/}/api/events/${CREATED_EVENT_ID}" ".metadata.l108_marker" "$TEST_RUN_ID"
      else
        echo "⚠ SKIP [write:event-metadata] block C event unavailable"
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
          # BUG-VARIETIESLIMIT500-001: the list GET runs `LIMIT ${VARIETY_LIST_CAP}::int` (it was a
          # literal 500 against 495 prod cultivars, sorted by name, so an "s…" name was the first to
          # fall off). The variety just created must be IN the full list.
          VLIST=$(mktemp)
          VLIST_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$VLIST" -w "%{http_code}" "${STAGING_API_VARIETIES%/}/api/varieties") || VLIST_HTTP="000"
          VLIST_HAS=$(jq -r --arg id "$CREATED_VARIETY_ID" 'if type == "array" then ([.[] | select(.id == $id)] | length > 0) else "not-an-array" end' "$VLIST" 2>/dev/null || echo "unparseable")
          VLIST_N=$(jq -r 'if type == "array" then length else 0 end' "$VLIST" 2>/dev/null || echo 0)
          rm -f "$VLIST"
          if [[ "${VLIST_HTTP:0:1}" == "2" && "$VLIST_HAS" == "true" ]]; then
            echo "✅ PASS [read:varieties-list] HTTP $VLIST_HTTP, $VLIST_N cultivars, the new one among them"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [read:varieties-list] HTTP $VLIST_HTTP, $VLIST_N cultivars, new one listed: $VLIST_HAS"
            FAIL=$((FAIL+1))
          fi
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
          # D-profile) the variety POST's OTHER write → SQL read-back (OPS-SMOKECAREPROFILE-001, L-108).
          # Since v4.137 the create also INSERTs a cultivar-scope care_profile in the cultivar's own
          # transaction (BUG-CULTIVARNOPROFILE-001, NEW_CULTIVAR_PROFILE in lambda/varieties/index.js). No
          # API route returns that row, so it is read on the staging DSN the workflow's L-058 sweep uses.
          # Expect exactly one row for THIS variety id, still carrying the 'unresearched' sentinel: "1/1".
          # "0/0" = the INSERT is gone or bound to another id; "0/1" = the row lost its sentinel. The id
          # goes in as a psql variable (stdin + :'vid'); psql does not interpolate variables in -c text.
          # Placed after the plant asserts so the DB round trip sits outside their ~60s token window.
          # The row itself is hard-deleted by the sweep, before plant_varieties.
          if [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
            CP_GOT=$(psql "$NEON_STAGING_URL" -X -At -v ON_ERROR_STOP=1 -v vid="$CREATED_VARIETY_ID" \
              <<< "SELECT COUNT(*) FILTER (WHERE profile->>'_basis' = 'unresearched') || '/' || COUNT(*) FROM care_profile WHERE scope = 'cultivar' AND scope_id = :'vid'::uuid;") \
              || CP_GOT="psql-exit-$?"
            if [[ "$CP_GOT" == "1/1" ]]; then
              echo "✅ PASS [write:variety-care-profile-readback] one cultivar care_profile for $CREATED_VARIETY_ID, _basis=unresearched"
              PASS=$((PASS+1))
            else
              echo "❌ FAIL [write:variety-care-profile-readback] expected '1/1' (unresearched/all cultivar rows for $CREATED_VARIETY_ID), got '$CP_GOT'"
              FAIL=$((FAIL+1))
            fi
          elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
            echo "❌ FAIL [write:variety-care-profile-readback] NEON_STAGING_URL unset or psql missing — the ship gate may not skip this assert"
            FAIL=$((FAIL+1))
          else
            echo "⚠️  WARN [write:variety-care-profile-readback] NEON_STAGING_URL unset or psql missing — care_profile read-back NOT run"
          fi
          # D-facts) the variety PUT → GET /:id read-back (V5-VARIETYFACTSEDIT-001, L-108). The PUT is the
          # only writer of the variety facts (origin, breeding, heat source) and GET /api/varieties/:id is
          # the read VarietyEditor seeds from; until this block the smoke called neither route. A run-unique
          # origin_country goes in through the PUT and must come back out of the by-id GET, so a PASS also
          # proves that GET answers 200 with the row. The PUT's result line stays VISIBLE (block E's lesson:
          # a silenced 400 leaves no evidence). Same throwaway variety, name unchanged, so the cleanup
          # DELETE above and the workflow's L-058 name sweep still remove it.
          CLERK_JWT=$(mint_session_token)
          VAR_ORIGIN="smoke-origin-$TEST_RUN_ID"
          auth_request "write:PUT /varieties/$CREATED_VARIETY_ID origin_country" \
            "${STAGING_API_VARIETIES%/}/api/varieties/${CREATED_VARIETY_ID}" "PUT" \
            "{\"origin_country\": \"$VAR_ORIGIN\"}" || true
          assert_readback "write:variety-origin-readback" \
            "${STAGING_API_VARIETIES%/}/api/varieties/${CREATED_VARIETY_ID}" ".origin_country" "$VAR_ORIGIN"
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

          # ── F2) The list's new row shape → wide PUT round-trip (V5-SEEDCARDS-001) ─────────────
          # Every list GET now carries the derived hero (hero_photo_id) and the cultivar facts, and
          # the client PUTs a LIST row back whole (Inventory's stepper, quantityAdjuster.js). Prove on
          # staging's real schema that the row just created carries the new keys, that the exact
          # row PUT back is accepted, and that the seeds list — which joins scoville_source and, since
          # BUG-SEEDLISTSIGNING-001, signs no photo URL at all — answers 200.
          INV_LIST=$(mktemp)
          INV_LIST_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$INV_LIST" -w "%{http_code}" "${STAGING_API_INVENTORY%/}/api/inventory-items") || INV_LIST_HTTP="000"
          INV_ROW=$(jq -c --arg id "$CREATED_INV_ID" '[.[] | select(.id == $id)][0] // empty' "$INV_LIST" 2>/dev/null || echo "")
          rm -f "$INV_LIST"
          if [[ "${INV_LIST_HTTP:0:1}" == "2" && -n "$INV_ROW" ]] \
             && echo "$INV_ROW" | jq -e 'has("hero_photo_id") and has("scoville_source") and has("variety_source_url")' >/dev/null 2>&1; then
            echo "✅ PASS [read:inventory-list-shape] the new row carries hero_photo_id, scoville_source, variety_source_url"
            PASS=$((PASS+1))
            ROW_PUT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
              -X PUT -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
              -o /dev/null -w "%{http_code}" "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_INV_ID}" \
              -d "$INV_ROW") || ROW_PUT_HTTP="000"
            if [[ "${ROW_PUT_HTTP:0:1}" == "2" ]]; then
              echo "✅ PASS [write:inventory-list-row-put] the list row PUT back whole → HTTP $ROW_PUT_HTTP"
              PASS=$((PASS+1))
              assert_readback "write:inventory-list-row-put-name" \
                "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_INV_ID}" ".name" "smoke-test-inv-$TEST_RUN_ID"
            else
              echo "❌ FAIL [write:inventory-list-row-put] the list row PUT back whole → HTTP $ROW_PUT_HTTP"
              FAIL=$((FAIL+1))
            fi
          else
            echo "❌ FAIL [read:inventory-list-shape] HTTP $INV_LIST_HTTP; row: ${INV_ROW:0:200}"
            FAIL=$((FAIL+1))
          fi
          SEEDS_LIST=$(mktemp)
          SEEDS_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$SEEDS_LIST" -w "%{http_code}" "${STAGING_API_INVENTORY%/}/api/inventory-items?category=seeds") || SEEDS_HTTP="000"
          SEEDS_N=$(jq -r 'if type == "array" then length else "not-an-array" end' "$SEEDS_LIST" 2>/dev/null || echo "unparseable")
          rm -f "$SEEDS_LIST"
          if [[ "${SEEDS_HTTP:0:1}" == "2" && "$SEEDS_N" =~ ^[0-9]+$ ]]; then
            echo "✅ PASS [read:seeds-list] HTTP $SEEDS_HTTP, $SEEDS_N row(s) (the ?category=seeds branch, which signs no photo URL)"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [read:seeds-list] HTTP $SEEDS_HTTP, body: $SEEDS_N"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [crud:POST /inventory-items] HTTP $INV_HTTP"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:inventory] STAGING_API_INVENTORY unset — inventory assert NOT run (the staging workflow sets it)"
      fi

      # ── F3) Seed packet → a planting sown from it → the packet's sown_from (V5-SEEDSTAB-001 slice 3, L-108) ──
      # GET /api/inventory-items/:id on a SEEDS row runs two garden_node reads beside the item: germination and,
      # since slice 3, sown_from (it also joins container). BUG-SEEDDETAIL500-001 was a seed-detail SELECT naming a
      # column garden_node does not have: every seed page 500'd in prod behind a green unit suite. Staging holds NO
      # planting that references an inventory item (0 on 2026-09-23), so a bare GET would pass on an empty list
      # whatever the join did; this block builds its own row. A seeds packet on block D's variety (seeds require
      # one), a planting sown from it under the test project, then the packet's detail must answer 200 with that
      # planting — its id AND the name written — inside sown_from. Both rows are 'smoke-test-*': the trap's API
      # deletes and the workflow's L-058 sweep remove them, plants before inventory_items (RESTRICT).
      if [[ -n "${STAGING_API_INVENTORY:-}" && -n "${CREATED_VARIETY_ID:-}" ]]; then
        CLERK_JWT=$(mint_session_token)
        SEEDPKT_BODY=$(mktemp)
        SEEDPKT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$SEEDPKT_BODY" -w "%{http_code}" "$STAGING_API_INVENTORY" \
          -d "{\"name\": \"smoke-test-seedpkt-$TEST_RUN_ID\", \"type\": \"consumable\", \"category\": \"seeds\", \"unit\": \"packet\", \"quantity_on_hand\": 1, \"variety_id\": \"$CREATED_VARIETY_ID\"}") || SEEDPKT_HTTP="000"
        CREATED_SEEDPKT_ID=$(jq -r '.id // empty' "$SEEDPKT_BODY" 2>/dev/null || echo "")
        rm -f "$SEEDPKT_BODY"
        if [[ "${SEEDPKT_HTTP:0:1}" == "2" && -n "$CREATED_SEEDPKT_ID" ]]; then
          echo "✅ PASS [crud:POST /inventory-items (seed packet)] HTTP $SEEDPKT_HTTP (id: $CREATED_SEEDPKT_ID)"
          PASS=$((PASS+1))
          SOWN_NAME_WRITTEN="smoke-test-sownplant-$TEST_RUN_ID"
          SOWN_BODY=$(mktemp)
          SOWN_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$SOWN_BODY" -w "%{http_code}" "$STAGING_API_PLANTS" \
            -d "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"$SOWN_NAME_WRITTEN\", \"variety_id\": \"$CREATED_VARIETY_ID\", \"source_inventory_item_id\": \"$CREATED_SEEDPKT_ID\", \"sown_at\": \"$(utc_days_ago 7)\", \"status\": \"seedling\"}") || SOWN_HTTP="000"
          CREATED_SOWN_PLANT_ID=$(jq -r '.id // empty' "$SOWN_BODY" 2>/dev/null || echo "")
          rm -f "$SOWN_BODY"
          if [[ "${SOWN_HTTP:0:1}" == "2" && -n "$CREATED_SOWN_PLANT_ID" ]]; then
            echo "✅ PASS [crud:POST /plants (sown from the packet)] HTTP $SOWN_HTTP (id: $CREATED_SOWN_PLANT_ID)"
            PASS=$((PASS+1))
            DETAIL_BODY=$(mktemp)
            DETAIL_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
              -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
              -o "$DETAIL_BODY" -w "%{http_code}" \
              "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || DETAIL_HTTP="000"
            # The name stored for the planting sown from this packet, read back out of sown_from — "absent"
            # when the planting is not listed, "no-sown_from:<type>" when the key itself is missing or wrong.
            SOWN_NAME_READ=$(jq -r --arg id "$CREATED_SOWN_PLANT_ID" \
              'if (.sown_from | type) == "array" then ([.sown_from[] | select(.id == $id) | .name][0] // "absent") else "no-sown_from:" + (.sown_from | type) end' \
              "$DETAIL_BODY" 2>/dev/null || echo "unparseable")
            DETAIL_SNIP=$(head -c 200 "$DETAIL_BODY" 2>/dev/null || echo "")
            rm -f "$DETAIL_BODY"
            if [[ "$DETAIL_HTTP" == "200" && "$SOWN_NAME_READ" == "$SOWN_NAME_WRITTEN" ]]; then
              echo "✅ PASS [write:seed-detail-sown-from] HTTP 200, planting $CREATED_SOWN_PLANT_ID is in the packet's sown_from as '$SOWN_NAME_READ'"
              PASS=$((PASS+1))
              # ── F3b) Archive-Hiding on the deployed stack: archive that planting through the app's own route,
              # re-GET the packet, and the planting must be GONE from sown_from (the route filters archived rows
              # in SQL; until now only the CI integration test proved it). Runs only after F3 proved the planting
              # present, so "absent" means hidden, never "was not listed"; a sown_from that is not an array (the
              # Lambda answers null when its read fails) is a FAIL, never "absent". Cleanup is unchanged: the
              # trap's DELETE soft-deletes an archived planting (its UPDATE has no archived_at test), and the
              # L-058 sweep hard-deletes plants by name, archived or not.
              CLERK_JWT=$(mint_session_token)
              ARCH_BODY=$(mktemp)
              ARCH_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
                -X PATCH -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                -o "$ARCH_BODY" -w "%{http_code}" \
                "${STAGING_API_PLANTS%/}/api/plants/${CREATED_SOWN_PLANT_ID}/archive" -d '{"archived": true}') || ARCH_HTTP="000"
              ARCH_AT=$(jq -r '.archived_at // empty' "$ARCH_BODY" 2>/dev/null || echo "")
              rm -f "$ARCH_BODY"
              if [[ "${ARCH_HTTP:0:1}" == "2" && -n "$ARCH_AT" ]]; then
                echo "✅ PASS [crud:PATCH /plants/:id/archive (sown planting)] HTTP $ARCH_HTTP (archived_at: $ARCH_AT)"
                PASS=$((PASS+1))
                HIDDEN_BODY=$(mktemp)
                HIDDEN_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
                  -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                  -o "$HIDDEN_BODY" -w "%{http_code}" \
                  "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || HIDDEN_HTTP="000"
                # "absent" only from a real array that does not list the id; "listed" if it still does.
                SOWN_AFTER_ARCHIVE=$(jq -r --arg id "$CREATED_SOWN_PLANT_ID" \
                  'if (.sown_from | type) == "array" then (if any(.sown_from[]; .id == $id) then "listed" else "absent" end) else "no-sown_from:" + (.sown_from | type) end' \
                  "$HIDDEN_BODY" 2>/dev/null || echo "unparseable")
                HIDDEN_SNIP=$(head -c 200 "$HIDDEN_BODY" 2>/dev/null || echo "")
                rm -f "$HIDDEN_BODY"
                if [[ "$HIDDEN_HTTP" == "200" && "$SOWN_AFTER_ARCHIVE" == "absent" ]]; then
                  echo "✅ PASS [write:seed-detail-sown-from-archived-hidden] HTTP 200, archived planting $CREATED_SOWN_PLANT_ID is gone from the packet's sown_from"
                  PASS=$((PASS+1))
                  # ── F3c) The packet's delete is REFUSED while a planting sown from it exists, archived or
                  # not (BUG-INVREFSTRAND-001, option C). The planting above is archived now, so this is the
                  # case Dave decided: DELETE must answer 409 with the sentence the page shows, and must
                  # write nothing — the packet still reads back 200 (L-108: a 409 that deleted anyway would
                  # strand the planting and say nothing). F3d below then deletes both rows through the API;
                  # the L-058 sweep hard-deletes them either way.
                  CLERK_JWT=$(mint_session_token)
                  DEL_BODY=$(mktemp)
                  DEL_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
                    -X DELETE -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                    -o "$DEL_BODY" -w "%{http_code}" \
                    "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || DEL_HTTP="000"
                  DEL_ERROR=$(jq -r '.error // empty' "$DEL_BODY" 2>/dev/null || echo "")
                  rm -f "$DEL_BODY"
                  DEL_EXPECTED="This packet can't be removed: 1 archived planting was sown from it. To mark it used up, set its Status to \"depleted\" instead."
                  KEPT_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
                    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                    -o /dev/null -w "%{http_code}" \
                    "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || KEPT_HTTP="000"
                  if [[ "$DEL_HTTP" == "409" && "$DEL_ERROR" == "$DEL_EXPECTED" && "$KEPT_HTTP" == "200" ]]; then
                    echo "✅ PASS [write:inventory-delete-refused-when-sown] HTTP 409 with the sentence; the packet still reads back 200"
                    PASS=$((PASS+1))
                  else
                    echo "❌ FAIL [write:inventory-delete-refused-when-sown] DELETE HTTP $DEL_HTTP, error '$DEL_ERROR' (expected 409 + '$DEL_EXPECTED'); the packet's GET afterwards HTTP $KEPT_HTTP (expected 200)"
                    FAIL=$((FAIL+1))
                  fi
                  # ── F3d) The ALLOWED half of the same DELETE, on the deployed stack (pre-promote review M-3,
                  # L-108). F3c proves the refusal; the shape the Sept-8 guard broke was the other half, a
                  # delete that should go through (Snap's Undo). Delete the sown planting (the plants DELETE
                  # soft-deletes an archived row too) → 200. Now nothing live was sown from the packet, so its
                  # DELETE must answer 200 with the route's success body {"ok":true}, and the packet must read
                  # back 404. Both routes answer {"ok":true} on success (lambda/plants/index.js and
                  # lambda/inventory-items/index.js, the DELETE arms). Each id is cleared once its own DELETE
                  # is confirmed, so the trap does not repeat it; one that was not confirmed is left for the
                  # trap, and the L-058 sweep hard-deletes both rows either way.
                  CLERK_JWT=$(mint_session_token)
                  UNSOW_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
                    -X DELETE -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                    -o /dev/null -w "%{http_code}" \
                    "${STAGING_API_PLANTS%/}/api/plants/${CREATED_SOWN_PLANT_ID}") || UNSOW_HTTP="000"
                  if [[ "$UNSOW_HTTP" == "200" ]]; then CREATED_SOWN_PLANT_ID=""; fi
                  PKTDEL_BODY=$(mktemp)
                  PKTDEL_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
                    -X DELETE -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                    -o "$PKTDEL_BODY" -w "%{http_code}" \
                    "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || PKTDEL_HTTP="000"
                  if jq -e '. == {"ok": true}' "$PKTDEL_BODY" >/dev/null 2>&1; then PKTDEL_OK="yes"; else PKTDEL_OK="no"; fi
                  PKTDEL_SNIP=$(head -c 200 "$PKTDEL_BODY" 2>/dev/null || echo "")
                  rm -f "$PKTDEL_BODY"
                  GONE_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
                    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
                    -o /dev/null -w "%{http_code}" \
                    "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDPKT_ID}") || GONE_HTTP="000"
                  if [[ "$PKTDEL_HTTP" == "200" ]]; then CREATED_SEEDPKT_ID=""; fi
                  if [[ "$UNSOW_HTTP" == "200" && "$PKTDEL_HTTP" == "200" && "$PKTDEL_OK" == "yes" && "$GONE_HTTP" == "404" ]]; then
                    echo "✅ PASS [write:inventory-delete-allowed-once-unsown] planting DELETE 200; packet DELETE 200 {\"ok\":true}; the packet then reads back 404"
                    PASS=$((PASS+1))
                  else
                    echo "❌ FAIL [write:inventory-delete-allowed-once-unsown] planting DELETE HTTP $UNSOW_HTTP (expected 200); packet DELETE HTTP $PKTDEL_HTTP body '$PKTDEL_SNIP' (expected 200 {\"ok\":true}); the packet's GET afterwards HTTP $GONE_HTTP (expected 404)"
                    FAIL=$((FAIL+1))
                  fi
                else
                  echo "❌ FAIL [write:seed-detail-sown-from-archived-hidden] HTTP $HIDDEN_HTTP, archived planting $CREATED_SOWN_PLANT_ID in sown_from: '$SOWN_AFTER_ARCHIVE' (expected 'absent')"
                  echo "   Body: $HIDDEN_SNIP"
                  FAIL=$((FAIL+1))
                fi
              else
                echo "❌ FAIL [crud:PATCH /plants/:id/archive (sown planting)] HTTP $ARCH_HTTP, archived_at: '$ARCH_AT'"
                FAIL=$((FAIL+1))
              fi
            else
              echo "❌ FAIL [write:seed-detail-sown-from] HTTP $DETAIL_HTTP, sown_from entry for $CREATED_SOWN_PLANT_ID: '$SOWN_NAME_READ' (expected '$SOWN_NAME_WRITTEN')"
              echo "   Body: $DETAIL_SNIP"
              FAIL=$((FAIL+1))
            fi
          else
            echo "❌ FAIL [crud:POST /plants (sown from the packet)] HTTP $SOWN_HTTP"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [crud:POST /inventory-items (seed packet)] HTTP $SEEDPKT_HTTP"
          FAIL=$((FAIL+1))
        fi
      elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
        echo "❌ FAIL [write:seed-detail-sown-from] STAGING_API_INVENTORY unset or block D made no variety — the ship gate may not skip this assert"
        FAIL=$((FAIL+1))
      else
        echo "⚠️  WARN [write:seed-detail-sown-from] STAGING_API_INVENTORY unset or no variety from block D — sown_from assert NOT run"
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

      # ── J) Critter routes — retirement contract + surviving read surface ─────────────
      # POST /api/critters was RETIRED on 2026-08-12 (BUG-CRITTERAPIUNGATED-001): it granted a
      # critter_state row for ANY event with no event_type gate and no roll, and the CALLER
      # picked the species. Awards now come ONLY from the server-side hook on POST /events
      # (deterministic_seed, pickSpecies, NON_REWARD-gated) — a seeded roll, so a single event
      # does NOT deterministically create a row and no assert here may demand one.
      # This section now asserts the retirement HOLDS (a resurrected unsafe route = FAIL) and
      # that the surviving read surface stays healthy.
      if [[ -n "${STAGING_API_CRITTERS:-}" && "$STAGING_API_CRITTERS" != *placeholder* ]]; then
        if [[ -n "$CREATED_PLANT_ID" ]]; then
          CLERK_JWT=$(mint_session_token)
          # Step 1: a plant-anchored event still writes cleanly (the hook's entry path).
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
          else
            echo "❌ FAIL [crud:POST /events (critter source)] HTTP $C_EV_HTTP"
            FAIL=$((FAIL+1))
          fi

          # Step 2: the retired route must STAY retired — 404, no critter row, no id.
          C_BODY=$(mktemp)
          C_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$C_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters" \
            -d "{\"source_event_id\": \"$CRITTER_SRC_EVENT_ID\", \"plant_id\": \"$CREATED_PLANT_ID\", \"species_id\": 255}") || C_HTTP="000"
          C_RETIRED_ID=$(jq -r '.critter.id // empty' "$C_BODY" 2>/dev/null || echo "")
          rm -f "$C_BODY"
          if [[ "$C_HTTP" == "404" && -z "$C_RETIRED_ID" ]]; then
            echo "✅ PASS [retire:POST /critters stays 404] caller-picks-species route is gone"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [retire:POST /critters stays 404] HTTP $C_HTTP id=$C_RETIRED_ID — the ungated award route is BACK (BUG-CRITTERAPIUNGATED-001)"
            FAIL=$((FAIL+1))
          fi

          # Step 3: surviving read surface — collection GET stays 200 with array shape.
          # No count assertion: hook awards are a seeded roll, so row existence is not
          # deterministic from one smoke event.
          C_COL_BODY=$(mktemp)
          C_COL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X GET -H "Authorization: Bearer $CLERK_JWT" \
            -o "$C_COL_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters/collection") || C_COL_HTTP="000"
          C_COL_SHAPE=$(jq -r '(.species | type) // "missing"' "$C_COL_BODY" 2>/dev/null || echo "missing")
          C_COL_LEN=$(jq -r '(.species | length) // 0' "$C_COL_BODY" 2>/dev/null || echo "0")
          rm -f "$C_COL_BODY"
          if [[ "$C_COL_HTTP" == "200" && "$C_COL_SHAPE" == "array" ]]; then
            echo "✅ PASS [read:critter-collection] HTTP $C_COL_HTTP species[]=array len=$C_COL_LEN"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [read:critter-collection] HTTP $C_COL_HTTP shape=$C_COL_SHAPE"
            FAIL=$((FAIL+1))
          fi

          # Step 4: active-critters read stays healthy too (Garden ambient surface reads it).
          C_ACT_BODY=$(mktemp)
          C_ACT_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X GET -H "Authorization: Bearer $CLERK_JWT" \
            -o "$C_ACT_BODY" -w "%{http_code}" "${STAGING_API_CRITTERS%/}/api/critters/active") || C_ACT_HTTP="000"
          rm -f "$C_ACT_BODY"
          if [[ "$C_ACT_HTTP" == "200" ]]; then
            echo "✅ PASS [read:critters-active] HTTP $C_ACT_HTTP"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [read:critters-active] HTTP $C_ACT_HTTP"
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
      # Every write-path block above (A-K, F3 included) hangs off this project id, so this branch skips all
      # of them. Under the ship gate that is a FAIL, like a missing Clerk secret, never a pass on
      # reachability plus one bare 2xx (pre-ship QA, smoke fail-closed completeness).
      if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
        echo "❌ FAIL [crud:POST /projects] HTTP $CREATE_HTTP with no id — every write-path assert was skipped, and SMOKE_REQUIRE_AUTH=1 may not skip them"
        FAIL=$((FAIL+1))
      fi
    fi
  else
    echo "❌ FAIL [crud:POST /projects] HTTP $CREATE_HTTP"
    echo "   Body: ${CREATE_RESPONSE:0:200}"
    FAIL=$((FAIL+1))
  fi
fi


# ── L) Per-person nav prefs write → read-back (V5-NAVCUSTOM-001; L-108) — Phase 2, continued ──────
# more_pins and bar_layout through PATCH /api/notifications/prefs on the critter Lambda, each read back
# through GET, plus the GET's computed can_edit_bar. Independent of the test project: the write goes to
# the smoke account's OWN prefs row (self-scoped, not admin-gated), so it needs no fixture and no admin.
# garden-critter-staging carries no ADMIN_CLERK_SUBS, so can_edit_bar is false there and only its TYPE
# is asserted. Needs migrations/v5-navcustom-001 applied on staging: the critter SELECT names both columns.
#
# Values are chosen to DIFFER from what the first GET returned (a run-unique pin id; the second layout
# when the first is already stored), so a leftover from a run that died mid-block cannot make a read-back
# pass vacuously. The second read-back also checks the pins survived a bar_layout-only PATCH (an absent
# key leaves the stored value alone).
#
# RESTORE: more_pins [] and the shipped default bar_layout, NOT NULL. A PATCH cannot write NULL back
# (null means "unchanged": the route merges with COALESCE), and [] and the default object mean exactly
# what NULL means to every reader (no pins; the shipped bar). The restore runs whether or not the asserts
# passed, and cleanup() repeats it best-effort if the run dies in between (NAVP_DIRTY).
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_CRITTERS:-}" && "$STAGING_API_CRITTERS" != *placeholder* ]]; then
  NAVP_URL="${STAGING_API_CRITTERS%/}/api/notifications/prefs"
  navp_patch() {                      # navp_patch <json-body> -> prints the HTTP status
    local code
    code=$(curl -s --max-time 30 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o /dev/null -w "%{http_code}" "$NAVP_URL" -d "$1") || code="000"
    echo "$code"
  }
  navp_get() {                        # navp_get <jq-filter> -> the filtered GET body, keys sorted, compact
    local body
    body=$(curl -s --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" "$NAVP_URL") || body=""
    echo "$body" | jq -S -c "$1" 2>/dev/null || echo "unreadable"
  }
  CLERK_JWT=$(mint_session_token)

  # L0) Read first: the GET answers 200 and carries all three fields before anything is written.
  NAVP_B=$(mktemp)
  NAVP_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
    -o "$NAVP_B" -w "%{http_code}" "$NAVP_URL") || NAVP_HTTP="000"
  NAVP_BEFORE=$(cat "$NAVP_B" 2>/dev/null || echo ""); rm -f "$NAVP_B"
  NAVP_SHAPE=$(echo "$NAVP_BEFORE" | jq -r '[(.can_edit_bar | type), has("more_pins"), has("bar_layout")] | map(tostring) | join(",")' 2>/dev/null || echo "unparseable")
  if [[ "$NAVP_HTTP" == "200" && "$NAVP_SHAPE" == "boolean,true,true" ]]; then
    echo "✅ PASS [read:prefs-nav-fields] HTTP 200, can_edit_bar is a boolean ($(echo "$NAVP_BEFORE" | jq -c '.can_edit_bar')), more_pins + bar_layout present"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [read:prefs-nav-fields] HTTP $NAVP_HTTP shape=$NAVP_SHAPE (expected 200 and boolean,true,true)"
    echo "   Body: ${NAVP_BEFORE:0:200}"
    FAIL=$((FAIL+1))
  fi

  NAVP_PIN_ID="smoke-$(echo "$TEST_RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-8)"
  NAVP_PINS=$(jq -c -n --arg id "$NAVP_PIN_ID" '["seeds", "photos", $id]')
  NAVP_LAYOUT_A='{"order":["today","garden","create","harvests","put-up"],"hidden":["put-up"]}'
  NAVP_LAYOUT_B='{"order":["today","harvests","create","garden","put-up"],"hidden":["garden"]}'
  if [[ "$(echo "$NAVP_BEFORE" | jq -S -c '.bar_layout' 2>/dev/null)" == "$(echo "$NAVP_LAYOUT_A" | jq -S -c .)" ]]; then
    NAVP_LAYOUT="$NAVP_LAYOUT_B"
  else
    NAVP_LAYOUT="$NAVP_LAYOUT_A"
  fi
  NAVP_LAYOUT_NORM=$(echo "$NAVP_LAYOUT" | jq -S -c .)
  NAVP_DIRTY=true

  # L1) more_pins → GET → equal.
  NAVP_CODE=$(navp_patch "{\"more_pins\": $NAVP_PINS}")
  NAVP_GOT=$(navp_get '.more_pins')
  if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "$NAVP_PINS" ]]; then
    echo "✅ PASS [write:prefs-more-pins-readback] read-back == $NAVP_PINS"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [write:prefs-more-pins-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected $NAVP_PINS)"
    FAIL=$((FAIL+1))
  fi

  # L2) bar_layout → GET → equal, and the pins from L1 still stored (the key was absent from this PATCH).
  CLERK_JWT=$(mint_session_token)
  NAVP_CODE=$(navp_patch "{\"bar_layout\": $NAVP_LAYOUT}")
  NAVP_GOT=$(navp_get '[.bar_layout, .more_pins]')
  if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "[$NAVP_LAYOUT_NORM,$NAVP_PINS]" ]]; then
    echo "✅ PASS [write:prefs-bar-layout-readback] read-back == $NAVP_LAYOUT_NORM, pins untouched"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [write:prefs-bar-layout-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected [$NAVP_LAYOUT_NORM,$NAVP_PINS])"
    FAIL=$((FAIL+1))
  fi

  # L3) Restore, and read it back: [] must CLEAR the pins (the trap is sending null, which keeps them).
  NAVP_DEFAULT_LAYOUT='{"order":["today","garden","create","harvests","put-up"],"hidden":[]}'
  CLERK_JWT=$(mint_session_token)
  NAVP_CODE=$(navp_patch "{\"more_pins\": [], \"bar_layout\": $NAVP_DEFAULT_LAYOUT}")
  [[ "${NAVP_CODE:0:1}" == "2" ]] && NAVP_DIRTY=false
  NAVP_GOT=$(navp_get '[.more_pins, .bar_layout]')
  NAVP_WANT="[[],$(echo "$NAVP_DEFAULT_LAYOUT" | jq -S -c .)]"
  if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "$NAVP_WANT" ]]; then
    echo "✅ PASS [write:prefs-nav-restore-readback] smoke account back to no pins and the shipped bar"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [write:prefs-nav-restore-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected $NAVP_WANT)"
    FAIL=$((FAIL+1))
  fi
else
  echo "⚠️  WARN [write:prefs-nav] STAGING_API_CRITTERS unset/placeholder or no JWT — nav prefs asserts NOT run"
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
