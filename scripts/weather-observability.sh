#!/usr/bin/env bash
# OPS-WXOBSERVABILITY-001 — observability for the weather path in garden-daily-plan.
#
# WHY. Two of the weather path's failure modes are swallowed by design, so the Lambda `Errors`
# metric is structurally blind to both — it stays flat at zero through a total outage:
#
#   handler.js  logRainEvents()      catch -> console.error 'rain-log ERROR', return null
#   handler.js  writeWeatherDaily()  catch -> console.warn  'weather_daily write failed — plan
#                                             unaffected', return 0
#
# Both are correct fail-open choices: the nightly plan is already durable when they run and must
# never be lost to a station outage or a late migration. But fail-open without an instrument means
# "no rain logged last night" and "the rain logger crashed last night" are the same picture from the
# outside — and logRainEvents authors the latest water event for 217 of 239 live plantings.
#
# Before this script, `aws logs describe-metric-filters --log-group-name /aws/lambda/garden-daily-plan`
# returned `{"metricFilters": []}` and log retention is 30 days, so a failure was unobservable and
# then gone.
#
# ORDERING — same doctrine as scripts/share-observability.sh, and for the same reason. A metric
# filter keyed on a string no code emits reads zero forever and its alarm sits green permanently,
# which is worse than no alarm because it looks like coverage.
#   1. `provision`      creates the filters (inert, no alarm, no behaviour change).
#   2. `test-patterns`  proves each pattern matches the literal the DEPLOYED code emits, and does
#                       NOT match its neighbours. Server-side; needs no traffic. Runnable now.
#   3. `alarm`          arms the two FAILURE alarms. Gated on test-patterns, not on verify: both use
#                       `--treat-missing-data notBreaching`, so an unmoved metric cannot false-fire,
#                       and the literals are proven present on origin/main (the shipped branch).
#   4. `verify`         proves the instrument is genuinely live — RainLogRuns must have moved.
#                       Cannot pass until one scheduled run lands after `provision`.
#   5. `alarm-liveness` arms the missing-run alarm on RainLogRuns. REFUSES until `verify` passes,
#                       because that alarm treats missing data as BREACHING: arming it against an
#                       empty metric pages Dave immediately with a false alarm.
#
# RainLogRuns is the attempt counter and it is the point of the whole set. Without it, "zero
# failures" and "logRainEvents is no longer reached" are the same reading — which is precisely the
# failure mode weatherdaily.test.js already guards in unit space ("the rain reader never ran —
# logRainEvents is not reachable"). Every exit path of logRainEvents emits exactly one `rain-log`
# line, so the counter reads one per invocation. Measured baseline over 2026-08-29..09-02:
# exactly 3/day at 06:00, 09:30 and 19:30 UTC — the three EventBridge rules that target the
# function (garden-daily-plan-nightly / -intraday-am / -intraday-pm).
#
# Metric count is kept to three deliberately. CloudWatch cost here is custom METRICS, not alarms,
# and the remaining weather warn-paths (fetchNWS / fetchPrecip / fetchStation / AWN-secret /
# weather_daily read) are transient degradation that is expected to blip on a provider hiccup.
# Metering them would add spend and train dismissal without adding a signal anyone would act on.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FN="${FN:-garden-daily-plan}"
LOG_GROUP="/aws/lambda/${FN}"
NS="Garden/Weather"
SNS_TOPIC="${SNS_TOPIC:-arn:aws:sns:us-east-1:769788341849:garden-ops-alerts}"

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
  # Matched against the literal lines handler.js emits. Text patterns, not JSON patterns: the
  # Node.js runtime prefixes every line with "<ts>\t<requestId>\t<LEVEL>\t", so the log event is not
  # a bare JSON document and a `{ $.msg = ... }` pattern is the wrong tool for this log group.
  #
  # ATTEMPT counter. 'rain-log' is a substring of 'rain-log ERROR', which is deliberate — this
  # counts every completion of logRainEvents, successful or swallowed.
  emit_filter weather-rainlog-runs        '"rain-log"'                   RainLogRuns
  # FAILURE. handler.js logRainEvents catch — the fail-open that pins Lambda Errors at 0.
  emit_filter weather-rainlog-failed      '"rain-log ERROR"'             RainLogFailures
  # FAILURE. handler.js writeWeatherDaily catch. Keyed on the ASCII prefix only: the emitted string
  # continues "— plan unaffected" with an em dash, and there is no reason to put a non-ASCII
  # character inside a filter pattern.
  emit_filter weather-daily-write-failed  '"weather_daily write failed"' WeatherDailyWriteFailed
  echo "filters provisioned. Run '$0 test-patterns' next (needs no traffic), then '$0 alarm'."
}

# Prove each pattern matches what the deployed code actually emits, and — just as important — that
# it does not match a neighbouring line. `aws logs test-metric-filter` evaluates a pattern against
# supplied messages server-side, so this runs before any failure has ever occurred. The sample lines
# below carry the real runtime prefix, because a pattern that only works on bare JSON would pass a
# naive check here and match nothing in production.
test_patterns() {
  local fails=0 T
  T=$(printf '\t')
  local PFX="2026-09-01T06:00:12.000Z${T}4b8305ac-1609-4ed1-8ed6-74cd042724c4${T}"

  check() {  # label, pattern, message, expected match count
    local got
    got=$(aws logs test-metric-filter --region "$REGION" \
            --filter-pattern "$2" --log-event-messages "$3" \
            --query 'length(matches)' --output text 2>/dev/null || echo 0)
    if [ "$got" = "$4" ]; then
      echo "  ok    $1"
    else
      echo "  FAIL  $1 (expected $4 match(es), got $got)"; fails=$((fails+1))
    fi
  }

  # Real shapes. The healthy line is copied verbatim from production (2026-08-29 06:00:46Z).
  local L_OK="${PFX}INFO${T}{\"msg\":\"rain-log\",\"today\":\"2026-08-29\",\"day\":\"2026-08-28\",\"logged\":0,\"skipped\":\"below_threshold\",\"amount_in\":0,\"ms\":9}"
  local L_ERR="${PFX}ERROR${T}{\"msg\":\"rain-log ERROR\",\"today\":\"2026-08-29\",\"error\":\"relation weather_daily does not exist\"}"
  local L_WDFAIL="${PFX}WARN${T}{\"msg\":\"weather_daily write failed — plan unaffected\",\"space\":\"11111111-2222-3333-4444-555555555555\",\"error\":\"boom\"}"
  local L_WDOK="${PFX}INFO${T}{\"msg\":\"weather-daily-write\",\"space\":\"x\",\"rows\":3,\"null_et0\":0,\"null_precip\":0,\"gauge_yesterday\":true}"
  local L_WDREAD="${PFX}WARN${T}{\"msg\":\"weather_daily read failed — ledger degrades to demand 1.0\",\"space\":\"x\",\"error\":\"boom\"}"
  local L_FROST="${PFX}ERROR${T}{\"msg\":\"frost alert publish FAILED\",\"space\":\"x\",\"user\":\"u\",\"dedup_key\":\"k\",\"error\":\"boom\"}"

  echo "positive: each pattern matches the string handler.js emits"
  check "runs ~ healthy rain-log"      '"rain-log"'                   "$L_OK"      1
  check "runs ~ failed rain-log"       '"rain-log"'                   "$L_ERR"     1
  check "failures ~ rain-log ERROR"    '"rain-log ERROR"'             "$L_ERR"     1
  check "wd-write ~ write failed"      '"weather_daily write failed"' "$L_WDFAIL"  1

  # NEGATIVE CONTROLS. A pattern that matches everything is worse than no pattern: every metric
  # moves together and none of them means anything.
  echo "negative controls (each must match NOTHING)"
  check "failures !~ healthy rain-log" '"rain-log ERROR"'             "$L_OK"      0
  check "failures !~ frost failure"    '"rain-log ERROR"'             "$L_FROST"   0
  check "wd-write !~ healthy write"    '"weather_daily write failed"' "$L_WDOK"    0
  check "wd-write !~ read failed"      '"weather_daily write failed"' "$L_WDREAD"  0
  check "runs !~ weather-daily-write"  '"rain-log"'                   "$L_WDOK"    0
  check "runs !~ frost failure"        '"rain-log"'                   "$L_FROST"   0

  if [ "$fails" -ne 0 ]; then
    echo "FAIL: $fails pattern check(s) wrong — do NOT trust these metrics until fixed." >&2
    return 1
  fi
  echo "all patterns verified against literal strings, with negative controls."
}

sum_metric() {   # metric name -> Sum over the last 7 days
  aws cloudwatch get-metric-statistics \
    --region "$REGION" --namespace "$NS" --metric-name "$1" \
    --start-time "$(date -u -v-7d '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%SZ')" \
    --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --period 604800 --statistics Sum \
    --query 'Datapoints[0].Sum' --output text 2>/dev/null || echo "None"
}

verify() {
  echo "verifying the instrument actually moves (7d window)"
  local runs; runs="$(sum_metric RainLogRuns)"
  echo "  RainLogRuns = ${runs}"
  case "$runs" in
    None|0|0.0)
      cat >&2 <<'EOF'
FAIL: RainLogRuns has never moved.

A metric filter only counts events ingested AFTER it was created, so this is the honest state until
one scheduled run lands. garden-daily-plan runs at 06:00, 09:30 and 19:30 UTC, so wait for the next
one and re-run. If it is still zero after a full day, logRainEvents is no longer being reached and
the failure alarms are watching a dead code path.
EOF
      return 1 ;;
  esac
  echo "  instrument confirmed live (expected 3/day)."
}

alarm() {
  test_patterns || { echo "refusing to arm alarms on unproven patterns." >&2; exit 1; }
  echo "arming failure alarms -> ${SNS_TOPIC}"

  # PERIOD 3600 / EVALUATION-PERIODS 1, matching the existing garden-daily-plan-errors alarm on the
  # same function. This is a SCHEDULED function: 3 invocations a day, each bounded by a 120s Lambda
  # timeout. An hour therefore contains a whole run and never splits one, while 21 of the 24 hourly
  # periods carry no data at all — hence notBreaching, which keeps the alarm green through the gaps
  # instead of flapping. A 300s period (the share-observability default) would work but buys nothing
  # here: nothing is invoked between the runs.
  #
  # THRESHOLD 0 / EVALUATION-PERIODS 1 rather than a tolerance band, because one swallowed failure
  # is already the whole event being watched: it means the night's rain auto-log silently did not
  # run for ~217 plantings. Requiring two consecutive breaching hours would mean waiting for the
  # next day's invocation, so a single-night outage — the common case — would never fire.
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-weather-rainlog-failures" \
    --alarm-description "logRainEvents swallowed a failure (handler.js 'rain-log ERROR'). Rain was NOT auto-logged for that run. The Lambda Errors metric cannot see this: the catch is fail-open by design and returns null rather than throwing." \
    --namespace "$NS" --metric-name RainLogFailures \
    --statistic Sum --period 3600 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-weather-rainlog-failures"

  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-weather-daily-write-failed" \
    --alarm-description "writeWeatherDaily swallowed a failure ('weather_daily write failed'). The try wraps the whole day loop, so one bad row aborts the remaining days — this is a silent unbounded weather-capture outage, and the plan looks completely healthy through it." \
    --namespace "$NS" --metric-name WeatherDailyWriteFailed \
    --statistic Sum --period 3600 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-weather-daily-write-failed"
  echo "armed. Run '$0 alarm-liveness' once '$0 verify' passes."
}

alarm_liveness() {
  verify || { echo "refusing to arm a breaching-on-missing alarm against an empty metric." >&2; exit 1; }
  # PERIOD 86400 / THRESHOLD 1 / LessThanThreshold / breaching, matching the existing
  # garden-daily-plan-missing-run alarm. Threshold 1 rather than 3 on purpose: the failure this
  # catches is "logRainEvents is no longer reached at all", and a threshold of 3 would fire on any
  # single missed or slow run, or on a run straddling the UTC day boundary. This alarm is what stops
  # RainLogFailures from reading a permanent, meaningless zero.
  aws cloudwatch put-metric-alarm \
    --region "$REGION" \
    --alarm-name "garden-weather-rainlog-missing-run" \
    --alarm-description "logRainEvents produced no 'rain-log' line in 24h. Expected 3/day (06:00/09:30/19:30 UTC). Either garden-daily-plan is not running or logRainEvents is no longer reachable — in which case garden-weather-rainlog-failures is watching a dead path and its zero means nothing." \
    --namespace "$NS" --metric-name RainLogRuns \
    --statistic Sum --period 86400 --evaluation-periods 1 --threshold 1 \
    --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-weather-rainlog-missing-run"
}

# Everything this script creates, removed. Nothing here touches app behaviour, so the teardown is
# complete and leaves no residue beyond the metrics' own retention.
teardown() {
  for f in weather-rainlog-runs weather-rainlog-failed weather-daily-write-failed; do
    aws logs delete-metric-filter --region "$REGION" --log-group-name "$LOG_GROUP" --filter-name "$f" \
      && echo "  removed filter $f"
  done
  aws cloudwatch delete-alarms --region "$REGION" --alarm-names \
    garden-weather-rainlog-failures garden-weather-daily-write-failed garden-weather-rainlog-missing-run \
    && echo "  removed alarms"
}

case "${1:-}" in
  provision)      provision ;;
  test-patterns)  test_patterns ;;
  verify)         verify ;;
  alarm)          alarm ;;
  alarm-liveness) alarm_liveness ;;
  teardown)       teardown ;;
  *) echo "usage: $0 {provision|test-patterns|alarm|verify|alarm-liveness|teardown}   # in that order" >&2; exit 2 ;;
esac
