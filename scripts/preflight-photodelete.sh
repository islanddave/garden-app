#!/usr/bin/env bash
# PREFLIGHT for the W-DEL promote (V4-PHOTOREASSIGN-001, photo-removal plan V100 §5).
#
# Three HARD ABORTS. This is a gate, not a report: any failure exits non-zero and the promote does
# not happen. There is deliberately no --force and no skip flag — a gate with a bypass is a report.
#
#   1. STAGING<->PROD PARITY on every photo-pointer column and on photos_must_have_parent.
#      "No DDL in this change" does NOT establish that staging already carries those objects in
#      prod form. Nothing keeps the staging Neon branch in sync (integration-test.yml branches off
#      staging and applies no migration), and lambda/photos/index.js:412 documents a prior instance
#      of exactly this drift. Without parity, the integration run that gates this promote is
#      exercising a different schema than the one W-DEL will meet.
#
#   2. ZERO heroes pointing at a soft-deleted photo, across ALL pointer columns.
#      Verified 0 on 2026-08-12 — re-run at promote, never trusted from a document. If this is
#      non-zero, the read-side effective-hero derivation is already masking a live inconsistency and
#      W-DEL is about to make many more of them.
#
#   3. LIVE pg_constraint pointer set == the PHOTO_POINTERS constant in the handler.
#      This is the check that keeps the null set from going stale. A new FK to photos(id) added by
#      any future migration silently escapes the delete's pointer-nulling otherwise, and the symptom
#      would be a dangling pointer nobody looks for.
#
# ENV (house convention, cf. scripts/check-staging-drift.py):
#   NEON_DATABASE_URL  prod  (required)
#   NEON_STAGING_URL   staging (required — its absence is check 1 failing, not check 1 skipping)
#
# READ ONLY: every statement runs inside BEGIN TRANSACTION READ ONLY. This script never writes.
#
# EXIT CODES (house convention): 0 = all three passed. 1 = a check FAILED (do not promote).
#                               2 = script/input error (a URL missing, a database unreachable).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POINTER_SRC="$REPO_ROOT/lambda/photos/photoDelete.js"

fail() { echo "ABORT: $*" >&2; exit 1; }
oops() { echo "ERROR: $*" >&2; exit 2; }

# Explicit tests, NOT `${VAR:?msg}`: an unset-parameter expansion aborts a non-interactive shell
# immediately with status 1, so the `|| oops` would never run and a config error would masquerade as
# a failed CHECK. The two are different situations and must not share an exit code.
[ -n "${NEON_DATABASE_URL:-}" ] || oops "NEON_DATABASE_URL not set"
[ -n "${NEON_STAGING_URL:-}" ] || oops "NEON_STAGING_URL not set — parity IS check 1, and an unverified staging is a failed check, not a skipped one"
[ -f "$POINTER_SRC" ] || oops "cannot find $POINTER_SRC — check 3 has no constant to compare against"

q() { # q <url> <sql>
  psql "$1" -v ON_ERROR_STOP=1 -qAt -F'|' <<SQL || oops "query failed against $(echo "$1" | sed 's|://[^@]*@|://***@|')"
BEGIN TRANSACTION READ ONLY;
$2
SQL
}

# The FK set as the DATABASE sees it. Ordered so both sides are byte-comparable.
FK_SQL="SELECT conrelid::regclass::text || '.' || a.attname::text
          FROM pg_constraint c
          JOIN unnest(c.conkey) k ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
         WHERE c.confrelid = 'photos'::regclass AND c.contype = 'f'
         ORDER BY 1;"

echo "== check 1/3 — staging<->prod parity on the photo-pointer surface"
PROD_FK="$(q "$NEON_DATABASE_URL" "$FK_SQL")"
STAG_FK="$(q "$NEON_STAGING_URL" "$FK_SQL")"
if [ "$PROD_FK" != "$STAG_FK" ]; then
  echo "--- prod-only:"    >&2; comm -23 <(echo "$PROD_FK") <(echo "$STAG_FK") >&2
  echo "--- staging-only:" >&2; comm -13 <(echo "$PROD_FK") <(echo "$STAG_FK") >&2
  fail "photo-pointer FK set differs between prod and staging — the integration run gating this promote is not testing W-DEL's schema"
fi

CHECK_SQL="SELECT COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
             WHERE conrelid = 'photos'::regclass AND conname = 'photos_must_have_parent'), 'MISSING');"
PROD_CHK="$(q "$NEON_DATABASE_URL" "$CHECK_SQL")"
STAG_CHK="$(q "$NEON_STAGING_URL" "$CHECK_SQL")"
[ "$PROD_CHK" != "MISSING" ] || fail "photos_must_have_parent is MISSING on prod"
if [ "$PROD_CHK" != "$STAG_CHK" ]; then
  echo "  prod:    $PROD_CHK" >&2
  echo "  staging: $STAG_CHK" >&2
  fail "photos_must_have_parent differs between prod and staging"
fi
echo "   OK — $(echo "$PROD_FK" | wc -l | tr -d ' ') pointer FKs identical; CHECK identical"

echo "== check 2/3 — no pointer references a soft-deleted photo (prod)"
# Every pointer column, not just featured_photo_id. The 0-populated columns are exactly the ones a
# hand-run smoke never exercises, which is why they are enumerated here rather than sampled.
DANGLING_SQL="SELECT t, n FROM (
  SELECT 'plants.featured_photo_id' t, count(*) n FROM plants x JOIN photos p ON p.id = x.featured_photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'plants.featured_image_id', count(*) FROM plants x JOIN photos p ON p.id = x.featured_image_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'plant_projects.featured_photo_id', count(*) FROM plant_projects x JOIN photos p ON p.id = x.featured_photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'plant_projects.featured_image_id', count(*) FROM plant_projects x JOIN photos p ON p.id = x.featured_image_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'locations.featured_photo_id', count(*) FROM locations x JOIN photos p ON p.id = x.featured_photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'locations.featured_image_id', count(*) FROM locations x JOIN photos p ON p.id = x.featured_image_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'inventory_items.featured_photo_id', count(*) FROM inventory_items x JOIN photos p ON p.id = x.featured_photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'inventory_items.featured_image_id', count(*) FROM inventory_items x JOIN photos p ON p.id = x.featured_image_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'plant_varieties.photo_id', count(*) FROM plant_varieties x JOIN photos p ON p.id = x.photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'preservation_log.photo_id', count(*) FROM preservation_log x JOIN photos p ON p.id = x.photo_id WHERE p.deleted_at IS NOT NULL
  UNION ALL SELECT 'spaces.featured_photo_id', count(*) FROM spaces x JOIN photos p ON p.id = x.featured_photo_id WHERE p.deleted_at IS NOT NULL
) s WHERE n > 0;"
DANGLING="$(q "$NEON_DATABASE_URL" "$DANGLING_SQL")"
if [ -n "$DANGLING" ]; then
  echo "$DANGLING" >&2
  fail "a pointer already references a soft-deleted photo — fix the data before shipping a route that creates more"
fi
echo "   OK — 0 dangling pointers across all 11 display columns"

echo "== check 3/3 — live FK set == PHOTO_POINTERS in lambda/photos/photoDelete.js"
# Parse the constant rather than restating it: a hand-copied list in this script would be the same
# drift hazard the check exists to catch, one layer out.
CONST_FK="$(grep -oE "\{ table: '[a-z_]+', column: '[a-z_]+'" "$POINTER_SRC" \
  | sed -E "s/\{ table: '([a-z_]+)', column: '([a-z_]+)'/\1.\2/" | sort)"
[ -n "$CONST_FK" ] || oops "parsed 0 entries out of PHOTO_POINTERS — the constant's shape changed and this check is now vacuous"
if [ "$(echo "$PROD_FK" | sort)" != "$CONST_FK" ]; then
  echo "--- in the database, missing from PHOTO_POINTERS (these would NOT be nulled on delete):" >&2
  comm -23 <(echo "$PROD_FK" | sort) <(echo "$CONST_FK") >&2
  echo "--- in PHOTO_POINTERS, absent from the database:" >&2
  comm -13 <(echo "$PROD_FK" | sort) <(echo "$CONST_FK") >&2
  fail "PHOTO_POINTERS is out of sync with live pg_constraint — classify the new FK before promoting"
fi
echo "   OK — $(echo "$CONST_FK" | wc -l | tr -d ' ') classified pointers match live"

echo
echo "PREFLIGHT PASSED — W-DEL is clear to promote."
