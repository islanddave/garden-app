#!/usr/bin/env bash
# Meta (Facebook/Instagram) credential health — the only instrument that can see a data-access lapse.
#
# WHY THIS EXISTS. The prod Page token has TWO independent clocks and every prior check read the
# wrong one:
#   expires_at             = 0            -> the credential never expires. True, and not the point.
#   data_access_expires_at = <moving>     -> the app's access to the user's data, 90 days from the
#                                            user's LAST AUTHORIZATION.
# When the second lapses, Meta's own docs say the user "is still authenticated" but "your app can't
# access their data" — a SCOPE REDUCTION, not a revocation. So `is_valid` stays TRUE and any health
# check that keys on is_valid/expires_at reports a green light through the outage. The Lambda
# `Errors` metric is blind too (every failure path in lambda/facebook-share/index.js RETURNS rather
# than throwing), and Garden/Share ShareFailed only moves if somebody happens to attempt a post.
# On a quiet week a lapse produces zero signal anywhere until Dave tries to post and it fails.
#
# THE DATE MOVES — DO NOT HARDCODE IT. Measured 2026-08-30 the value was 2026-11-19; measured
# 2026-08-31 it was 2026-11-28. Nothing was rotated. The clock belongs to the app<->user GRANT, not
# to a token: prod and staging return a BYTE-IDENTICAL data_access_expires_at despite different
# Pages, different secrets and different issue dates, so re-authing staging moved prod's deadline
# nine days. A fireAt reminder or a cached date is the wrong shape for this problem. Poll it.
#
# SCOPES ARE THE BETTER SIGNAL. Because a lapse presents as reduced permissions, a shrinking `scopes`
# array is a more direct detector than the countdown, and it also catches unrelated permission loss.
# Meta publishes a "do not expire" list; cross-referencing it against the two publish endpoints:
#   FB Page photo publish needs pages_show_list + pages_read_engagement + pages_manage_posts
#                                                            -> all three ARE on the exempt list
#   IG publish needs instagram_basic + instagram_content_publish + pages_read_engagement
#                                     ^^^^^^^^^^^^^^^^^^^^^^^^^ NEITHER is on the exempt list
# So the likely failure is ASYMMETRIC: Instagram publishing stops, Facebook keeps working. Meta has
# never published that combined claim and no empirical report exists in either direction, which is
# exactly why this script records the scope set every day rather than asserting an outcome — the
# November window turns the ambiguity into a measured fact.
#
# NO PUSH SIGNAL EXISTS. No webhook field, no developer-notification category, no documented
# pre-expiry email. Polling is the only channel. A once-daily poll is negligible against the
# app-level rate budget; a per-request pre-flight check would not be.
#
# Subcommands:
#   check             poll Graph debug_token, classify, emit CloudWatch metrics, alert to SNS on ALERT
#   selftest          exercise the classifier against fixtures — no network, no AWS, no credentials
#   alarms            provision the two content alarms (idempotent, safe before any data exists)
#   alarms-staleness  provision the monitor-is-down alarm; REFUSES until the feeder has actually run
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SECRET_ID="${FB_SECRET_NAME:-garden-app/facebook-page-token}"
GRAPH_VERSION="${FB_GRAPH_VERSION:-v21.0}"
NS="Garden/Share"
SNS_TOPIC="${SNS_TOPIC:-arn:aws:sns:us-east-1:769788341849:garden-ops-alerts}"
OUT="${OUT:-meta-token-report.json}"

# Days of runway below which we alert. 21 leaves three weeks for a 5-10 minute manual re-auth.
ALERT_DAYS="${ALERT_DAYS:-21}"
WARN_DAYS="${WARN_DAYS:-35}"

# Required for Facebook Page photo publishing (all on Meta's do-not-expire list).
FB_SCOPES="pages_show_list pages_read_engagement pages_manage_posts"
# Required for Instagram publishing. instagram_* are NOT on the do-not-expire list.
IG_SCOPES="instagram_basic instagram_content_publish pages_read_engagement"

log() { printf '%s\n' "$*" >&2; }

# classify <is_valid> <days_remaining> <missing_fb_csv> <missing_ig_csv>
# Echoes one of OK | WARN | ALERT. Pure function — no network, no AWS. This is what selftest covers.
classify() {
  local valid="$1" days="$2" missing_fb="$3" missing_ig="$4"
  if [ "$valid" != "true" ]; then echo "ALERT"; return; fi
  # A missing publish scope is the failure itself, not a forecast of one.
  if [ -n "$missing_fb" ] || [ -n "$missing_ig" ]; then echo "ALERT"; return; fi
  # days may be a float; compare with awk rather than bash integer arithmetic.
  if awk -v d="$days" -v t="$ALERT_DAYS" 'BEGIN{exit !(d <= t)}'; then echo "ALERT"; return; fi
  if awk -v d="$days" -v t="$WARN_DAYS" 'BEGIN{exit !(d <= t)}'; then echo "WARN"; return; fi
  echo "OK"
}

# missing_from <granted-space-separated> <required-space-separated> -> csv of required-but-absent
missing_from() {
  local granted="$1" required="$2" want out=""
  for want in $required; do
    case " $granted " in
      *" $want "*) ;;
      *) out="${out:+$out,}$want" ;;
    esac
  done
  printf '%s' "$out"
}

selftest() {
  local fails=0
  # shellcheck disable=SC2317
  assert() { # expected actual label
    if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 — expected '$1', got '$2'"; fails=$((fails+1)); fi
  }

  echo "classify()"
  assert ALERT "$(classify false 80 '' '')"                        "invalid token alerts even with 80 days runway"
  assert ALERT "$(classify true 80 '' 'instagram_basic')"           "a missing IG scope alerts regardless of runway"
  assert ALERT "$(classify true 80 'pages_manage_posts' '')"        "a missing FB scope alerts regardless of runway"
  assert ALERT "$(classify true 21 '' '')"                          "runway exactly at the alert threshold alerts"
  assert ALERT "$(classify true 0 '' '')"                           "expired runway alerts"
  assert ALERT "$(classify true -5 '' '')"                          "negative runway alerts"
  assert WARN  "$(classify true 22 '' '')"                          "one day above the alert threshold warns"
  assert WARN  "$(classify true 35 '' '')"                          "runway exactly at the warn threshold warns"
  assert OK    "$(classify true 36 '' '')"                          "one day above the warn threshold is OK"
  assert OK    "$(classify true 89 '' '')"                          "a freshly re-authed grant is OK"
  assert WARN  "$(classify true 30.4 '' '')"                        "fractional days compare correctly"

  echo "missing_from()"
  assert ''                             "$(missing_from 'a b c' 'a b')"                    "all required present -> empty"
  assert 'c'                            "$(missing_from 'a b' 'a b c')"                    "one absent"
  assert 'b,c'                          "$(missing_from 'a' 'a b c')"                      "two absent, csv"
  assert ''                             "$(missing_from 'pages_show_list pages_read_engagement pages_manage_posts' "$FB_SCOPES")" "real FB grant satisfies FB scopes"
  assert 'instagram_basic,instagram_content_publish' \
         "$(missing_from 'pages_show_list pages_read_engagement pages_manage_posts' "$IG_SCOPES")" "an FB-only grant is missing both IG scopes"
  # Substring safety: a scope that merely CONTAINS a required name must not satisfy it.
  assert 'pages_manage_posts'           "$(missing_from 'pages_manage_posts_extra' 'pages_manage_posts')" "substring does not count as a match"

  echo
  if [ "$fails" -eq 0 ]; then echo "selftest: all assertions passed"; else echo "selftest: $fails FAILED"; return 1; fi
}

check() {
  local secret app_id app_secret page_token
  secret="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)"
  app_id="$(printf '%s' "$secret"     | python3 -c 'import sys,json;print(json.load(sys.stdin)["app_id"])')"
  app_secret="$(printf '%s' "$secret" | python3 -c 'import sys,json;print(json.load(sys.stdin)["app_secret"])')"
  page_token="$(printf '%s' "$secret" | python3 -c 'import sys,json;print(json.load(sys.stdin)["page_token"])')"

  local resp
  resp="$(curl -sS -G "https://graph.facebook.com/${GRAPH_VERSION}/debug_token" \
            --data-urlencode "input_token=${page_token}" \
            --data-urlencode "access_token=${app_id}|${app_secret}")"

  if printf '%s' "$resp" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if "error" in d else 1)'; then
    log "::warning::debug_token returned an error — reporting UNVERIFIED, not alerting"
    printf '%s' "$resp" | python3 -c 'import sys,json;print(json.dumps({"status":"UNVERIFIED","graph_error":json.load(sys.stdin)["error"]}))' > "$OUT"
    cat "$OUT"
    return 0
  fi

  # Pull the fields out once, as a tab-separated line, so no secret ever reaches the log.
  local parsed valid expires_at dae issued scopes days
  parsed="$(printf '%s' "$resp" | python3 -c '
import sys, json, time
d = json.load(sys.stdin)["data"]
dae = int(d.get("data_access_expires_at") or 0)
days = (dae - time.time()) / 86400.0 if dae else -1.0
print("\t".join([
    "true" if d.get("is_valid") else "false",
    str(int(d.get("expires_at") or 0)),
    str(dae),
    str(int(d.get("issued_at") or 0)),
    " ".join(d.get("scopes") or []),
    "%.3f" % days,
]))')"
  IFS=$'\t' read -r valid expires_at dae issued scopes days <<< "$parsed"

  local missing_fb missing_ig status
  missing_fb="$(missing_from "$scopes" "$FB_SCOPES")"
  missing_ig="$(missing_from "$scopes" "$IG_SCOPES")"
  status="$(classify "$valid" "$days" "$missing_fb" "$missing_ig")"

  python3 - "$status" "$valid" "$expires_at" "$dae" "$issued" "$days" "$missing_fb" "$missing_ig" "$scopes" > "$OUT" <<'PY'
import sys, json, datetime
_, status, valid, expires_at, dae, issued, days, mfb, mig, scopes = sys.argv
iso = lambda t: datetime.datetime.fromtimestamp(int(t), datetime.timezone.utc).isoformat() if int(t) else None
print(json.dumps({
    "status": status,
    "is_valid": valid == "true",
    "expires_at": int(expires_at),
    "expires_at_iso": iso(expires_at),
    "data_access_expires_at": int(dae),
    "data_access_expires_at_iso": iso(dae),
    "issued_at_iso": iso(issued),
    "days_remaining": round(float(days), 3),
    "scopes": scopes.split() if scopes else [],
    "missing_facebook_scopes": mfb.split(",") if mfb else [],
    "missing_instagram_scopes": mig.split(",") if mig else [],
}, indent=2))
PY
  cat "$OUT"

  local missing_count=0
  [ -n "$missing_fb" ] && missing_count=$((missing_count + $(printf '%s' "$missing_fb" | tr ',' '\n' | wc -l)))
  [ -n "$missing_ig" ] && missing_count=$((missing_count + $(printf '%s' "$missing_ig" | tr ',' '\n' | wc -l)))

  aws cloudwatch put-metric-data --region "$REGION" --namespace "$NS" \
    --metric-data \
      "MetricName=MetaDataAccessDaysRemaining,Value=${days},Unit=Count" \
      "MetricName=MetaTokenScopesMissing,Value=${missing_count},Unit=Count" \
      "MetricName=MetaTokenValid,Value=$([ "$valid" = true ] && echo 1 || echo 0),Unit=Count"
  log "metrics emitted to ${NS}"

  if [ "$status" = "ALERT" ]; then
    aws sns publish --region "$REGION" --topic-arn "$SNS_TOPIC" \
      --subject "garden-app: Meta credential ALERT" \
      --message "$(cat "$OUT")" >/dev/null
    log "ALERT published to ${SNS_TOPIC}"
  fi
  log "status=${status} days_remaining=${days} missing=${missing_count}"
}

alarms() {
  # Threshold alarm. Sum is wrong for a gauge — use Minimum so a single bad reading in the period wins.
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name garden-meta-data-access-expiring \
    --alarm-description "Meta data-access runway is inside ${ALERT_DAYS} days. Re-authorize the app grant (auth_type=reauthorize); this does NOT self-renew." \
    --namespace "$NS" --metric-name MetaDataAccessDaysRemaining --statistic Minimum \
    --period 86400 --evaluation-periods 1 --threshold "$ALERT_DAYS" \
    --comparison-operator LessThanOrEqualToThreshold --treat-missing-data notBreaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-meta-data-access-expiring"

  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name garden-meta-token-scopes-missing \
    --alarm-description "A publish permission has disappeared from the Meta token grant. This is the data-access lapse presenting as scope reduction — Instagram publishing is the expected first casualty." \
    --namespace "$NS" --metric-name MetaTokenScopesMissing --statistic Maximum \
    --period 86400 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-meta-token-scopes-missing"

  echo
  echo "NOT armed: garden-meta-token-check-missing-run — run '$0 alarms-staleness' once the"
  echo "scheduled feeder is actually running. See that subcommand for why."
}

# The staleness alarm is the one that catches the monitor itself dying — without it, absence of
# signal reads as success. But it is `treat-missing-data breaching` by construction, so arming it
# before a feeder exists guarantees a false alert within 48h, and an alarm that cried wolf on day
# one is worse than no alarm. Same ordering discipline as share-observability.sh: prove the
# instrument moves, THEN arm on it.
alarms_staleness() {
  local n
  n="$(aws cloudwatch get-metric-statistics --region "$REGION" \
        --namespace "$NS" --metric-name MetaTokenValid --statistic SampleCount \
        --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
        --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --period 86400 --query 'length(Datapoints)' --output text)"
  if [ "${n:-0}" -lt 2 ]; then
    echo "REFUSING to arm: MetaTokenValid has ${n:-0} daily datapoint(s) in the last 7 days, need >= 2." >&2
    echo "The scheduled feeder is not running yet. Arming now would alarm within 48h on its own absence." >&2
    return 1
  fi
  aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name garden-meta-token-check-missing-run \
    --alarm-description "The Meta credential check has not reported in 48h — the monitor itself is down, so the other two alarms are meaningless." \
    --namespace "$NS" --metric-name MetaTokenValid --statistic SampleCount \
    --period 172800 --evaluation-periods 1 --threshold 1 \
    --comparison-operator LessThanThreshold --treat-missing-data breaching \
    --alarm-actions "$SNS_TOPIC"
  echo "  ok  garden-meta-token-check-missing-run (armed on ${n} observed datapoints)"
}

# ---------------------------------------------------------------------------
# System-user migration (OPS-FBSYSTEMUSER-001).
#
# A Meta SYSTEM USER token needs no re-authorization, which would end the 90-day chore outright.
# Whether it actually helps is an EMPIRICAL question Meta has never documented: nothing on the
# system-users page mentions data access at all (searched: "data_access", "never expire", "do not
# expire" — zero hits). If a system user token carries its own 90-day clock, the migration trades one
# chore for the same chore plus a harder setup. So the swap is gated on a MEASUREMENT, not a promise.
#
# THE CANDIDATE TOKEN MUST NEVER TRANSIT CHAT. Put it in one of two places and this script reads it:
#   - a local file:  CANDIDATE_TOKEN_FILE=~/candidate.txt scripts/meta-token-check.sh verify-candidate
#   - or an AWS secret named  garden-app/facebook-page-token-candidate  (key: page_token)
# Delete the local file afterwards; `swap-candidate` reminds you.
CANDIDATE_SECRET="${CANDIDATE_SECRET:-garden-app/facebook-page-token-candidate}"

read_candidate() {   # echoes the token, never logs it
  if [ -n "${CANDIDATE_TOKEN_FILE:-}" ]; then
    [ -r "$CANDIDATE_TOKEN_FILE" ] || { log "cannot read CANDIDATE_TOKEN_FILE=$CANDIDATE_TOKEN_FILE"; return 1; }
    tr -d ' \t\r\n' < "$CANDIDATE_TOKEN_FILE"
  else
    aws secretsmanager get-secret-value --region "$REGION" --secret-id "$CANDIDATE_SECRET" \
      --query SecretString --output text \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["page_token"] if isinstance(d,dict) else d)'
  fi
}

verify_candidate() {
  local live app_id app_secret cand page_id ig_id
  live="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)"
  app_id="$(printf '%s' "$live"     | python3 -c 'import sys,json;print(json.load(sys.stdin)["app_id"])')"
  app_secret="$(printf '%s' "$live" | python3 -c 'import sys,json;print(json.load(sys.stdin)["app_secret"])')"
  page_id="$(printf '%s' "$live"    | python3 -c 'import sys,json;print(json.load(sys.stdin)["page_id"])')"
  ig_id="$(printf '%s' "$live"      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ig_user_id",""))')"
  cand="$(read_candidate)" || return 1
  [ -n "$cand" ] || { log "candidate token is empty"; return 1; }

  local resp
  resp="$(curl -sS -G "https://graph.facebook.com/${GRAPH_VERSION}/debug_token" \
            --data-urlencode "input_token=${cand}" \
            --data-urlencode "access_token=${app_id}|${app_secret}")"

  # NOTE: the heredoc supplies python's PROGRAM on stdin, so the response cannot also come by pipe —
  # it is passed by environment instead. Piping it here silently yields an empty read.
  RESP="$resp" python3 - "$FB_SCOPES $IG_SCOPES" <<'PY'
import sys, os, json, datetime
required = sorted(set(sys.argv[1].split()))
raw = json.loads(os.environ["RESP"])
if "error" in raw:
    print("FAIL  debug_token returned an error:", raw["error"].get("message")); sys.exit(1)
d = raw["data"]
iso = lambda t: datetime.datetime.fromtimestamp(int(t), datetime.timezone.utc).isoformat() if int(t) else "0 (never)"
scopes, fails = d.get("scopes") or [], []
print(f"  type                   {d.get('type')}")
print(f"  is_valid               {d.get('is_valid')}")
print(f"  expires_at             {iso(d.get('expires_at') or 0)}")
print(f"  data_access_expires_at {iso(d.get('data_access_expires_at') or 0)}")
print(f"  scopes                 {', '.join(scopes)}")
if not d.get("is_valid"):                     fails.append("token is not valid")
if int(d.get("expires_at") or 0) != 0:        fails.append("expires_at is NOT 0 — this token expires by time")
# The whole point of the migration. A non-zero value here means we gained nothing.
if int(d.get("data_access_expires_at") or 0) != 0:
    fails.append("data_access_expires_at is NOT 0 — this token carries the SAME 90-day clock. "
                 "The migration buys nothing; keep the existing token.")
missing = [s for s in required if s not in scopes]
if missing:                                    fails.append("missing scopes: " + ", ".join(missing))
if fails:
    print("\nFAIL"); [print("  -", f) for f in fails]; sys.exit(1)
print("\nPASS  never expires, no data-access clock, all required scopes present")
PY
  local rc=$?
  [ $rc -eq 0 ] || return $rc

  # Smoke: the credential must actually reach both publish targets, not merely look well-formed.
  local pn ign
  pn="$(curl -sS -G "https://graph.facebook.com/${GRAPH_VERSION}/${page_id}" --data-urlencode "fields=name" \
        --data-urlencode "access_token=${cand}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("name") or "ERROR: "+str(d.get("error",{}).get("message")))')"
  echo "  page  ${page_id} -> ${pn}"
  case "$pn" in ERROR*) log "candidate cannot read the Page"; return 1 ;; esac
  if [ -n "$ig_id" ]; then
    ign="$(curl -sS -G "https://graph.facebook.com/${GRAPH_VERSION}/${ig_id}" --data-urlencode "fields=username" \
          --data-urlencode "access_token=${cand}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("username") or "ERROR: "+str(d.get("error",{}).get("message")))')"
    echo "  ig    ${ig_id} -> ${ign}"
    # IG is the half actually exposed to the data-access lapse — a candidate that cannot reach it is useless.
    case "$ign" in ERROR*) log "candidate cannot read the Instagram account — this is the half that matters"; return 1 ;; esac
  fi
  echo "VERIFIED — safe to swap"
}

swap_candidate() {
  echo "verifying before swapping..." && verify_candidate || { log "REFUSING to swap: verification failed"; return 1; }
  local live cand
  live="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)"
  cand="$(read_candidate)"
  # Back up the OLD token before overwriting. It stays valid, so this is a real rollback, not a formality.
  printf '%s' "$live" > "/tmp/fb-page-token-previous-$(date +%Y%m%d%H%M%S).json"
  local backup; backup="$(ls -t /tmp/fb-page-token-previous-*.json | head -1)"
  chmod 600 "$backup"
  echo "  previous secret saved to ${backup} (chmod 600) — restore with: aws secretsmanager put-secret-value --region ${REGION} --secret-id ${SECRET_ID} --secret-string file://${backup}"
  printf '%s' "$live" | CAND="$cand" python3 -c 'import sys,json,os;d=json.load(sys.stdin);d["page_token"]=os.environ["CAND"];print(json.dumps(d))' \
    | aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" --secret-string file:///dev/stdin >/dev/null
  echo "  swapped. The Lambda caches secrets for 5 minutes (SECRETS_TTL_MS) — wait before smoke-testing a real post."
  echo "  now delete the candidate: rm -f \"\${CANDIDATE_TOKEN_FILE:-}\" and/or aws secretsmanager delete-secret --region ${REGION} --secret-id ${CANDIDATE_SECRET} --force-delete-without-recovery"
}

case "${1:-}" in
  check)            check ;;
  selftest)         selftest ;;
  alarms)           alarms ;;
  alarms-staleness) alarms_staleness ;;
  verify-candidate) verify_candidate ;;
  swap-candidate)   swap_candidate ;;
  *) echo "usage: $0 {check|selftest|alarms|alarms-staleness|verify-candidate|swap-candidate}" >&2; exit 2 ;;
esac
