#!/usr/bin/env bash
# photos-lifecycle.sh — the declared lifecycle configuration for the two photos buckets, and the
# drift check that proves live AWS still matches it.
#
# WHY THIS FILE EXISTS. The rule `expire-noncurrent-photos` was applied to BOTH photos buckets on
# 2026-08-30 (Dave's decision, session garden-igintegrate-20260828; recorded in
# project-state/s3-lifecycle-survey-20260828.md §Applied). It was applied by hand. Nothing in this
# repo declares it, so nothing would recreate it if it were dropped, and nothing notices if it
# changes. `scripts/ig-staging-retention.sh` authors only `expire-ig-staging` — it is NOT the home
# for this rule and must not become it: that script's subject is the Instagram scratch prefix.
#
# THIS SCRIPT DOES NOT PROPOSE A NEW RULE, and the reason is the whole point. Measured live
# 2026-09-03, AFTER the applied rules had run: garden-photos-prod and garden-photos-replica-usw2 each
# hold ZERO non-current versions and ZERO delete markers. There is nothing left for any expiry rule
# to reclaim. More fundamentally, a lifecycle rule CANNOT reach a deleted photo at all —
# lambda/photos/photoDelete.js is SOFT-DELETE-ONLY and never issues an S3 delete, so a deleted
# photo's object stays a CURRENT version forever and no NoncurrentVersionExpiration will ever see it.
# The rule below is a forward-looking backstop for OVERWRITES, which is the only thing that has ever
# produced a non-current version here.
#
# Usage:
#   ./scripts/photos-lifecycle.sh          # drift check — READ ONLY. exit 0 = live matches declared.
#   ./scripts/photos-lifecycle.sh apply    # write the declared config (merge by Id) to both buckets
#
# EXIT CODES (house convention, cf. scripts/preflight-photodelete.sh):
#   0 = live matches the declaration (or apply succeeded and read back clean)
#   1 = DRIFT — live differs from the declaration
#   2 = script/input error (bucket unreachable, credentials absent, malformed response)
set -euo pipefail

BUCKET="${BUCKET:-garden-photos-prod}"
BUCKET_REGION="${BUCKET_REGION:-us-east-1}"
REPLICA="${REPLICA:-garden-photos-replica-usw2}"
REPLICA_REGION="${REPLICA_REGION:-us-west-2}"
MODE="${1:-check}"

fail() { echo "DRIFT: $*" >&2; exit 1; }
oops() { echo "ERROR: $*" >&2; exit 2; }

[[ "$MODE" == "check" || "$MODE" == "apply" ]] || oops "usage: $0 [apply]"

# ── The declaration ──────────────────────────────────────────────────────────────────────────────
#
# THE SAFETY PROPERTY, and it is not decorative: this rule carries NO `Expiration.Days`. On a
# bucket-wide filter (`Prefix: ""`) that key expires CURRENT objects — on garden-photos-prod it would
# delete live photos, every one of them, on a 30-day rolling basis. `assert_safe` below re-derives
# that check from the JSON on every run rather than trusting this comment, and refuses to apply
# anything that violates it.
#
# `ExpiredObjectDeleteMarker: true` removes a delete marker once it is the only version left. It
# cannot delete data: by definition the object it points at is already gone.
#
# 30 days is the deliberate undo window agreed on 2026-08-30 — an overwritten photo stays recoverable
# for a month and is genuinely gone after.
#
# `AbortIncompleteMultipartUpload` reclaims the parts of a multipart upload that never completed.
# Those parts are billed and are invisible to both list-objects-v2 and list-object-versions, so they
# are the one kind of waste on this bucket that no enumeration in the survey would have found.
DECLARED_RULE='{
  "ID": "expire-noncurrent-photos",
  "Status": "Enabled",
  "Filter": { "Prefix": "" },
  "Expiration": { "ExpiredObjectDeleteMarker": true },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
  "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
}'

# garden-photos-archive-prod is DELIBERATELY absent from this file. It holds 32.3 GB in Glacier
# Instant Retrieval, which bills a 90-day MINIMUM storage duration: an expiry shorter than that
# incurs a pro-rated early-deletion charge instead of a saving. Measured 2026-09-03 it carries 12
# non-current objects totalling 2.96 MB — a rule there could only cost money. This exclusion is a
# decision that was made and re-measured, not a gap someone forgot to fill.

assert_safe() { # assert_safe <rule-json> — refuse a bucket-wide rule that expires current objects
  printf '%s' "$1" | python3 -c '
import json, sys
r = json.load(sys.stdin)
pfx = (r.get("Filter") or {}).get("Prefix", "")
exp = r.get("Expiration") or {}
if pfx == "" and ("Days" in exp or "Date" in exp):
    sys.exit("REFUSING: bucket-wide rule carries Expiration.Days/Date — that expires CURRENT objects")
' || oops "declared rule failed the safety assertion"
}

# Compare only the keys this script owns. A byte-diff of the whole configuration would red on
# TransitionDefaultMinimumObjectSize (an account-level default AWS injects) and on any rule another
# script legitimately added.
live_rule() { # live_rule <bucket> <region> — the declared rule as it exists live, normalised
  aws s3api get-bucket-lifecycle-configuration --bucket "$1" --region "$2" --output json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    rules = json.load(sys.stdin).get("Rules", [])
except Exception:
    rules = []
m = [r for r in rules if r.get("ID") == "expire-noncurrent-photos"]
print(json.dumps(m[0], sort_keys=True) if m else "ABSENT")
' || oops "could not read lifecycle configuration from $1"
}

normalise() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))'; }

assert_safe "$DECLARED_RULE"
WANT="$(normalise "$DECLARED_RULE")"

status=0
for pair in "$BUCKET:$BUCKET_REGION" "$REPLICA:$REPLICA_REGION"; do
  b="${pair%%:*}"; r="${pair##*:}"
  got="$(live_rule "$b" "$r")"
  if [ "$got" = "$WANT" ]; then
    echo "  OK       $b ($r) — expire-noncurrent-photos matches the declaration"
  elif [ "$got" = "ABSENT" ]; then
    echo "  MISSING  $b ($r) — expire-noncurrent-photos is not present" >&2
    status=1
  else
    echo "  DIFFERS  $b ($r)" >&2
    echo "    want: $WANT" >&2
    echo "    live: $got" >&2
    status=1
  fi
done

if [ "$MODE" = "check" ]; then
  [ "$status" -eq 0 ] || fail "live lifecycle configuration does not match the declaration — re-run with 'apply' only after confirming the difference is unintended"
  echo "OK — both photos buckets match the declared lifecycle configuration."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────────────────────────
#
# MERGE, NEVER REPLACE. put-bucket-lifecycle-configuration overwrites the ENTIRE configuration for
# the bucket. Both photos buckets also carry `expire-ig-staging` from ig-staging-retention.sh;
# passing only this rule would silently delete it. The existing configuration is read first and this
# rule merged in by Id — same discipline as that script.
echo
echo "APPLYING…"
for pair in "$BUCKET:$BUCKET_REGION" "$REPLICA:$REPLICA_REGION"; do
  b="${pair%%:*}"; r="${pair##*:}"
  existing="$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" --region "$r" --output json 2>/dev/null || echo '{"Rules":[]}')"
  merged="$(printf '%s' "$existing" | RULE="$DECLARED_RULE" python3 -c '
import json, os, sys
cur = json.load(sys.stdin).get("Rules", [])
new = json.loads(os.environ["RULE"])
for r in cur:
    pfx = (r.get("Filter") or {}).get("Prefix", "")
    exp = r.get("Expiration") or {}
    if r.get("ID") != new["ID"] and pfx == "" and ("Days" in exp or "Date" in exp):
        sys.exit("REFUSING: bucket already carries a bucket-wide current-object expiry (%s) — resolve by hand" % r.get("ID"))
out = [r for r in cur if r.get("ID") != new["ID"]] + [new]
print(json.dumps({"Rules": out}))
')" || oops "merge refused for $b"
  printf '%s' "$merged" > "/tmp/photos-lifecycle-${b}.json"
  aws s3api put-bucket-lifecycle-configuration --bucket "$b" --region "$r" \
    --lifecycle-configuration "file:///tmp/photos-lifecycle-${b}.json"
  echo "  wrote expire-noncurrent-photos to $b ($r)"
done

# VERIFY BY READ-BACK, not by exit code. A put returning 0 is not evidence the rule is live.
echo
echo "VERIFY (read-back):"
for pair in "$BUCKET:$BUCKET_REGION" "$REPLICA:$REPLICA_REGION"; do
  b="${pair%%:*}"; r="${pair##*:}"
  got="$(live_rule "$b" "$r")"
  [ "$got" = "$WANT" ] || fail "read-back mismatch on $b — live: $got"
  echo "  OK  $b"
done
echo "Done."
