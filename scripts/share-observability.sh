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
#   2. `provision` creates the filters (inert, safe, no alarm).
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
  echo "provisioning metric filters on ${LOG_GROUP}"
  # Matched against the literal lines emitted by shareMetric() in index.js.
  emit_filter share-attempt  '"SHARE_METRIC attempt"'  ShareAttempts
  emit_filter share-posted   '"SHARE_METRIC posted"'   SharePosted
  emit_filter share-failed   '"SHARE_METRIC failed"'   ShareFailed
  emit_filter share-rejected '"SHARE_METRIC rejected"' ShareRejected
  # Not a SHARE_METRIC line — this one is the orphan-cleanup failure from orphans.js, which means a
  # real unpublished object was left on the public Page and needs removing by hand.
  emit_filter share-orphan-stranded '"orphan cleanup FAILED"' ShareOrphanStranded
  echo "filters provisioned. Run '$0 verify' AFTER exercising a publish — do not arm the alarm first."
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
  echo "alarms armed."
}

case "${1:-}" in
  provision) provision ;;
  verify)    verify ;;
  alarm)     alarm ;;
  *) echo "usage: $0 {provision|verify|alarm}   # run in that order, after deploying the handler" >&2; exit 2 ;;
esac
