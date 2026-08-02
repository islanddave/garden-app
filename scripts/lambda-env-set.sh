#!/usr/bin/env bash
# lambda-env-set.sh — set or remove ONE environment variable on a Lambda, without wiping the others.
#
# WHY THIS EXISTS
# ---------------
# `aws lambda update-function-configuration --environment` REPLACES the entire Variables map. The
# obvious command —
#     aws lambda update-function-configuration --function-name garden-photos \
#       --environment 'Variables={SPACE_PHOTOS_ENABLED=true}'
# — is not "set one var", it is "delete every other var". On garden-photos that silently destroys
# GARDEN_HOUSEHOLD_IDS (Dave and Jen stop sharing a photo library, HTTP 200 throughout, no error
# anywhere), S3_PHOTOS_BUCKET (module-load throw, every request 500s) and PHOTO_CDN_SIGNING_SECRET
# (symptomless today, breaks at the CDN flip). That shape is already the house muscle memory —
# deploy-lambda.yml uses it for xp-reconcile — which is exactly why a prose warning is not enough.
#
# Both DIRECTIONS run through this one script deliberately. A rollback is executed under incident
# pressure, and a second, riskier code path for the undo is how a feature rollback becomes an outage.
#
# GUARANTEES
#   1. BASELINE COMPLETENESS — refuses to write if the pre-read returned empty/{} or is missing any
#      key named in REQUIRED_KEYS. deploy-lambda.yml's own merge steps use `|| echo "{}"`, so a
#      throttled read there can write a 3-key map over a 7-key one and still exit green. Not here.
#   2. OPTIMISTIC CONCURRENCY — the RevisionId from the pre-read is sent with the write, so a racing
#      writer (a lambda deploy's env step) fails with PreconditionFailedException instead of one of
#      the two silently clobbering the other.
#   3. NO STALE RETRIES — the baseline is re-captured on every attempt. Reusing a baseline file
#      across attempts reverts any change made in between, because the payload restates the whole map.
#   4. VERIFIED AFTER WRITE — waits for the update to settle, re-reads, and asserts the expected key
#      set. An immediate read is eventually consistent and can return the pre-write value.
#
# PREFER --set false OVER --unset for a rollback: both disable a `=== 'true'` gate, but `false` keeps
# the key count stable, is greppable, and says "deliberately off" rather than "never configured".
#
# USAGE
#   scripts/lambda-env-set.sh <function-name> <KEY> <value>       # set KEY to value
#   scripts/lambda-env-set.sh <function-name> <KEY> --unset       # remove KEY entirely
#   DRY_RUN=1 scripts/lambda-env-set.sh ...                       # print the payload, write nothing
#
# EXAMPLES
#   scripts/lambda-env-set.sh garden-photos SPACE_PHOTOS_ENABLED true
#   scripts/lambda-env-set.sh garden-photos SPACE_PHOTOS_ENABLED false   # the rollback

set -euo pipefail

FN="${1:-}"
KEY="${2:-}"
VAL="${3:-}"
REGION="${AWS_REGION:-us-east-1}"

if [[ -z "$FN" || -z "$KEY" || -z "$VAL" ]]; then
  echo "usage: $0 <function-name> <KEY> <value|--unset>" >&2
  exit 64
fi

# Keys that must survive any write to these functions. Losing one of these is an outage or, worse,
# a silent behavioral change. Extend per function as new crown-jewel vars appear.
case "$FN" in
  garden-photos)
    REQUIRED_KEYS=(SECRET_NAME S3_PHOTOS_BUCKET GARDEN_HOUSEHOLD_IDS PHOTO_CDN_SIGNING_SECRET PHOTO_CDN_DOMAIN PHOTO_CDN_KEY_PAIR_ID)
    ;;
  garden-photos-staging)
    # Deliberately SHORTER than prod: staging carries no PHOTO_CDN_* trio, so signed-URL behaviour
    # is NOT exercised there and a staging pass is not evidence about the prod CDN path.
    # GARDEN_HOUSEHOLD_IDS was added 2026-08-02 — before that staging held only 2 keys and silently
    # ran UNSCOPED, which made the promote-gate staging smoke vacuous for every household assertion.
    # Listing it here is what stops a future one-var write from dropping it back to that state.
    REQUIRED_KEYS=(SECRET_NAME S3_PHOTOS_BUCKET GARDEN_HOUSEHOLD_IDS)
    ;;
  *)
    # Unknown function: require nothing by name, but still enforce non-empty baseline below.
    REQUIRED_KEYS=()
    ;;
esac

command -v jq >/dev/null || { echo "FATAL: jq not found (brew install jq)" >&2; exit 69; }

echo "── 1. pre-read (baseline + revision) ────────────────────────────────"
BASE_JSON="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query '{Vars:Environment.Variables,Rev:RevisionId,State:State,Upd:LastUpdateStatus}' --output json)"

STATE="$(jq -r '.State' <<<"$BASE_JSON")"
UPD="$(jq -r '.Upd'   <<<"$BASE_JSON")"
REV="$(jq -r '.Rev'   <<<"$BASE_JSON")"
VARS="$(jq -c '.Vars // {}' <<<"$BASE_JSON")"

if [[ "$STATE" != "Active" || "$UPD" != "Successful" ]]; then
  echo "ABORT: function is State=$STATE LastUpdateStatus=$UPD — a config update now would" >&2
  echo "       ResourceConflictException. Run: aws lambda wait function-updated --function-name $FN" >&2
  exit 75
fi

BASE_COUNT="$(jq 'length' <<<"$VARS")"
if [[ "$BASE_COUNT" -eq 0 ]]; then
  echo "ABORT: baseline env read returned an empty map. Refusing to write a partial env block." >&2
  exit 75
fi

for k in "${REQUIRED_KEYS[@]:-}"; do
  [[ -z "$k" ]] && continue
  jq -e --arg k "$k" 'has($k)' <<<"$VARS" >/dev/null || {
    echo "ABORT: baseline is missing required key '$k' — the pre-read is not trustworthy." >&2
    exit 75
  }
done
echo "   baseline OK: $BASE_COUNT keys, revision $REV"

echo "── 2. merge ─────────────────────────────────────────────────────────"
if [[ "$VAL" == "--unset" ]]; then
  NEW_VARS="$(jq -c --arg k "$KEY" 'del(.[$k])' <<<"$VARS")"
else
  NEW_VARS="$(jq -c --arg k "$KEY" --arg v "$VAL" '. + {($k): $v}' <<<"$VARS")"
fi
EXPECTED_COUNT="$(jq 'length' <<<"$NEW_VARS")"
echo "   $BASE_COUNT keys -> $EXPECTED_COUNT keys ($KEY $( [[ "$VAL" == "--unset" ]] && echo removed || echo "= $VAL"))"

PAYLOAD="$(mktemp -t lambda-env-set)"
trap 'rm -f "$PAYLOAD"' EXIT
jq -n --arg fn "$FN" --arg rev "$REV" --argjson vars "$NEW_VARS" \
  '{FunctionName:$fn, RevisionId:$rev, Environment:{Variables:$vars}}' > "$PAYLOAD"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "── DRY_RUN — payload below, nothing written ─────────────────────────"
  jq '.Environment.Variables |= with_entries(.value = "<redacted>")' "$PAYLOAD"
  exit 0
fi

echo "── 3. write (RevisionId-guarded) ────────────────────────────────────"
aws lambda update-function-configuration --region "$REGION" --cli-input-json "file://$PAYLOAD" \
  --query '{Rev:RevisionId,Upd:LastUpdateStatus}' --output json

echo "── 4. wait for the update to settle ─────────────────────────────────"
aws lambda wait function-updated --function-name "$FN" --region "$REGION"

echo "── 5. verify ────────────────────────────────────────────────────────"
AFTER="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query 'Environment.Variables' --output json)"
AFTER_COUNT="$(jq 'length' <<<"$AFTER")"

FAIL=0
if [[ "$AFTER_COUNT" -ne "$EXPECTED_COUNT" ]]; then
  echo "   FAIL: expected $EXPECTED_COUNT keys, found $AFTER_COUNT" >&2; FAIL=1
fi
for k in "${REQUIRED_KEYS[@]:-}"; do
  [[ -z "$k" ]] && continue
  jq -e --arg k "$k" 'has($k)' <<<"$AFTER" >/dev/null || { echo "   FAIL: required key '$k' is GONE" >&2; FAIL=1; }
done
if [[ "$VAL" == "--unset" ]]; then
  jq -e --arg k "$KEY" 'has($k) | not' <<<"$AFTER" >/dev/null || { echo "   FAIL: '$KEY' still present" >&2; FAIL=1; }
else
  [[ "$(jq -r --arg k "$KEY" '.[$k] // "<absent>"' <<<"$AFTER")" == "$VAL" ]] \
    || { echo "   FAIL: '$KEY' is not '$VAL'" >&2; FAIL=1; }
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "VERIFY FAILED — inspect the function config before doing anything else." >&2
  exit 70
fi

echo "   OK: $AFTER_COUNT keys present; $KEY $( [[ "$VAL" == "--unset" ]] && echo "removed" || echo "= $VAL")"
echo
echo "NOTE: config is settled, but running containers pick the value up on their next invocation."
echo "      A config read is NOT proof of behavior — probe the actual endpoint before declaring done."
