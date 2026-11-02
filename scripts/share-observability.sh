#!/usr/bin/env bash
# Observability for the social publish path (garden-facebook-share).
#
# WHY. Every failure path in lambda/facebook-share/index.js RETURNS a response rather than throwing,
# so the Lambda `Errors` metric is structurally blind to a failed publish — it stays flat at zero
# through a total outage. Before this script the function carried exactly one metric filter
# (tokenless-request-401, a fleet-wide auth probe) and nothing that could see a post fail.
#
# ORDERING IS THE WHOLE POINT — run the phases in order and do not skip `verify`.
#   1. The handler must be DEPLOYED with the SHARE_METRIC log lines first. A metric filter keyed on
#      a string no code emits reads zero forever, and an alarm on it sits green permanently. That is
#      a worse state than no alarm, because it looks like coverage.
#   2. `provision` runs test-patterns, refuses on any failure, then writes the filters. Three of them feed live
#      alarms, so a filter it writes counts at once.
#   3. `verify` proves the filters actually match real log output. It FAILS if the attempt metric has
#      never moved — which is the honest state until the first publish is exercised.
#   4. `alarm` refuses to run until `verify` passes.
#
# The attempt counter exists so "zero failures" and "zero attempts" are distinguishable. Today the
# feature has never run (share_log holds 0 rows), so a failure metric alone would report a
# never-executed publish path as perfectly healthy.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FN="${FN:-garden-facebook-share}"
LOG_GROUP="/aws/lambda/${FN}"
NS="Garden/Share"
SNS_TOPIC="${SNS_TOPIC:-}"   # optional; alarm is created without an action if unset

# Each pattern names fields of the Lambda Text line, "<ts>\t<requestId>\t<LEVEL>\t<message>": tabs split fields,
# the caller cannot move the first three, and the message's first words are the emitter's own literal. A quoted
# phrase would match anywhere in the line, and the sign-in kit's 401 line quotes a caller's token kid, so anyone
# could raise these metrics. test-patterns proves each one, forged 401 lines included. The anchors hold only while
# the function logs in Text format (a JSON-format line starts `{"timestamp"`, so every filter would read 0):
# test-patterns reads the live LogFormat and fails unless it is Text; a LogFormat change re-keys these filters.
P_ATTEMPT='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=attempt, ...]'
P_POSTED='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=posted, ...]'
P_FAILED='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=failed, ...]'
P_REJECTED='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=rejected, ...]'
P_BLOCKED='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=blocked, ...]'
P_RETAINED='[ts, rid, level=INFO, w1=SHARE_METRIC, w2=staging_version_retained, ...]'
P_ORPHAN='[ts, rid, level=ERROR, w1=orphan, w2=cleanup, w3=FAILED, ...]'   # orphans.js logs through console.error

verify_log_format() {
  local fmt
  fmt=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FN" \
          --query 'LoggingConfig.LogFormat' --output text 2>/dev/null) || fmt="unreadable"
  if [ "$fmt" = "Text" ]; then echo "  ok    log format ${FN}: Text"; else echo "  FAIL  log format ${FN}: $fmt (want Text)"; return 1; fi
}

emit_filter() {   # name, pattern, metric
  aws logs put-metric-filter \
    --region "$REGION" \
    --log-group-name "$LOG_GROUP" \
    --filter-name "$1" \
    --filter-pattern "$2" \
    --metric-transformations "metricName=$3,metricNamespace=${NS},metricValue=1,defaultValue=0"
  echo "  ok  $1 -> ${NS}/$3"
}

provision() {
  test_patterns || { echo "refusing to write the filters: a pattern is unproven, or ${FN} does not log in Text." >&2; exit 1; }
  echo "provisioning metric filters on ${LOG_GROUP}"
  # Matched against the literal lines emitted by shareMetric() in index.js.
  emit_filter share-attempt  "$P_ATTEMPT"  ShareAttempts
  emit_filter share-posted   "$P_POSTED"   SharePosted
  emit_filter share-failed   "$P_FAILED"   ShareFailed
  emit_filter share-rejected "$P_REJECTED" ShareRejected
  # Not a SHARE_METRIC line — this one is the orphan-cleanup failure from orphans.js, which means a
  # real unpublished object was left on the public Page and needs removing by hand.
  emit_filter share-orphan-stranded "$P_ORPHAN" ShareOrphanStranded

  # ── V4-IGSHARE-001 outcomes. Both existed in the handler with NO filter watching them. ──
  #
  # blocked — the pre-publish content assertion refused to publish. This is the guard WORKING, so it
  # is deliberately counted and deliberately NOT alarmed (see alarm()). It still needs a metric:
  # without one, "the location guard has never fired" and "the location guard is not running" are
  # the same picture, which is the exact ambiguity the attempt counter exists to remove elsewhere.
  emit_filter share-blocked "$P_BLOCKED" ShareBlocked
  # staging_version_retained — an EXIF-stripped copy of a private photo could NOT be removed from
  # S3 and remains as a non-current version. Alarmed: this one accumulates silently and is the
  # privacy-relevant failure, not a cosmetic one. See scripts/ig-staging-retention.sh.
  emit_filter share-staging-retained "$P_RETAINED" ShareStagingRetained
  echo "filters provisioned. Run '$0 verify' AFTER exercising a publish — do not arm the alarm first."
}

# Prove each pattern matches the string the DEPLOYED code actually emits, and — just as important —
# that it does not match a neighbouring one. `aws logs test-metric-filter` evaluates a pattern against
# supplied lines server-side and needs no real log events, so this is runnable before anything has
# ever posted. A filter keyed on a string no code emits reads zero forever and looks like health.
test_patterns() {
  local fails=0 T PFX
  T=$(printf '\t')
  PFX="2026-11-01T12:00:00.000Z${T}0f0f0f0f-1111-2222-3333-444444444444${T}"
  check() {  # label, pattern, line, expect(1|0)
    local got
    # A refused call is a failure, not a 0: otherwise a malformed pattern would pass every negative control.
    got=$(aws logs test-metric-filter --region "$REGION" \
            --filter-pattern "$2" --log-event-messages "$3" \
            --query 'length(matches)' --output text 2>/dev/null) || got="error"
    if [ "$got" = "$4" ]; then
      echo "  ok    $1"
    else
      echo "  FAIL  $1 (expected $4 match(es), got $got)"; fails=$((fails+1))
    fi
  }
  echo "the live function's log format (the anchors read only Text lines)"
  verify_log_format || fails=$((fails+1))
  # POSITIVE: each pattern and the line shareMetric() (console.log, INFO) or orphans.js (console.error) logs.
  echo "testing filter patterns against the exact lines index.js emits, Lambda prefix included"
  check "attempt matches"        "$P_ATTEMPT"  "${PFX}INFO${T}SHARE_METRIC attempt {\"target\":\"instagram\"}" 1
  check "posted matches"         "$P_POSTED"   "${PFX}INFO${T}SHARE_METRIC posted {\"target\":\"facebook\",\"status\":201}" 1
  check "failed matches"         "$P_FAILED"   "${PFX}INFO${T}SHARE_METRIC failed {\"target\":\"instagram\",\"kind\":\"GraphError\",\"graph\":190}" 1
  check "rejected matches"       "$P_REJECTED" "${PFX}INFO${T}SHARE_METRIC rejected {\"target\":\"facebook\",\"status\":404}" 1
  check "blocked matches"        "$P_BLOCKED"  "${PFX}INFO${T}SHARE_METRIC blocked {\"target\":\"instagram\",\"kinds\":[\"coordinates\"]}" 1
  check "staging retained match" "$P_RETAINED" "${PFX}INFO${T}SHARE_METRIC staging_version_retained {\"target\":\"instagram\",\"reason\":\"delete_version_denied\"}" 1
  check "orphan stranded match"  "$P_ORPHAN"   "${PFX}ERROR${T}orphan cleanup FAILED for 2 of 2 media M1,M2" 1

  # NEGATIVE CONTROLS. A pattern that matches everything is worse than no pattern: every metric would
  # move together and none would mean anything. These assert the outcomes stay distinguishable.
  echo "negative controls (each must match NOTHING)"
  check "failed !~ posted line"   "$P_FAILED"   "${PFX}INFO${T}SHARE_METRIC posted {\"target\":\"facebook\",\"status\":201}" 0
  check "posted !~ replay line"   "$P_POSTED"   "${PFX}INFO${T}SHARE_METRIC replay {\"target\":\"facebook\",\"status\":200}" 0
  check "rejected !~ failed line" "$P_REJECTED" "${PFX}INFO${T}SHARE_METRIC failed {\"target\":\"facebook\"}" 0
  check "blocked !~ failed line"  "$P_BLOCKED"  "${PFX}INFO${T}SHARE_METRIC failed {\"target\":\"instagram\"}" 0
  check "retained !~ failed line" "$P_RETAINED" "${PFX}INFO${T}SHARE_METRIC failed {\"target\":\"instagram\"}" 0
  # 'attempt' must not be tripped by prose that merely contains the word.
  check "attempt !~ prose"        "$P_ATTEMPT"  "${PFX}INFO${T}share attempt logged by something else" 0
  # The kit logs Clerk's message for any token before auth, and that message quotes the token header's kid.
  # These are the lines a caller writes with kid set to each alarmed phrase; the quoted-phrase patterns matched them.
  local kid='verifyToken failed: Unable to find a signing key in JWKS that matches the kid='
  check "failed !~ forged 401 line"   "$P_FAILED"   "${PFX}ERROR${T}${kid}'SHARE_METRIC failed' of the provided session token." 0
  check "orphan !~ forged 401 line"   "$P_ORPHAN"   "${PFX}ERROR${T}${kid}'orphan cleanup FAILED' of the provided session token." 0
  check "retained !~ forged 401 line" "$P_RETAINED" "${PFX}ERROR${T}${kid}'SHARE_METRIC staging_version_retained' of the provided session token." 0
  # The level field is the emitter's console method: the same words at another level are some other line.
  check "failed !~ ERROR-level line"  "$P_FAILED"   "${PFX}ERROR${T}SHARE_METRIC failed {\"target\":\"instagram\"}" 0
  check "orphan !~ INFO-level line"   "$P_ORPHAN"   "${PFX}INFO${T}orphan cleanup FAILED for 1 of 1 media M1" 0
  check "retained !~ ERROR-level line" "$P_RETAINED" "${PFX}ERROR${T}SHARE_METRIC staging_version_retained {\"target\":\"instagram\"}" 0

  if [ "$fails" -ne 0 ]; then
    echo "FAIL: $fails pattern check(s) wrong — do NOT trust these metrics until fixed." >&2
    return 1
  fi
  echo "all patterns verified against the emitted lines, with negative controls."
}

sum_metric() {   # metric name -> total datapoints sum over the window
  aws cloudwatch get-metric-statistics \
    --region "$REGION" --namespace "$NS" --metric-name "$1" \
    --start-time "$(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%SZ')" \
    --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --period 604800 --statistics Sum \
    --query 'Datapoints[0].Sum' --output text 2>/dev/null || echo "None"
}

verify() {
  echo "verifying the instrument actually moves (7d window)"
  local attempts; attempts="$(sum_metric ShareAttempts)"
  echo "  ShareAttempts = ${attempts}"
  if [ "$attempts" = "None" ] || [ "$attempts" = "0.0" ] || [ "$attempts" = "0" ]; then
    cat >&2 <<'EOF'
FAIL: ShareAttempts has never moved.

That means one of:
  - the handler carrying the SHARE_METRIC log lines is not deployed yet, or
  - no publish has been attempted since it was.

Either way the filters are unproven, so the alarm must NOT be armed: an alarm on a metric that no
code has been observed emitting is indistinguishable from an alarm on a healthy system. Exercise a
publish (staging first), then re-run.
EOF
    return 1
  fi
  echo "  instrument confirmed live."
}

alarm() {
  verify || { echo "refusing to arm the alarm on an unverified instrument." >&2; exit 1; }
  local -a actions=()
  [ -n "$SNS_TOPIC" ] && actions=(--alarm-actions "$SNS_TOPIC")
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-share-failures" \
    --alarm-description "A social publish failed. The Lambda Errors metric cannot see this: every failure path returns rather than throws." \
    --namespace "$NS" --metric-name ShareFailed \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    "${actions[@]+"${actions[@]}"}"
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-share-orphan-stranded" \
    --alarm-description "Orphan cleanup failed — an unpublished media object is still on the public Page and must be removed by hand." \
    --namespace "$NS" --metric-name ShareOrphanStranded \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    "${actions[@]+"${actions[@]}"}"
  # PRIVACY, not availability. Every firing means an EXIF-stripped copy of a private photo could not
  # be deleted and is sitting in the bucket as a non-current version. It accumulates silently and
  # nothing else in the system would ever surface it — there is no lifecycle rule to sweep it.
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-share-staging-retained" \
    --alarm-description "An Instagram staging object could not be deleted; stripped bytes of a private photo remain as a non-current S3 version. Check s3:DeleteObjectVersion on garden-app-lambda-exec (scripts/ig-staging-retention.sh)." \
    --namespace "$NS" --metric-name ShareStagingRetained \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    "${actions[@]+"${actions[@]}"}"
  # DELIBERATELY NO ALARM ON ShareBlocked. That metric fires when the content assertion STOPS a
  # publish — the guard doing its job. Paging on a working control trains the reader to dismiss it,
  # and the failure it would mask (the guard silently not running) is invisible to an alarm on the
  # guard's own output anyway. It is a metric to look at, not to be woken by.
  echo "alarms armed (failures, orphan-stranded, staging-retained). ShareBlocked intentionally unalarmed."
}

case "${1:-}" in
  provision)     provision ;;
  test-patterns) test_patterns ;;
  verify)        verify ;;
  alarm)         alarm ;;
  *) echo "usage: $0 {provision|test-patterns|verify|alarm}   # in that order, after deploying the handler" >&2; exit 2 ;;
esac
