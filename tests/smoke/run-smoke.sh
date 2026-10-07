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
#     F3) a seed packet (on block D's variety), found through GET /api/search as a seeds row
#        (F3-search, BUG-SEARCHSEEDCAP20-001) → a planting sown from it → the packet's detail GET
#        answers 200 with that planting inside sown_from (V5-SEEDSTAB-001 slice 3); then that planting
#        archived through PATCH /api/plants/:id/archive → the packet's sown_from no longer lists it
#        (F3b, Archive-Hiding on the deployed stack); then DELETE on the packet → 409 with the
#        "1 archived planting was sown from it" sentence, and the packet still reads back 200
#        (F3c, BUG-INVREFSTRAND-001: archived plantings still block a delete); then the planting
#        deleted → the packet's DELETE answers 200 {"ok":true} and the packet reads back 404
#        (F3d, the allowed half of the same DELETE)
#     G) favorites toggle → assert favorited on, then off
#     U) (right after G; needs block D's variety and planting) seed lots and their parent plantings
#        (V5-SEEDMULTIPARENT-001). First what every shipped client already sends, on a lot of its own: a create
#        with source_plant_id alone → one parent read back → the legacy PATCH /source-plant moving it, then
#        clearing it, each read back → PATCH /source-kind read back → a parent refused (400) on that gift lot →
#        its DELETE. Then a lot with TWO parents: POST with source_plant_ids → the detail GET lists both and
#        source_plant_id is one of them → GET /api/plants/:id/seed-lots lists the lot under the parent the column
#        does NOT hold → PUT
#        /source-plants to one parent, read back → both again, then the legacy PATCH /source-plant with an id and
#        with null, each 409 multi_parent_lot with the lot read back unchanged → DELETE on the lot → 200 (parents
#        never block it) and it reads back 404 → the second parent planting's DELETE → 200 → last, the link rows
#        read back through SQL (needs NEON_STAGING_URL + psql), still live on the deleted lot
#        Since release 2a (V5-VARIETYBLEND-001) both parents carry a variety, and U7 to U23 follow on rows of their own:
#        three lot POSTs refused by the parent rules → a MIX of two varieties made, found again, a lot filed under it →
#        its filing, plant count, a stale set (409), two seed_saved events, the stats row. Mints two tokens of its own.
#     L) a taught name (voice alias) for block D's variety → one use through PATCH /api/varieties/voice-aliases
#        → the GET reads its hit_count exactly one higher, with a last_used_at (BUG-VOICEALIASHITCOUNT-001)
#     M) (after the project blocks, independent of them) the smoke account's own nav prefs
#        (V5-NAVCUSTOM-001): PATCH more_pins, then bar_layout, on the critter Lambda, each read back
#        through GET, which must also carry a boolean can_edit_bar; then restored to [] and the shipped bar;
#        then garden_group_by 'crop_type' (Type) and 'bean_use' (a bean facet), each read back, then
#        restored (BUG-GARDENGROUPBYRESET-001: the two values the Lambda refused before)
#     P) Put-Up 1b + Ferment (06-ferment-path §5.6): P1 put-up date/basis + legacy-PUT refusal, P1b clearing a typed
#        discard date (the engine's date, then the recipe's on a batch that follows one), P2 salt line,
#        P3 draw → Mark used → RowEditor, P4 weighed draw to 0 g, P5 take out/restore, P6 check-in edit,
#        P7 SHU save, P8 Undo put-up restores grams, P9 batch removal restores the count, P10 Raw at create,
#        P11 a batch made from a jar that already exists (from-jars) and its replay, P12 that jar taken off the
#        batch and put back (the two outputs routes);
#        REQUIRED (a FAIL, never a WARN) whenever the checked-out tree carries migrations/v5-fermentpath-001; its own
#        FK-ordered hard-delete
#     Q) (after Put-Up's N, independent of the project) one fixed-name source (V5-SOURCECONTACT-001):
#        Instagram + Facebook links PATCHed and read back by id and in the list, a scheme-less link
#        refused 400 with nothing changed, then both cleared to null and read back
#     R) (right after D) GET /api/harvests/season-stats (V5-SEASONSTATS-001): envelope v1, the 8 sections
#        in page order, block D's planting counted, 400 on an unknown section
#     S) Pantry (B′ release 2; 05-release-train §5): a keyed pantry item → its replay → listed by place →
#        Used it up → unlisted → DELETE → 404 on a second DELETE; a Used one on a jar → Undo; a part of that jar gone
#        bad (a count, fate discarded) → still listed with what is left → Undo; then Put-Up R2a's S10 to S19: the
#        door's create (a size total, where it's from, Raw, In oil; a dried row's texture) → its replay; a dated,
#        weighed jar; the shipped form's rename → a re-kind refused (409, nothing written) → the date set by hand →
#        the same re-kind 200; /move clears a worked-out date; a re-kind over undated put-ups; Went bad, all that is
#        left → Undo; the jar PATCH's where-from pair; an as-is item's amount and where-from; the place's DELETE
#        refused while in use, then clean; REQUIRED whenever the tree carries migrations/v5-pantry-001; its own
#        FK-ordered hard-delete
#     T) Recipes (B′ release 4): 16 built-in types incl. "Sambal & chili relish" → a keyed recipe → GET (its line,
#        no pH field) → PATCH its lines (T3b) → DELETE → 404; REQUIRED whenever the tree carries
#        migrations/v5-recipes-001; own hard-delete
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
CREATED_SEEDLOT_ID=""
CREATED_SEEDLOT_LEGACY_ID=""
CREATED_SEEDPARENT_PLANT_ID=""
CREATED_SEEDMIX_LOT_ID=""
CREATED_SEEDPARENT3_PLANT_ID=""
CREATED_SEEDPARENT4_PLANT_ID=""
CREATED_SEEDVARIETY2_ID=""
CREATED_SEEDVARIETY3_ID=""
CREATED_SEEDMIX_VARIETY_ID=""
CREATED_FAVORITE_DONE=false
NAVP_DIRTY=false
NAVP_GB_DIRTY=false
NAVP_GB_RESTORE=""
SRC_ID=""
SRC_DIRTY=false
DATA_CREATED=false
CLERK_JWT=""
CLERK_SESSION_ID=""
PASS=0
FAIL=0

cleanup() {
  # Block P (Put-Up F): the run died between its first write and its own ferm_sweep. Hard-delete, FK order.
  if [[ "${FERM_DIRTY:-false}" == "true" ]]; then
    ferm_sweep >/dev/null 2>&1 && echo "✅ Cleanup: smoke-test-ferment rows hard-deleted" \
      || echo "WARNING: smoke-test-ferment sweep failed — rows labelled smoke-test-ferment-% may remain on staging"
  fi
  # Block S (Pantry, B′ release 2): the run died between its first write and its own pantry_sweep.
  if [[ "${PANTRY_DIRTY:-false}" == "true" ]]; then
    pantry_sweep >/dev/null 2>&1 && echo "✅ Cleanup: smoke-test-pantry rows hard-deleted" \
      || echo "WARNING: smoke-test-pantry sweep failed — rows named smoke-test-pantry-% may remain on staging"
  fi
  # Blocks P (P1b) and T (recipes, B′ release 4): the run died between a recipe's create and block T's recipes_sweep.
  # After ferm_sweep above, on purpose: P1b's batch names its recipe (kitchen_batch.recipe_id, NO ACTION).
  if [[ "${RECIPES_DIRTY:-false}" == "true" ]]; then
    recipes_sweep >/dev/null 2>&1 && echo "✅ Cleanup: smoke-test-recipe rows hard-deleted" \
      || echo "WARNING: smoke-test-recipe sweep failed — recipes named smoke-test-recipe-% may remain on staging"
  fi
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
    # Block U's pair: the saved-seed lot and its second parent planting (the first parent is block D's planting,
    # deleted above). Each id is cleared in the block once its own DELETE answers 200, so these run only when the
    # run died in between. Soft-deletes, in either order: a lot's parent links follow it and block nothing. No route
    # deletes a link row; the workflow's L-058 sweep hard-deletes them, ahead of the plantings and the lot.
    if [[ -n "$CREATED_SEEDLOT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDLOT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test seed lot deleted" \
        || echo "WARNING: seed lot cleanup failed (id: $CREATED_SEEDLOT_ID)"
    fi
    # Block U's other lot, the one-parent lot of its section U0, when the run died before that lot's own DELETE.
    if [[ -n "$CREATED_SEEDLOT_LEGACY_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_INVENTORY%/}/api/inventory-items/${CREATED_SEEDLOT_LEGACY_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test one-parent seed lot deleted" \
        || echo "WARNING: one-parent seed lot cleanup failed (id: $CREATED_SEEDLOT_LEGACY_ID)"
    fi
    if [[ -n "$CREATED_SEEDPARENT_PLANT_ID" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${STAGING_API_PLANTS%/}/api/plants/${CREATED_SEEDPARENT_PLANT_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test seed-parent planting deleted" \
        || echo "WARNING: seed-parent planting cleanup failed (id: $CREATED_SEEDPARENT_PLANT_ID)"
    fi
    # Block U from U7 on (release 2a): the lot filed under a mix, its two parent plantings, then the two varieties
    # and the mix made of them. Lot and plantings before varieties, as above. The lot's and the plantings' ids are
    # cleared in the block once their own DELETE answers 200; the three varieties have no DELETE in the block (block
    # D's has none either), so they are soft-deleted here on every run. The L-058 sweep hard-deletes all six, the
    # mix's component rows first.
    local sp_left sp_left_id sp_left_url
    for sp_left in \
      "mix seed lot|${STAGING_API_INVENTORY:-}|/api/inventory-items/|$CREATED_SEEDMIX_LOT_ID" \
      "third seed-parent planting|${STAGING_API_PLANTS:-}|/api/plants/|$CREATED_SEEDPARENT3_PLANT_ID" \
      "fourth seed-parent planting|${STAGING_API_PLANTS:-}|/api/plants/|$CREATED_SEEDPARENT4_PLANT_ID" \
      "seed mix variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDMIX_VARIETY_ID" \
      "second smoke variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDVARIETY2_ID" \
      "third smoke variety|${STAGING_API_VARIETIES:-}|/api/varieties/|$CREATED_SEEDVARIETY3_ID"; do
      sp_left_id="${sp_left##*|}"
      if [[ -z "$sp_left_id" ]]; then continue; fi
      sp_left_url="${sp_left#*|}"; sp_left_url="${sp_left_url%%|*}"
      sp_left="${sp_left%|*}"
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        "${sp_left_url%/}${sp_left##*|}${sp_left_id}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: test ${sp_left%%|*} deleted" \
        || echo "WARNING: ${sp_left%%|*} cleanup failed (id: $sp_left_id)"
    done
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
  elif [[ "$DATA_CREATED" == "true" ]]; then
    # A mint that came back empty leaves CLERK_JWT empty until the next one; a run that dies in that stretch gets here.
    echo "Cleanup: no session token in hand, so the API soft-deletes were skipped; the workflow's L-058 sweep removes the rows"
  fi
  # Block N (Put-Up): the run died before the smoke jar's or place's DELETE answered 200 (each id is cleared once
  # it does). Soft-deletes, jar before place, on a fresh token; the L-058 sweep hard-deletes both either way.
  if [[ -n "${CREATED_PUTUP_ID:-}${CREATED_PUTUP_PLACE_ID:-}" && -n "${CLERK_SESSION_ID:-}" ]]; then
    local pu_jwt
    pu_jwt=$(mint_session_token)
    if [[ -n "${CREATED_PUTUP_ID:-}" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $pu_jwt" -H "Content-Type: application/json" \
        "${STAGING_API_PRESERVATION%/}/api/preservation/${CREATED_PUTUP_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: smoke put-up deleted" \
        || echo "WARNING: put-up cleanup failed (id: $CREATED_PUTUP_ID)"
    fi
    if [[ -n "${CREATED_PUTUP_PLACE_ID:-}" ]]; then
      curl -sf --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $pu_jwt" -H "Content-Type: application/json" \
        "${STAGING_API_STORAGE_LOCATIONS%/}/api/storage-locations/${CREATED_PUTUP_PLACE_ID}" -o /dev/null 2>&1 \
        && echo "✅ Cleanup: smoke put-up place deleted" \
        || echo "WARNING: put-up place cleanup failed (id: $CREATED_PUTUP_PLACE_ID)"
    fi
  fi
  # Block M (V5-NAVCUSTOM-001): the run died between its first nav-prefs PATCH and its restore. Put the
  # smoke account's own pins and bar back, best-effort, before the session is revoked below (the next
  # run's block M restores them anyway). Fresh token: the one in hand may have expired.
  if [[ "$NAVP_DIRTY" == "true" && -n "${CLERK_SESSION_ID:-}" && -n "${NAVP_URL:-}" ]]; then
    local navp_jwt
    navp_jwt=$(mint_session_token)
    curl -sf --max-time 15 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $navp_jwt" -H "Content-Type: application/json" -o /dev/null \
      "$NAVP_URL" -d '{"more_pins": [], "bar_layout": {"order": ["today","garden","create","harvests","put-up"], "hidden": []}}' \
      && echo "✅ Cleanup: smoke account nav prefs restored" || true
  fi
  # Block M4 (BUG-GARDENGROUPBYRESET-001): died between its first garden_group_by PATCH and its restore.
  if [[ "$NAVP_GB_DIRTY" == "true" && -n "${CLERK_SESSION_ID:-}" && -n "${NAVP_URL:-}" && -n "$NAVP_GB_RESTORE" ]]; then
    local navp_gb_jwt
    navp_gb_jwt=$(mint_session_token)
    curl -sf --max-time 15 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $navp_gb_jwt" -H "Content-Type: application/json" -o /dev/null \
      "$NAVP_URL" -d "{\"garden_group_by\": \"$NAVP_GB_RESTORE\"}" \
      && echo "✅ Cleanup: smoke account Garden grouping restored" || true
  fi
  # Block Q (V5-SOURCECONTACT-001): died between its first link PATCH and its restore. Clear the smoke
  # source's two links, best-effort, before the session is revoked (the next run's O4 clears them anyway).
  if [[ "$SRC_DIRTY" == "true" && -n "${CLERK_SESSION_ID:-}" && -n "$SRC_ID" && -n "${STAGING_API_VARIETIES:-}" ]]; then
    local src_jwt
    src_jwt=$(mint_session_token)
    curl -sf --max-time 15 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $src_jwt" -H "Content-Type: application/json" -o /dev/null \
      "${STAGING_API_VARIETIES%/}/api/varieties/sources/${SRC_ID}" \
      -d '{"instagram_url": null, "facebook_url": null}' \
      && echo "✅ Cleanup: smoke source links cleared" || true
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
#
# LOG-ONLY instrumentation (promote-path plan B6a). Each call also writes ONE line to STDERR:
#   [mint] http=<code> shape=<ok|empty|malformed> caller=<function>:<line>
# A mint that comes back empty mid-run goes out as `Bearer ` and every request after it reads as an app 401
# (the 2026-09-29 promote: 66 pass, 5 x 401), and until now nothing recorded why it was empty. http=000 is no
# HTTP answer at all, 429/5xx is Clerk, 401/404 is the session; shape is `ok` for three non-empty dot-separated
# parts. The token is never printed, in whole or in part.
# NOTHING ELSE CHANGES, and scripts/test_smoke_mint_log.py holds it to that against the function as it was:
# stdout byte for byte, exit status, exactly one request with the same URL, headers and body. No retry, no
# validation, no new exit path: a caller gets what it got before. A retry or a hard stop is a separate, gated
# change (B6b), to be decided on what these lines show.
# How: the pipeline is the old one plus `-w '%{stderr}%{http_code}'`, which makes curl write the status to its
# own stderr, so the body jq reads is untouched. `2>&3` carries that status around the token capture into the
# outer one, where it lands first; the unit separator (\037) splits the two. The `x` keeps the pipeline's
# trailing newlines, which $(...) would strip, so stdout is replayed exactly.
mint_session_token() {
  local mint_sep=$'\037' mint_nl=$'\n' mint_out mint_err mint_code mint_tok mint_seen mint_shape
  mint_out=$(
    {
      mint_tok=$(
        curl -s --max-time 30 --connect-timeout 10 \
          -X POST \
          -H "Authorization: Bearer $CLERK_SECRET_KEY_STAGING" \
          -H "Content-Type: application/json" \
          -d '{}' \
          -w '%{stderr}%{http_code}' \
          "https://api.clerk.com/v1/sessions/${CLERK_SESSION_ID}/tokens" 2>&3 \
          | jq -r '.jwt // empty' 2>/dev/null || echo ""
        printf x
      )
      printf '%s%s' "$mint_sep" "$mint_tok"
    } 3>&1
  )
  mint_err=${mint_out%%"$mint_sep"*}  # all of curl's stderr; the status, written last, is its final 3 characters
  mint_tok=${mint_out#*"$mint_sep"}
  mint_tok=${mint_tok%x}
  mint_code=000
  case "$mint_err" in
    *[0-9][0-9][0-9]) mint_code=${mint_err: -3}; mint_err=${mint_err%???} ;;
  esac
  # curl is silent under -s, so this is normally empty; anything else that reached its stderr goes where it went before
  if [[ -n "$mint_err" ]]; then printf '%s\n' "${mint_err%"$mint_nl"}" >&2 || true; fi
  mint_seen=$(printf '%s' "$mint_tok")  # as a caller's $(...) sees it: trailing newlines gone
  case "$mint_seen" in
    "") mint_shape=empty ;;
    *[[:space:]]*|*.*.*.*) mint_shape=malformed ;;
    ?*.?*.?*) mint_shape=ok ;;
    *) mint_shape=malformed ;;
  esac
  echo "[mint] http=${mint_code} shape=${mint_shape} caller=${FUNCNAME[1]:-main}:${BASH_LINENO[0]:-0}" >&2 || true
  printf '%s' "$mint_tok"
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

# Season stats (V5-SEASONSTATS-001) rides lambda/harvests. That handler verifies the token BEFORE it
# routes, so an unauthenticated 401 proves the Lambda is up and its module graph (season-stats.js is a
# top-level import) loads; it does not reach the route or the stat_* views. Block R does, authed.
if [[ -n "${STAGING_API_HARVESTS:-}" && "$STAGING_API_HARVESTS" != *placeholder* ]]; then
  check_reachable "lambda:harvests:season-stats" "${STAGING_API_HARVESTS%/}/api/harvests/season-stats"
else
  echo "   (season-stats reachability skipped — STAGING_API_HARVESTS unset/placeholder)"
fi

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

      # ── R) Season stats read (V5-SEASONSTATS-001): envelope v1, the 8 sections in page order, 400 on an
      #       unknown section, and block D's planting counted through the stat_* views ──────────────────────
      # Placed HERE, straight after D and before D3: stat_planting dates a planting by
      # coalesce(sown_at, transplanted_at, planted_at, created_at) in ET, and D POSTs no dates, so its planting
      # falls in the current grow-year (created today). D3 later sets sown_at to the 15th of LAST month, which
      # on a run between Nov 1 and Nov 14 lands in the previous grow-year, so this read must come first.
      # sources.by_type sums EVERY planting of the caller's household for the season (source_type NULL counts
      # under 'none'); the L-058 sweep hard-deletes earlier runs' plantings, so >= 1 here is this run's. With no
      # planting from D the block asserts the envelope only. The server caches 60 s per household|year|sections;
      # nothing else in the run calls this route before here.
      if [[ -n "${STAGING_API_HARVESTS:-}" && "$STAGING_API_HARVESTS" != *placeholder* ]]; then
        CLERK_JWT=$(mint_session_token)
        STATS_URL="${STAGING_API_HARVESTS%/}/api/harvests/season-stats"
        STATS_M=$((10#$(TZ=America/New_York date +%m)))
        STATS_YEAR=$(( $(TZ=America/New_York date +%Y) + (STATS_M >= 11 ? 1 : 0) ))
        STATS_MIN=0
        [[ -n "$CREATED_PLANT_ID" ]] && STATS_MIN=1
        STATS_B=$(mktemp)
        STATS_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
          -o "$STATS_B" -w "%{http_code}" "$STATS_URL?season=$STATS_YEAR") || STATS_HTTP="000"
        STATS_SHAPE=$(jq -r '[.version, .season.year, (.sections | keys_unsorted | join(",")),
                              ([.sections | to_entries[] | (.value.section == .key and .value.version == 1
                                and (.value.meta.limits | type) == "array" and (.value.series | type) == "object")] | all),
                              ([.sections.sources.series.by_type[]?.plantings] | add // 0)] | map(tostring) | join("|")' "$STATS_B" 2>/dev/null || echo "unparseable")
        STATS_BODY=$(head -c 200 "$STATS_B" 2>/dev/null || echo ""); rm -f "$STATS_B"
        STATS_WANT_PREFIX="1|$STATS_YEAR|ribbon,sources,heat_clock,heat_ladder,tomato_keep,longest,sep_size,seed_lots|true|"
        STATS_PLANTINGS="${STATS_SHAPE##*|}"
        if [[ "$STATS_HTTP" == "200" && "$STATS_SHAPE" == "$STATS_WANT_PREFIX"* && "$STATS_PLANTINGS" =~ ^[0-9]+$ && "$STATS_PLANTINGS" -ge "$STATS_MIN" ]]; then
          echo "✅ PASS [read:season-stats] HTTP 200, v1, 8 sections in order, season $STATS_YEAR, $STATS_PLANTINGS planting(s) counted (>= $STATS_MIN: block D's)"
          PASS=$((PASS+1))
        else
          echo "❌ FAIL [read:season-stats] HTTP $STATS_HTTP shape '$STATS_SHAPE' (expected '${STATS_WANT_PREFIX}<n>', n >= $STATS_MIN)"
          echo "   Body: $STATS_BODY"
          FAIL=$((FAIL+1))
        fi
        STATS_BAD=$(curl -s --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
          -o /dev/null -w "%{http_code}" "$STATS_URL?season=$STATS_YEAR&sections=nope") || STATS_BAD="000"
        if [[ "$STATS_BAD" == "400" ]]; then
          echo "✅ PASS [read:season-stats-unknown-section] HTTP 400"
          PASS=$((PASS+1))
        else
          echo "❌ FAIL [read:season-stats-unknown-section] HTTP $STATS_BAD (expected 400)"
          FAIL=$((FAIL+1))
        fi
      elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
        echo "❌ FAIL [read:season-stats] STAGING_API_HARVESTS unset/placeholder — the ship gate may not skip this assert"
        FAIL=$((FAIL+1))
      else
        echo "⚠️  WARN [read:season-stats] STAGING_API_HARVESTS unset/placeholder — season stats read NOT run"
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

      # ── D3) End of season + Catch up write paths → read-back (V5-SEASONEND-001, V5-PLANTSTARTDATES-001; L-108) ──
      # Both pages write through PUT /api/plants/:id alone. End sends {status:"ended"} and the PUT must
      # record exactly one status_change event (metadata.status_to) in the same transaction; Undo sends
      # the row's own prior status back; Catch up sends a month-level sown_at on the 15th with
      # sown_at_approx:true. The smoke planting is POSTed with no status, and a null cannot be put back
      # (the PUT merges with COALESCE, which is why the page never lists one), so a real status is set
      # first and that is the prior status Undo restores. Events are read on the planting-scoped list
      # (project_id + plant_id, PlantingDetail's read). The workflow's L-058 sweep deletes smoke events
      # by project and by plant, so no new cleanup line is needed.
      if [[ -n "$CREATED_PLANT_ID" ]]; then
        CLERK_JWT=$(mint_session_token)
        SE_PLANT_URL="${STAGING_API_PLANTS%/}/api/plants/${CREATED_PLANT_ID}"
        SE_EVENTS_URL="${STAGING_API_EVENTS%/}/api/events?project_id=${CREATED_PROJECT_ID}&plant_id=${CREATED_PLANT_ID}&limit=200"
        # Emits the count of this planting's status_change events (to status $1, or all when $1 is
        # empty), or a non-numeric reason when the read fails.
        se_status_changes() {
          local TMP CODE
          TMP=$(mktemp)
          CODE=$(curl -s --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$TMP" -w "%{http_code}" "$SE_EVENTS_URL") || CODE="000"
          if [[ "${CODE:0:1}" == "2" ]]; then
            jq -r --arg to "$1" 'if type == "array" then [.[] | select(.event_type == "status_change" and ($to == "" or .metadata.status_to == $to))] | length else "not-an-array" end' "$TMP" 2>/dev/null || echo "unparseable"
          else
            echo "http-$CODE"
          fi
          rm -f "$TMP"
        }
        SE_PRIOR="vegetative"
        auth_request "write:PUT /plants/$CREATED_PLANT_ID status=$SE_PRIOR (the prior status)" \
          "$SE_PLANT_URL" "PUT" "{\"status\": \"$SE_PRIOR\"}" >/dev/null || true
        assert_readback "write:plant-status-prior" "$SE_PLANT_URL" ".status" "$SE_PRIOR"
        SC_BEFORE=$(se_status_changes "")

        # (a) End: status reads back ended, and exactly one new status_change event, to "ended".
        auth_request "write:PUT /plants/$CREATED_PLANT_ID status=ended (End of season)" \
          "$SE_PLANT_URL" "PUT" '{"status": "ended"}' >/dev/null || true
        assert_readback "write:season-end-status" "$SE_PLANT_URL" ".status" "ended"
        SC_AFTER=$(se_status_changes "")
        SC_ENDED=$(se_status_changes "ended")
        SC_WANT="n/a"
        if [[ "$SC_BEFORE" =~ ^[0-9]+$ ]]; then SC_WANT=$((SC_BEFORE + 1)); fi
        if [[ "$SC_AFTER" == "$SC_WANT" && "$SC_ENDED" == "1" ]]; then
          echo "✅ PASS [write:season-end-status-event] one new status_change event, status_to=ended ($SC_BEFORE → $SC_AFTER)"
          PASS=$((PASS+1))
        else
          echo "❌ FAIL [write:season-end-status-event] status_change events before=$SC_BEFORE after=$SC_AFTER (want $SC_WANT), to ended=$SC_ENDED (want 1)"
          FAIL=$((FAIL+1))
        fi

        # (b) Undo: the row's own prior status goes back.
        auth_request "write:PUT /plants/$CREATED_PLANT_ID status=$SE_PRIOR (Undo)" \
          "$SE_PLANT_URL" "PUT" "{\"status\": \"$SE_PRIOR\"}" >/dev/null || true
        assert_readback "write:season-end-undo-status" "$SE_PLANT_URL" ".status" "$SE_PRIOR"

        # (c) Catch up: the 15th of last month (never a future day), marked approximate. The date is
        # compared on its first 10 characters, whether the read returns a date or a timestamp.
        CLERK_JWT=$(mint_session_token)
        CU_SOWN="$(utc_days_ago 31 | cut -c1-7)-15"
        auth_request "write:PUT /plants/$CREATED_PLANT_ID sown_at=$CU_SOWN approx (Catch up)" \
          "$SE_PLANT_URL" "PUT" "{\"sown_at\": \"$CU_SOWN\", \"sown_at_approx\": true}" >/dev/null || true
        assert_readback "write:catch-up-sown-at" "$SE_PLANT_URL" '(.sown_at // "")[0:10]' "$CU_SOWN"
        assert_readback "write:catch-up-sown-approx" "$SE_PLANT_URL" ".sown_at_approx" "true"

        # (d) The End of season read: 200, { plants: [...] }, every row carrying kind, variety_ref and
        # last_logged_at. The route returns EVERY live planting in a live container (the frost-band
        # rule runs in the page, src/lib/seasonEnd.js), so the smoke planting must be in it — even though
        # the page itself would not list it: block D cleared its cultivar, so it has no crop, no band.
        SE_LIST=$(mktemp)
        SE_LIST_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
          -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$SE_LIST" -w "%{http_code}" "${STAGING_API_PLANTS%/}/api/plants/season-end") || SE_LIST_HTTP="000"
        SE_SHAPE=$(jq -r --arg id "$CREATED_PLANT_ID" '
          if (.plants | type) != "array" then "not-an-array"
          elif ([.plants[] | select(has("kind") and has("variety_ref") and has("last_logged_at") | not)] | length) > 0 then "a-row-lacks-kind/variety_ref/last_logged_at"
          elif ([.plants[] | select(.id == $id)] | length) != 1 then "smoke-planting-not-listed"
          else "ok, \(.plants | length) rows" end' "$SE_LIST" 2>/dev/null || echo "unparseable")
        rm -f "$SE_LIST"
        if [[ "$SE_LIST_HTTP" == "200" && "$SE_SHAPE" == ok* ]]; then
          echo "✅ PASS [read:season-end-list] HTTP 200, $SE_SHAPE, the smoke planting among them"
          PASS=$((PASS+1))
        else
          echo "❌ FAIL [read:season-end-list] HTTP $SE_LIST_HTTP, $SE_SHAPE"
          FAIL=$((FAIL+1))
        fi
      else
        echo "⚠️  WARN [write:season-end] no test planting (block D skipped) — End/Undo/Catch up asserts NOT run"
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
          # ── F3-search) This packet through header Search (BUG-SEARCHSEEDCAP20-001, v4.148.0 review I2, L-108). ──
          # GET /api/search runs its seven section queries under Promise.allSettled, so a broken inventory query
          # still answers 200, with the Seeds AND Inventory groups empty and one CloudWatch line; nothing else in
          # this script calls the route. Searched by a word only this run's packet carries, here, while the
          # packet is live (F3d deletes it). PASS needs >=1 seeds row in results.inventory AND this packet among
          # them; "no-inventory:<type>" when the list is missing. Its own token, its own temp file.
          CLERK_JWT=$(mint_session_token)
          SRCH_Q="seedpkt-$TEST_RUN_ID"
          SRCH_BODY=$(mktemp)
          SRCH_HTTP=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$SRCH_BODY" -w "%{http_code}" \
            "${STAGING_API_DASHBOARD%/}/api/search?q=$(jq -rn --arg q "$SRCH_Q" '$q | @uri')") || SRCH_HTTP="000"
          SRCH_N=$(jq -r 'if (.results.inventory | type) == "array" then ([.results.inventory[] | select(.category == "seeds")] | length) else 0 end' "$SRCH_BODY" 2>/dev/null || echo 0)
          SRCH_HAS=$(jq -r --arg id "$CREATED_SEEDPKT_ID" \
            'if (.results.inventory | type) == "array" then ([.results.inventory[] | select(.id == $id and .category == "seeds")] | length > 0) else "no-inventory:" + (.results.inventory | type) end' \
            "$SRCH_BODY" 2>/dev/null || echo "unparseable")
          SRCH_SNIP=$(head -c 200 "$SRCH_BODY" 2>/dev/null || echo "")
          rm -f "$SRCH_BODY"
          if [[ "$SRCH_HTTP" == "200" && "$SRCH_N" =~ ^[0-9]+$ && "$SRCH_N" -ge 1 && "$SRCH_HAS" == "true" ]]; then
            echo "✅ PASS [read:search-seed-packet] HTTP 200, q='$SRCH_Q': $SRCH_N seeds row(s) in results.inventory, packet $CREATED_SEEDPKT_ID among them"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [read:search-seed-packet] HTTP $SRCH_HTTP, q='$SRCH_Q': $SRCH_N seeds row(s), packet $CREATED_SEEDPKT_ID listed: '$SRCH_HAS' (expected 200, >=1, 'true')"
            echo "   Body: $SRCH_SNIP"
            FAIL=$((FAIL+1))
          fi
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

      # ── U) A saved-seed lot with TWO parent plantings: the set, the reverse read, a replace, the legacy refusal,
      #       the rows, the delete (V5-SEEDMULTIPARENT-001; R1-CONTRACT sections 1 to 5; L-108) ───────────────────
      # A lot's parents are link rows in seed_lot_parent_planting now, and inventory_items.source_plant_id stays as a
      # MEMBER CACHE: NULL exactly when the lot has no live parent row, otherwise the planting of one of them. Until
      # this block nothing on the deployed stack wrote or read a parent at all, not even the single one the column
      # has carried since V4-SEEDLINK-001. Each step is a write followed by a read-back:
      #   U0) FIRST, on a lot of its own ('smoke-test-seedlot-legacy-<run>'), the three writes every SHIPPED client
      #       makes from the day this deploys, all of which now run through the rewritten set-replace write. The
      #       two-parent steps below prove routes no client calls yet; without U0 these would first run on a phone.
      #       u0a) POST with source_plant_id P1 and NO source_plant_ids (SaveSeedSheet's body) → 201; the GET reads
      #            source_plant_id P1 AND source_plants [P1]: the create wrote the link row as well as the column.
      #       u0b) legacy PATCH /source-plant {P2} (InventoryDetail's "Saved from") → 200 with source_plant_id P2 in
      #            its body; the GET reads [P2] and P2: P1's row retired, P2's written, the cache moved.
      #       u0c) the same PATCH with null → 200; the GET reads no parent and a null source_plant_id.
      #       u0d) PATCH /source-kind {gift} on the now parentless lot → 200; the GET reads gift. Then the legacy
      #            PATCH {P1} → 400, and the GET still reads no parent and gift: a lot that says it came from
      #            somewhere else refuses a garden parent. Only the status is compared, not the sentence.
      #       u0e) that lot's DELETE → 200 {"ok":true}.
      #   U1) POST /api/inventory-items with source_plant_ids [P1, P2] → 201; GET /api/inventory-items/:id →
      #       source_plants lists exactly both, source_plant_id is one of them, and P2 carries the name written.
      #       source_plants is null when the Lambda's parents read failed: that reads "no-source_plants:null" here
      #       and is a FAIL, never an empty set.
      #   U2) GET /api/plants/<the parent the column does NOT hold>/seed-lots lists the lot, once, with the other
      #       parent in other_parents. This is the assert that tells a read of the link rows from a read of the
      #       column: a plants Lambda from before this release finds a lot only by source_plant_id and answers
      #       without it. Which parent that is comes from U1's read-back (P2 when the cache is P1, as the contract
      #       makes it for an array sent alone), so the assert means the same whichever member is cached.
      #   U3) PUT /api/inventory-items/:id/source-plants [P2] → 200; the GET reads the set [P2] and the cache P2.
      #   U4) PUT [P1, P2] → 200; the GET reads both, and the cache still P2 (it is still a member). Then the legacy
      #       PATCH /api/inventory-items/:id/source-plant, as a phone that has not reloaded sends it, with P1 and
      #       then with null: each 409 with code multi_parent_lot, and the GET after each still reads both parents and
      #       the cache P2. (P1 is the id sent because it is NOT the cache: a PATCH that wrote would move it.)
      #   U6) DELETE /api/inventory-items/:id → 200 {"ok":true} with both parents still linked (the links follow
      #       the lot, they never block its delete), and the lot then reads back 404.
      #   then P2's own DELETE → 200. P2 is a seed parent by now, so under SMOKE_REQUIRE_AUTH anything else is a FAIL.
      #   U5) LAST, the rows, through SQL on the staging DSN (block D's precedent; no route shows a retired row): 2
      #       live seed_parent rows, 1 retired (P1's first row, soft-deleted by U3; U4 wrote a new one), and
      #       source_plant_id is the planting of a LIVE row. Read after the lot's delete and P2's, it also shows the
      #       links still live on a deleted lot. Under SMOKE_REQUIRE_AUTH a missing DSN or psql is a FAIL.
      #   RELEASE 2a (R2A-CONTRACT sections 2 to 5), U7 to U23, on rows of their own: two varieties of one crop
      #   (V2, V3: 'smoke-test-variety2/3-<run>', both tomato), two plantings (P3 on V2; P4 with no variety, then on
      #   V3: 'smoke-test-seedparent3/4-<run>'), the mix of V2 and V3, and one lot filed under it
      #   ('smoke-test-seedlot-mix-<run>'). Three lot POSTs are refused under one name
      #   ('smoke-test-seedlot-refused-<run>'), and after each the seeds list is read for a row of that name.
      #   U7)  POST [P1, P3] → 400 mixed_crop_parents (block D's variety has no crop, V2 is a tomato); list: none.
      #   U8)  POST [P3, P4], P4 without a variety → 400 parent_without_variety naming P4; list: none.
      #   U9)  PUT P4's variety to V3, read back.
      #   U10) POST [P3, P4] under V2, a plain variety → 400 blend_required with both variety ids; list: none.
      #   U11) POST /api/varieties/blend {[V2, V3], create} → 201, created, rank blend, key and components V2,V3;
      #        the same with the ids swapped → 200, not created, the same id; GET /api/varieties/:id reads the row.
      #   U12) POST the lot under the mix with source_plant_ids [P3, P4] AND source_plant_id P4 → 201; its GET reads
      #        both parents, the cache P4 (the single key picks the member), the mix, rank blend, both crop_slug.
      #   U13) the lot's row out of the seeds LIST, kept for U16: filed under the mix, rank blend.
      #   U14) PUT /seed-measure {seed_parent_plant_count: 3} → echoed; the GET reads 3.
      #   U15) PUT /filing to V2 (a component), expecting the mix → changed, previous the mix; the GET reads V2.
      #   U16) U13's row, now stale, through the wide PUT, whole, as a client that has not reloaded sends it → 200;
      #        the GET still reads V2 and the count 3: the wide verb moves neither on a lot with a parent.
      #   U17) PUT /filing back to what U15's reply called previous, expecting V2 → the GET reads the mix, rank blend.
      #   U18) PUT /seed-measure {seed_parent_plant_count: null} → the GET reads null.
      #   U19) PUT /source-plants [P3] with expected_source_plant_ids [P3], which is not what the lot holds → 409
      #        lot_changed; the GET still reads both parents and the cache P4.
      #   U20) two seed_saved events naming the lot, P3's then P4's, one after the other and in SaveSeedSheet's
      #        shape; after each, GET /api/events?plant_id= lists exactly one such event on that planting. Both
      #        carry metadata._skip_critter_award (the events Lambda's own switch for a smoke caller), so no
      #        critter is rolled. WHAT IS NOT ASSERTED: that the jar pays XP once. The smoke user can stand at the
      #        300-a-day cap after a few promotes, and at the cap no xp_events row is written at all; "pays once"
      #        is the integration suite's, with a fresh user per case. U23 asserts the half the cap cannot hide.
      #   U21) GET season-stats?sections=seed_lots → 200, every lot row carries a numeric parent_count, this lot's is 2.
      #   U22) the lot's DELETE → 200 {"ok":true}; then P3's and P4's, a FAIL under SMOKE_REQUIRE_AUTH unless 200.
      #   U23) LAST, after U5's SQL: one blend row for the mix | two live component rows, V2 and V3 | one
      #        cultivar care_profile | NO xp_events row of reason event_logged keyed on either EVENT id (a jar-keyed
      #        grant is keyed on the lot; a Lambda that fell back to event-keyed rewards shows here unless capped).
      # Later steps read what earlier ones wrote, so one fault can show as several FAIL lines; the first is the cause.
      # P1 is block D's planting. Block D cleared its variety and blocks between D and here read it that way, so
      # this block gives it block D's variety back (read back, "first-parent-variety") and clears it again at its
      # end ("first-parent-variety-restored"): since release 2a a planting ADDED to a set of two or more must carry
      # a variety, or the POST answers 400 parent_without_variety. P2 is this block's own, created on the same
      # variety, made here and soft-deleted here, as are P3 and P4, so blocks H to L find the project as they did
      # before this block existed. The first lot is a seeds row on block D's variety: F3's packet body plus the
      # array. Two parents of ONE variety need no mix, which is why U1 to U6 still file under a plain variety.
      # TWO MINTS OF ITS OWN (scripts/test_smoke_mint_log.py holds the number of mint_session_token call sites in
      # this file; both were added to its count with this text). Requests on each token:
      #   F3's token: every path through F3 ends at most three requests after a mint, G's four follow, then this
      #     block's first 14 (P2, P1's variety and its read, U0's 11): at most 21;
      #   the mint between U0 and U1: 14 (U1 to U6, then P2's DELETE);
      #   the mint before U7: 40 (U7 to U22, then P1's variety cleared and read).
      # 68 requests in all. Measured on the staging run of dev 1564c564 (2026-10-05): 0.2 to 0.5 s a request, so
      # the longest stretch, the last, is 8 to 20 s of its token's 60. Both psql reads come after the last
      # request, so no request that needs a token waits behind a database round trip. H mints its own. A token
      # that did run out would show as 401s and FAIL lines, never as a pass.
      # NEEDS migrations/v5-seedmultiparent-001, v5-varietyblend-001, v5-seedplantcount-001 and
      # v5-seedstatsparents-001 applied on staging. Without them the POSTs answer 500 and this block FAILS, as it
      # should: the Lambdas this tree deploys cannot save a lot with parents, or make a mix, there.
      # THE VARIETY RATE LIMIT: a variety create draws on plant_varieties.create (60 an hour for a person). A run
      # now draws four times (block D, V2, V3, the mix; the swapped call finds the row and draws nothing).
      # CLEANUP: the three lots and P2, P3, P4 are soft-deleted here through their own routes, and cleanup() repeats
      # whichever did not answer 200; V2, V3 and the mix are cleanup()'s, like block D's variety. Every name holds
      # 'smoke-test-', the mix's included (it is made of its two components' names), which the workflow's L-058
      # sweep matches. It hard-deletes the link rows first (live or retired), then clears source_plant_id, then
      # deletes plantings, then lots: all three foreign keys are RESTRICT, and a lot points at its plantings while a
      # sown planting points at its packet. Since release 2a it also takes a mix by ID as well as by name: after the
      # lots, in ONE transaction, the mix's component rows and then the mix row (both of that table's keys to
      # plant_varieties are RESTRICT). Those sweep edits landed with this block, and neither is safe without the other.
      if [[ -n "${STAGING_API_INVENTORY:-}" && -n "${CREATED_VARIETY_ID:-}" && -n "${CREATED_PLANT_ID:-}" ]]; then
        SP_INV="${STAGING_API_INVENTORY%/}/api/inventory-items"
        SP_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        # A lot's parent ids from its detail GET, sorted and comma-joined; "no-source_plants:<type>" when the key is not an array.
        SP_IDS_JQ='if (.source_plants | type) == "array" then ([.source_plants[].id] | sort | join(",")) else "no-source_plants:" + (.source_plants | type) end'
        SP_P1="$CREATED_PLANT_ID"
        SP_P2_NAME="smoke-test-seedparent-$TEST_RUN_ID"
        SP_LOT=""; SP_STATE=""
        # sp_req METHOD URL [BODY] → SP_CODE (HTTP status or 000) and SP_OUT (the body, a temp file; sp_req removes the last one)
        SP_OUT=""
        sp_req() {
          [[ -n "$SP_OUT" ]] && rm -f "$SP_OUT"
          SP_OUT=$(mktemp)
          if [[ -n "${3:-}" ]]; then
            SP_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
              -H "Content-Type: application/json" -o "$SP_OUT" -w "%{http_code}" "$2" -d "$3") || SP_CODE="000"
          else
            SP_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
              -H "Content-Type: application/json" -o "$SP_OUT" -w "%{http_code}" "$2") || SP_CODE="000"
          fi
        }
        sp_jq() { jq -rc "$1" "$SP_OUT" 2>/dev/null || echo "unparseable"; }
        sp_jqx() { jq -rc --arg x "$1" "$2" "$SP_OUT" 2>/dev/null || echo "unparseable"; }   # sp_jqx <value of $x> <filter>
        sp_pass() { echo "✅ PASS [seed-parents:$1] $2"; PASS=$((PASS+1)); }
        sp_fail() { echo "❌ FAIL [seed-parents:$1] $2"; FAIL=$((FAIL+1)); }
        sp_check() { if [[ "$2" == "$3" ]]; then sp_pass "$1" "$4 → '$2'"; else sp_fail "$1" "$4 → '$2' (expected '$3')"; fi; }
        sp_id_ok() { [[ "${1:-}" =~ $SP_UUID_RE ]]; }
        # sp_state [LOT] → SP_STATE, "<HTTP> <parent ids>|<source_plant_id>" from a lot's detail GET: the two-parent
        # lot's, or the lot named. It sets a variable rather than printing: called inside $(...), sp_req would run
        # in a subshell and lose track of its temp file.
        sp_state() {
          sp_req GET "$SP_INV/${1:-$SP_LOT}"
          SP_STATE="$SP_CODE $(sp_jq "$SP_IDS_JQ")|$(sp_jq '.source_plant_id // "null"')"
        }

        # sp_drop LABEL URL → DELETE; returns 0 when it answered 200. Anything else is a FAIL under the ship gate
        # and a WARN without it, and returns 1 (always called as an `if` condition).
        sp_drop() {
          sp_req DELETE "$2"
          if [[ "$SP_CODE" == "200" ]]; then return 0; fi
          if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
            sp_fail "$1" "DELETE $2 → HTTP $SP_CODE (expected 200; cleanup() retries, the L-058 sweep removes the row either way)"
          else
            echo "⚠️  WARN [seed-parents:$1] DELETE $2 → HTTP $SP_CODE (cleanup() retries; the L-058 sweep removes the row either way)"
          fi
          return 1
        }
        # sp_lot NAME VARIETY PARENT PARENT [CACHE] → a seeds lot's POST body: F3's packet keys, the two parents as
        # source_plant_ids and, when a fifth argument is given, the single key source_plant_id beside them.
        sp_lot() {
          echo "{\"name\": \"$1\", \"type\": \"consumable\", \"category\": \"seeds\", \"unit\": \"packet\", \"quantity_on_hand\": 1, \"variety_id\": \"$2\", \"source_plant_ids\": [\"$3\", \"$4\"]${5:+, \"source_plant_id\": \"$5\"}}"
        }
        SP_REFUSED_NAME="smoke-test-seedlot-refused-$TEST_RUN_ID"
        # sp_refused → SP_NONE, "<HTTP> <n>": the seeds list, and how many of its rows carry the refused lot's name.
        sp_refused() {
          sp_req GET "$SP_INV?category=seeds"
          SP_NONE="$SP_CODE $(sp_jqx "$SP_REFUSED_NAME" 'if type == "array" then ([.[] | select(.name == $x)] | length) else "not-an-array" end')"
        }

        # P2 is created ON block D's variety (release 2a: a planting added to a set of two or more must carry one).
        sp_req POST "$STAGING_API_PLANTS" "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"$SP_P2_NAME\", \"variety_id\": \"$CREATED_VARIETY_ID\"}"
        SP_P2=$(sp_jq '.id // empty')
        # Handed to cleanup() as soon as P2 itself exists, whatever the test below makes of block D's id.
        if sp_id_ok "$SP_P2"; then CREATED_SEEDPARENT_PLANT_ID="$SP_P2"; fi
        if [[ "${SP_CODE:0:1}" == "2" ]] && sp_id_ok "$SP_P2" && sp_id_ok "$SP_P1"; then
          sp_pass "second-parent" "POST /api/plants → HTTP $SP_CODE (id: $SP_P2); the first parent is block D's planting $SP_P1"
          SP_BOTH=$(jq -rn --arg a "$SP_P1" --arg b "$SP_P2" '[$a, $b] | sort | join(",")' 2>/dev/null || echo "unsortable")

          # P1 gets block D's variety back: block D cleared it, and U1, U4 and U7 need it set. Judged on the GET,
          # so a PUT that did not take shows as the variety it left. Cleared again after U22.
          sp_req PUT "${STAGING_API_PLANTS%/}/api/plants/$SP_P1" "{\"variety_id\": \"$CREATED_VARIETY_ID\"}"
          SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P1"
          sp_check "first-parent-variety" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 $CREATED_VARIETY_ID" "PUT /api/plants/$SP_P1 {variety_id: block D's} → HTTP $SP_WRITE; then its GET: variety_id"

          # ── U0) the one-parent path every shipped client uses: create, move, clear, source-kind, on its own lot ──
          # The create's body is SaveSeedSheet's: F3's packet keys plus source_plant_id, and no source_kind key.
          sp_req POST "$STAGING_API_INVENTORY" "{\"name\": \"smoke-test-seedlot-legacy-$TEST_RUN_ID\", \"type\": \"consumable\", \"category\": \"seeds\", \"unit\": \"packet\", \"quantity_on_hand\": 1, \"variety_id\": \"$CREATED_VARIETY_ID\", \"source_plant_id\": \"$SP_P1\"}"
          SP_OLD=$(sp_jq '.id // empty')
          if [[ "$SP_CODE" == "201" ]] && sp_id_ok "$SP_OLD"; then
            CREATED_SEEDLOT_LEGACY_ID="$SP_OLD"
            sp_state "$SP_OLD"
            sp_check "u0a-legacy-create-readback" "$SP_STATE" "200 $SP_P1|$SP_P1" "POST with source_plant_id P1 and no source_plant_ids → HTTP 201; GET /api/inventory-items/:id: parent ids|source_plant_id"

            sp_req PATCH "$SP_INV/$SP_OLD/source-plant" "{\"source_plant_id\": \"$SP_P2\"}"
            SP_WRITE="$SP_CODE $(sp_jq '.source_plant_id // "null"')"; sp_state "$SP_OLD"
            sp_check "u0b-legacy-move-readback" "$SP_WRITE $SP_STATE" "200 $SP_P2 200 $SP_P2|$SP_P2" "legacy PATCH /source-plant {P2} on a one-parent lot; its status and its body's source_plant_id, then the GET: parent ids|source_plant_id"

            sp_req PATCH "$SP_INV/$SP_OLD/source-plant" '{"source_plant_id": null}'
            SP_WRITE="$SP_CODE"; sp_state "$SP_OLD"
            sp_check "u0c-legacy-clear-readback" "$SP_WRITE $SP_STATE" "200 200 |null" "legacy PATCH /source-plant {null}; then the GET: no parent ids|source_plant_id null"

            sp_req PATCH "$SP_INV/$SP_OLD/source-kind" '{"source_kind": "gift"}'
            SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_OLD"
            sp_check "u0d-source-kind-readback" "$SP_WRITE $SP_CODE $(sp_jq '.source_kind // "null"')" "200 200 gift" "PATCH /source-kind {gift} on the lot with no parent; then the GET's source_kind"
            sp_req PATCH "$SP_INV/$SP_OLD/source-plant" "{\"source_plant_id\": \"$SP_P1\"}"
            SP_WRITE="$SP_CODE"; sp_state "$SP_OLD"
            sp_check "u0d-parent-refused-on-a-gift-lot" "$SP_WRITE $SP_STATE|$(sp_jq '.source_kind // "null"')" "400 200 |null|gift" "legacy PATCH /source-plant {P1} on a lot whose source_kind is gift; its status, then the GET: no parent ids|source_plant_id null|source_kind"

            sp_req DELETE "$SP_INV/$SP_OLD"
            SP_WRITE="$SP_CODE $(sp_jq '. == {"ok": true}')"
            if [[ "$SP_CODE" == "200" ]]; then CREATED_SEEDLOT_LEGACY_ID=""; fi
            sp_check "u0e-legacy-lot-delete" "$SP_WRITE" "200 true" "DELETE /api/inventory-items/:id on the one-parent lot, now parentless; ok"
          else
            sp_fail "u0a-legacy-create" "POST /api/inventory-items with source_plant_id P1 → HTTP $SP_CODE (expected 201 and an id): $(head -c 200 "$SP_OUT" 2>/dev/null || true)"
          fi

          # The block's first mint: U1 to U6 and P2's DELETE ride this token (14 requests).
          CLERK_JWT=$(mint_session_token)
          sp_req POST "$STAGING_API_INVENTORY" "{\"name\": \"smoke-test-seedlot-$TEST_RUN_ID\", \"type\": \"consumable\", \"category\": \"seeds\", \"unit\": \"packet\", \"quantity_on_hand\": 1, \"variety_id\": \"$CREATED_VARIETY_ID\", \"source_plant_ids\": [\"$SP_P1\", \"$SP_P2\"]}"
          SP_LOT=$(sp_jq '.id // empty')
          SP_LOT_MADE=false
          if [[ "$SP_CODE" == "201" ]] && sp_id_ok "$SP_LOT"; then
            CREATED_SEEDLOT_ID="$SP_LOT"
            SP_LOT_MADE=true

            # ── U1) the set and its cache, read back ──
            sp_req GET "$SP_INV/$SP_LOT"
            SP_CACHE=$(sp_jq '.source_plant_id // "null"')
            # SP_OFF = the parent the column does NOT hold (U2 reads its seed-lots); SP_ON = the other one.
            case "$SP_CACHE" in
              "$SP_P1") SP_ON="$SP_P1"; SP_OFF="$SP_P2"; SP_MEMBER="one-of-them" ;;
              "$SP_P2") SP_ON="$SP_P2"; SP_OFF="$SP_P1"; SP_MEMBER="one-of-them" ;;
              *)        SP_ON="$SP_P1"; SP_OFF="$SP_P2"; SP_MEMBER="neither:$SP_CACHE" ;;
            esac
            sp_check "u1-create-readback" "$SP_CODE $(sp_jq "$SP_IDS_JQ")|$SP_MEMBER|$(sp_jqx "$SP_P2" '[.source_plants[]? | select(.id == $x) | .name][0] // "absent"')" "200 $SP_BOTH|one-of-them|$SP_P2_NAME" "POST source_plant_ids [P1, P2] → HTTP 201; GET /api/inventory-items/:id: parent ids|source_plant_id|P2's name"

            # ── U2) the lot, read from the planting's side, under the parent the column does not hold ──
            sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_OFF/seed-lots"
            sp_check "u2-seed-lots-of-the-uncached-parent" "$SP_CODE $(sp_jqx "$SP_LOT" 'if (.seed_lots | type) == "array" then ([.seed_lots[] | select(.id == $x)] | if length == 1 then "listed|other_parents:" + ([.[0].other_parents[]?.id] | join(",")) elif length == 0 then "absent" else "listed \(length) times" end) else "no-seed_lots:" + (.seed_lots | type) end')" "200 listed|other_parents:$SP_ON" "GET /api/plants/$SP_OFF/seed-lots (the lot's source_plant_id is $SP_CACHE); the lot, then its other parents"

            # ── U3) replace the set with [P2] ──
            sp_req PUT "$SP_INV/$SP_LOT/source-plants" "{\"source_plant_ids\": [\"$SP_P2\"]}"
            SP_WRITE="$SP_CODE"; sp_state
            sp_check "u3-replace-readback" "$SP_WRITE $SP_STATE" "200 200 $SP_P2|$SP_P2" "PUT /source-plants [P2], then GET /api/inventory-items/:id: parent ids|source_plant_id"

            # ── U4) both again; then the legacy single-parent PATCH is refused, with an id and with null ──
            SP_TWO="200 $SP_BOTH|$SP_P2"   # the lot's GET with both parents and the cache still P2
            sp_req PUT "$SP_INV/$SP_LOT/source-plants" "{\"source_plant_ids\": [\"$SP_P1\", \"$SP_P2\"]}"
            SP_WRITE="$SP_CODE"; sp_state
            sp_check "u4-readd-readback" "$SP_WRITE $SP_STATE" "200 $SP_TWO" "PUT /source-plants [P1, P2], then GET: both parents|source_plant_id still P2"
            sp_req PATCH "$SP_INV/$SP_LOT/source-plant" "{\"source_plant_id\": \"$SP_P1\"}"
            SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_state
            sp_check "u4-legacy-set-refused" "$SP_WRITE $SP_STATE" "409 multi_parent_lot $SP_TWO" "legacy PATCH /source-plant {P1} on a two-parent lot; its code, then the GET: both parents|source_plant_id, as before it"
            sp_req PATCH "$SP_INV/$SP_LOT/source-plant" '{"source_plant_id": null}'
            SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_state
            sp_check "u4-legacy-clear-refused" "$SP_WRITE $SP_STATE" "409 multi_parent_lot $SP_TWO" "legacy PATCH /source-plant {null} on a two-parent lot; its code, then the GET: both parents|source_plant_id, as before it"

            # ── U6) the lot's delete goes through with both parents still linked ──
            sp_req DELETE "$SP_INV/$SP_LOT"
            SP_WRITE="$SP_CODE $(sp_jq '. == {"ok": true}')"
            if [[ "$SP_CODE" == "200" ]]; then CREATED_SEEDLOT_ID=""; fi
            sp_req GET "$SP_INV/$SP_LOT"
            sp_check "u6-delete-with-parents" "$SP_WRITE $SP_CODE" "200 true 404" "DELETE /api/inventory-items/:id with two parents linked; ok, then the lot's GET"
          else
            sp_fail "u1-create" "POST /api/inventory-items with source_plant_ids [P1, P2] → HTTP $SP_CODE (expected 201 and an id): $(head -c 200 "$SP_OUT" 2>/dev/null || true)"
          fi
          # P2 goes back out, so blocks H to L find the project as they did before this block existed. By now P2 is a
          # seed parent of the lot (a live link row, and the lot's source_plant_id), so under the ship gate a DELETE
          # that does not answer 200 is a FAIL: the migration's claim that RESTRICT blocks nothing the app does is
          # asserted for the lot by U6 and for the planting here.
          sp_req DELETE "${STAGING_API_PLANTS%/}/api/plants/$SP_P2"
          if [[ "$SP_CODE" == "200" ]]; then
            CREATED_SEEDPARENT_PLANT_ID=""
          elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
            sp_fail "second-parent-delete" "DELETE /api/plants/$SP_P2 → HTTP $SP_CODE (expected 200: a planting that is a lot's seed parent must still soft-delete; cleanup() retries, the L-058 sweep removes the row either way)"
          else
            echo "⚠️  WARN [seed-parents:second-parent-delete] DELETE /api/plants/$SP_P2 → HTTP $SP_CODE (cleanup() retries; the L-058 sweep removes the row either way)"
          fi

          # ── U7 to U22) release 2a: the three refusals, the mix, a lot filed under it, its filing, its plant
          #      count, a stale set, its two seed_saved events, the stats row ──
          # The block's second mint: everything from here to P1's variety being cleared rides it (40 requests).
          CLERK_JWT=$(mint_session_token)
          SP_VAR="${STAGING_API_VARIETIES%/}/api/varieties"
          SP_NIL="00000000-0000-0000-0000-000000000000"
          SP_MIX=""; SP_MIX_MADE=false; SP_MIXLOT=""; SP_E1="$SP_NIL"; SP_E2="$SP_NIL"
          sp_req POST "$STAGING_API_VARIETIES" "{\"name\": \"smoke-test-variety2-$TEST_RUN_ID\", \"crop_type_slug\": \"tomato\"}"
          SP_V2=$(sp_jq '.id // empty')
          # SP_MADE keeps each create's own status for u7-rows: by its FAIL line SP_CODE is P4's.
          SP_MADE="V2 $SP_CODE"
          if sp_id_ok "$SP_V2"; then CREATED_SEEDVARIETY2_ID="$SP_V2"; fi
          sp_req POST "$STAGING_API_VARIETIES" "{\"name\": \"smoke-test-variety3-$TEST_RUN_ID\", \"crop_type_slug\": \"tomato\"}"
          SP_V3=$(sp_jq '.id // empty')
          SP_MADE="$SP_MADE, V3 $SP_CODE"
          if sp_id_ok "$SP_V3"; then CREATED_SEEDVARIETY3_ID="$SP_V3"; fi
          sp_req POST "$STAGING_API_PLANTS" "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"smoke-test-seedparent3-$TEST_RUN_ID\", \"variety_id\": \"$SP_V2\"}"
          SP_P3=$(sp_jq '.id // empty')
          SP_MADE="$SP_MADE, P3 $SP_CODE"
          if sp_id_ok "$SP_P3"; then CREATED_SEEDPARENT3_PLANT_ID="$SP_P3"; fi
          # P4 has NO variety yet: U8 needs it bare, U9 gives it V3.
          sp_req POST "$STAGING_API_PLANTS" "{\"project_id\": \"$CREATED_PROJECT_ID\", \"name\": \"smoke-test-seedparent4-$TEST_RUN_ID\"}"
          SP_P4=$(sp_jq '.id // empty')
          SP_MADE="$SP_MADE, P4 $SP_CODE"
          if sp_id_ok "$SP_P4"; then CREATED_SEEDPARENT4_PLANT_ID="$SP_P4"; fi
          if sp_id_ok "$SP_V2" && sp_id_ok "$SP_V3" && sp_id_ok "$SP_P3" && sp_id_ok "$SP_P4"; then
            sp_pass "u7-rows" "two tomato varieties ($SP_V2, $SP_V3) and two plantings ($SP_P3 on the first, $SP_P4 with no variety)"
            # A mix's key and its component list: the two variety ids, sorted, comma-joined (lowercase uuids sort
            # as text the way Postgres sorts them as uuid).
            SP_VKEY=$(jq -rn --arg a "$SP_V2" --arg b "$SP_V3" '[$a, $b] | sort | join(",")' 2>/dev/null || echo "unsortable")
            SP_MIXBOTH=$(jq -rn --arg a "$SP_P3" --arg b "$SP_P4" '[$a, $b] | sort | join(",")' 2>/dev/null || echo "unsortable")

            # ── U7) two parents of different crops ──
            sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$CREATED_VARIETY_ID" "$SP_P1" "$SP_P3")"
            SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_refused
            sp_check "u7-mixed-crop-refused" "$SP_WRITE $SP_NONE" "400 mixed_crop_parents 200 0" "POST source_plant_ids [P1 (no crop), P3 (tomato)]; its status and code, then the seeds list: rows named $SP_REFUSED_NAME"

            # ── U8) a parent with no variety ──
            sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$SP_V2" "$SP_P3" "$SP_P4")"
            SP_WRITE="$SP_CODE $(sp_jq '.code // "-"') $(sp_jq '.plant_id // "-"')"; sp_refused
            sp_check "u8-parent-without-variety-refused" "$SP_WRITE $SP_NONE" "400 parent_without_variety $SP_P4 200 0" "POST source_plant_ids [P3, P4], P4 with no variety; its status, code and plant_id, then the seeds list: rows named $SP_REFUSED_NAME"

            # ── U9) P4 gets V3 ──
            sp_req PUT "${STAGING_API_PLANTS%/}/api/plants/$SP_P4" "{\"variety_id\": \"$SP_V3\"}"
            SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P4"
            sp_check "u9-fourth-parent-variety" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 $SP_V3" "PUT /api/plants/$SP_P4 {variety_id: V3} → HTTP $SP_WRITE; then its GET: variety_id"

            # ── U10) two varieties under a plain one ──
            sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "$SP_REFUSED_NAME" "$SP_V2" "$SP_P3" "$SP_P4")"
            SP_WRITE="$SP_CODE $(sp_jq '.code // "-"') $(sp_jq '(.component_variety_ids // []) | sort | join(",")')"; sp_refused
            sp_check "u10-blend-required-refused" "$SP_WRITE $SP_NONE" "400 blend_required $SP_VKEY 200 0" "POST source_plant_ids [P3 (V2), P4 (V3)] filed under V2; its status, code and component_variety_ids, then the seeds list: rows named $SP_REFUSED_NAME"

            # ── U11) the mix: created, found again with the ids swapped, read back ──
            sp_req POST "$SP_VAR/blend" "{\"component_variety_ids\": [\"$SP_V2\", \"$SP_V3\"], \"create\": true}"
            SP_MIX=$(sp_jq '.id // empty')
            if sp_id_ok "$SP_MIX"; then
              CREATED_SEEDMIX_VARIETY_ID="$SP_MIX"
              SP_MIX_MADE=true
              sp_check "u11-blend-create" "$SP_CODE $(sp_jq '.created')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '.blend_key // "null"')|$(sp_jq '[.components[]?.id] | sort | join(",")')" "201 true|blend|$SP_VKEY|$SP_VKEY" "POST /api/varieties/blend {[V2, V3], create: true}; its status, created|variety_rank|blend_key|component ids"
              sp_req POST "$SP_VAR/blend" "{\"component_variety_ids\": [\"$SP_V3\", \"$SP_V2\"], \"create\": true}"
              sp_check "u11-blend-swapped-same-row" "$SP_CODE $(sp_jq '.created')|$(sp_jq '.id // "null"')|$(sp_jq '.variety_rank // "null"')" "200 false|$SP_MIX|blend" "the same POST with the ids swapped; its status, created|id (the first call's)|variety_rank"
              sp_req GET "$SP_VAR/$SP_MIX"
              sp_check "u11-blend-readback" "$SP_CODE $(sp_jq '.id // "null"')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '.blend_key // "null"')" "200 $SP_MIX|blend|$SP_VKEY" "GET /api/varieties/$SP_MIX: id|variety_rank|blend_key"

              # ── U12) a lot filed under the mix, both parents, the single key beside the array ──
              # P4 is the single key because it is NOT the array's first id: a create that ignored it caches P3.
              sp_req POST "$STAGING_API_INVENTORY" "$(sp_lot "smoke-test-seedlot-mix-$TEST_RUN_ID" "$SP_MIX" "$SP_P3" "$SP_P4" "$SP_P4")"
              SP_MIXLOT=$(sp_jq '.id // empty')
              if [[ "$SP_CODE" == "201" ]] && sp_id_ok "$SP_MIXLOT"; then
                CREATED_SEEDMIX_LOT_ID="$SP_MIXLOT"
                SP_FILED_MIX="$SP_MIX|blend"   # the lot's GET while it is filed under the mix: variety_id|variety_rank
                sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u12-mix-lot-readback" "$SP_CODE $(sp_jq "$SP_IDS_JQ")|$(sp_jq '.source_plant_id // "null"')|$(sp_jq '.variety_id // "null"')|$(sp_jq '.variety_rank // "null"')|$(sp_jq '[.source_plants[]? | .crop_slug // "null"] | join(",")')" "200 $SP_MIXBOTH|$SP_P4|$SP_FILED_MIX|tomato,tomato" "POST under the mix with source_plant_ids [P3, P4] and source_plant_id P4 → HTTP 201; its GET: parent ids|source_plant_id|variety_id|variety_rank|each parent's crop_slug"

                # ── U13) the lot's LIST row, kept whole for U16 ──
                sp_req GET "$SP_INV?category=seeds"
                SP_ROW=$(sp_jqx "$SP_MIXLOT" '[.[]? | select(.id == $x)][0] // empty')
                sp_check "u13-list-row" "$SP_CODE $(jq -rn --argjson r "${SP_ROW:-null}" '($r.variety_id // "null") + "|" + ($r.variety_rank // "null")' 2>/dev/null || echo "unparseable")" "200 $SP_FILED_MIX" "GET /api/inventory-items?category=seeds; the lot's row: variety_id|variety_rank"

                # ── U14) the plant count, through /seed-measure ──
                sp_req PUT "$SP_INV/$SP_MIXLOT/seed-measure" '{"seed_parent_plant_count": 3}'
                SP_WRITE="$SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')"; sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u14-plant-count-readback" "$SP_WRITE $SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')" "200 3 200 3" "PUT /seed-measure {seed_parent_plant_count: 3}; its status and echo, then the GET: seed_parent_plant_count"

                # ── U15) re-file to a component ──
                sp_req PUT "$SP_INV/$SP_MIXLOT/filing" "{\"variety_id\": \"$SP_V2\", \"expect_variety_id\": \"$SP_MIX\"}"
                SP_WRITE="$SP_CODE $(sp_jq '.changed')|$(sp_jq '.previous.variety_id // "null"')"
                SP_PREVIOUS=$(sp_jq '.previous.variety_id // empty')
                sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u15-filing-to-component" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')" "200 true|$SP_MIX 200 $SP_V2" "PUT /filing {variety_id: V2, expect_variety_id: the mix}; its status, changed|previous.variety_id, then the GET: variety_id"

                # ── U16) U13's row, stale by now, through the wide PUT ──
                sp_req PUT "$SP_INV/$SP_MIXLOT" "$SP_ROW"
                SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u16-stale-list-row-put-keeps-filing" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')|$(sp_jq '.seed_parent_plant_count // "null"')" "200 200 $SP_V2|3" "PUT /api/inventory-items/:id with the list row read before the re-file (it says the mix, and no plant count); its status, then the GET: variety_id|seed_parent_plant_count"

                # ── U17) and back, from what U15's reply called previous ──
                sp_req PUT "$SP_INV/$SP_MIXLOT/filing" "{\"variety_id\": \"$SP_PREVIOUS\", \"expect_variety_id\": \"$SP_V2\"}"
                SP_WRITE="$SP_CODE $(sp_jq '.changed')"; sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u17-filing-back-from-previous" "$SP_WRITE $SP_CODE $(sp_jq '.variety_id // "null"')|$(sp_jq '.variety_rank // "null"')" "200 true 200 $SP_FILED_MIX" "PUT /filing {variety_id: U15's previous, expect_variety_id: V2}; its status and changed, then the GET: variety_id|variety_rank"

                # ── U18) the plant count cleared ──
                sp_req PUT "$SP_INV/$SP_MIXLOT/seed-measure" '{"seed_parent_plant_count": null}'
                SP_WRITE="$SP_CODE"; sp_req GET "$SP_INV/$SP_MIXLOT"
                sp_check "u18-plant-count-cleared" "$SP_WRITE $SP_CODE $(sp_jq '.seed_parent_plant_count // "null"')" "200 200 null" "PUT /seed-measure {seed_parent_plant_count: null}; its status, then the GET: seed_parent_plant_count"

                # ── U19) a set sent against a stale reading of the lot ──
                sp_req PUT "$SP_INV/$SP_MIXLOT/source-plants" "{\"source_plant_ids\": [\"$SP_P3\"], \"expected_source_plant_ids\": [\"$SP_P3\"]}"
                SP_WRITE="$SP_CODE $(sp_jq '.code // "-"')"; sp_state "$SP_MIXLOT"
                sp_check "u19-stale-set-refused" "$SP_WRITE $SP_STATE" "409 lot_changed 200 $SP_MIXBOTH|$SP_P4" "PUT /source-plants [P3] with expected_source_plant_ids [P3] on a lot that holds P3 and P4; its status and code, then the GET: both parents|source_plant_id, as before it"

                # ── U20) one seed_saved event per parent, in turn, each then listed on its planting ──
                # SaveSeedSheet's body (plant_id, no project_id) plus the events Lambda's own smoke switch. A day
                # back, as block C dates its event: a bare date is stored at noon UTC, which today can be ahead of now.
                SP_DAY=$(utc_days_ago 1)
                SP_EV_JQ='if type == "array" then ([.[] | select(.event_type == "seed_saved" and .metadata.seed_lot_id == $x)] | length) else "not-an-array:" + type end'
                sp_req POST "$STAGING_API_EVENTS" "{\"plant_id\": \"$SP_P3\", \"event_type\": \"seed_saved\", \"event_date\": \"$SP_DAY\", \"notes\": \"CI smoke — safe to delete\", \"metadata\": {\"seed_lot_id\": \"$SP_MIXLOT\", \"_skip_critter_award\": true}}"
                SP_WRITE="$SP_CODE"; SP_EVENT=$(sp_jq '.id // empty')
                if sp_id_ok "$SP_EVENT"; then SP_E1="$SP_EVENT"; fi
                sp_req GET "${STAGING_API_EVENTS%/}/api/events?plant_id=$SP_P3&limit=50"
                sp_check "u20-seed-saved-first-parent" "$SP_WRITE $SP_CODE $(sp_jqx "$SP_MIXLOT" "$SP_EV_JQ")" "201 200 1" "POST /api/events seed_saved on P3 naming the lot; its status, then GET /api/events?plant_id=P3: seed_saved events carrying this seed_lot_id"
                sp_req POST "$STAGING_API_EVENTS" "{\"plant_id\": \"$SP_P4\", \"event_type\": \"seed_saved\", \"event_date\": \"$SP_DAY\", \"notes\": \"CI smoke — safe to delete\", \"metadata\": {\"seed_lot_id\": \"$SP_MIXLOT\", \"_skip_critter_award\": true}}"
                SP_WRITE="$SP_CODE"; SP_EVENT=$(sp_jq '.id // empty')
                if sp_id_ok "$SP_EVENT"; then SP_E2="$SP_EVENT"; fi
                sp_req GET "${STAGING_API_EVENTS%/}/api/events?plant_id=$SP_P4&limit=50"
                sp_check "u20-seed-saved-second-parent" "$SP_WRITE $SP_CODE $(sp_jqx "$SP_MIXLOT" "$SP_EV_JQ")" "201 200 1" "POST /api/events seed_saved on P4 naming the lot; its status, then GET /api/events?plant_id=P4: seed_saved events carrying this seed_lot_id"

                # ── U21) the stats read: every lot row counts its parents, and this lot has two ──
                # While the lot is live (stat_saved_lot drops a deleted one). sections=seed_lots is a cache key no
                # other call in the run uses (block R reads the whole envelope), so this is not R's answer replayed.
                # The lot is dated by its created_at in ET, the season by the same clock: block R's own arithmetic.
                # Only "this-lot" can fail: the Lambda's shaper sends a number for parent_count whatever it read, so
                # "every-row-counted" is true of any 200. A missing or cache-only count reads 0 or 1 under this-lot.
                if [[ -n "${STAGING_API_HARVESTS:-}" && "$STAGING_API_HARVESTS" != *placeholder* ]]; then
                  SP_MONTH=$((10#$(TZ=America/New_York date +%m)))
                  SP_SEASON=$(( $(TZ=America/New_York date +%Y) + (SP_MONTH >= 11 ? 1 : 0) ))
                  sp_req GET "${STAGING_API_HARVESTS%/}/api/harvests/season-stats?season=$SP_SEASON&sections=seed_lots"
                  sp_check "u21-season-stats-parent-count" "$SP_CODE $(sp_jqx "$SP_MIXLOT" '.sections.seed_lots.series.rows as $r | if ($r | type) != "array" then "no-rows:" + ($r | type) else "every-row-counted:" + ([$r[] | (.parent_count | type) == "number"] | all | tostring) + "|this-lot:" + ([$r[] | select(.lot_id == $x) | .parent_count | tostring] | join(",")) end')" "200 every-row-counted:true|this-lot:2" "GET season-stats?season=$SP_SEASON&sections=seed_lots; whether every lot row has a numeric parent_count, then this lot's"
                elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
                  sp_fail "u21-season-stats-parent-count" "STAGING_API_HARVESTS unset/placeholder — the ship gate may not skip this assert"
                else
                  echo "⚠️  WARN [seed-parents:u21-season-stats-parent-count] STAGING_API_HARVESTS unset/placeholder — parent_count NOT read"
                fi

                # ── U22) the lot goes, its parents still linked ──
                sp_req DELETE "$SP_INV/$SP_MIXLOT"
                SP_WRITE="$SP_CODE $(sp_jq '. == {"ok": true}')"
                if [[ "$SP_CODE" == "200" ]]; then CREATED_SEEDMIX_LOT_ID=""; fi
                sp_check "u22-mix-lot-delete" "$SP_WRITE" "200 true" "DELETE /api/inventory-items/:id on the lot filed under the mix; ok"
              else
                sp_fail "u12-mix-lot" "POST /api/inventory-items under the mix with source_plant_ids [P3, P4] → HTTP $SP_CODE (expected 201 and an id): $(head -c 200 "$SP_OUT" 2>/dev/null || true)"
              fi
            else
              sp_fail "u11-blend-create" "POST /api/varieties/blend → HTTP $SP_CODE (expected 201 and an id): $(head -c 200 "$SP_OUT" 2>/dev/null || true)"
            fi
          else
            sp_fail "u7-rows" "the release 2a rows were not all made (HTTP of each create: $SP_MADE; a 429 on a variety is the hourly create limit): varieties [$SP_V2] [$SP_V3], plantings [$SP_P3] [$SP_P4]"
          fi
          # P3 and P4 go back out, whichever of them exists, for the reason P2 did.
          if sp_id_ok "$SP_P3"; then
            if sp_drop "third-parent-delete" "${STAGING_API_PLANTS%/}/api/plants/$SP_P3"; then CREATED_SEEDPARENT3_PLANT_ID=""; fi
          fi
          if sp_id_ok "$SP_P4"; then
            if sp_drop "fourth-parent-delete" "${STAGING_API_PLANTS%/}/api/plants/$SP_P4"; then CREATED_SEEDPARENT4_PLANT_ID=""; fi
          fi
          # P1's variety is cleared again: blocks H to L find block D's planting as block D left it.
          sp_req PUT "${STAGING_API_PLANTS%/}/api/plants/$SP_P1" '{"variety_id": null}'
          SP_WRITE="$SP_CODE"; sp_req GET "${STAGING_API_PLANTS%/}/api/plants/$SP_P1"
          sp_check "first-parent-variety-restored" "$SP_CODE $(sp_jq '.variety_id // "null"')" "200 null" "PUT /api/plants/$SP_P1 {variety_id: null} → HTTP $SP_WRITE; then its GET: variety_id"

          # ── U5) the link rows, through SQL: live | retired | the cache is the planting of a live row ──
          # LAST, after every authed request of this block (block D's rule for its own SQL read): nothing that
          # needs a token may wait behind a database round trip. By now the lot is
          # soft-deleted and so is P2, and the SQL filters on neither, so the same three numbers also show that the
          # links FOLLOW the lot (still live on a deleted lot) and outlast the soft-delete of a parent planting.
          # The lot id goes in as a psql variable (stdin + :'lot'), never spliced into the text (block D's reason).
          if [[ "$SP_LOT_MADE" == "true" ]]; then
            if [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
              SP_ROWS=$(psql "$NEON_STAGING_URL" -X -At -v ON_ERROR_STOP=1 -v lot="$SP_LOT" \
                <<< "SELECT COUNT(*) FILTER (WHERE l.deleted_at IS NULL) || '|' || COUNT(*) FILTER (WHERE l.deleted_at IS NOT NULL) || '|' || COALESCE(bool_or(l.deleted_at IS NULL AND l.plant_id = i.source_plant_id), false) FROM inventory_items i LEFT JOIN seed_lot_parent_planting l ON l.inventory_item_id = i.id AND l.role = 'seed_parent' WHERE i.id = :'lot'::uuid;") \
                || SP_ROWS="psql-exit-$?"
              sp_check "u5-link-rows-readback" "$SP_ROWS" "2|1|true" "seed_lot_parent_planting for the lot, on the staging DSN, after the lot's delete: live rows|retired rows|source_plant_id is a live row's planting"
            elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
              sp_fail "u5-link-rows-readback" "NEON_STAGING_URL unset or psql missing — the ship gate may not skip this assert"
            else
              echo "⚠️  WARN [seed-parents:u5-link-rows-readback] NEON_STAGING_URL unset or psql missing — the link rows were NOT read back"
            fi
          fi

          # ── U23) the mix's rows, and what the two seed_saved events did NOT write, through SQL ──
          # blend rows for the mix | live component rows naming V2 or V3 | cultivar care_profile rows | xp_events
          # rows of reason event_logged keyed on either EVENT id. The last is 0 on a correct Lambda whether or not
          # the smoke user is at the daily cap: a jar-keyed grant is keyed on the lot. Above 0 is the events Lambda
          # having fallen back to event-keyed rewards. An event that was not made goes in as the nil uuid, which
          # keys nothing; its own FAIL is U20's. Every id is a psql variable, never spliced (block D's reason).
          if [[ "$SP_MIX_MADE" == "true" ]]; then
            if [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
              SP_MIXROWS=$(psql "$NEON_STAGING_URL" -X -At -v ON_ERROR_STOP=1 -v mix="$SP_MIX" -v va="$SP_V2" -v vb="$SP_V3" -v ea="$SP_E1" -v eb="$SP_E2" \
                <<< "SELECT (SELECT COUNT(*) FROM plant_varieties WHERE id = :'mix'::uuid AND variety_rank = 'blend' AND blend_key IS NOT NULL) || '|' || (SELECT COUNT(*) FROM variety_blend_component WHERE blend_variety_id = :'mix'::uuid AND deleted_at IS NULL AND component_variety_id IN (:'va'::uuid, :'vb'::uuid)) || '|' || (SELECT COUNT(*) FROM care_profile WHERE scope = 'cultivar' AND scope_id = :'mix'::uuid) || '|' || (SELECT COUNT(*) FROM xp_events WHERE reason = 'event_logged' AND source_id IN (:'ea'::uuid, :'eb'::uuid));") \
                || SP_MIXROWS="psql-exit-$?"
              sp_check "u23-mix-rows-readback" "$SP_MIXROWS" "1|2|1|0" "the mix on the staging DSN: blend rows|live component rows (V2, V3)|cultivar care_profile rows|xp_events rows keyed on either seed_saved event"
            elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
              sp_fail "u23-mix-rows-readback" "NEON_STAGING_URL unset or psql missing — the ship gate may not skip this assert"
            else
              echo "⚠️  WARN [seed-parents:u23-mix-rows-readback] NEON_STAGING_URL unset or psql missing — the mix's rows were NOT read back"
            fi
          fi
        else
          sp_fail "second-parent" "POST /api/plants → HTTP $SP_CODE, id '$SP_P2' (block D's planting: '$SP_P1')"
        fi
        [[ -n "$SP_OUT" ]] && rm -f "$SP_OUT"
      elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
        echo "❌ FAIL [seed-parents] STAGING_API_INVENTORY unset, or block D made no variety or no planting — the ship gate may not skip this assert"
        FAIL=$((FAIL+1))
      else
        echo "⚠️  WARN [seed-parents] STAGING_API_INVENTORY unset, or no variety or planting from block D — seed lot parent asserts NOT run"
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

      # ── L) A taught name (voice alias) → one use → its hit_count read back exactly +1 (BUG-VOICEALIASHITCOUNT-001, L-108) ──
      # PATCH /api/varieties/voice-aliases is the voice page's fire-and-forget "this taught name was just used"
      # write (hit_count + 1, last_used_at = now()), sent after a harvest or a Log many batch saves. Until this
      # block nothing on the deployed stack called it, nor the teach POST that creates the row it counts. The
      # smoke user teaches a run-unique phrase for block D's throwaway variety, reads it back through the GET
      # the voice page loads its list from, sends ONE use, and the GET must then read exactly one more use and
      # a last_used_at: a bare 2xx would pass a PATCH that counts nothing, and "exactly" also catches a double
      # count. The PATCH's result line stays visible (block E's lesson).
      # Cleanup: no route removes an alias (voice_alias has no soft delete; the path answers DELETE with 405),
      # so the row rides on the variety it names. voice_alias.variety_id is ON DELETE CASCADE (prod and staging
      # catalogs, 2026-09-24), and the workflow's L-058 sweep hard-deletes block D's variety by its smoke name,
      # which takes the alias with it. No sweep line is needed.
      if [[ -n "${STAGING_API_VARIETIES:-}" && -n "${CREATED_VARIETY_ID:-}" ]]; then
        CLERK_JWT=$(mint_session_token)
        VA_URL="${STAGING_API_VARIETIES%/}/api/varieties/voice-aliases"
        # A heard_key is lowercase with no whitespace or punctuation, 4-120 characters (the route's checks and
        # the table's CHECKs). uuidgen answers upper-case on macOS, so fold it before stripping.
        VA_KEY="smokealias$(printf '%s' "$TEST_RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
        # "<hit_count> <last_used_at|none>" for THIS phrase from the GET; "absent" when the list does not carry
        # it; "no-aliases:<type>" when the list itself is missing (the idiom of F3's sown_from read).
        va_read() {
          local TMP
          TMP=$(mktemp)
          curl -s --compressed --max-time 30 --connect-timeout 10 \
            -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$TMP" "$VA_URL" >/dev/null 2>&1 || true
          jq -r --arg k "$VA_KEY" \
            'if (.aliases | type) == "array" then ([.aliases[] | select(.heard_key == $k) | "\(.hit_count) \(.last_used_at // "none")"][0] // "absent") else "no-aliases:" + (.aliases | type) end' \
            "$TMP" 2>/dev/null || echo "unparseable"
          rm -f "$TMP"
        }
        VA_TEACH_BODY=$(mktemp)
        VA_TEACH_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
          -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
          -o "$VA_TEACH_BODY" -w "%{http_code}" "$VA_URL" \
          -d "{\"heard_key\": \"$VA_KEY\", \"heard_text\": \"smoke alias $TEST_RUN_ID\", \"variety_id\": \"$CREATED_VARIETY_ID\"}") || VA_TEACH_HTTP="000"
        VA_TAUGHT=$(jq -r '.heard_key // empty' "$VA_TEACH_BODY" 2>/dev/null || echo "")
        rm -f "$VA_TEACH_BODY"
        if [[ "$VA_TEACH_HTTP" == "200" && "$VA_TAUGHT" == "$VA_KEY" ]]; then
          echo "✅ PASS [crud:POST /varieties/voice-aliases (teach)] HTTP 200, '$VA_KEY' for variety $CREATED_VARIETY_ID"
          PASS=$((PASS+1))
          VA_BEFORE=$(va_read)
          VA_PATCH_BODY=$(mktemp)
          VA_PATCH_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
            -X PATCH -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
            -o "$VA_PATCH_BODY" -w "%{http_code}" "$VA_URL" \
            -d "{\"used\": [{\"heard_key\": \"$VA_KEY\", \"variety_id\": \"$CREATED_VARIETY_ID\"}]}") || VA_PATCH_HTTP="000"
          VA_COUNTED=$(jq -r '.counted // empty' "$VA_PATCH_BODY" 2>/dev/null || echo "")
          rm -f "$VA_PATCH_BODY"
          echo "   PATCH /varieties/voice-aliases, one use of '$VA_KEY' → HTTP $VA_PATCH_HTTP, counted '$VA_COUNTED'"
          VA_AFTER=$(va_read)
          # Exactly one more than the read before the PATCH, and only when that read was a number.
          VA_WANT="?"
          if [[ "${VA_BEFORE%% *}" =~ ^[0-9]+$ ]]; then VA_WANT="$(( ${VA_BEFORE%% *} + 1 ))"; fi
          if [[ "$VA_PATCH_HTTP" == "200" && "${VA_AFTER%% *}" == "$VA_WANT" && "${VA_AFTER#* }" != "none" ]]; then
            echo "✅ PASS [write:voice-alias-use-readback] hit_count ${VA_BEFORE%% *} → ${VA_AFTER%% *} through the GET, last_used_at ${VA_AFTER#* }"
            PASS=$((PASS+1))
          else
            echo "❌ FAIL [write:voice-alias-use-readback] PATCH HTTP $VA_PATCH_HTTP, counted '$VA_COUNTED'; the GET read '$VA_BEFORE' before and '$VA_AFTER' after (expected hit_count $VA_WANT and a last_used_at)"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [crud:POST /varieties/voice-aliases (teach)] HTTP $VA_TEACH_HTTP, heard_key '$VA_TAUGHT' (expected 200 and '$VA_KEY')"
          FAIL=$((FAIL+1))
        fi
      elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
        echo "❌ FAIL [write:voice-alias-use-readback] STAGING_API_VARIETIES unset or block D made no variety — the ship gate may not skip this assert"
        FAIL=$((FAIL+1))
      else
        echo "⚠️  WARN [write:voice-alias-use-readback] STAGING_API_VARIETIES unset or no variety from block D — taught-name count assert NOT run"
      fi
    else
      echo "   WARNING: POST succeeded but no id in response — skipping fetch (response: ${CREATE_RESPONSE:0:200})"
      # Every write-path block above (A-L, F3 included) hangs off this project id, so this branch skips all
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


# ── M) Per-person nav prefs write → read-back (V5-NAVCUSTOM-001; L-108) — Phase 2, continued ──────
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
# BOTH test layouts are the shape V5-NAVANYSLOT-001 introduced: a More row id (seeds) in a slot, one
# of them a short order. A critter Lambda from before that change refuses each with 400, so a stale
# deploy reds M2 here; the old five-key shape passes old and new alike and would not. The old shape
# is still written and read back once per run, by the restore in M3.
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

  # M0) Read first: the GET answers 200 and carries all three fields before anything is written.
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
  NAVP_LAYOUT_A='{"order":["today","garden","create","harvests","seeds"],"hidden":[]}'
  NAVP_LAYOUT_B='{"order":["today","create","put-up","seeds"],"hidden":[]}'
  if [[ "$(echo "$NAVP_BEFORE" | jq -S -c '.bar_layout' 2>/dev/null)" == "$(echo "$NAVP_LAYOUT_A" | jq -S -c .)" ]]; then
    NAVP_LAYOUT="$NAVP_LAYOUT_B"
  else
    NAVP_LAYOUT="$NAVP_LAYOUT_A"
  fi
  NAVP_LAYOUT_NORM=$(echo "$NAVP_LAYOUT" | jq -S -c .)
  NAVP_DIRTY=true

  # M1) more_pins → GET → equal.
  NAVP_CODE=$(navp_patch "{\"more_pins\": $NAVP_PINS}")
  NAVP_GOT=$(navp_get '.more_pins')
  if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "$NAVP_PINS" ]]; then
    echo "✅ PASS [write:prefs-more-pins-readback] read-back == $NAVP_PINS"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [write:prefs-more-pins-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected $NAVP_PINS)"
    FAIL=$((FAIL+1))
  fi

  # M2) bar_layout → GET → equal, and the pins from M1 still stored (the key was absent from this PATCH).
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

  # M3) Restore, and read it back: [] must CLEAR the pins (the trap is sending null, which keeps them).
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

  # M4) garden_group_by (BUG-GARDENGROUPBYRESET-001; L-108): Type ('crop_type') and a bean facet ('bean_use') —
  # the two kinds of value the Lambda refused before the fix, so Garden's choice never reached the row — each
  # PATCHed and read back through GET, then the row restored. The order makes each write DIFFER from what the row
  # held just before it, so a leftover from a run that died mid-block cannot pass vacuously. RESTORE: the value
  # the first GET read, or 'crop_type' when it was unset — a PATCH cannot write NULL back (COALESCE), and Garden
  # shows an unset grouping as Type anyway.
  NAVP_GB_BEFORE=$(echo "$NAVP_BEFORE" | jq -r '.garden_group_by // empty' 2>/dev/null || echo "")
  NAVP_GB_RESTORE="${NAVP_GB_BEFORE:-crop_type}"
  if [[ "$NAVP_GB_BEFORE" == "crop_type" ]]; then NAVP_GB_SEQ="bean_use crop_type"; else NAVP_GB_SEQ="crop_type bean_use"; fi
  NAVP_GB_DIRTY=true
  for NAVP_GB in $NAVP_GB_SEQ; do
    CLERK_JWT=$(mint_session_token)
    NAVP_CODE=$(navp_patch "{\"garden_group_by\": \"$NAVP_GB\"}")
    NAVP_GOT=$(navp_get '.garden_group_by')
    if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "\"$NAVP_GB\"" ]]; then
      echo "✅ PASS [write:prefs-garden-group-by-readback] $NAVP_GB read back"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [write:prefs-garden-group-by-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected \"$NAVP_GB\")"
      FAIL=$((FAIL+1))
    fi
  done
  CLERK_JWT=$(mint_session_token)
  NAVP_CODE=$(navp_patch "{\"garden_group_by\": \"$NAVP_GB_RESTORE\"}")
  [[ "${NAVP_CODE:0:1}" == "2" ]] && NAVP_GB_DIRTY=false
  NAVP_GOT=$(navp_get '.garden_group_by')
  if [[ "${NAVP_CODE:0:1}" == "2" && "$NAVP_GOT" == "\"$NAVP_GB_RESTORE\"" ]]; then
    echo "✅ PASS [write:prefs-garden-group-by-restore-readback] smoke account back on '$NAVP_GB_RESTORE'"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL [write:prefs-garden-group-by-restore-readback] PATCH HTTP $NAVP_CODE, read-back '$NAVP_GOT' (expected \"$NAVP_GB_RESTORE\")"
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


# ── N) Put-Up: a place and a jar, write → read-back (Put-Up release 1a; L-108) — Phase 2, continued ──────
# Until this block the put-up family had no authed write here: preservation and storage-locations were only the
# Phase 1 reachability probes. Release 1a changes two things this proves on the deployed stack:
#   * the legacy PUT (lambda/preservation/index.js): a changed package_count moves remaining_count by the same
#     delta, from COALESCE(remaining_count, package_count), and ignores the body's remaining_count; a count of
#     jars that cannot exist is REFUSED with a coded 409, decided inside the one UPDATE;
#   * every preservation DATE leaves projectRow (jarRules.js) as 'YYYY-MM-DD'. The driver's Date went out as
#     "…T00:00:00.000Z", which an ET phone read as the day before and wrote back on each Mark used or Edit.
# Independent of the test project: a place and a jar need neither a project nor a planting. One smoke place
# (deep freezer), one smoke jar in it (tomato, the crop_types slug tests/integration/preservation.int.test.js
# uses on its staging fork; whole_freeze; 3 containers; source_kind and preserved_at_approx sent as the Put-Up
# form always sends them), then by READ-BACK through GET /api/preservation/:id:
#   N1) preserved_at is the day sent (today in ET, the phone's day; the runner's UTC day turns over at 7 or 8 pm
#       ET) and use_by_target the day the server derived: 12 months on, whole_freeze's deep_freezer leg in
#       lambda/preservation/shelfLife.js (the cell shelfLife.test.js pins), Feb 29 clamped to Feb 28 as
#       addMonths() does. Compared as whole strings, so the pre-1a "…T00:00:00.000Z" is a FAIL.
#   N2) an untouched full-echo PUT leaves both dates as N1 read them. pu_put sends what buildFullPayload
#       (src/pages/PutUp.jsx) sends: its nineteen keys, taken from the row the GET returned.
#   N3) count 3 → 5 with no remaining_count: 5 left.
#   N4) a Mark-used-shaped PUT (count unchanged, remaining 4): 4 left. Then a second, remaining 2, so 3 are used:
#       N5 needs a count below what is used that is still a legal count. With 1 used the only such count is 0,
#       which validateCommon refuses (400, package_count must be >= 1) before the count rule is reached.
#   N5) the RowEditor count edit 5 → 2 with 3 used: 409, code count_below_used, and the row reads back
#       unchanged — both counts, both dates and updated_at (a refused UPDATE writes nothing).
#   N6) the jar, then the place, soft-deleted through their own routes, then absent from each default list.
# N4 and N5 run only once the step before them passed: each one's numbers are the last one's result. No step
# waits on a clock. Markers, the only columns the workflow's L-058 sweep matches for this block: the jar's notes
# 'smoke-test-putup-<run>' and the place's label 'smoke-test-place-<run>'. The sweep hard-deletes the jar
# before the place (preservation_log.storage_location_id has no ON DELETE action). Each id is cleared once its
# DELETE answers 200; cleanup() soft-deletes whichever is left.
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" && -n "${STAGING_API_STORAGE_LOCATIONS:-}" ]]; then
  PU_JARS_URL="${STAGING_API_PRESERVATION%/}/api/preservation"
  PU_PLACES_URL="${STAGING_API_STORAGE_LOCATIONS%/}/api/storage-locations"
  PU_DAY=$(TZ=America/New_York date +%Y-%m-%d)
  PU_YEAR_ON=$(( ${PU_DAY:0:4} + 1 ))
  if [[ "${PU_DAY:5:5}" == "02-29" ]]; then PU_USE_BY="$PU_YEAR_ON-02-28"; else PU_USE_BY="$PU_YEAR_ON-${PU_DAY:5:5}"; fi
  pu_get() {                          # pu_get <jq filter> -> the jar's GET /:id through it (raw, compact), or http-<code>
    local TMP CODE
    TMP=$(mktemp)
    CODE=$(curl -s --max-time 30 --connect-timeout 10 \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o "$TMP" -w "%{http_code}" "$PU_JAR_URL") || CODE="000"
    if [[ "$CODE" == "200" ]]; then jq -rc "$1" "$TMP" 2>/dev/null || echo "unparseable"; else echo "http-$CODE"; fi
    rm -f "$TMP"
  }
  # pu_put <jq edit> -> reads the jar, builds buildFullPayload's body from that row (a key the row lacks goes as
  # null), applies the edit and PUTs it, as RecordRow and RowEditor do. Prints "<HTTP code> <the answer's .code,
  # or ->"; "no-row-<code> -" when the read failed, so nothing was sent.
  pu_put() {
    local ROW TMP CODE BODY=""
    ROW=$(mktemp); TMP=$(mktemp)
    CODE=$(curl -s --max-time 30 --connect-timeout 10 \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o "$ROW" -w "%{http_code}" "$PU_JAR_URL") || CODE="000"
    if [[ "$CODE" == "200" ]]; then
      BODY=$(jq -c "{crop_type_slug, variety_id, plant_id, harvest_log_id, preserved_at, preserved_at_approx, method, method_other_text, quantity_value, quantity_unit, package_count, storage_location_id, use_by_target, remaining_count, consumed_at, notes, photo_id, source_kind, source_label} | $1" "$ROW" 2>/dev/null || echo "")
    fi
    if [[ -n "$BODY" ]]; then
      CODE=$(curl -s --max-time 30 --connect-timeout 10 -X PUT \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o "$TMP" -w "%{http_code}" "$PU_JAR_URL" -d "$BODY") || CODE="000"
      echo "$CODE $(jq -r '.code // "-"' "$TMP" 2>/dev/null || echo "-")"
    else
      echo "no-row-$CODE -"
    fi
    rm -f "$ROW" "$TMP"
  }
  pu_listed() {                       # pu_listed <list url> <id> -> listed | absent (a real array), else why not
    local TMP CODE
    TMP=$(mktemp)
    CODE=$(curl -s --compressed --max-time 30 --connect-timeout 10 \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o "$TMP" -w "%{http_code}" "$1") || CODE="000"
    if [[ "$CODE" == "200" ]]; then
      jq -r --arg id "$2" 'if type == "array" then (if any(.[]; .id == $id) then "listed" else "absent" end) else "not-an-array" end' "$TMP" 2>/dev/null || echo "unparseable"
    else
      echo "http-$CODE"
    fi
    rm -f "$TMP"
  }
  CLERK_JWT=$(mint_session_token)

  PU_PLACE_BODY=$(mktemp)
  PU_PLACE_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
    -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
    -o "$PU_PLACE_BODY" -w "%{http_code}" "$PU_PLACES_URL" \
    -d "{\"label\": \"smoke-test-place-$TEST_RUN_ID\", \"kind\": \"deep_freezer\"}") || PU_PLACE_HTTP="000"
  CREATED_PUTUP_PLACE_ID=$(jq -r '.id // empty' "$PU_PLACE_BODY" 2>/dev/null || echo "")
  rm -f "$PU_PLACE_BODY"
  PU_PLACE_ID="$CREATED_PUTUP_PLACE_ID"
  if [[ "${PU_PLACE_HTTP:0:1}" == "2" && -n "$PU_PLACE_ID" ]]; then
    echo "✅ PASS [crud:POST /storage-locations (smoke place)] HTTP $PU_PLACE_HTTP (id: $PU_PLACE_ID, deep_freezer)"
    PASS=$((PASS+1))
    PU_JAR_BODY=$(mktemp)
    PU_JAR_HTTP=$(curl -s --max-time 30 --connect-timeout 10 \
      -X POST -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o "$PU_JAR_BODY" -w "%{http_code}" "$PU_JARS_URL" \
      -d "{\"crop_type_slug\": \"tomato\", \"method\": \"whole_freeze\", \"quantity_value\": 2, \"quantity_unit\": \"lb\", \"package_count\": 3, \"preserved_at\": \"$PU_DAY\", \"preserved_at_approx\": false, \"source_kind\": \"own_garden\", \"storage_location_id\": \"$PU_PLACE_ID\", \"notes\": \"smoke-test-putup-$TEST_RUN_ID\"}") || PU_JAR_HTTP="000"
    CREATED_PUTUP_ID=$(jq -r '.id // empty' "$PU_JAR_BODY" 2>/dev/null || echo "")
    PU_JAR_SNIP=$(head -c 200 "$PU_JAR_BODY" 2>/dev/null || echo "")
    rm -f "$PU_JAR_BODY"
    PU_JAR_ID="$CREATED_PUTUP_ID"
    PU_JAR_URL="$PU_JARS_URL/$PU_JAR_ID"
    if [[ "${PU_JAR_HTTP:0:1}" == "2" && -n "$PU_JAR_ID" ]]; then
      echo "✅ PASS [crud:POST /preservation (smoke jar)] HTTP $PU_JAR_HTTP (id: $PU_JAR_ID)"
      PASS=$((PASS+1))

      # N1) both dates, exactly as the GET returns them.
      PU_DATES=$(pu_get '"\(.preserved_at) \(.use_by_target)"')
      if [[ "$PU_DATES" == "$PU_DAY $PU_USE_BY" ]]; then
        echo "✅ PASS [write:putup-dates-readback] preserved_at '$PU_DAY' as sent, use_by_target '$PU_USE_BY' as derived (deep freezer, 12 months), both 'YYYY-MM-DD'"
        PASS=$((PASS+1))
      else
        echo "❌ FAIL [write:putup-dates-readback] read '$PU_DATES' (expected '$PU_DAY $PU_USE_BY': the day sent, then 12 months on, each exactly 'YYYY-MM-DD')"
        FAIL=$((FAIL+1))
      fi

      # N2) the untouched echo — no key changed — must leave both dates where N1 read them.
      CLERK_JWT=$(mint_session_token)
      PU_PUT=$(pu_put '.')
      PU_DATES_AFTER=$(pu_get '"\(.preserved_at) \(.use_by_target)"')
      if [[ "$PU_PUT" == "200 -" && "$PU_DATES" == [0-9]* && "$PU_DATES_AFTER" == "$PU_DATES" ]]; then
        echo "✅ PASS [write:putup-echo-dates-unchanged] untouched full-echo PUT → HTTP 200; dates read back '$PU_DATES_AFTER', as before"
        PASS=$((PASS+1))
      else
        echo "❌ FAIL [write:putup-echo-dates-unchanged] PUT → '$PU_PUT' (expected '200 -'); dates before '$PU_DATES', after '$PU_DATES_AFTER' (expected the same two days)"
        FAIL=$((FAIL+1))
      fi

      # N3) count 3 → 5, no remaining_count key: the delta lands on the 3 left.
      PU_PUT=$(pu_put '.package_count = 5 | del(.remaining_count)')
      PU_COUNTS=$(pu_get '"\(.package_count) \(.remaining_count)"')
      if [[ "$PU_PUT" == "200 -" && "$PU_COUNTS" == "5 5" ]]; then
        echo "✅ PASS [write:putup-count-delta] count 3 → 5 with no remaining_count → HTTP 200; reads back 5 containers, 5 left"
        PASS=$((PASS+1))

        # N4) Mark used (5 → 4 left), then count unchanged with 2 left, which leaves 3 used for N5.
        CLERK_JWT=$(mint_session_token)
        PU_PUT=$(pu_put '.remaining_count = 4')
        PU_COUNTS=$(pu_get '"\(.package_count) \(.remaining_count)"')
        if [[ "$PU_PUT" == "200 -" && "$PU_COUNTS" == "5 4" ]]; then
          echo "✅ PASS [write:putup-mark-used] Mark-used PUT (count unchanged, remaining 4) → HTTP 200; reads back 5 containers, 4 left"
          PASS=$((PASS+1))
          PU_PUT=$(pu_put '.remaining_count = 2')
          PU_COUNTS=$(pu_get '"\(.package_count) \(.remaining_count)"')
          if [[ "$PU_PUT" == "200 -" && "$PU_COUNTS" == "5 2" ]]; then
            echo "✅ PASS [write:putup-mark-used-again] count unchanged, remaining 2 → HTTP 200; reads back 5 containers, 2 left (3 used)"
            PASS=$((PASS+1))

            # N5) the count below what is used: refused, and nothing written.
            CLERK_JWT=$(mint_session_token)
            PU_SNAP='[.package_count, .remaining_count, .preserved_at, .use_by_target, .updated_at]'
            PU_BEFORE=$(pu_get "$PU_SNAP")
            PU_PUT=$(pu_put '.package_count = 2')
            PU_AFTER=$(pu_get "$PU_SNAP")
            if [[ "$PU_PUT" == "409 count_below_used" && "$PU_BEFORE" == "[5,2,"* && "$PU_AFTER" == "$PU_BEFORE" ]]; then
              echo "✅ PASS [write:putup-count-below-used-refused] count 5 → 2 with 3 used → HTTP 409 count_below_used; the row reads back unchanged: $PU_AFTER"
              PASS=$((PASS+1))
            else
              echo "❌ FAIL [write:putup-count-below-used-refused] PUT → '$PU_PUT' (expected '409 count_below_used'); row before $PU_BEFORE, after $PU_AFTER (expected equal, starting [5,2,)"
              FAIL=$((FAIL+1))
            fi
          else
            echo "❌ FAIL [write:putup-mark-used-again] PUT → '$PU_PUT' (expected '200 -'); reads back '$PU_COUNTS' (expected '5 2')"
            FAIL=$((FAIL+1))
          fi
        else
          echo "❌ FAIL [write:putup-mark-used] PUT → '$PU_PUT' (expected '200 -'); reads back '$PU_COUNTS' (expected '5 4')"
          FAIL=$((FAIL+1))
        fi
      else
        echo "❌ FAIL [write:putup-count-delta] PUT → '$PU_PUT' (expected '200 -'); reads back '$PU_COUNTS' (expected '5 5': 3 left plus the 2 added)"
        FAIL=$((FAIL+1))
      fi

      # N6) the jar: soft-deleted, then gone from the default list.
      CLERK_JWT=$(mint_session_token)
      PU_DEL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X DELETE \
        -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
        -o /dev/null -w "%{http_code}" "$PU_JAR_URL") || PU_DEL_HTTP="000"
      if [[ "$PU_DEL_HTTP" == "200" ]]; then CREATED_PUTUP_ID=""; fi
      PU_LISTED=$(pu_listed "$PU_JARS_URL" "$PU_JAR_ID")
      if [[ "$PU_DEL_HTTP" == "200" && "$PU_LISTED" == "absent" ]]; then
        echo "✅ PASS [delete:putup-jar-gone-from-list] DELETE → HTTP 200; GET /api/preservation no longer lists $PU_JAR_ID"
        PASS=$((PASS+1))
      else
        echo "❌ FAIL [delete:putup-jar-gone-from-list] DELETE → HTTP $PU_DEL_HTTP (expected 200); GET /api/preservation: '$PU_LISTED' (expected 'absent')"
        FAIL=$((FAIL+1))
      fi
    else
      echo "❌ FAIL [crud:POST /preservation (smoke jar)] HTTP $PU_JAR_HTTP"
      echo "   Body: $PU_JAR_SNIP"
      FAIL=$((FAIL+1))
    fi

    # N6) the place, after its jar: soft-deleted, then gone from the default list.
    CLERK_JWT=$(mint_session_token)
    PU_DEL_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X DELETE \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o /dev/null -w "%{http_code}" "$PU_PLACES_URL/$PU_PLACE_ID") || PU_DEL_HTTP="000"
    if [[ "$PU_DEL_HTTP" == "200" ]]; then CREATED_PUTUP_PLACE_ID=""; fi
    PU_LISTED=$(pu_listed "$PU_PLACES_URL" "$PU_PLACE_ID")
    if [[ "$PU_DEL_HTTP" == "200" && "$PU_LISTED" == "absent" ]]; then
      echo "✅ PASS [delete:putup-place-gone-from-list] DELETE → HTTP 200; GET /api/storage-locations no longer lists $PU_PLACE_ID"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [delete:putup-place-gone-from-list] DELETE → HTTP $PU_DEL_HTTP (expected 200); GET /api/storage-locations: '$PU_LISTED' (expected 'absent')"
      FAIL=$((FAIL+1))
    fi
  else
    echo "❌ FAIL [crud:POST /storage-locations (smoke place)] HTTP $PU_PLACE_HTTP"
    FAIL=$((FAIL+1))
  fi
else
  echo "⚠️  WARN [write:putup] STAGING_API_PRESERVATION or STAGING_API_STORAGE_LOCATIONS unset, or no JWT — Put-Up write-path asserts NOT run"
fi


# ── Recipes sweep (L-058): the hard-delete of every smoke-test-recipe-<run> row, shared by blocks P and T ────────
# Two blocks write a recipe: P1b (the recipe a batch follows, to prove the clear's recipe rung) and block T (create →
# GET → DELETE). The sweep and its flag are defined HERE, above block P, and not in block T where they began. A
# function exists only once the script has run past its definition: while these sat in block T, a run that died
# between P1b and block T left cleanup() calling a sweep that was not there yet, and block T's own initialisation
# then lowered the flag P1b had raised. From here the trap hard-deletes the recipe wherever the run stops. What it
# deletes is unchanged: a recipe named with the prefix, its lines first, in ONE transaction; built-in types are never
# touched. cleanup() runs ferm_sweep before it, the order kitchen_batch.recipe_id (NO ACTION) needs. Block T still
# runs it at its own end, and lowers the flag only then.
RECIPES_DIRTY=false
recipes_sweep() {
  [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1 || return 1
  psql "$NEON_STAGING_URL" -X -q -1 -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE rc_r ON COMMIT DROP AS SELECT id FROM recipe WHERE name LIKE 'smoke-test-recipe-%';
DELETE FROM recipe_ingredient WHERE recipe_id IN (SELECT id FROM rc_r);
DELETE FROM recipe WHERE id IN (SELECT id FROM rc_r);
SQL
}


# ── P) Put-Up 1b + Ferment (F): make, draw, use, take out, undo, remove — write → read-back (06-ferment-path §5.6;
#    L-108) — Phase 2, continued ─────────────────────────────────────────────────────────────────────────────────
# Nine sub-blocks, one per §5.6 row, each a write followed by a read-back:
#   P1) put-up (1b): the jar reads back the date sent and use_by_basis 'typed' (discard_by sent); a legacy PUT with a
#       DIFFERENT discard-by (use_by_target: V4 §5.4's "date" — a differing preserved_at is still written) → 409
#       client_stale; an equal echo → 200 and nothing changes.
#   P2) batch → a typed line → a salt line; read back salt_pct / salt_base / base_g / salt_method / base_from.
#   P3) counted draw of 1 from jar J → remaining −1 → a stale 1a Mark used on J (the 19-key legacy PUT, remaining
#       n−1) → 409 client_stale, count and delta_at unchanged → the F bundle's Mark used (POST /api/pantry/uses) → 201,
#       remaining −1 → the F bundle's note edit (PATCH /api/preservation/:id; the legacy PUT refuses a changed note
#       from any bundle) → 200, the note reads back and the count is unchanged. The drawn jar stays usable (06 §1.3).
#   P4) weighed draw 8 g from a 100 g bag → 92 g; the rest (92 g) → 0 g, count 0, consumed; use-soon lists it
#       before and not after.
#   P5) take P3's line out → the count comes back → restore → drawn again.
#   P6) PATCH a check-in note → edited_at is set.
#   P7) a jalapeño line (170 g @ 2,500-8,000) → shu-estimate → save → the batch reads back basis 'computed'.
#   P8) put-up with a row shu + cooked and a sitting line drawing 8 g from a reaper bag → Undo that put-up → the
#       bag's grams are back.
#   P9) a fresh batch draws 1 from jar K → remove the batch → K's count is back (F1).
# Two more, from Put-Up UX pass R1 (neither is a §5.6 row):
#   P1b) PATCH /api/preservation/:id {"discard_by": "clear"} on P1's typed jar (no recipe) → basis table, the engine's
#        date; then on a typed fridge row of a batch that follows a "Fridge · 7 days" recipe → basis recipe, day + 7.
#   P10) POST /api/preservation with is_raw true at a fridge place → is_raw stored, basis none (the Walk sends it).
# One more, from Put-Up R2a:
#   P11) POST /api/kitchen-batches/from-jars on a jar that already exists → the jar's batch is closed as put_up; the
#        same body again → 200 replayed, one batch on the key.
# One more, with batch detail's "Take it off this batch" (BUG-BATCHREMOVEDEADEND-001):
#   P12) DELETE /api/kitchen-batches/:id/outputs/:plid on P11's jar → the jar is live and on no batch; POST
#        /:id/outputs with it → linked 1, the jar is on that batch again.
# Stock is read back through SQL (NEON_STAGING_URL + psql, as block D does): remaining_amount and consumed_at are
# not on every API projection, and the ledger (pantry_use) has no read route in F.
# GATED ON F BEING DEPLOYED: F's DDL and Lambda reach staging only at F's sitting. The probe is GET
# /api/kitchen-batches/line-search (200 only with F's Lambda). THE REQUIREMENT TRAVELS WITH THE SHA
# (review-F-prepromote-early I1): deploy-staging is dispatched --ref dev, so its env block is dev's workflow file,
# not the tree under test — a flag set there would not reach step 5's run. So a checked-out tree that carries F's
# migration requires this block: the probe failing, or the block not running at all, is a FAIL there. Only a tree
# without F (dev before F lands) keeps the WARN. SMOKE_REQUIRE_FERMENT=1 still forces the requirement by hand.
# SELF-CONTAINED CLEANUP (L-058): every row this block writes carries 'smoke-test-ferment-<run>' (batch label, jar
# notes/label, place label, line labels) or hangs off a row that does — with ONE exception, P1b's recipe, which is
# named 'smoke-test-recipe-<run>' and is recipes_sweep's to hard-delete (defined just above this block, so cleanup()
# can run it when the run dies before block T does). ferm_sweep hard-deletes the rest in FK order,
# in ONE transaction: reversing pantry_use → pantry_use → kitchen_batch_input → preservation_source →
# preservation_log → kitchen_stage_log → kitchen_batch → storage_location. kitchen_stage_log goes AFTER
# preservation_log (a jar names its put_up row, preservation_log.put_up_stage_id, NO ACTION) — 06 §5.6's listed
# order puts it before, which would 23503. It runs at the end of the block and again from cleanup() if the run
# dies in between (FERM_DIRTY).
FERM_DIRTY=false
ferm_sweep() {
  [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1 || return 1
  psql "$NEON_STAGING_URL" -X -q -1 -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE fe_b ON COMMIT DROP AS SELECT id FROM kitchen_batch WHERE label LIKE 'smoke-test-ferment-%';
CREATE TEMP TABLE fe_j ON COMMIT DROP AS SELECT id FROM preservation_log
  WHERE notes LIKE 'smoke-test-ferment-%' OR label LIKE 'smoke-test-ferment-%' OR batch_id IN (SELECT id FROM fe_b);
CREATE TEMP TABLE fe_l ON COMMIT DROP AS SELECT id FROM kitchen_batch_input
  WHERE batch_id IN (SELECT id FROM fe_b) OR preservation_log_id IN (SELECT id FROM fe_j) OR output_id IN (SELECT id FROM fe_j);
DELETE FROM pantry_use WHERE reverses_use_id IS NOT NULL
  AND (preservation_log_id IN (SELECT id FROM fe_j) OR kitchen_batch_input_id IN (SELECT id FROM fe_l));
DELETE FROM pantry_use WHERE preservation_log_id IN (SELECT id FROM fe_j) OR kitchen_batch_input_id IN (SELECT id FROM fe_l);
DELETE FROM kitchen_batch_input WHERE id IN (SELECT id FROM fe_l);
DELETE FROM preservation_source WHERE preservation_log_id IN (SELECT id FROM fe_j);
DELETE FROM preservation_log WHERE id IN (SELECT id FROM fe_j);
DELETE FROM kitchen_stage_log WHERE batch_id IN (SELECT id FROM fe_b);
DELETE FROM kitchen_batch WHERE id IN (SELECT id FROM fe_b);
DELETE FROM storage_location WHERE label LIKE 'smoke-test-ferment-%';
SQL
}
# I1: from the checked-out tree (this script's own repo root, so the working directory cannot matter).
FE_TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -d "$FE_TREE/migrations/v5-fermentpath-001" ]] && SMOKE_REQUIRE_FERMENT=1
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" && -n "${STAGING_API_STORAGE_LOCATIONS:-}" ]]; then
  FE_BASE="${STAGING_API_PRESERVATION%/}"
  FE_TAG="smoke-test-ferment-$TEST_RUN_ID"
  FE_DAY=$(TZ=America/New_York date +%Y-%m-%d)
  FE_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  fe_uuid() { local u; u=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid); echo "$u" | tr 'A-Z' 'a-z'; }
  # fe_req METHOD URL [BODY] → FE_CODE (HTTP status or 000) and FE_OUT (the body, a temp file; fe_req removes the last one)
  FE_OUT=""
  fe_req() {
    [[ -n "$FE_OUT" ]] && rm -f "$FE_OUT"
    FE_OUT=$(mktemp)
    if [[ -n "${3:-}" ]]; then
      FE_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$FE_OUT" -w "%{http_code}" "$2" -d "$3") || FE_CODE="000"
    else
      FE_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$FE_OUT" -w "%{http_code}" "$2") || FE_CODE="000"
    fi
  }
  fe_jq() { jq -rc "$1" "$FE_OUT" 2>/dev/null || echo "unparseable"; }
  fe_jqx() { jq -rc --arg x "$1" "$2" "$FE_OUT" 2>/dev/null || echo "unparseable"; }   # fe_jqx <value of $x> <filter>
  fe_pass() { echo "✅ PASS [ferment:$1] $2"; PASS=$((PASS+1)); }
  fe_fail() { echo "❌ FAIL [ferment:$1] $2"; FAIL=$((FAIL+1)); }
  fe_check() { if [[ "$2" == "$3" ]]; then fe_pass "$1" "$4 → '$2'"; else fe_fail "$1" "$4 → '$2' (expected '$3')"; fi; }
  # fe_row <sql> → one row, '|'-separated, or 'sql-error'. Ids reach SQL only after matching FE_UUID_RE.
  fe_row() { psql "$NEON_STAGING_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || echo "sql-error"; }
  fe_id_ok() { [[ "${1:-}" =~ $FE_UUID_RE ]]; }
  fe_jar() { fe_id_ok "$1" && fe_row "SELECT coalesce(remaining_count::text,'null')||'|'||coalesce(remaining_amount::numeric(12,2)::text,'null')||'|'||(consumed_at IS NOT NULL)::text FROM preservation_log WHERE id = '$1'" || echo "bad-id"; }
  # POST one keyed line to a batch; FE_LINE_ID = the line's id read back by its key.
  fe_line() {
    local k; k=$(fe_uuid)
    fe_req POST "$FE_BASE/api/kitchen-batches/$1/inputs" "{\"inputs\": [$(echo "$2" | jq -c --arg k "$k" '. + {idempotency_key: $k}')]}"
    FE_LINE_ID=$(fe_row "SELECT id FROM kitchen_batch_input WHERE idempotency_key = '$k'")
  }
  # A new batch (201 → id) and a jar (POST /api/preservation → id), both carrying the tag.
  fe_batch() { fe_req POST "$FE_BASE/api/kitchen-batches" "{\"label\": \"$FE_TAG $1\", \"kind\": \"ferment\", \"idempotency_key\": \"$(fe_uuid)\"}"; fe_jq '.id // empty'; }
  fe_newjar() {  # fe_newjar <qty> <unit> <count> [use_by] → id
    local ub=""; [[ -n "${4:-}" ]] && ub=", \"use_by_target\": \"$4\""
    fe_req POST "$FE_BASE/api/preservation" "{\"crop_type_slug\": \"tomato\", \"method\": \"whole_freeze\", \"quantity_value\": $1, \"quantity_unit\": \"$2\", \"package_count\": $3, \"preserved_at\": \"$FE_DAY\", \"preserved_at_approx\": false, \"source_kind\": \"own_garden\", \"storage_location_id\": \"$FE_PLACE\", \"notes\": \"$FE_TAG\"$ub}"
    fe_jq '.id // empty'
  }

  CLERK_JWT=$(mint_session_token)
  fe_req GET "$FE_BASE/api/kitchen-batches/line-search?q=smoke"
  if [[ "$FE_CODE" != "200" ]]; then
    if [[ "${SMOKE_REQUIRE_FERMENT:-}" == "1" ]]; then
      fe_fail "deployed" "GET /api/kitchen-batches/line-search → HTTP $FE_CODE: this tree carries F (or SMOKE_REQUIRE_FERMENT=1), but F's Lambda is not answering on staging"
    else
      echo "⚠️  WARN [ferment:deployed] GET /api/kitchen-batches/line-search → HTTP $FE_CODE — this tree has no F (no migrations/v5-fermentpath-001); block P NOT run"
    fi
  elif [[ -z "${NEON_STAGING_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
    fe_fail "readback-sql" "NEON_STAGING_URL unset or psql missing — block P reads stock back through SQL and cleans up through it"
  else
    FERM_DIRTY=true
    fe_req POST "${STAGING_API_STORAGE_LOCATIONS%/}/api/storage-locations" "{\"label\": \"$FE_TAG place\", \"kind\": \"fridge\"}"
    FE_PLACE=$(fe_jq '.id // empty')
    if ! fe_id_ok "$FE_PLACE"; then
      fe_fail "place" "POST /storage-locations → HTTP $FE_CODE (no id)"
    else
      FE_LATER=$(fe_row "SELECT (CURRENT_DATE + 60)::text")
      FE_OTHER_DAY=$(fe_row "SELECT (CURRENT_DATE + 90)::text")

      # ── P1) put-up (1b): date + basis read back; a differing-date legacy PUT refused; an equal echo a no-op ──
      CLERK_JWT=$(mint_session_token)
      FE_B1=$(fe_batch "P1")
      FE_PU_KEY=$(fe_uuid)
      fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B1/put-up" "{\"idempotency_key\": \"$FE_PU_KEY\", \"when\": {\"date\": \"$FE_DAY\", \"precision\": \"day\"}, \"method\": \"ferment\", \"rows\": [{\"count\": 2, \"container_label\": \"pint\", \"size_value\": 450, \"size_unit\": \"g\", \"place\": {\"id\": \"$FE_PLACE\"}, \"name\": \"$FE_TAG P1\", \"discard_by\": \"$FE_LATER\"}], \"made_g\": 900, \"finish\": false}"
      FE_J1=$(fe_jq '.jars[0].id // empty')
      if [[ "$FE_CODE" == "201" ]] && fe_id_ok "$FE_J1"; then
        fe_check "p1-putup-readback" "$(fe_row "SELECT preserved_at::text||'|'||coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id = '$FE_J1'")" "$FE_DAY|typed|$FE_LATER" "put-up → HTTP 201; the jar's date|basis|discard-by"
        fe_req GET "$FE_BASE/api/preservation/$FE_J1"
        FE_ROW=$(fe_jq '{crop_type_slug, variety_id, plant_id, harvest_log_id, preserved_at, preserved_at_approx, method, method_other_text, quantity_value, quantity_unit, package_count, storage_location_id, use_by_target, remaining_count, consumed_at, notes, photo_id, source_kind, source_label}')
        FE_BEFORE=$(fe_row "SELECT preserved_at::text||'|'||coalesce(remaining_count::text,'null')||'|'||coalesce(notes,'null') FROM preservation_log WHERE id = '$FE_J1'")
        fe_req PUT "$FE_BASE/api/preservation/$FE_J1" "$(echo "$FE_ROW" | jq -c --arg d "$FE_OTHER_DAY" '.use_by_target = $d')"
        fe_check "p1-legacy-date-refused" "$FE_CODE $(fe_jq '.code // "-"') $(fe_row "SELECT use_by_target::text FROM preservation_log WHERE id = '$FE_J1'")" "409 client_stale $FE_LATER" "legacy PUT with a different discard-by; the stored one after"
        fe_req PUT "$FE_BASE/api/preservation/$FE_J1" "$FE_ROW"
        fe_check "p1-legacy-echo-noop" "$FE_CODE $(fe_row "SELECT preserved_at::text||'|'||coalesce(remaining_count::text,'null')||'|'||coalesce(notes,'null') FROM preservation_log WHERE id = '$FE_J1'")" "200 $FE_BEFORE" "untouched legacy echo; date|remaining|notes after"
      else
        fe_fail "p1-putup-readback" "POST /put-up → HTTP $FE_CODE: $(head -c 200 "$FE_OUT")"
      fi

      # ── P1b) clear a typed discard date: the engine's date with no recipe, the recipe's on a batch that follows one ──
      # Put-Up UX pass R1. PATCH /api/preservation/:id {"discard_by": "clear"} resolves by the whole discard-by rule: a
      # moved jar → no date; else the recipe's "how long, and where" when its storage kind is the jar's place kind; else
      # the engine. Two clears, each read back through SQL as basis|discard-by, before → after:
      #   * P1's jar (a ferment in a fridge, typed above; its batch follows no recipe) → table|the day + 6 months
      #     (shelfLife.js: ferment, fridge). It runs AFTER P1's legacy-PUT checks, which need the typed date in place.
      #   * a recipe that says "Fridge · 7 days", a batch that follows it, a typed fridge row on that batch → recipe|the
      #     day + 7. A Lambda from before this release answers table here, which is the signal wanted.
      # The recipe is named smoke-test-recipe-<run> so recipes_sweep owns it. That sweep and its flag are defined above
      # this block: block T runs it at its end (every recipe with the prefix), and if the run dies before that, cleanup()
      # runs it, because the flag is raised here before the POST and nothing lowers it until a sweep has succeeded. The
      # batch and its jar carry this block's tag, so ferm_sweep takes them first; cleanup() sweeps ferment before
      # recipes, the order kitchen_batch.recipe_id (NO ACTION) needs. The recipe is also removed through its own route
      # here (a soft delete, the API cleanup): a belt only, since a soft-deleted row is still a row and it is the sweep
      # that removes it. Expected dates are Postgres's own date arithmetic, not the Lambda's.
      CLERK_JWT=$(mint_session_token)
      FE_BASIS_SQL="SELECT coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id ="
      if fe_id_ok "$FE_J1"; then
        FE_WAS=$(fe_row "$FE_BASIS_SQL '$FE_J1'")
        fe_req PATCH "$FE_BASE/api/preservation/$FE_J1" '{"discard_by": "clear"}'
        fe_check "p1b-clear-table" "$FE_WAS → $FE_CODE $(fe_row "$FE_BASIS_SQL '$FE_J1'")" "typed|$FE_LATER → 200 table|$(fe_row "SELECT (DATE '$FE_DAY' + INTERVAL '6 months')::date::text")" "clear on P1's typed jar (no recipe); basis|discard-by before → after"
      else
        fe_fail "p1b-clear-table" "no jar from P1's put-up to clear"
      fi
      RECIPES_DIRTY=true
      fe_req POST "$FE_BASE/api/recipes" "{\"idempotency_key\": \"$(fe_uuid)\", \"name\": \"smoke-test-recipe-$TEST_RUN_ID clear\", \"keeps\": {\"n\": 7, \"unit\": \"day\", \"storage_kind\": \"fridge\"}}"
      FE_RCP=$(fe_jq '.recipe.id // empty')
      FE_J1B=""
      if [[ "$FE_CODE" == "201" ]] && fe_id_ok "$FE_RCP"; then
        fe_req POST "$FE_BASE/api/kitchen-batches" "{\"label\": \"$FE_TAG P1b\", \"kind\": \"ferment\", \"recipe_id\": \"$FE_RCP\", \"idempotency_key\": \"$(fe_uuid)\"}"
        FE_B1B=$(fe_jq '.id // empty')
        fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B1B/put-up" "{\"idempotency_key\": \"$(fe_uuid)\", \"when\": {\"date\": \"$FE_DAY\", \"precision\": \"day\"}, \"method\": \"ferment\", \"rows\": [{\"count\": 1, \"place\": {\"id\": \"$FE_PLACE\"}, \"name\": \"$FE_TAG P1b\", \"discard_by\": \"$FE_LATER\"}], \"finish\": false}"
        FE_J1B=$(fe_jq '.jars[0].id // empty')
      fi
      if fe_id_ok "$FE_J1B"; then
        FE_WAS=$(fe_row "$FE_BASIS_SQL '$FE_J1B'")
        fe_req PATCH "$FE_BASE/api/preservation/$FE_J1B" '{"discard_by": "clear"}'
        fe_check "p1b-clear-recipe" "$FE_WAS → $FE_CODE $(fe_row "$FE_BASIS_SQL '$FE_J1B'")" "typed|$FE_LATER → 200 recipe|$(fe_row "SELECT (DATE '$FE_DAY' + 7)::text")" "a typed fridge row on a batch that follows a \"Fridge · 7 days\" recipe, then clear; basis|discard-by before → after"
      else
        fe_fail "p1b-clear-recipe" "no typed jar on a recipe batch to clear (last request → HTTP $FE_CODE): $(head -c 200 "$FE_OUT")"
      fi
      if fe_id_ok "$FE_RCP"; then
        fe_req DELETE "$FE_BASE/api/recipes/$FE_RCP"
        [[ "$FE_CODE" == "200" ]] || echo "⚠️  WARN [ferment:p1b-recipe-delete] DELETE /api/recipes/:id → HTTP $FE_CODE (recipes_sweep removes it)"
      fi

      # ── P2) batch → typed line → salt line; the salt facts read back ──
      CLERK_JWT=$(mint_session_token)
      FE_B2=$(fe_batch "P2")
      fe_line "$FE_B2" "{\"input_kind\": \"other\", \"label\": \"$FE_TAG cabbage\", \"qty\": 1000, \"qty_unit\": \"g\"}"
      fe_line "$FE_B2" "{\"input_kind\": \"other\", \"label\": \"$FE_TAG salt\", \"role\": \"salt\", \"qty\": 20, \"qty_unit\": \"g\", \"salt_pct\": 2, \"salt_base\": \"produce\", \"base_g\": 1000, \"salt_method\": \"dry\", \"base_from\": \"lines\"}"
      FE_SALT="$FE_LINE_ID"
      fe_req GET "$FE_BASE/api/kitchen-batches/$FE_B2"
      fe_check "p2-salt-readback" "$(fe_jqx "$FE_SALT" '.inputs[] | select(.id == $x) | "\(.salt_pct|tonumber)|\(.salt_base)|\(.base_g|tonumber)|\(.salt_method)|\(.base_from)"')" "2|produce|1000|dry|lines" "salt line on the batch GET"

      # ── P3) counted draw → F Mark used → F note edit through PATCH (the drawn jar stays usable) ──
      CLERK_JWT=$(mint_session_token)
      FE_J3=$(fe_newjar 3 "jar" 4)
      fe_line "$FE_B2" "{\"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J3\", \"count_drawn\": 1}"
      FE_DRAW3="$FE_LINE_ID"
      fe_check "p3-draw" "$FE_CODE $(fe_jar "$FE_J3")" "201 3|null|false" "counted draw of 1 from 4; remaining|grams|consumed"
      # I2 (review-F-prepromote-early; 06 §1.3 item 6 case c): a stale 1a phone's Mark used on the DRAWN jar — the
      # full nineteen-key buildFullPayload echo (block N's pu_put shape), remaining_count n-1 — is refused 409
      # client_stale by the delta_at predicate (every other value is the stored one), and the count and delta_at are
      # exactly as the draw left them.
      if fe_id_ok "$FE_J3"; then
        FE_STALE_SQL="SELECT coalesce(remaining_count::text,'null')||'|'||coalesce(delta_at::text,'null') FROM preservation_log WHERE id = '$FE_J3'"
        FE_BEFORE=$(fe_row "$FE_STALE_SQL")
        fe_req GET "$FE_BASE/api/preservation/$FE_J3"
        FE_ROW=$(fe_jq '{crop_type_slug, variety_id, plant_id, harvest_log_id, preserved_at, preserved_at_approx, method, method_other_text, quantity_value, quantity_unit, package_count, storage_location_id, use_by_target, remaining_count, consumed_at, notes, photo_id, source_kind, source_label} | .remaining_count = (.remaining_count - 1)')
        fe_req PUT "$FE_BASE/api/preservation/$FE_J3" "$FE_ROW"
        fe_check "p3-legacy-stale-refused" "$FE_CODE $(fe_jq '.code // "-"') $(fe_row "$FE_STALE_SQL")" "409 client_stale $FE_BEFORE" "1a full-echo PUT, remaining_count n-1, on the drawn jar; remaining|delta_at after"
      else
        fe_fail "p3-legacy-stale-refused" "no jar id from P3's POST /api/preservation"
      fi
      fe_req POST "$FE_BASE/api/pantry/uses" "{\"idempotency_key\": \"$(fe_uuid)\", \"preservation_log_id\": \"$FE_J3\", \"count_used\": 1}"
      fe_check "p3-mark-used" "$FE_CODE $(fe_jar "$FE_J3")" "201 2|null|false" "F Mark used (POST /api/pantry/uses)"
      fe_req PATCH "$FE_BASE/api/preservation/$FE_J3" "{\"notes\": \"$FE_TAG edited\"}"
      fe_check "p3-note-edit" "$FE_CODE $(fe_jar "$FE_J3") $(fe_row "SELECT coalesce(notes,'null') FROM preservation_log WHERE id = '$FE_J3'")" "200 2|null|false $FE_TAG edited" "F note edit (PATCH /api/preservation/:id); remaining|grams|consumed, then the note"

      # ── P4) weighed: 8 g → 92 g; the rest → 0 g, used up, gone from use-soon ──
      CLERK_JWT=$(mint_session_token)
      FE_J4=$(fe_newjar 100 "g" 1 "$FE_DAY")   # use-by today: classifyUseBy's zero span reads use_soon
      fe_req GET "$FE_BASE/api/preservation/use-soon"
      FE_LISTED_BEFORE=$(fe_jqx "$FE_J4" 'any(.items[]; .id == $x)')
      fe_line "$FE_B2" "{\"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J4\", \"qty\": 8, \"qty_unit\": \"g\"}"
      fe_check "p4-weighed-draw" "$FE_CODE $(fe_jar "$FE_J4")" "201 1|92.00|false" "8 g from a 100 g bag (POST seeded remaining 1 and 100 g; a gram draw leaves the count)"
      fe_line "$FE_B2" "{\"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J4\", \"qty\": 92, \"qty_unit\": \"g\"}"
      fe_req GET "$FE_BASE/api/preservation/use-soon"
      fe_check "p4-draw-to-zero" "$(fe_jar "$FE_J4") listed-before:$FE_LISTED_BEFORE listed-after:$(fe_jqx "$FE_J4" 'any(.items[]; .id == $x)')" "0|0.00|true listed-before:true listed-after:false" "the other 92 g; use-soon before/after"

      # ── P5) take P3's line out → count back; restore → drawn again ──
      CLERK_JWT=$(mint_session_token)
      if fe_id_ok "$FE_DRAW3"; then
        fe_req DELETE "$FE_BASE/api/kitchen-batches/$FE_B2/inputs/$FE_DRAW3"
        fe_check "p5-take-out" "$FE_CODE $(fe_jar "$FE_J3")" "200 3|null|false" "take the draw line out"
        fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B2/inputs/$FE_DRAW3/restore"
        fe_check "p5-restore" "$FE_CODE $(fe_jar "$FE_J3")" "200 2|null|false" "restore it"
      else
        fe_fail "p5-take-out" "no draw line from P3 to take out"
      fi

      # ── P6) a check-in, then PATCH its note → edited_at ──
      CLERK_JWT=$(mint_session_token)
      fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B2/stages" "{\"stage_kind\": \"tended\", \"acts\": [\"pushed_under\"], \"note\": \"$FE_TAG check-in\"}"
      FE_STAGE=$(fe_jq '.stage.id // empty')
      if fe_id_ok "$FE_STAGE"; then
        fe_req PATCH "$FE_BASE/api/kitchen-batches/$FE_B2/stages/$FE_STAGE" "{\"note\": \"$FE_TAG check-in, film on top\"}"
        fe_check "p6-stage-edit" "$FE_CODE $(fe_row "SELECT (edited_at IS NOT NULL)::text||'|'||note FROM kitchen_stage_log WHERE id = '$FE_STAGE'")" "200 true|$FE_TAG check-in, film on top" "PATCH the check-in note; edited_at|note"
      else
        fe_fail "p6-stage-edit" "POST /stages → HTTP $FE_CODE (no stage id)"
      fi

      # ── P7) SHU: work it out, save, read basis computed ──
      CLERK_JWT=$(mint_session_token)
      FE_B7=$(fe_batch "P7")
      fe_line "$FE_B7" "{\"input_kind\": \"purchased\", \"label\": \"$FE_TAG jalapeno\", \"qty\": 170, \"qty_unit\": \"g\", \"form\": \"fresh\", \"shu_rating_low\": 2500, \"shu_rating_high\": 8000}"
      fe_line "$FE_B7" "{\"input_kind\": \"other\", \"label\": \"$FE_TAG onion\", \"qty\": 28, \"qty_unit\": \"g\"}"
      fe_line "$FE_B7" "{\"input_kind\": \"other\", \"label\": \"Water\", \"role\": \"water\", \"qty\": 250, \"qty_unit\": \"ml\"}"
      fe_req GET "$FE_BASE/api/kitchen-batches/$FE_B7/shu-estimate?scope=batch"
      FE_EST=$(fe_jq '"\(.denominator_g|tonumber)"')
      fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B7/shu-estimate/save" '{"scope": "batch"}'
      fe_check "p7-shu-save" "$FE_CODE denominator:$FE_EST $(fe_row "SELECT shu_est_low||'|'||shu_est_high||'|'||shu_est_basis FROM kitchen_batch WHERE id = '$FE_B7'")" "200 denominator:448 949|3036|computed" "shu-estimate over 448 g, then save"

      # ── P8) put-up with row shu + cooked + a sitting line drawing 8 g from a reaper bag → Undo → grams back ──
      CLERK_JWT=$(mint_session_token)
      FE_B8=$(fe_batch "P8")
      FE_J8=$(fe_newjar 100 "g" 1)
      fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B8/put-up" "{\"idempotency_key\": \"$(fe_uuid)\", \"when\": {\"date\": \"$FE_DAY\", \"precision\": \"day\"}, \"method\": \"ferment\", \"rows\": [{\"count\": 1, \"container_label\": \"woozy\", \"size_value\": 250, \"size_unit\": \"g\", \"place\": {\"id\": \"$FE_PLACE\"}, \"name\": \"$FE_TAG P8\", \"shu_est_low\": 16000, \"shu_est_high\": 23000, \"cooked\": true}], \"sitting_lines\": [{\"idempotency_key\": \"$(fe_uuid)\", \"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J8\", \"qty\": 8, \"qty_unit\": \"g\"}], \"made_g\": 250, \"finish\": true}"
      FE_S8=$(fe_jq '.stage.id // empty')
      FE_R8=$(fe_jq '.jars[0].id // empty')
      if [[ "$FE_CODE" == "201" ]] && fe_id_ok "$FE_S8" && fe_id_ok "$FE_R8"; then
        fe_check "p8-putup-row" "$(fe_row "SELECT shu_est_low||'|'||shu_est_high||'|'||shu_est_basis||'|'||cooked FROM preservation_log WHERE id = '$FE_R8'")|$(fe_jar "$FE_J8")" "16000|23000|typed|true|1|92.00|false" "row shu|basis|cooked, then the bag"
        fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B8/put-up/$FE_S8/undo"
        fe_check "p8-undo" "$FE_CODE $(fe_jar "$FE_J8") $(fe_row "SELECT (deleted_at IS NOT NULL)::text FROM preservation_log WHERE id = '$FE_R8'")" "200 1|100.00|false true" "Undo that put-up; bag, then the row jar removed"
      else
        fe_fail "p8-putup-row" "POST /put-up → HTTP $FE_CODE: $(head -c 200 "$FE_OUT")"
      fi

      # ── P9) remove a batch → its draw is reversed ──
      CLERK_JWT=$(mint_session_token)
      FE_B9=$(fe_batch "P9")
      FE_J9=$(fe_newjar 2 "jar" 3)
      fe_line "$FE_B9" "{\"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J9\", \"count_drawn\": 1}"
      fe_line "$FE_B9" "{\"input_kind\": \"put_up\", \"preservation_log_id\": \"$FE_J9\", \"count_drawn\": 1}"
      FE_MID=$(fe_jar "$FE_J9")
      fe_req DELETE "$FE_BASE/api/kitchen-batches/$FE_B9"
      fe_check "p9-batch-remove" "$FE_MID → $FE_CODE $(fe_jar "$FE_J9")" "1|null|false → 200 3|null|false" "two draws of 1 from 3 (one jar, F1), then remove the batch"

      # ── P10) Raw at create: POST /api/preservation stores is_raw, and a Raw jar in a fridge gets no date ──
      # Put-Up UX pass R1: Walk a place starts sending is_raw / in_oil to this endpoint. It ignores a key it does not
      # know, so a misspelt one would answer 201, store nothing, and the jar would take the general figure. Hot sauce has
      # a fridge figure (basis table without Raw), so both halves show: is_raw stored true, and the basis none.
      CLERK_JWT=$(mint_session_token)
      fe_req POST "$FE_BASE/api/preservation" "{\"crop_type_slug\": \"tomato\", \"method\": \"hot_sauce\", \"quantity_value\": 1, \"quantity_unit\": \"jar\", \"package_count\": 1, \"preserved_at\": \"$FE_DAY\", \"preserved_at_approx\": false, \"source_kind\": \"own_garden\", \"storage_location_id\": \"$FE_PLACE\", \"notes\": \"$FE_TAG\", \"is_raw\": true}"
      FE_J10=$(fe_jq '.id // empty')
      if [[ "$FE_CODE" == "201" ]] && fe_id_ok "$FE_J10"; then
        fe_check "p10-raw-create" "$(fe_row "SELECT coalesce(is_raw::text,'null')||'|'||coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id = '$FE_J10'")" "true|none|null" "POST /api/preservation with is_raw true at a fridge place → HTTP 201; is_raw|basis|discard-by"
      else
        fe_fail "p10-raw-create" "POST /api/preservation → HTTP $FE_CODE: $(head -c 200 "$FE_OUT")"
      fi

      # ── P11) How it was made: a batch made FROM a jar that already exists, and its replay ──
      # Put-Up R2a (V5-PUTUPLOGRETIRE-001). POST /api/kitchen-batches/from-jars had no smoke: one statement makes a
      # batch that is already closed as put_up and links the jar to it by batch_id. Read back through the JAR (its
      # batch is closed, its outcome put_up, its label the one sent), so the check does not rest on the answer's
      # shape. The same body again → 200 replayed, and still one batch on the key. Three requests on P10's token: no
      # mint of its own. The batch's label and the jar's notes carry $FE_TAG, so ferm_sweep takes both (jars before
      # batches, as kitchen_batch's NO ACTION link from preservation_log.batch_id needs).
      FE_J11=$(fe_newjar 2 "jar" 3)
      if fe_id_ok "$FE_J11"; then
        FE_FJ_KEY=$(fe_uuid)
        FE_FJ_BODY="{\"idempotency_key\": \"$FE_FJ_KEY\", \"label\": \"$FE_TAG from-jars\", \"started\": {\"date\": \"$FE_DAY\", \"precision\": \"day\"}, \"kind\": \"ferment\", \"jar_ids\": [\"$FE_J11\"]}"
        fe_req POST "$FE_BASE/api/kitchen-batches/from-jars" "$FE_FJ_BODY"
        fe_check "p11-from-jars" "$FE_CODE $(fe_row "SELECT (b.closed_at IS NOT NULL)::text||'|'||b.outcome||'|'||b.label FROM preservation_log p JOIN kitchen_batch b ON b.id = p.batch_id WHERE p.id = '$FE_J11'")" "201 true|put_up|$FE_TAG from-jars" "POST /api/kitchen-batches/from-jars; the jar's batch: closed|outcome|label"
        fe_req POST "$FE_BASE/api/kitchen-batches/from-jars" "$FE_FJ_BODY"
        fe_check "p11-replay" "$FE_CODE $(fe_jq '.replayed') $(fe_row "SELECT count(*) FROM kitchen_batch WHERE idempotency_key = '$FE_FJ_KEY'")" "200 true 1" "the same POST, same key; replayed, batches on the key"
      else
        fe_fail "p11-from-jars" "no jar id from POST /api/preservation (HTTP $FE_CODE)"
      fi

      CLERK_JWT=$(mint_session_token)

      # ── P12) Take it off this batch, and its Undo: the two outputs routes ──
      # BUG-BATCHREMOVEDEADEND-001. Batch detail's "Take it off this batch" is the first screen to call DELETE
      # /api/kitchen-batches/:id/outputs/:plid, and its "Taken off · Undo" the first to call POST /:id/outputs; neither
      # route had a smoke. On P11's batch, which is closed and holds its jar by batch_id alone (the shape the close
      # sheet's jar picker makes too): unlink → the jar is live and on no batch; link again → the answer counts 1 and
      # the jar is on that batch again. The batch id is read from the JAR before the unlink, so the last check compares
      # the link to what it was, not to the answer's shape. Two requests on the mint above: block P gains no mint, and
      # block Q, which starts on this token, gets it a few seconds older. P11's rows are the only ones touched and
      # they end as P11 left them, so ferm_sweep is unchanged.
      FE_B11=$(fe_row "SELECT batch_id FROM preservation_log WHERE id = '${FE_J11:-}'")
      if fe_id_ok "$FE_B11"; then
        fe_req DELETE "$FE_BASE/api/kitchen-batches/$FE_B11/outputs/$FE_J11"
        fe_check "p12-take-off" "$FE_CODE $(fe_row "SELECT coalesce(batch_id::text,'null')||'|'||(deleted_at IS NULL)::text FROM preservation_log WHERE id = '$FE_J11'")" "200 null|true" "DELETE /api/kitchen-batches/:id/outputs/:plid; the jar's batch|live"
        fe_req POST "$FE_BASE/api/kitchen-batches/$FE_B11/outputs" "{\"preservation_log_ids\": [\"$FE_J11\"]}"
        fe_check "p12-put-back" "$FE_CODE $(fe_jq '.linked') $(fe_row "SELECT (batch_id = '$FE_B11')::text||'|'||(deleted_at IS NULL)::text FROM preservation_log WHERE id = '$FE_J11'")" "200 1 true|true" "POST /api/kitchen-batches/:id/outputs; linked, then the jar on that batch|live"
      else
        fe_fail "p12-take-off" "P11's jar names no batch (from-jars did not link it)"
      fi
    fi
    if ferm_sweep; then
      FERM_DIRTY=false
      FE_LEFT=$(fe_row "SELECT (SELECT count(*) FROM kitchen_batch WHERE label LIKE 'smoke-test-ferment-%') + (SELECT count(*) FROM preservation_log WHERE notes LIKE 'smoke-test-ferment-%' OR label LIKE 'smoke-test-ferment-%') + (SELECT count(*) FROM storage_location WHERE label LIKE 'smoke-test-ferment-%')")
      fe_check "l058-sweep" "$FE_LEFT" "0" "hard-delete of every smoke-test-ferment row, FK order, one transaction; residue"
    else
      fe_fail "l058-sweep" "ferm_sweep failed — smoke-test-ferment rows may remain on staging (cleanup() retries)"
    fi
  fi
  [[ -n "$FE_OUT" ]] && rm -f "$FE_OUT"
elif [[ "${SMOKE_REQUIRE_FERMENT:-}" == "1" ]]; then
  echo "❌ FAIL [ferment:deployed] this tree carries F (or SMOKE_REQUIRE_FERMENT=1), but block P could not run: STAGING_API_PRESERVATION or STAGING_API_STORAGE_LOCATIONS unset, or no JWT"
  FAIL=$((FAIL+1))
else
  echo "⚠️  WARN [ferment] STAGING_API_PRESERVATION or STAGING_API_STORAGE_LOCATIONS unset, or no JWT — block P NOT run"
fi


# ── Q) A source's contact links: PATCH → GET read-back → refused bad link → PATCH to null → read-back
#       (V5-SOURCECONTACT-001; L-108) — Phase 2, continued ─────────────────────────────────────────────
# public.source has no DELETE (the route answers 405), so the block reuses ONE fixed-name row: POST it, and a
# 409 {reason:'exists', existing} hands back existing.id (a soft-deleted one comes back 200, restored). The
# smoke account created that row, so canEditSource (lambda/varieties/authz.js) lets it PATCH even when it is
# not a household member. Links are run-unique, so a leftover from a run that died mid-block cannot pass a
# read-back vacuously. The read-back also asserts the name is untouched (the PATCH is partial). RESTORE: both
# links back to null, read back; cleanup() repeats it if the run dies in between (SRC_DIRTY). No L-058 sweep
# line: the row is meant to persist. The list GET is a bare array (resp(200, rows)).
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_VARIETIES:-}" ]]; then
  SRC_BASE="${STAGING_API_VARIETIES%/}/api/varieties/sources"
  SRC_NAME="Smoke Contact Source"
  src_patch() {                       # src_patch <json-body> -> prints the HTTP status
    local code
    code=$(curl -s --max-time 30 --connect-timeout 10 -X PATCH \
      -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
      -o /dev/null -w "%{http_code}" "$SRC_BASE/$SRC_ID" -d "$1") || code="000"
    echo "$code"
  }
  src_get() {                         # src_get <jq-filter> -> "<http> <filtered body, compact>"
    local TMP code
    TMP=$(mktemp)
    code=$(curl -s --compressed --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" \
      -o "$TMP" -w "%{http_code}" "$SRC_BASE/$SRC_ID") || code="000"
    echo "$code $(jq -c "$1" "$TMP" 2>/dev/null || echo unreadable)"
    rm -f "$TMP"
  }
  CLERK_JWT=$(mint_session_token)

  # Q0) find-or-create the fixed-name row. The stored name is taken from the answer: a 409 names the row
  # that already holds this match_key, whose casing may differ.
  SRC_B=$(mktemp)
  SRC_HTTP=$(curl -s --max-time 30 --connect-timeout 10 -X POST \
    -H "Authorization: Bearer $CLERK_JWT" -H "Content-Type: application/json" \
    -o "$SRC_B" -w "%{http_code}" "$SRC_BASE" -d "{\"name\": \"$SRC_NAME\"}") || SRC_HTTP="000"
  SRC_ID=$(jq -r 'if .reason == "exists" then (.existing.id // empty) else (.id // empty) end' "$SRC_B" 2>/dev/null || echo "")
  SRC_STORED_NAME=$(jq -r 'if .reason == "exists" then (.existing.name // empty) else (.name // empty) end' "$SRC_B" 2>/dev/null || echo "")
  SRC_POST_BODY=$(head -c 200 "$SRC_B" 2>/dev/null || echo ""); rm -f "$SRC_B"
  if [[ "$SRC_HTTP" =~ ^(200|201|409)$ && "$SRC_ID" =~ ^[0-9a-fA-F-]{36}$ && -n "$SRC_STORED_NAME" ]]; then
    echo "✅ PASS [crud:POST /varieties/sources (find-or-create)] HTTP $SRC_HTTP, id $SRC_ID"
    PASS=$((PASS+1))
    SRC_TAG=$(echo "$TEST_RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-12)
    SRC_IG="https://www.instagram.com/smoke${SRC_TAG}"
    SRC_FB="https://www.facebook.com/smoke${SRC_TAG}"
    SRC_DIRTY=true

    # Q1) both links → GET by id → equal, name untouched.
    SRC_CODE=$(src_patch "{\"instagram_url\": \"$SRC_IG\", \"facebook_url\": \"$SRC_FB\"}")
    SRC_GOT=$(src_get '[.instagram_url, .facebook_url, .name]')
    SRC_WANT="200 $(jq -c -n --arg ig "$SRC_IG" --arg fb "$SRC_FB" --arg n "$SRC_STORED_NAME" '[$ig, $fb, $n]')"
    if [[ "$SRC_CODE" == "200" && "$SRC_GOT" == "$SRC_WANT" ]]; then
      echo "✅ PASS [write:source-links-readback] read-back == $SRC_IG, $SRC_FB; name untouched"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [write:source-links-readback] PATCH HTTP $SRC_CODE, read-back '$SRC_GOT' (expected '$SRC_WANT')"
      FAIL=$((FAIL+1))
    fi

    # Q2) the list GET (what SourcePicker loads) carries the same links for this row.
    SRC_LIST=$(curl -s --compressed --max-time 30 --connect-timeout 10 -H "Authorization: Bearer $CLERK_JWT" "$SRC_BASE" \
      | jq -c --arg id "$SRC_ID" 'if type == "array" then ([.[] | select(.id == $id) | [.instagram_url, .facebook_url]][0]) else "not-an-array" end' 2>/dev/null || echo "unreadable")
    if [[ "$SRC_LIST" == "[\"$SRC_IG\",\"$SRC_FB\"]" ]]; then
      echo "✅ PASS [read:sources-list-links] list row carries both links"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [read:sources-list-links] list row '$SRC_LIST' (expected [\"$SRC_IG\",\"$SRC_FB\"])"
      FAIL=$((FAIL+1))
    fi

    # Q3) a scheme-less link is refused (400, validateSourcePatch, before any read or write) and changes nothing.
    CLERK_JWT=$(mint_session_token)
    SRC_CODE=$(src_patch '{"instagram_url": "instagram.com/not-a-full-link"}')
    SRC_GOT=$(src_get '.instagram_url')
    if [[ "$SRC_CODE" == "400" && "$SRC_GOT" == "200 \"$SRC_IG\"" ]]; then
      echo "✅ PASS [write:source-link-refused] HTTP 400, stored link unchanged"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [write:source-link-refused] PATCH HTTP $SRC_CODE (expected 400), read-back '$SRC_GOT' (expected 200 \"$SRC_IG\")"
      FAIL=$((FAIL+1))
    fi

    # Q4) restore: null clears both (a present key with null IS a clear on this route), read back.
    SRC_CODE=$(src_patch '{"instagram_url": null, "facebook_url": null}')
    [[ "$SRC_CODE" == "200" ]] && SRC_DIRTY=false
    SRC_GOT=$(src_get '[.instagram_url, .facebook_url]')
    if [[ "$SRC_CODE" == "200" && "$SRC_GOT" == "200 [null,null]" ]]; then
      echo "✅ PASS [write:source-links-restore-readback] both links cleared"
      PASS=$((PASS+1))
    else
      echo "❌ FAIL [write:source-links-restore-readback] PATCH HTTP $SRC_CODE, read-back '$SRC_GOT' (expected 200 [null,null])"
      FAIL=$((FAIL+1))
    fi
  else
    echo "❌ FAIL [crud:POST /varieties/sources (find-or-create)] HTTP $SRC_HTTP, id '$SRC_ID', name '$SRC_STORED_NAME'"
    echo "   Body: $SRC_POST_BODY"
    FAIL=$((FAIL+1))
  fi
elif [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then
  echo "❌ FAIL [write:source-links-readback] STAGING_API_VARIETIES unset or no Clerk session — the ship gate may not skip this assert"
  FAIL=$((FAIL+1))
else
  echo "⚠️  WARN [write:source-links-readback] STAGING_API_VARIETIES unset or no Clerk session — source link assert NOT run"
fi


# ── S) Pantry (B′ release 2): a bought item kept, replayed, used up, removed; a Used one undone — write → read-back
#    (04-design-final V4 §2.5, §4.3, §5.1 rows "2"; 05-release-train §5; L-108) — Phase 2, continued ───────────────
# Block letters: Q and R are STATS's (421a1f9 renamed them off Put-Up's P), so the B′ blocks are S (Pantry) and T
# (recipes). Each sub-block is a write followed by a read-back:
#   S1) POST /api/pantry/items (keyed; filed by storage_location_id in this block's own smoke place) → 201; the row
#       read back through SQL: name|place|acquired_at|used_up_at|deleted_at.
#   S2) the same POST again under the same key → 200 replayed:true with the same id, and still ONE row on that key.
#   S3) GET /api/pantry?place_id=<the place> lists it: stock_kind 'pantry_item', stock_mode 'item', its name, its place.
#   S4) PATCH used_up_at "now" → 200; used_up_at is stamped (SQL).
#   S5) GET /api/pantry?place_id= no longer lists it (the list excludes used-up items).
#   S6) DELETE /api/pantry/items/:id → 200 {ok:true}; deleted_at is stamped (SQL). The item's API cleanup.
#   S7) a second DELETE → 404 not_found (nothing live matches).
#   S8) 05 §5 "Used one then read back remaining and delta_at, Undo": a jar in the same place → POST /api/pantry/uses
#       count_used 1 → remaining −1 and delta_at set → POST /api/pantry/uses/:id/undo → 200, remaining back, delta_at
#       moved past the use, and the reversing row (count −1, reverses_use_id = the use) read back.
#   S9) Put-Up UX pass R1, Went bad as a COUNT, on S8's jar (3 of 3 again): S9a POST /api/pantry/uses count_used 1,
#       fate 'discarded' → 201; the jar reads 2 left and not consumed, the use row 1|discarded. S9b GET
#       /api/pantry?place_id= still lists the jar, with count_left 2. S9c its Undo → 200, 3 left, delta_at moved past
#       the use, and the reversing row −1|discarded|<the use>.
#   S10 to S19) Put-Up R2a: listed where they run, below S9 ("The place, through its own route"). They end with
#       the place's own DELETE: refused while it holds stock (S17), then answered 200 once it is empty, which is this
#       block's API cleanup. Then pantry_sweep runs.
# Stock is read back through SQL (NEON_STAGING_URL + psql), as block P does: used_up_at, deleted_at, delta_at and
# the reversing pantry_use row are on no list projection.
# GATED ON B′ BEING DEPLOYED, the way block P is gated on F: the probe is GET /api/pantry (200 with a rows array only
# from B′'s Lambda). THE REQUIREMENT TRAVELS WITH THE SHA (review-F-prepromote-early I1): a checked-out tree that
# carries migrations/v5-pantry-001 requires this block — the probe failing, or the block not running at all, is a
# FAIL there. Only a tree without release 2 keeps the WARN. SMOKE_REQUIRE_PANTRY=1 still forces it by hand.
# SELF-CONTAINED CLEANUP (L-058): every row this block writes carries 'smoke-test-pantry-<run>' (item name, jar
# notes, place label) or hangs off a row that does. pantry_sweep hard-deletes them in FK order, in ONE transaction:
# reversing pantry_use → pantry_use → preservation_source → preservation_log → pantry_item → storage_location.
# It runs at the end of the block and again from cleanup() if the run dies in between (PANTRY_DIRTY).
PANTRY_DIRTY=false
pantry_sweep() {
  [[ -n "${NEON_STAGING_URL:-}" ]] && command -v psql >/dev/null 2>&1 || return 1
  psql "$NEON_STAGING_URL" -X -q -1 -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE pn_s ON COMMIT DROP AS SELECT id FROM storage_location WHERE label LIKE 'smoke-test-pantry-%';
CREATE TEMP TABLE pn_j ON COMMIT DROP AS SELECT id FROM preservation_log
  WHERE notes LIKE 'smoke-test-pantry-%' OR storage_location_id IN (SELECT id FROM pn_s);
DELETE FROM pantry_use WHERE reverses_use_id IS NOT NULL AND preservation_log_id IN (SELECT id FROM pn_j);
DELETE FROM pantry_use WHERE preservation_log_id IN (SELECT id FROM pn_j);
DELETE FROM preservation_source WHERE preservation_log_id IN (SELECT id FROM pn_j);
DELETE FROM preservation_log WHERE id IN (SELECT id FROM pn_j);
DELETE FROM pantry_item WHERE name LIKE 'smoke-test-pantry-%' OR storage_location_id IN (SELECT id FROM pn_s);
DELETE FROM storage_location WHERE id IN (SELECT id FROM pn_s);
SQL
}
# I1: from the checked-out tree (this script's own repo root, so the working directory cannot matter).
PN_TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -d "$PN_TREE/migrations/v5-pantry-001" ]] && SMOKE_REQUIRE_PANTRY=1
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" && -n "${STAGING_API_STORAGE_LOCATIONS:-}" ]]; then
  PN_BASE="${STAGING_API_PRESERVATION%/}"
  PN_TAG="smoke-test-pantry-$TEST_RUN_ID"
  PN_DAY=$(TZ=America/New_York date +%Y-%m-%d)
  PN_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  pn_uuid() { local u; u=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid); echo "$u" | tr 'A-Z' 'a-z'; }
  # pn_req METHOD URL [BODY] → PN_CODE (HTTP status or 000) and PN_OUT (the body, a temp file; pn_req removes the last one)
  PN_OUT=""
  pn_req() {
    [[ -n "$PN_OUT" ]] && rm -f "$PN_OUT"
    PN_OUT=$(mktemp)
    if [[ -n "${3:-}" ]]; then
      PN_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$PN_OUT" -w "%{http_code}" "$2" -d "$3") || PN_CODE="000"
    else
      PN_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$PN_OUT" -w "%{http_code}" "$2") || PN_CODE="000"
    fi
  }
  pn_jq() { jq -rc "$1" "$PN_OUT" 2>/dev/null || echo "unparseable"; }
  pn_jqx() { jq -rc --arg x "$1" "$2" "$PN_OUT" 2>/dev/null || echo "unparseable"; }   # pn_jqx <value of $x> <filter>
  pn_pass() { echo "✅ PASS [pantry:$1] $2"; PASS=$((PASS+1)); }
  pn_fail() { echo "❌ FAIL [pantry:$1] $2"; FAIL=$((FAIL+1)); }
  pn_check() { if [[ "$2" == "$3" ]]; then pn_pass "$1" "$4 → '$2'"; else pn_fail "$1" "$4 → '$2' (expected '$3')"; fi; }
  # pn_row <sql> → one row, '|'-separated, or 'sql-error'. Ids reach SQL only after matching PN_UUID_RE.
  pn_row() { psql "$NEON_STAGING_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || echo "sql-error"; }
  pn_id_ok() { [[ "${1:-}" =~ $PN_UUID_RE ]]; }
  pn_item() { pn_id_ok "$1" && pn_row "SELECT name||'|'||storage_location_id||'|'||coalesce(acquired_at::text,'null')||'|'||(used_up_at IS NOT NULL)::text||'|'||(deleted_at IS NOT NULL)::text FROM pantry_item WHERE id = '$1'" || echo "bad-id"; }
  # pn_use <use id> → the pantry_use row's 'count|fate' (fate 'null' when eaten), or 'bad-id'
  pn_use() { pn_id_ok "$1" && pn_row "SELECT count_used||'|'||coalesce(fate,'null') FROM pantry_use WHERE id = '$1'" || echo "bad-id"; }
  # pn_listed <item id> → GET /api/pantry?place_id=<the place>; 'kind|mode|name|place' of the item's row, or 'absent'
  pn_listed() {
    pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"
    if [[ "$PN_CODE" != "200" ]]; then echo "HTTP $PN_CODE"; return; fi
    pn_jqx "$1" '[.rows[] | select(.stock_id == $x)] | if length == 0 then "absent" else (.[0] | "\(.stock_kind)|\(.stock_mode)|\(.name)|\(.place.id)") end'
  }

  CLERK_JWT=$(mint_session_token)
  pn_req GET "$PN_BASE/api/pantry"
  if [[ "$PN_CODE" != "200" || "$(pn_jq '.rows | type')" != "array" ]]; then
    if [[ "${SMOKE_REQUIRE_PANTRY:-}" == "1" ]]; then
      pn_fail "deployed" "GET /api/pantry → HTTP $PN_CODE: this tree carries release 2 (or SMOKE_REQUIRE_PANTRY=1), but B′'s Lambda is not answering on staging"
    else
      echo "⚠️  WARN [pantry:deployed] GET /api/pantry → HTTP $PN_CODE — this tree has no release 2 (no migrations/v5-pantry-001); block S NOT run"
    fi
  elif [[ -z "${NEON_STAGING_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
    pn_fail "readback-sql" "NEON_STAGING_URL unset or psql missing — block S reads stock back through SQL and cleans up through it"
  else
    PANTRY_DIRTY=true
    pn_req POST "${STAGING_API_STORAGE_LOCATIONS%/}/api/storage-locations" "{\"label\": \"$PN_TAG place\", \"kind\": \"pantry\"}"
    PN_PLACE=$(pn_jq '.id // empty')
    if ! pn_id_ok "$PN_PLACE"; then
      pn_fail "place" "POST /storage-locations → HTTP $PN_CODE (no id)"
    else
      # ── S1) a keyed create, read back ──
      CLERK_JWT=$(mint_session_token)
      PN_KEY=$(pn_uuid)
      PN_NAME="$PN_TAG capers"
      PN_BODY="{\"idempotency_key\": \"$PN_KEY\", \"name\": \"$PN_NAME\", \"storage_location_id\": \"$PN_PLACE\", \"acquired_at\": \"$PN_DAY\"}"
      pn_req POST "$PN_BASE/api/pantry/items" "$PN_BODY"
      PN_ITEM=$(pn_jq '.item.id // empty')
      if [[ "$PN_CODE" == "201" ]] && pn_id_ok "$PN_ITEM"; then
        pn_check "s1-create-readback" "$(pn_item "$PN_ITEM")" "$PN_NAME|$PN_PLACE|$PN_DAY|false|false" "POST /api/pantry/items → HTTP 201; name|place|acquired_at|used up|deleted"

        # ── S2) the same key again → the same item, replayed; one row on the key ──
        pn_req POST "$PN_BASE/api/pantry/items" "$PN_BODY"
        pn_check "s2-replay" "$PN_CODE $(pn_jq '.replayed') $(pn_jq '.item.id') $(pn_row "SELECT count(*) FROM pantry_item WHERE idempotency_key = '$PN_KEY'")" "200 true $PN_ITEM 1" "the same POST, same key; replayed, id, rows on the key"

        # ── S3) listed in its place ──
        pn_check "s3-listed" "$(pn_listed "$PN_ITEM")" "pantry_item|item|$PN_NAME|$PN_PLACE" "GET /api/pantry?place_id=; kind|mode|name|place"

        # ── S4) Used it up ──
        CLERK_JWT=$(mint_session_token)
        pn_req PATCH "$PN_BASE/api/pantry/items/$PN_ITEM" '{"used_up_at": "now"}'
        pn_check "s4-used-up" "$PN_CODE $(pn_jq '.item.used_up_at != null') $(pn_item "$PN_ITEM")" "200 true $PN_NAME|$PN_PLACE|$PN_DAY|true|false" "PATCH used_up_at \"now\"; stamped in the reply, then the row"

        # ── S5) gone from the list ──
        pn_check "s5-unlisted" "$(pn_listed "$PN_ITEM")" "absent" "GET /api/pantry?place_id= after Used it up"

        # ── S6) Remove (soft) ──
        pn_req DELETE "$PN_BASE/api/pantry/items/$PN_ITEM"
        pn_check "s6-delete" "$PN_CODE $(pn_jq '.ok') $(pn_item "$PN_ITEM")" "200 true $PN_NAME|$PN_PLACE|$PN_DAY|true|true" "DELETE /api/pantry/items/:id; ok, then the row"

        # ── S7) a second DELETE matches nothing ──
        pn_req DELETE "$PN_BASE/api/pantry/items/$PN_ITEM"
        pn_check "s7-delete-again" "$PN_CODE $(pn_jq '.code // "-"')" "404 not_found" "the same DELETE again"
      else
        pn_fail "s1-create-readback" "POST /api/pantry/items → HTTP $PN_CODE: $(head -c 200 "$PN_OUT")"
      fi

      # ── S8) Used one → remaining and delta_at → Undo → remaining back, delta_at moved, the reversing row ──
      CLERK_JWT=$(mint_session_token)
      pn_req POST "$PN_BASE/api/preservation" "{\"crop_type_slug\": \"tomato\", \"method\": \"whole_freeze\", \"quantity_value\": 1, \"quantity_unit\": \"jar\", \"package_count\": 3, \"preserved_at\": \"$PN_DAY\", \"preserved_at_approx\": false, \"source_kind\": \"own_garden\", \"storage_location_id\": \"$PN_PLACE\", \"notes\": \"$PN_TAG\"}"
      PN_JAR=$(pn_jq '.id // empty')
      if pn_id_ok "$PN_JAR"; then
        pn_req POST "$PN_BASE/api/pantry/uses" "{\"idempotency_key\": \"$(pn_uuid)\", \"preservation_log_id\": \"$PN_JAR\", \"count_used\": 1}"
        PN_USE=$(pn_jq '.use.id // empty')
        pn_check "s8-used-one" "$PN_CODE $(pn_row "SELECT coalesce(remaining_count::text,'null')||'|'||(delta_at IS NOT NULL)::text FROM preservation_log WHERE id = '$PN_JAR'")" "201 2|true" "Used one of 3 (POST /api/pantry/uses); remaining|delta_at set"
        if pn_id_ok "$PN_USE"; then
          pn_req POST "$PN_BASE/api/pantry/uses/$PN_USE/undo" "{\"idempotency_key\": \"$(pn_uuid)\"}"
          pn_check "s8-undo" "$PN_CODE $(pn_row "SELECT coalesce(p.remaining_count::text,'null')||'|'||(p.delta_at > u.created_at)::text FROM preservation_log p JOIN pantry_use u ON u.id = '$PN_USE' WHERE p.id = '$PN_JAR'") $(pn_row "SELECT count_used||'|'||reverses_use_id FROM pantry_use WHERE reverses_use_id = '$PN_USE'")" "200 3|true -1|$PN_USE" "Undo it (POST /api/pantry/uses/:id/undo); remaining|delta_at moved past the use, then the reversing row"
        else
          pn_fail "s8-undo" "no use id from POST /api/pantry/uses (HTTP $PN_CODE)"
        fi

        # ── S9) Went bad as a COUNT: a part of the jar discarded → listed with what is left → undone ──
        # Put-Up UX pass R1. S8's Undo leaves the jar at 3 of 3. A Lambda from before this release answers S9a with
        # 400 ("Went bad is all that is left"), which is the signal wanted.
        CLERK_JWT=$(mint_session_token)
        pn_req POST "$PN_BASE/api/pantry/uses" "{\"idempotency_key\": \"$(pn_uuid)\", \"preservation_log_id\": \"$PN_JAR\", \"count_used\": 1, \"fate\": \"discarded\"}"
        PN_BAD=$(pn_jq '.use.id // empty')
        PN_BAD_HTTP="$PN_CODE"
        pn_check "s9-went-bad-part" "$PN_CODE $(pn_row "SELECT coalesce(remaining_count::text,'null')||'|'||(consumed_at IS NOT NULL)::text FROM preservation_log WHERE id = '$PN_JAR'") $(pn_use "$PN_BAD")" "201 2|false 1|discarded" "one of 3 went bad (POST /api/pantry/uses, count_used 1, fate discarded); remaining|consumed, then the use row's count|fate"
        pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"
        pn_check "s9-listed" "$PN_CODE $(pn_jqx "$PN_JAR" '[.rows[] | select(.stock_id == $x)] | if length == 0 then "absent" else (.[0] | "\(.stock_kind)|\(.stock_mode)|\(.count_left)") end')" "200 put_up|counted|2" "GET /api/pantry?place_id= after a part went bad; the jar's kind|mode|count_left"
        if pn_id_ok "$PN_BAD"; then
          pn_req POST "$PN_BASE/api/pantry/uses/$PN_BAD/undo" "{\"idempotency_key\": \"$(pn_uuid)\"}"
          pn_check "s9-undo" "$PN_CODE $(pn_row "SELECT coalesce(p.remaining_count::text,'null')||'|'||(p.delta_at > u.created_at)::text FROM preservation_log p JOIN pantry_use u ON u.id = '$PN_BAD' WHERE p.id = '$PN_JAR'") $(pn_row "SELECT count_used||'|'||coalesce(fate,'null')||'|'||reverses_use_id FROM pantry_use WHERE reverses_use_id = '$PN_BAD'")" "200 3|true -1|discarded|$PN_BAD" "Undo it (POST /api/pantry/uses/:id/undo); remaining|delta_at moved past the use, then the reversing row's count|fate|reverses"
        else
          pn_fail "s9-undo" "no use id from the Went bad POST (HTTP $PN_BAD_HTTP)"
        fi
      else
        pn_fail "s8-used-one" "POST /api/preservation → HTTP $PN_CODE (no jar id)"
      fi

      # The place, through its own route — and Put-Up R2a (V5-PUTUPLOGRETIRE-001), S10 to S19: what the door, the
      # Places sheet and Edit send, on the deployed stack. Eight steps, each a function, run in order by the ONE loop
      # at the end of this section. Every row they write carries $PN_TAG (a jar's notes, an item's name, a place's
      # label), so pantry_sweep takes them with no change; no jar here carries a photo_id (a photo needs an upload).
      # The place is a pantry shelf when they start, and S8's jar (whole_freeze, 3 of 3, no date on a shelf) is in it.
      #   S10) the door's create: a size as a TOTAL (3 containers of 1.5 qt → 4.5 qt), where it is from (a kind and a
      #        name), Raw and In oil → every column read back, and no date (Raw or In oil off a freezer); its replay
      #        under the same key → 200 replayed, one row; a dried row's texture (dehydrate, bends → no date).
      #   S11) a hot sauce logged as ONE container in a mass unit: the engine's date (basis table, 12 months on a
      #        shelf), remaining_amount seeded in grams, and the Pantry lists it weighed with no count.
      #   S12) the shipped "Edit locations" form's rename: BOTH keys, the kind unchanged, at a place holding that
      #        dated jar → 200, the name read back. S13) a re-kind (with a new name beside it) → 409
      #        place_has_dated_jars, n 1, one sentence in message and error; the kind AND the name read back
      #        unchanged, and the jar's date too. A Lambda from before R2a answers 200, which is the signal wanted.
      #        Then the way out the sentence names: the same date set by hand (PATCH discard_by) → basis typed → the
      #        SAME re-kind answers 200.
      #   S14) that jar's date worked out again (clear → table, 6 months in what is now a fridge), then /move to a
      #        shelf: the place changes, the worked-out date is cleared, the move is stamped. S15) the first place,
      #        left holding only undated put-ups, takes a re-kind: the refusal counts worked-out dates, not jars.
      #   S16) Went bad, ALL that is left of S8's jar: 0 left, consumed, unlisted; its Undo: 3 left, listed again.
      #   S18) where it's from, corrected in Edit: PATCH the pair on S10's jar → read back; our garden clears the
      #        name; one of the pair alone → 400 and the row is as it was.
      #   S19) an as-is item with an amount and where it's from (the migration v5-pantryitemamount-001's four
      #        columns): created, replayed, listed (the amount is as logged: no count, no grams left), PATCHed pair
      #        by pair, cleared with null, null.
      #   S17) last: DELETE of the place while it holds stock → 409 place_in_use with n, deleted_at still null; then
      #        everything in it is removed through its own route and the same DELETE answers 200 (the API cleanup).
      # WHY ONE LOOP. Each step needs a fresh ~60 s token. scripts/test_smoke_mint_log.py holds the number of
      # mint_session_token call sites in this script, so the steps share ONE plain capture, the one that used to sit
      # in front of this block's closing place DELETE. Its `[mint]` line carries the same caller line for every step;
      # the step is named on the line printed just before it.
      PN_DOOR=""; PN_DRIED=""; PN_DATED=""; PN_DATED_BY=""; PN_AS_IS=""
      PN_PLACE_URL="${STAGING_API_STORAGE_LOCATIONS%/}/api/storage-locations/$PN_PLACE"
      PN_USE_BY_SQL="SELECT coalesce(use_by_basis,'null')||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id ="
      # pn_place → the smoke place's 'label|kind'; pn_place_gone → 'true' once it is soft-deleted
      pn_place() { pn_row "SELECT label||'|'||kind FROM storage_location WHERE id = '$PN_PLACE'"; }
      pn_place_gone() { pn_row "SELECT (deleted_at IS NOT NULL)::text FROM storage_location WHERE id = '$PN_PLACE'"; }
      # pn_refusal → a coded refusal's 'code|n|one sentence in both text fields'
      pn_refusal() { pn_jq '"\(.code)|\(.n)|\(.message == .error and (.message | type) == "string")"'; }

      # ── S10) the door's create, its replay, and a dried row ──
      pn_s10_door() {
        local key; key=$(pn_uuid)
        PN_DOOR_BODY="{\"idempotency_key\": \"$key\", \"label\": \"$PN_TAG door sauce\", \"method\": \"hot_sauce\", \"preserved_at\": \"$PN_DAY\", \"preserved_at_precision\": \"day\", \"preserved_at_approx\": false, \"package_count\": 3, \"storage_location_id\": \"$PN_PLACE\", \"crop_type_slug\": \"tomato\", \"quantity_value\": 4.5, \"quantity_unit\": \"qt\", \"source_kind\": \"farm_stand\", \"source_label\": \"$PN_TAG stand\", \"is_raw\": true, \"in_oil\": true, \"notes\": \"$PN_TAG\"}"
        pn_req POST "$PN_BASE/api/preservation" "$PN_DOOR_BODY"
        PN_DOOR=$(pn_jq '.id // empty')
        if [[ "$PN_CODE" == "201" ]] && pn_id_ok "$PN_DOOR"; then
          pn_check "s10-door-create" "$(pn_row "SELECT label||'|'||method||'|'||quantity_value::numeric(12,2)::text||'|'||quantity_unit||'|'||package_count::text||'|'||remaining_count::text||'|'||source_kind||'|'||source_label||'|'||is_raw::text||'|'||in_oil::text||'|'||preserved_at_precision||'|'||preserved_at_approx::text||'|'||use_by_basis||'|'||coalesce(use_by_target::text,'null')||'|'||crop_type_slug FROM preservation_log WHERE id = '$PN_DOOR'")" "$PN_TAG door sauce|hot_sauce|4.50|qt|3|3|farm_stand|$PN_TAG stand|true|true|day|false|none|null|tomato" "POST /api/preservation as the door sends it → HTTP 201; name|method|size total|unit|count|left|from kind|from name|raw|in oil|precision|approx|basis|discard-by|crop"
          pn_req POST "$PN_BASE/api/preservation" "$PN_DOOR_BODY"
          pn_check "s10-door-replay" "$PN_CODE $(pn_jq '.replayed') $(pn_jq '.id') $(pn_row "SELECT count(*) FROM preservation_log WHERE idempotency_key = '$key'")" "200 true $PN_DOOR 1" "the same POST, same key; replayed, id, rows on the key"
        else
          PN_DOOR=""
          pn_fail "s10-door-create" "POST /api/preservation → HTTP $PN_CODE: $(head -c 200 "$PN_OUT")"
        fi
        pn_req POST "$PN_BASE/api/preservation" "{\"idempotency_key\": \"$(pn_uuid)\", \"label\": \"$PN_TAG door dried\", \"method\": \"dehydrate\", \"texture\": \"bends\", \"preserved_at\": \"$PN_DAY\", \"preserved_at_precision\": \"day\", \"preserved_at_approx\": false, \"package_count\": 2, \"storage_location_id\": \"$PN_PLACE\", \"quantity_value\": 1, \"quantity_unit\": \"cup\", \"source_kind\": \"u_pick\", \"source_label\": \"$PN_TAG farm\", \"notes\": \"$PN_TAG\"}"
        PN_DRIED=$(pn_jq '.id // empty')
        if [[ "$PN_CODE" == "201" ]] && pn_id_ok "$PN_DRIED"; then
          pn_check "s10-door-dried" "$(pn_row "SELECT method||'|'||texture||'|'||quantity_value::numeric(12,2)::text||'|'||quantity_unit||'|'||package_count::text||'|'||source_kind||'|'||source_label||'|'||use_by_basis||'|'||coalesce(use_by_target::text,'null') FROM preservation_log WHERE id = '$PN_DRIED'")" "dehydrate|bends|1.00|cup|2|u_pick|$PN_TAG farm|none|null" "a dried row with How dry? answered → HTTP 201; method|texture|size total|unit|count|from kind|from name|basis|discard-by"
        else
          PN_DRIED=""
          pn_fail "s10-door-dried" "POST /api/preservation → HTTP $PN_CODE: $(head -c 200 "$PN_OUT")"
        fi
      }

      # ── S11) one container in a mass unit: the engine's date, grams seeded, listed weighed ──
      pn_s11_dated() {
        pn_req POST "$PN_BASE/api/preservation" "{\"idempotency_key\": \"$(pn_uuid)\", \"label\": \"$PN_TAG dated sauce\", \"method\": \"hot_sauce\", \"preserved_at\": \"$PN_DAY\", \"preserved_at_precision\": \"day\", \"preserved_at_approx\": false, \"package_count\": 1, \"quantity_value\": 1, \"quantity_unit\": \"lb\", \"storage_location_id\": \"$PN_PLACE\", \"notes\": \"$PN_TAG\"}"
        PN_DATED=$(pn_jq '.id // empty')
        if [[ "$PN_CODE" == "201" ]] && pn_id_ok "$PN_DATED"; then
          PN_DATED_BY=$(pn_row "SELECT (DATE '$PN_DAY' + INTERVAL '12 months')::date::text")
          pn_check "s11-dated-weighed" "$(pn_row "SELECT use_by_basis||'|'||coalesce(use_by_target::text,'null')||'|'||coalesce(remaining_amount::numeric(12,2)::text,'null') FROM preservation_log WHERE id = '$PN_DATED'")" "table|$PN_DATED_BY|453.59" "a hot sauce on a shelf, 1 container of 1 lb → HTTP 201; basis|discard-by (the day + 12 months)|grams left"
          pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"
          pn_check "s11-listed-weighed" "$PN_CODE $(pn_jqx "$PN_DATED" '[.rows[] | select(.stock_id == $x)] | if length == 0 then "absent" else (.[0] | "\(.stock_kind)|\(.stock_mode)|\(.count_left)") end')" "200 put_up|weighed|null" "GET /api/pantry?place_id=; the jar's kind|mode|count_left"
        else
          PN_DATED=""
          pn_fail "s11-dated-weighed" "POST /api/preservation → HTTP $PN_CODE: $(head -c 200 "$PN_OUT")"
        fi
      }

      # ── S12) the shipped form's rename → S13) a re-kind refused, nothing written → the date by hand → the same re-kind ──
      pn_s12_rekind() {
        if ! pn_id_ok "$PN_DATED"; then
          pn_fail "s13-rekind-refused" "no dated jar from S11: the rename and the refusal need one in the place"
          return 0
        fi
        pn_req PUT "$PN_PLACE_URL" "{\"label\": \"$PN_TAG place-b\", \"kind\": \"pantry\"}"
        pn_check "s12-place-rename" "$PN_CODE $(pn_place)" "200 $PN_TAG place-b|pantry" "PUT { label, kind unchanged } at a place holding a dated jar (the shipped editor's body); the place's name|kind"
        pn_req PUT "$PN_PLACE_URL" "{\"label\": \"$PN_TAG place-c\", \"kind\": \"fridge\"}"
        pn_check "s13-rekind-refused" "$PN_CODE $(pn_refusal) $(pn_place) $(pn_row "$PN_USE_BY_SQL '$PN_DATED'")" "409 place_has_dated_jars|1|true $PN_TAG place-b|pantry table|$PN_DATED_BY" "PUT { label, kind: fridge } at that place; code|n|one sentence, then the place's name|kind and the jar's basis|discard-by, all unchanged"
        pn_req PATCH "$PN_BASE/api/preservation/$PN_DATED" "{\"discard_by\": \"$PN_DATED_BY\"}"
        pn_check "s13-date-by-hand" "$PN_CODE $(pn_row "$PN_USE_BY_SQL '$PN_DATED'")" "200 typed|$PN_DATED_BY" "the same date set by hand (PATCH discard_by); basis|discard-by"
        pn_req PUT "$PN_PLACE_URL" '{"kind": "fridge"}'
        pn_check "s13-rekind-after" "$PN_CODE $(pn_place)" "200 $PN_TAG place-b|fridge" "the same re-kind once the date is his own; the place's name|kind"
      }

      # ── S14) the date worked out again, then /move clears it → S15) a re-kind over undated put-ups ──
      pn_s14_move() {
        if ! pn_id_ok "$PN_DATED"; then
          pn_fail "s14-move" "no dated jar from S11 to move"
          return 0
        fi
        pn_req PATCH "$PN_BASE/api/preservation/$PN_DATED" '{"discard_by": "clear"}'
        pn_check "s14-work-it-out" "$PN_CODE $(pn_row "$PN_USE_BY_SQL '$PN_DATED'")" "200 table|$(pn_row "SELECT (DATE '$PN_DAY' + INTERVAL '6 months')::date::text")" "clear the typed date in what is now a fridge; basis|discard-by (the day + 6 months)"
        pn_req POST "$PN_BASE/api/preservation/$PN_DATED/move" "{\"place\": {\"kind\": \"pantry\", \"label\": \"$PN_TAG shelf\"}, \"when\": {\"date\": \"$PN_DAY\", \"precision\": \"day\"}}"
        pn_check "s14-move" "$PN_CODE $(pn_row "SELECT (p.storage_location_id <> '$PN_PLACE')::text||'|'||coalesce(p.use_by_basis,'null')||'|'||coalesce(p.use_by_target::text,'null')||'|'||(p.storage_moved_at IS NOT NULL)::text||'|'||s.kind||'|'||s.label FROM preservation_log p JOIN storage_location s ON s.id = p.storage_location_id WHERE p.id = '$PN_DATED'")" "200 true|none|null|true|pantry|$PN_TAG shelf" "POST /api/preservation/:id/move to a new shelf; left the place|basis|discard-by|move stamped|the new place's kind|name"
        pn_req PUT "$PN_PLACE_URL" '{"kind": "cold_storage"}'
        pn_check "s15-rekind-allowed" "$PN_CODE $(pn_place)" "200 $PN_TAG place-b|cold_storage" "a re-kind of a place that holds only undated put-ups; the place's name|kind"
      }

      # ── S16) Went bad, all that is left → unlisted → Undo → listed again ──
      pn_s16_all_remaining() {
        if ! pn_id_ok "${PN_JAR:-}"; then
          pn_fail "s16-all-remaining" "no jar from S8 to discard"
          return 0
        fi
        local use undone left_sql="SELECT coalesce(remaining_count::text,'null')||'|'||(consumed_at IS NOT NULL)::text FROM preservation_log WHERE id = '$PN_JAR'"
        pn_req POST "$PN_BASE/api/pantry/uses" "{\"idempotency_key\": \"$(pn_uuid)\", \"preservation_log_id\": \"$PN_JAR\", \"all_remaining\": true, \"fate\": \"discarded\"}"
        use=$(pn_jq '.use.id // empty')
        pn_check "s16-all-remaining" "$PN_CODE $(pn_row "$left_sql") $(pn_use "$use") $(pn_listed "$PN_JAR")" "201 0|true 3|discarded absent" "all 3 went bad (POST /api/pantry/uses, all_remaining, fate discarded); remaining|consumed, the use row's count|fate, then the list"
        if pn_id_ok "$use"; then
          pn_req POST "$PN_BASE/api/pantry/uses/$use/undo" "{\"idempotency_key\": \"$(pn_uuid)\"}"
          undone="$PN_CODE $(pn_row "$left_sql") $(pn_row "SELECT count_used||'|'||coalesce(fate,'null')||'|'||reverses_use_id FROM pantry_use WHERE reverses_use_id = '$use'")"
          pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"
          pn_check "s16-undo" "$undone $(pn_jqx "$PN_JAR" '[.rows[] | select(.stock_id == $x)] | if length == 0 then "absent" else (.[0] | "\(.stock_kind)|\(.stock_mode)|\(.count_left)") end')" "200 3|false -3|discarded|$use put_up|counted|3" "Undo it (POST /api/pantry/uses/:id/undo); remaining|consumed, the reversing row's count|fate|reverses, then the list's kind|mode|count_left"
        else
          pn_fail "s16-undo" "no use id from the all-remaining POST (HTTP $PN_CODE)"
        fi
      }

      # ── S18) where it's from, corrected in Edit: the pair on the jar PATCH ──
      pn_s18_source() {
        if ! pn_id_ok "$PN_DOOR"; then
          pn_fail "s18-jar-source" "no jar from S10 to correct"
          return 0
        fi
        local from_sql="SELECT coalesce(source_kind,'null')||'|'||coalesce(source_label,'null') FROM preservation_log WHERE id = '$PN_DOOR'"
        pn_req PATCH "$PN_BASE/api/preservation/$PN_DOOR" "{\"source_kind\": \"store\", \"source_label\": \"$PN_TAG market\"}"
        pn_check "s18-jar-source" "$PN_CODE $(pn_jq '"\(.source_kind)|\(.source_label)"') $(pn_row "$from_sql")" "200 store|$PN_TAG market store|$PN_TAG market" "PATCH /api/preservation/:id { source_kind, source_label }; the reply's pair, then the row's"
        pn_req PATCH "$PN_BASE/api/preservation/$PN_DOOR" '{"source_kind": "own_garden", "source_label": null}'
        pn_check "s18-jar-source-garden" "$PN_CODE $(pn_row "$from_sql")" "200 own_garden|null" "our garden: the kind stored, the name cleared"
        pn_req PATCH "$PN_BASE/api/preservation/$PN_DOOR" '{"source_kind": "store"}'
        pn_check "s18-jar-source-pair" "$PN_CODE $(pn_row "$from_sql")" "400 own_garden|null" "one of the pair alone is refused; the row is as it was"
      }

      # ── S19) an as-is item with an amount and where it's from: created, replayed, listed, PATCHed, cleared ──
      pn_s19_as_is() {
        local key; key=$(pn_uuid)
        local four='"\(.quantity_value)|\(.quantity_unit)|\(.source_kind)|\(.source_label)"'
        PN_AS_IS_BODY="{\"idempotency_key\": \"$key\", \"name\": \"$PN_TAG flour\", \"storage_location_id\": \"$PN_PLACE\", \"acquired_at\": \"$PN_DAY\", \"quantity_value\": 2.5, \"quantity_unit\": \"lb\", \"source_kind\": \"store\", \"source_label\": \"$PN_TAG market\"}"
        pn_req POST "$PN_BASE/api/pantry/items" "$PN_AS_IS_BODY"
        PN_AS_IS=$(pn_jq '.item.id // empty')
        if ! { [[ "$PN_CODE" == "201" ]] && pn_id_ok "$PN_AS_IS"; }; then
          PN_AS_IS=""
          pn_fail "s19-item-create" "POST /api/pantry/items with an amount and where it's from → HTTP $PN_CODE: $(head -c 200 "$PN_OUT")"
          return 0
        fi
        local four_sql="SELECT coalesce(quantity_value::numeric(12,2)::text,'null')||'|'||coalesce(quantity_unit,'null')||'|'||coalesce(source_kind,'null')||'|'||coalesce(source_label,'null') FROM pantry_item WHERE id = '$PN_AS_IS'"
        pn_check "s19-item-create" "$(pn_jq ".item | $four") $(pn_row "$four_sql")" "2.5|lb|store|$PN_TAG market 2.50|lb|store|$PN_TAG market" "POST /api/pantry/items → HTTP 201; amount|unit|from kind|from name in the reply, then the row"
        pn_req POST "$PN_BASE/api/pantry/items" "$PN_AS_IS_BODY"
        pn_check "s19-item-replay" "$PN_CODE $(pn_jq '.replayed') $(pn_jq '.item.id') $(pn_jq ".item | $four") $(pn_row "SELECT count(*) FROM pantry_item WHERE idempotency_key = '$key'")" "200 true $PN_AS_IS 2.5|lb|store|$PN_TAG market 1" "the same POST, same key; replayed, id, the four in the reply, rows on the key"
        pn_req GET "$PN_BASE/api/pantry?place_id=$PN_PLACE"
        pn_check "s19-item-listed" "$PN_CODE $(pn_jqx "$PN_AS_IS" '[.rows[] | select(.stock_id == $x)] | if length == 0 then "absent" else (.[0] | "\(.stock_kind)|\(.stock_mode)|\(.quantity_value)|\(.quantity_unit)|\(.source_kind)|\(.source_label)|\(.where_from)|\(.from_garden)|\(.count_left)|\(.grams_left)") end')" "200 pantry_item|item|2.5|lb|store|$PN_TAG market|$PN_TAG market|false|null|null" "GET /api/pantry?place_id=; kind|mode|amount|unit|from kind|from name|where_from|from_garden|count_left|grams_left (the amount is as logged)"
        pn_req PATCH "$PN_BASE/api/pantry/items/$PN_AS_IS" '{"quantity_value": 1, "quantity_unit": "bag", "source_kind": "own_garden", "source_label": null}'
        pn_check "s19-item-patch" "$PN_CODE $(pn_jq ".item | $four") $(pn_row "$four_sql")" "200 1|bag|own_garden|null 1.00|bag|own_garden|null" "PATCH both pairs; our garden stores no name; the reply, then the row"
        pn_req PATCH "$PN_BASE/api/pantry/items/$PN_AS_IS" '{"quantity_value": null, "quantity_unit": null, "source_kind": null, "source_label": null}'
        pn_check "s19-item-clear" "$PN_CODE $(pn_row "$four_sql")" "200 null|null|null|null" "PATCH null, null on each pair clears it"
      }

      # ── S17) the place while it holds stock → refused; emptied through each row's own route → deleted ──
      pn_s17_place_delete() {
        local id held
        held=$(pn_row "SELECT (SELECT count(*) FROM preservation_log WHERE storage_location_id = '$PN_PLACE' AND deleted_at IS NULL AND consumed_at IS NULL AND COALESCE(remaining_count, package_count) > 0) + (SELECT count(*) FROM pantry_item WHERE storage_location_id = '$PN_PLACE' AND deleted_at IS NULL AND used_up_at IS NULL)")
        pn_req DELETE "$PN_PLACE_URL"
        if [[ "$held" =~ ^[1-9][0-9]*$ ]]; then
          pn_check "s17-delete-refused" "$PN_CODE $(pn_refusal) $(pn_place_gone)" "409 place_in_use|$held|true false" "DELETE /api/storage-locations/:id while $held things are stored there; code|n|one sentence, then deleted"
        else
          pn_fail "s17-delete-refused" "nothing is stored in the smoke place (counted '$held'), so the refusal was not exercised; DELETE → HTTP $PN_CODE"
        fi
        for id in "${PN_JAR:-}" "$PN_DOOR" "$PN_DRIED" "$PN_DATED"; do
          if pn_id_ok "$id"; then pn_req DELETE "$PN_BASE/api/preservation/$id"; fi
        done
        if pn_id_ok "$PN_AS_IS"; then pn_req DELETE "$PN_BASE/api/pantry/items/$PN_AS_IS"; fi
        pn_req DELETE "$PN_PLACE_URL"
        pn_check "s17-delete-clean" "$PN_CODE $(pn_jq '.ok') $(pn_place_gone)" "200 true true" "the same DELETE once nothing is stored there (the API cleanup); ok, then deleted"
      }

      for PN_STEP in pn_s10_door pn_s11_dated pn_s12_rekind pn_s14_move pn_s16_all_remaining pn_s18_source pn_s19_as_is pn_s17_place_delete; do
        echo "── pantry (R2a) step ${PN_STEP#pn_} ──"
        CLERK_JWT=$(mint_session_token)
        "$PN_STEP"
      done
    fi
    if pantry_sweep; then
      PANTRY_DIRTY=false
      PN_LEFT=$(pn_row "SELECT (SELECT count(*) FROM pantry_item WHERE name LIKE 'smoke-test-pantry-%') + (SELECT count(*) FROM preservation_log WHERE notes LIKE 'smoke-test-pantry-%') + (SELECT count(*) FROM storage_location WHERE label LIKE 'smoke-test-pantry-%')")
      pn_check "l058-sweep" "$PN_LEFT" "0" "hard-delete of every smoke-test-pantry row, FK order, one transaction; residue"
    else
      pn_fail "l058-sweep" "pantry_sweep failed — smoke-test-pantry rows may remain on staging (cleanup() retries)"
    fi
  fi
  [[ -n "$PN_OUT" ]] && rm -f "$PN_OUT"
elif [[ "${SMOKE_REQUIRE_PANTRY:-}" == "1" ]]; then
  echo "❌ FAIL [pantry:deployed] this tree carries release 2 (or SMOKE_REQUIRE_PANTRY=1), but block S could not run: STAGING_API_PRESERVATION or STAGING_API_STORAGE_LOCATIONS unset, or no JWT"
  FAIL=$((FAIL+1))
else
  echo "⚠️  WARN [pantry] STAGING_API_PRESERVATION or STAGING_API_STORAGE_LOCATIONS unset, or no JWT — block S NOT run"
fi


# ── T) Recipes (B′ release 4): the built-in types; a recipe created, read back, removed — write → read-back
#    (04-design-final V4 §2.6, §4.5, §5.1 row 4, "pH"; 05-release-train §5 "a recipe create → GET → DELETE"; L-108)
#    — Phase 2, continued ──────────────────────────────────────────────────────────────────────────────────────
#   T1) GET /api/recipes/types: 16 built-ins, "Sambal & chili relish" among them (its id is T2's type).
#   T2) POST /api/recipes (keyed; one line, a keeps line, that built-in type) → 201 with an id.
#   T3) GET /api/recipes/:id → the line (name|qty|unit), the keeps line, the type; and NO key anywhere in the body
#       names a pH (V4 "pH": his target pH lives in the notes, never in a field; the batch list has no pH column).
#   T3b) Put-Up R2a: PATCH /api/recipes/:id {lines} → the line comes back with at_the_end and a brand; one live line
#       and one soft-deleted (SQL).
#   T4) DELETE /api/recipes/:id → 200 {ok:true}; the recipe and its line are soft-deleted in the one statement (SQL).
#   T5) GET /api/recipes/:id → 404.
# The smoke has one user, so there is no STRANGER leg here; tests/integration covers household scope.
# GATED like block S: the probe is GET /api/recipes/types (200 with a types array only from release 4's Lambda), and a
# checked-out tree that carries migrations/v5-recipes-001 requires the block (SMOKE_REQUIRE_RECIPES=1 by hand).
# SELF-CONTAINED CLEANUP (L-058): the recipe's name carries 'smoke-test-recipe-<run>'; recipes_sweep hard-deletes its
# lines, then it, in ONE transaction, at the end of the block and from cleanup() if the run dies (RECIPES_DIRTY).
# Built-in types are never touched. The sweep and its flag are defined above block P ("Recipes sweep"), which writes
# a recipe too (P1b). This block does not initialise the flag: one P1b raised is still up when the run gets here.
# I1: from the checked-out tree (this script's own repo root, so the working directory cannot matter).
RC_TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -d "$RC_TREE/migrations/v5-recipes-001" ]] && SMOKE_REQUIRE_RECIPES=1
if [[ -n "$CLERK_JWT" && -n "${CLERK_SESSION_ID:-}" && -n "${STAGING_API_PRESERVATION:-}" ]]; then
  RC_BASE="${STAGING_API_PRESERVATION%/}"
  RC_TAG="smoke-test-recipe-$TEST_RUN_ID"
  RC_SAMBAL="Sambal & chili relish"
  RC_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  rc_uuid() { local u; u=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid); echo "$u" | tr 'A-Z' 'a-z'; }
  # rc_req METHOD URL [BODY] → RC_CODE (HTTP status or 000) and RC_OUT (the body, a temp file; rc_req removes the last one)
  RC_OUT=""
  rc_req() {
    [[ -n "$RC_OUT" ]] && rm -f "$RC_OUT"
    RC_OUT=$(mktemp)
    if [[ -n "${3:-}" ]]; then
      RC_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$RC_OUT" -w "%{http_code}" "$2" -d "$3") || RC_CODE="000"
    else
      RC_CODE=$(curl -s --max-time 30 --connect-timeout 10 -X "$1" -H "Authorization: Bearer $CLERK_JWT" \
        -H "Content-Type: application/json" -o "$RC_OUT" -w "%{http_code}" "$2") || RC_CODE="000"
    fi
  }
  rc_jq() { jq -rc "$1" "$RC_OUT" 2>/dev/null || echo "unparseable"; }
  rc_jqx() { jq -rc --arg x "$1" "$2" "$RC_OUT" 2>/dev/null || echo "unparseable"; }   # rc_jqx <value of $x> <filter>
  rc_pass() { echo "✅ PASS [recipes:$1] $2"; PASS=$((PASS+1)); }
  rc_fail() { echo "❌ FAIL [recipes:$1] $2"; FAIL=$((FAIL+1)); }
  rc_check() { if [[ "$2" == "$3" ]]; then rc_pass "$1" "$4 → '$2'"; else rc_fail "$1" "$4 → '$2' (expected '$3')"; fi; }
  # rc_row <sql> → one row, '|'-separated, or 'sql-error'. Ids reach SQL only after matching RC_UUID_RE.
  rc_row() { psql "$NEON_STAGING_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || echo "sql-error"; }
  rc_id_ok() { [[ "${1:-}" =~ $RC_UUID_RE ]]; }

  CLERK_JWT=$(mint_session_token)
  rc_req GET "$RC_BASE/api/recipes/types"
  if [[ "$RC_CODE" != "200" || "$(rc_jq '.types | type')" != "array" ]]; then
    if [[ "${SMOKE_REQUIRE_RECIPES:-}" == "1" ]]; then
      rc_fail "deployed" "GET /api/recipes/types → HTTP $RC_CODE: this tree carries release 4 (or SMOKE_REQUIRE_RECIPES=1), but its Lambda is not answering on staging"
    else
      echo "⚠️  WARN [recipes:deployed] GET /api/recipes/types → HTTP $RC_CODE — this tree has no release 4 (no migrations/v5-recipes-001); block T NOT run"
    fi
  elif [[ -z "${NEON_STAGING_URL:-}" ]] || ! command -v psql >/dev/null 2>&1; then
    rc_fail "readback-sql" "NEON_STAGING_URL unset or psql missing — block T reads the soft delete back through SQL and cleans up through it"
  else
    # ── T1) the sixteen built-ins, Sambal among them ──
    rc_check "t1-builtin-types" "$(rc_jqx "$RC_SAMBAL" '"\([.types[] | select(.builtin)] | length)|\(any(.types[]; .builtin and .label == $x))"')" "16|true" "GET /api/recipes/types; built-ins|\"$RC_SAMBAL\" among them"
    RC_TYPE=$(rc_jqx "$RC_SAMBAL" 'first(.types[] | select(.builtin and .label == $x) | .id) // empty')

    # ── T2) a keyed create: one line, a keeps line, the built-in type ──
    RECIPES_DIRTY=true
    CLERK_JWT=$(mint_session_token)
    RC_NAME="$RC_TAG sambal"
    rc_req POST "$RC_BASE/api/recipes" "{\"idempotency_key\": \"$(rc_uuid)\", \"name\": \"$RC_NAME\", \"kind\": \"ferment\", \"recipe_type_id\": \"$RC_TYPE\", \"keeps\": {\"n\": 2, \"unit\": \"month\", \"storage_kind\": \"fridge\"}, \"lines\": [{\"name\": \"$RC_TAG fresno\", \"qty\": 500, \"qty_unit\": \"g\"}]}"
    RC_ID=$(rc_jq '.recipe.id // empty')
    if [[ "$RC_CODE" == "201" ]] && rc_id_ok "$RC_ID"; then
      rc_pass "t2-create" "POST /api/recipes → HTTP 201, id $RC_ID"

      # ── T3) read back: the line, the keeps line, the type; no pH field anywhere ──
      rc_req GET "$RC_BASE/api/recipes/$RC_ID"
      rc_check "t3-readback" "$RC_CODE $(rc_jq '.recipe | "\(.name)|\(.type_label)|\(.keeps_n)|\(.keeps_unit)|\(.keeps_storage_kind)|\(.lines | length)|\(.lines[0].name)|\((.lines[0].qty | tonumber) + 0)|\(.lines[0].qty_unit)"')" "200 $RC_NAME|$RC_SAMBAL|2|month|fridge|1|$RC_TAG fresno|500|g" "GET /api/recipes/:id; name|type|keeps n|unit|where|lines|line name|qty|unit"
      rc_check "t3-no-ph-field" "$(rc_jq '[.. | objects | keys[] | select(test("(^|_)ph(_|$)"; "i"))] | unique')" "[]" "keys naming a pH anywhere in the recipe detail"

      # ── T3b) PATCH the lines: `lines` present replaces the live set, in the one statement ──
      # Put-Up R2a (V5-PUTUPLOGRETIRE-001). The recipe sheet's Save sends the whole line list; the PATCH had no smoke.
      # The same line comes back with what the sheet adds to it (added at the end, a brand), read through GET; and in
      # SQL the recipe now has one live line and one soft-deleted (the line T2 wrote). Two requests on T2's token.
      rc_req PATCH "$RC_BASE/api/recipes/$RC_ID" "{\"lines\": [{\"name\": \"$RC_TAG fresno\", \"qty\": 500, \"qty_unit\": \"g\", \"at_the_end\": true, \"brand\": \"smoke-brand\"}]}"
      RC_PATCH_HTTP="$RC_CODE"
      rc_req GET "$RC_BASE/api/recipes/$RC_ID"
      rc_check "t3b-patch-lines" "$RC_PATCH_HTTP $(rc_jq '.recipe | "\(.lines | length)|\(.lines[0].name)|\(.lines[0].at_the_end)|\(.lines[0].brand)"') $(rc_row "SELECT (SELECT count(*) FROM recipe_ingredient i WHERE i.recipe_id = '$RC_ID' AND i.deleted_at IS NULL)||'|'||(SELECT count(*) FROM recipe_ingredient i WHERE i.recipe_id = '$RC_ID' AND i.deleted_at IS NOT NULL)")" "200 1|$RC_TAG fresno|true|smoke-brand 1|1" "PATCH /api/recipes/:id { lines }; lines|name|at the end|brand on the GET, then live|soft-deleted lines"

      # ── T4) Remove (soft): the recipe and its line ──
      CLERK_JWT=$(mint_session_token)
      rc_req DELETE "$RC_BASE/api/recipes/$RC_ID"
      rc_check "t4-delete" "$RC_CODE $(rc_jq '.ok') $(rc_row "SELECT (r.deleted_at IS NOT NULL)::text||'|'||(SELECT count(*) FROM recipe_ingredient i WHERE i.recipe_id = r.id AND i.deleted_at IS NULL) FROM recipe r WHERE r.id = '$RC_ID'")" "200 true true|0" "DELETE /api/recipes/:id; ok, then recipe deleted|live lines"

      # ── T5) gone ──
      rc_req GET "$RC_BASE/api/recipes/$RC_ID"
      rc_check "t5-gone" "$RC_CODE $(rc_jq '.code // "-"')" "404 not_found" "GET /api/recipes/:id after the DELETE"
    else
      rc_fail "t2-create" "POST /api/recipes → HTTP $RC_CODE (type '$RC_TYPE'): $(head -c 200 "$RC_OUT")"
    fi
    if recipes_sweep; then
      RECIPES_DIRTY=false
      rc_check "l058-sweep" "$(rc_row "SELECT count(*) FROM recipe WHERE name LIKE 'smoke-test-recipe-%'")" "0" "hard-delete of every smoke-test-recipe row and its lines, one transaction; residue"
    else
      rc_fail "l058-sweep" "recipes_sweep failed — smoke-test-recipe rows may remain on staging (cleanup() retries)"
    fi
  fi
  [[ -n "$RC_OUT" ]] && rm -f "$RC_OUT"
elif [[ "${SMOKE_REQUIRE_RECIPES:-}" == "1" ]]; then
  echo "❌ FAIL [recipes:deployed] this tree carries release 4 (or SMOKE_REQUIRE_RECIPES=1), but block T could not run: STAGING_API_PRESERVATION unset, or no JWT"
  FAIL=$((FAIL+1))
else
  echo "⚠️  WARN [recipes] STAGING_API_PRESERVATION unset, or no JWT — block T NOT run"
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
