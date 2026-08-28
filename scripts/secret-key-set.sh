#!/usr/bin/env bash
# secret-key-set.sh — set or remove ONE key inside a Secrets Manager JSON bundle, without wiping
# the others. Sibling of lambda-env-set.sh, for the same reason and with the same guarantees.
#
# WHY THIS EXISTS
# ---------------
# `aws secretsmanager put-secret-value --secret-string ...` REPLACES THE WHOLE BUNDLE. The obvious
# command for "add the extractor key" —
#     aws secretsmanager put-secret-value --secret-id garden-app/secrets \
#       --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
# — is not "add a key", it is "delete CLERK_SECRET_KEY and NEON_DATABASE_URL". Both are read at
# module scope by every Lambda in the fleet: verifyToken() fails closed without the Clerk key (401
# on every authenticated request) and neon(undefined) throws at cold start (500 on everything
# else). That is a total application outage produced by a command that exits 0.
#
# Same failure shape lambda-env-set.sh exists to prevent, on a different AWS API, and MORE dangerous
# here: a Lambda env map is per-function, this bundle is shared by the whole fleet.
#
# GUARANTEES
#   1. BASELINE COMPLETENESS — refuses to write unless the pre-read parsed as a JSON object AND
#      holds every key in REQUIRED_KEYS. Otherwise a throttled read becomes a one-key bundle
#      written over a three-key one, green exit and all.
#   2. THE VALUE NEVER APPEARS IN argv OR IN SHELL HISTORY — read with `read -rs` from /dev/tty,
#      passed to the merge helper over stdin, and handed to the CLI via a 0600 temp file
#      (file://), never as a command-line argument where `ps` would show it.
#   3. NO-OP DETECTION — an unchanged bundle is not rewritten, so re-running does not burn a
#      secret version.
#   4. VERIFY BY CONTENT — re-reads after the write and asserts the required keys survived and the
#      target key is in the intended state, rather than trusting the exit code.
#
# The merge itself lives in scripts/secret_key_merge.py (unit-tested) rather than in a heredoc here.
#
# USAGE
#   scripts/secret-key-set.sh <secret-id> <KEY_NAME>            # prompts for the value, hidden
#   scripts/secret-key-set.sh <secret-id> <KEY_NAME> --remove   # deletes just that key
#
#   scripts/secret-key-set.sh garden-app/secrets ANTHROPIC_API_KEY
#
# BUG-SEEDEXTRACTOR-001: no Lambda redeploy is needed after adding ANTHROPIC_API_KEY.
# lambda/inventory-items/index.js clears its module-level `_secrets` cache and re-reads ONCE before
# returning `extractor_not_configured`, precisely so a key added to a warm fleet takes effect on
# the next request.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
REQUIRED_KEYS=(CLERK_SECRET_KEY NEON_DATABASE_URL)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE="$HERE/secret_key_merge.py"

SECRET_ID="${1:-}"
KEY_NAME="${2:-}"
FLAG="${3:-}"

if [[ -z "$SECRET_ID" || -z "$KEY_NAME" ]]; then
  echo "usage: $0 <secret-id> <KEY_NAME> [--remove]" >&2
  exit 2
fi
case "$FLAG" in
  "")        MODE=set ;;
  --remove)  MODE=remove ;;
  *)         echo "third argument must be --remove or omitted (got: $FLAG)" >&2; exit 2 ;;
esac
if [[ ! "$KEY_NAME" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  echo "KEY_NAME must be SCREAMING_SNAKE_CASE (got: $KEY_NAME)" >&2
  exit 2
fi
[[ -f "$MERGE" ]] || { echo "missing helper: $MERGE" >&2; exit 2; }

TMP="$(mktemp -t secret-key-set.XXXXXX)"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT INT TERM

echo "Reading current bundle from $SECRET_ID ($REGION)..." >&2
CURRENT="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_ID" --query SecretString --output text)"

# GUARANTEE 1 — completeness-check BEFORE composing any write.
printf '%s' "$CURRENT" | python3 "$MERGE" check "${REQUIRED_KEYS[@]}"

NEWVAL=""
if [[ "$MODE" == "set" ]]; then
  # GUARANTEE 2 — -s: no echo, -r: no backslash mangling (API keys are opaque). Read from the
  # terminal, not stdin, so the value cannot silently arrive from a pipe or a stray redirect.
  read -rsp "Value for ${KEY_NAME} (input hidden): " NEWVAL < /dev/tty
  echo >&2
  if [[ -z "$NEWVAL" ]]; then
    echo "REFUSING: empty value. Use --remove to delete a key." >&2
    exit 1
  fi
fi

# GUARANTEE 3 — merge; exit 3 means nothing changed. `set -e` must not swallow that, hence the
# explicit `|| rc=$?` capture.
rc=0
printf '%s\0%s' "$CURRENT" "$NEWVAL" | python3 "$MERGE" merge "$KEY_NAME" "$MODE" > "$TMP" || rc=$?
if [[ $rc -eq 3 ]]; then
  echo "No change — $KEY_NAME already holds that value. Nothing written." >&2
  exit 0
fi
[[ $rc -eq 0 ]] || exit $rc

aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id "$SECRET_ID" --secret-string "file://$TMP" \
  --query 'VersionId' --output text >&2

# GUARANTEE 4 — verify by content, not by exit code.
aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_ID" --query SecretString --output text \
  | python3 "$MERGE" verify "$KEY_NAME" "$MODE" "${REQUIRED_KEYS[@]}"
