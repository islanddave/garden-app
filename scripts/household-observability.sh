#!/usr/bin/env bash
# OPS-HOUSEHOLDALARMS-001 — alarms on the household / authz log lines.
#
# WHY. The fail-closed authz work (BUG-AUTHZLAMBDA-001, v5.1.1-v5.1.3) answers a denied or degraded
# household check with a 403, a 400 or a narrower scope, and logs one JSON line. None of those paths
# throws, so the Lambda Errors metric stays at zero through them, and before this script no metric
# filter read any of the lines. A misconfigured GARDEN_HOUSEHOLD_IDS would show up only as Dave or Jen
# quietly seeing less.
#
# The seven lines, all `console.<level>(JSON.stringify({ msg: '<name>', ... }))` (dev 6cc3a465):
#   household-membership-denied  warn  lambda/shared-state/index.js        garden-shared-state
#   household-scope-degraded     log   lambda/daily-plan/handler.js        garden-daily-plan  (once per Space per run)
#   space-owner-missing          log   lambda/daily-plan/handler.js        garden-daily-plan  (once per Space per run)
#   assignee-outside-household   log   lambda/daily-plan/handler.js        garden-daily-plan  (once per Space per run)
#   overwinter-state-throw       warn  lambda/daily-plan/engine.js         garden-daily-plan  (error + fallback:true = planting skipped)
#   evidence-tier-denied         warn  lambda/evidence-ingest/index.js     garden-evidence-ingest
#   authz-fk-reject              warn  warnRejectedFk, lambda/household.js garden-<the 9 functions that CALL it, below>
# A 14-day prod count on 2026-10-16 was 0 for all seven (recon-household-alarms.md), so threshold 0 does
# not page on today's traffic.
#
# JSON PATTERNS, NOT TEXT. Every function logs in Text format, so a line is
# "<ts>\t<requestId>\t<LEVEL>\t{json}". CloudWatch still parses the JSON body for a `{ $.msg = ... }`
# pattern (proven server-side by test-patterns below, including the prefix), and a JSON pattern on
# `msg` cannot match a line that merely quotes the literal inside another field (an `error` or `value`
# string), which a text pattern would. (weather-observability.sh says JSON patterns are the wrong tool
# for this format; test-patterns here is the evidence that they work.)
#
# ALARM SHAPE. One metric per line, one alarm per metric, all to garden-ops-alerts (email only).
# Period 3600, 24 evaluation periods, 1 datapoint to alarm, threshold 0, missing = notBreaching: the
# alarm goes to ALARM on the first hour with any line and stays there until 24 hours pass with none,
# so a condition that repeats on every hourly daily-plan run sends ONE email per episode, not one per
# gap in the schedule (its largest gap is 4 h). For the user-driven lines (membership, evidence tier,
# fk reject) a recurrence after 24 quiet hours is a new episode and a new email, and a condition that
# never stops sends one email and no reminder. There is no OK action: the email is the start of an
# episode, the console shows its end. household-membership-denied does not split reason env-missing
# (misconfiguration) from non-member (a third account): read the line's `reason`.
#
# ORDERING (same doctrine as weather-observability.sh): `provision` makes inert filters; `test-patterns`
# proves every pattern against the literal the code emits AND against neighbours it must not match;
# `alarm` refuses unless test-patterns passes, every filter `provision` should have made is live with
# the proven pattern, and every target function still logs in Text format (the format the patterns were
# proven on). There is no liveness step: these lines are rare by design, so a zero is the healthy
# reading, and the pattern proof is what stands in for traffic. scripts/test_household_observability.py
# pins FK_FUNCTIONS and each msg literal to the code that emits it.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=769788341849
NS="Garden/Household"
SNS_TOPIC="${SNS_TOPIC:-arn:aws:sns:${REGION}:${ACCOUNT}:garden-ops-alerts}"

require_account() {
  local got
  got=$(aws sts get-caller-identity --query Account --output text) || { echo "cannot read the AWS identity" >&2; exit 1; }
  [ "$got" = "$ACCOUNT" ] || { echo "refusing: credentials are for account $got, not $ACCOUNT" >&2; exit 1; }
}

# The dirs that CALL warnRejectedFk (git grep on dev). The other nine dirs that ship household.js only
# carry the definition; a filter on their log groups would be dead.
FK_FUNCTIONS="events evidence-ingest inventory-items locations photos plants preservation projects varieties"

# name|log-group function|metric|msg
FILTERS="
household-membership-denied|shared-state|HouseholdMembershipDenied|household-membership-denied
household-scope-degraded|daily-plan|HouseholdScopeDegraded|household-scope-degraded
household-space-owner-missing|daily-plan|SpaceOwnerMissing|space-owner-missing
household-assignee-outside|daily-plan|AssigneeOutsideHousehold|assignee-outside-household
household-overwinter-state-throw|daily-plan|OverwinterStateThrow|overwinter-state-throw
household-evidence-tier-denied|evidence-ingest|EvidenceTierDenied|evidence-tier-denied
"

pattern() { printf '{ $.msg = "%s" }' "$1"; }

emit_filter() {   # filter-name, function dir, metric, msg
  aws logs put-metric-filter --region "$REGION" \
    --log-group-name "/aws/lambda/garden-$2" --filter-name "$1" \
    --filter-pattern "$(pattern "$4")" \
    --metric-transformations "metricName=$3,metricNamespace=${NS},metricValue=1,defaultValue=0"
  echo "  ok  garden-$2: $1 -> ${NS}/$3"
}

each_filter() {   # callback with: name fn metric msg (authz-fk-reject expanded per calling function)
  local name fn metric msg f
  while IFS='|' read -r name fn metric msg; do
    [ -n "$name" ] || continue
    "$1" "$name" "$fn" "$metric" "$msg"
  done <<< "$FILTERS"
  for f in $FK_FUNCTIONS; do "$1" household-authz-fk-reject "$f" AuthzFkReject authz-fk-reject; done
}

provision() {
  require_account
  echo "provisioning metric filters (inert until '$0 alarm')"
  each_filter emit_filter
  echo "filters provisioned. Run '$0 test-patterns', then '$0 alarm'."
}

# Server-side proof (aws logs test-metric-filter): each pattern matches the line its code emits, with
# the real Text-format prefix, and matches nothing else. Needs no traffic.
test_patterns() {
  local fails=0 T PFX ERRF
  ERRF=$(mktemp)
  T=$(printf '\t')
  PFX="2026-10-16T13:00:12.000Z${T}4b8305ac-1609-4ed1-8ed6-74cd042724c4${T}"

  check() {  # label, msg, log line, expected matches
    local got
    got=$(aws logs test-metric-filter --region "$REGION" \
            --filter-pattern "$(pattern "$2")" --log-event-messages "$3" \
            --query 'length(matches)' --output text 2>"$ERRF") || got="error: $(head -1 "$ERRF")"
    if [ "$got" = "$4" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (expected $4, got $got)"; fails=$((fails+1)); fi
  }

  local U='user_0000000000000000000000test' SP='11111111-2222-3333-4444-555555555555'
  local L_MEMB="${PFX}WARN${T}{\"msg\":\"household-membership-denied\",\"userId\":\"${U}\",\"reason\":\"non-member\"}"
  local L_DEGR="${PFX}INFO${T}{\"msg\":\"household-scope-degraded\",\"space_id\":\"${SP}\",\"reason\":\"env-single-entry\",\"members\":1,\"plantings\":12,\"assignees_excluded\":0}"
  local L_OWNR="${PFX}INFO${T}{\"msg\":\"space-owner-missing\",\"space_id\":\"${SP}\",\"plantings\":3}"
  local L_ASGN="${PFX}INFO${T}{\"msg\":\"assignee-outside-household\",\"space_id\":\"${SP}\",\"count\":2,\"plant_ids\":[\"a\",\"b\"]}"
  local L_OWT1="${PFX}WARN${T}{\"msg\":\"overwinter-state-throw\",\"planting\":\"p1\",\"error\":\"bad window\"}"
  local L_OWT2="${PFX}ERROR${T}{\"msg\":\"overwinter-state-throw\",\"planting\":\"p1\",\"fallback\":true,\"error\":\"bad window\"}"
  local L_EVID="${PFX}WARN${T}{\"msg\":\"evidence-tier-denied\",\"userId\":\"${U}\",\"fields\":[\"tier\"]}"
  local L_FK="${PFX}WARN${T}{\"msg\":\"authz-fk-reject\",\"userId\":\"${U}\",\"table\":\"locations\",\"column\":\"parent_id\",\"value\":\"x\"}"
  # Neighbours: the closest real lines, and lines that QUOTE a literal inside another field.
  local N_BADDATE="${PFX}WARN${T}{\"msg\":\"overwinter-bad-date\",\"planting\":\"p1\",\"fields\":[\"start\"]}"
  local N_RAIN="${PFX}INFO${T}{\"msg\":\"rain-log\",\"today\":\"2026-10-16\",\"logged\":0}"
  local N_QUOTE="${PFX}ERROR${T}{\"msg\":\"plan run failed\",\"error\":\"authz-fk-reject household-membership-denied space-owner-missing overwinter-state-throw evidence-tier-denied household-scope-degraded assignee-outside-household\"}"
  local N_JWT="${PFX}ERROR${T}verifyToken failed: Invalid JWT form. A JWT consists of three parts separated by dots."
  local N_BARE="${PFX}WARN${T}household-membership-denied authz-fk-reject"

  echo "positive: each pattern matches its emitted line (runtime prefix included)"
  check "membership-denied"          household-membership-denied "$L_MEMB" 1
  check "scope-degraded"             household-scope-degraded    "$L_DEGR" 1
  check "space-owner-missing"        space-owner-missing         "$L_OWNR" 1
  check "assignee-outside"           assignee-outside-household  "$L_ASGN" 1
  check "overwinter throw (warn)"    overwinter-state-throw      "$L_OWT1" 1
  check "overwinter throw (skipped)" overwinter-state-throw      "$L_OWT2" 1
  check "evidence-tier-denied"       evidence-tier-denied        "$L_EVID" 1
  check "authz-fk-reject"            authz-fk-reject             "$L_FK"   1

  echo "negative controls (each must match NOTHING)"
  local m
  for m in household-membership-denied household-scope-degraded space-owner-missing assignee-outside-household \
           overwinter-state-throw evidence-tier-denied authz-fk-reject; do
    check "$m !~ literal quoted in error" "$m" "$N_QUOTE"   0
    check "$m !~ tokenless 401 line"      "$m" "$N_JWT"     0
    check "$m !~ bare text"               "$m" "$N_BARE"    0
    check "$m !~ rain-log"                "$m" "$N_RAIN"    0
  done
  check "overwinter !~ overwinter-bad-date" overwinter-state-throw   "$N_BADDATE" 0
  check "degraded !~ owner-missing"         household-scope-degraded "$L_OWNR"    0
  check "owner-missing !~ degraded"         space-owner-missing      "$L_DEGR"    0
  check "membership !~ evidence denial"     household-membership-denied "$L_EVID" 0
  check "evidence !~ membership denial"     evidence-tier-denied     "$L_MEMB"    0
  check "fk-reject !~ membership denial"    authz-fk-reject          "$L_MEMB"    0

  if [ "$fails" -ne 0 ]; then
    echo "FAIL: $fails pattern check(s) wrong. Do NOT arm alarms on these metrics." >&2
    return 1
  fi
  echo "all patterns verified against the emitted literals, with negative controls."
}

ALARMS="
HouseholdMembershipDenied|garden-household-membership-denied|garden-shared-state refused a caller as not a household member (or GARDEN_HOUSEHOLD_IDS is missing on it): shared state 403s. Check the function's GARDEN_HOUSEHOLD_IDS against garden-events.
HouseholdScopeDegraded|garden-household-scope-degraded|garden-daily-plan narrowed a Space to its owner alone (reason env-missing, env-single-entry or owner-not-in-household): the other household member's plantings drop out of Today. Check GARDEN_HOUSEHOLD_IDS on garden-daily-plan.
SpaceOwnerMissing|garden-household-space-owner-missing|garden-daily-plan met a Space with no owner (blank created_by) or plantings in no Space: those plantings get no household scope.
AssigneeOutsideHousehold|garden-household-assignee-outside|garden-daily-plan met plantings assigned to someone outside the Space's household: they are excluded from that Space's plan.
OverwinterStateThrow|garden-household-overwinter-state-throw|engine.js overwinterState threw for a planting; with fallback:true the planting was skipped from the plan entirely.
EvidenceTierDenied|garden-household-evidence-tier-denied|garden-evidence-ingest refused admin-only fields from a non-admin caller (403).
AuthzFkReject|garden-household-authz-fk-reject|A write named a parent row outside the caller's household and was refused with a 400 (warnRejectedFk, 9 functions). A client bug or a household membership misconfiguration.
"

# The filter provision made is live, with the proven pattern, metric and namespace. Prints one line per
# filter; returns non-zero if any is missing or different.
verify_filter() {   # filter-name, function dir, metric, msg
  local got want
  want="$(pattern "$4")|$3|${NS}"
  got=$(aws logs describe-metric-filters --region "$REGION" --log-group-name "/aws/lambda/garden-$2" \
          --filter-name-prefix "$1" \
          --query "metricFilters[?filterName=='$1'] | [0].[filterPattern, metricTransformations[0].metricName, metricTransformations[0].metricNamespace]" \
          --output text 2>/dev/null | tr '\t' '|') || got="unreadable"
  if [ "$got" = "$want" ]; then echo "  live    garden-$2/$1"; return 0; fi
  echo "  WRONG   garden-$2/$1 (live: ${got:-absent})"; return 1
}

verify_filters() {
  local bad=0 name fn metric msg f
  while IFS='|' read -r name fn metric msg; do
    [ -n "$name" ] || continue
    verify_filter "$name" "$fn" "$metric" "$msg" || bad=1
  done <<< "$FILTERS"
  for f in $FK_FUNCTIONS; do verify_filter household-authz-fk-reject "$f" AuthzFkReject authz-fk-reject || bad=1; done
  return "$bad"
}

# The patterns were proven on the Text-format line ("<ts>\t<reqId>\t<LEVEL>\t{json}"). A function moved to
# JSON log format would need the patterns proven again first.
verify_log_format() {
  local bad=0 fn fmt
  for fn in shared-state daily-plan evidence-ingest $FK_FUNCTIONS; do
    fmt=$(aws lambda get-function-configuration --region "$REGION" --function-name "garden-$fn" \
            --query 'LoggingConfig.LogFormat' --output text 2>/dev/null) || fmt="unreadable"
    [ "$fmt" = "Text" ] || { echo "  log format garden-$fn: $fmt (want Text)"; bad=1; }
  done
  return "$bad"
}

alarm() {
  require_account
  test_patterns || { echo "refusing to arm alarms on unproven patterns." >&2; exit 1; }
  verify_filters || { echo "refusing to arm: a filter is missing or differs from the proven pattern (run provision)." >&2; exit 1; }
  verify_log_format || { echo "refusing to arm: a function no longer logs in Text format." >&2; exit 1; }
  echo "arming alarms -> ${SNS_TOPIC}"
  local metric name desc
  while IFS='|' read -r metric name desc; do
    [ -n "$metric" ] || continue
    aws cloudwatch put-metric-alarm --region "$REGION" \
      --alarm-name "$name" --alarm-description "$desc (OPS-HOUSEHOLDALARMS-001, scripts/household-observability.sh)" \
      --namespace "$NS" --metric-name "$metric" \
      --statistic Sum --period 3600 --evaluation-periods 24 --datapoints-to-alarm 1 --threshold 0 \
      --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
      --alarm-actions "$SNS_TOPIC"
    echo "  ok  $name"
  done <<< "$ALARMS"
}

status() {   # read-only: what exists now
  verify_filters || true
  aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix garden-household- \
    --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
}

# Alarms first, then filters, and every delete tolerates "already gone", so a second teardown or one after
# a partial provision still completes instead of stopping at the first missing filter.
teardown() {
  require_account
  local names
  names=$(printf '%s\n' "$ALARMS" | cut -d'|' -f2 | grep . | tr '\n' ' ')
  # shellcheck disable=SC2086  # one alarm name per word, by construction
  if aws cloudwatch delete-alarms --region "$REGION" --alarm-names $names; then echo "  removed alarms"
  else echo "  alarms: delete refused (see above)"; fi
  rm_filter() {
    if aws logs delete-metric-filter --region "$REGION" --log-group-name "/aws/lambda/garden-$2" --filter-name "$1" 2>/dev/null; then
      echo "  removed garden-$2/$1"
    else
      echo "  absent  garden-$2/$1"
    fi
  }
  each_filter rm_filter
}

case "${1:-}" in
  provision)     provision ;;
  test-patterns) test_patterns ;;
  alarm)         alarm ;;
  status)        status ;;
  teardown)      teardown ;;
  *) echo "usage: $0 {provision|test-patterns|alarm|status|teardown}   # provision, test-patterns, alarm in that order" >&2; exit 2 ;;
esac
