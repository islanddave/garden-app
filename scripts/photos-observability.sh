#!/usr/bin/env bash
# The metric filter behind the garden-photos-handler-error alarm (Garden/Photos PhotosHandlerErrors, >= 1 in 300 s).
# It counts garden-photos' catch-all line, console.error('photos lambda error', err) in lambda/photos/index.js,
# which every unexpected throw logs before its 500 or 503.
#
# The pattern names fields of the Lambda Text line, "<ts>\t<requestId>\t<LEVEL>\t<message>": tabs split fields,
# the caller cannot move the first three, and the message's first words are the catch-all's literal. A quoted
# phrase would match anywhere in the line, and the sign-in kit's 401 line quotes a caller's token kid, so anyone
# could hold the alarm in ALARM.
#
# ORDERING: the alarm already exists, so a filter written by provision pages at once. provision therefore runs
# test-patterns first and refuses on any failure. scripts/test_photos_observability.py pins the pattern's words
# to the catch-all line and the provision call to the filter's name and metric.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=769788341849
LOG_GROUP=/aws/lambda/garden-photos
FILTER=photos-lambda-error
NS=Garden/Photos
METRIC=PhotosHandlerErrors
PATTERN='[ts, rid, level=ERROR, w1=photos, w2=lambda, w3=error, ...]'

require_account() {
  local got
  got=$(aws sts get-caller-identity --query Account --output text) || { echo "cannot read the AWS identity" >&2; exit 1; }
  [ "$got" = "$ACCOUNT" ] || { echo "refusing: credentials are for account $got, not $ACCOUNT" >&2; exit 1; }
}

FAILS=0
check() {   # label, log line, expected matches
  local got
  # A refused call is a failure, not a 0: otherwise a malformed pattern would pass every negative control.
  got=$(aws logs test-metric-filter --region "$REGION" --filter-pattern "$PATTERN" --log-event-messages "$2" \
          --query 'length(matches)' --output text 2>/dev/null) || got="error"
  if [ "$got" = "$3" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (expected $3, got $got)"; FAILS=$((FAILS+1)); fi
}

# Server-side proof (aws logs test-metric-filter only, no writes, no traffic needed).
test_patterns() {
  local T PFX kid
  T=$(printf '\t')
  PFX="2026-11-01T12:00:00.000Z${T}0f0f0f0f-1111-2222-3333-444444444444${T}"
  kid='verifyToken failed: Unable to find a signing key in JWKS that matches the kid='
  FAILS=0
  echo "positive: the catch-all line, Lambda prefix included"
  check "catch-all with a stack"         "${PFX}ERROR${T}photos lambda error Error: boom
    at handler (/var/task/index.js:1608:5)" 1
  check "catch-all with \" and [ in it"  "${PFX}ERROR${T}photos lambda error NeonDbError: invalid input \"x\" [y" 1
  check "catch-all with a plain object"  "${PFX}ERROR${T}photos lambda error { code: 'ECONNRESET' }" 1

  echo "negative controls (each must match NOTHING)"
  # The kit logs Clerk's message for any token before auth: the kid, or a header that is not JSON, comes back in it.
  check "forged 401 line (kid)"          "${PFX}ERROR${T}${kid}'photos lambda error' of the provided session token." 0
  check "forged 401 line (header JSON)"  "${PFX}ERROR${T}verifyToken failed: Unexpected token 'p', \"photos lambda error\" is not valid JSON" 0
  # photos logs the request path before auth.
  check "route line, path with spaces"   "${PFX}INFO${T}route GET /x/photos lambda error" 0
  check "route line, path with tabs"     "${PFX}INFO${T}route GET /x${T}ERROR${T}photos lambda error" 0
  # The level field is the emitter's console method: the same words at another level are some other line.
  check "same words at INFO"             "${PFX}INFO${T}photos lambda error Error: boom" 0

  if [ "$FAILS" -ne 0 ]; then
    echo "FAIL: $FAILS pattern check(s) wrong. Do NOT write this filter." >&2
    return 1
  fi
  echo "pattern verified against the catch-all line, with negative controls."
}

provision() {
  require_account
  test_patterns || { echo "refusing to write the filter: its pattern is unproven." >&2; exit 1; }
  aws logs put-metric-filter --region "$REGION" --log-group-name "$LOG_GROUP" --filter-name "$FILTER" \
    --filter-pattern "$PATTERN" \
    --metric-transformations "metricName=${METRIC},metricNamespace=${NS},metricValue=1,defaultValue=0"
  echo "  ok  ${LOG_GROUP}: ${FILTER} -> ${NS}/${METRIC} (garden-photos-handler-error reads it now)"
}

case "${1:-}" in
  test-patterns) test_patterns ;;
  provision)     provision ;;
  *) echo "usage: $0 {test-patterns|provision}   # provision runs test-patterns first" >&2; exit 2 ;;
esac
