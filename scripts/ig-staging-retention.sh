#!/usr/bin/env bash
# ig-staging-retention.sh — the two AWS prerequisites for the Instagram staging sweep.
#
# V4-IGSHARE-001 stages an EXIF-STRIPPED copy of a private photo to s3://<bucket>/ig-staging/<group>/
# so Meta's fetcher can retrieve it over a presigned URL (Instagram has no byte-upload). The handler
# sweeps that object on every exit path. TWO facts, both verified against live AWS on 2026-08-28,
# stop that sweep actually removing the bytes:
#
#   1. garden-photos-prod has versioning ENABLED. A DeleteObject with no VersionId writes a DELETE
#      MARKER — the key stops listing, the object survives as a non-current version, indefinitely.
#   2. The exec role garden-app-lambda-exec allows s3:DeleteObject but NOT s3:DeleteObjectVersion
#      (checked across all three inline policies), so the handler CANNOT remove a version even
#      though it now knows the VersionId.
#
# And there is no lifecycle configuration on the bucket at all (NoSuchLifecycleConfiguration), so
# nothing expires non-current versions in the background either. Net effect without this script: the
# handler's own sweep tombstones, and the stripped bytes stay forever.
#
# NOTHING HERE IS APPLIED BY DEFAULT. Run with no argument for a dry run that only READS. Pass
# `apply` to make the changes. Both changes are reversible and both are scoped as narrowly as the
# APIs allow.
#
# Usage:
#   ./scripts/ig-staging-retention.sh            # dry run — prints current state and the diff
#   ./scripts/ig-staging-retention.sh apply      # make the changes
#
# Env: BUCKET (default garden-photos-prod), ROLE (default garden-app-lambda-exec), AWS creds/region.
set -euo pipefail

BUCKET="${BUCKET:-garden-photos-prod}"
ROLE="${ROLE:-garden-app-lambda-exec}"
POLICY_NAME="IgStagingVersionCleanup"
PREFIX="ig-staging/"
MODE="${1:-dryrun}"

say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "------------------------------------------------------------"; }

if [[ "$MODE" != "dryrun" && "$MODE" != "apply" ]]; then
  say "usage: $0 [apply]"; exit 2
fi

hr; say "bucket=$BUCKET  role=$ROLE  mode=$MODE"; hr

# ── 1. IAM: allow deleting VERSIONS, scoped to the staging prefix only ────────────────────────────
#
# Deliberately NOT bucket-wide. s3:DeleteObjectVersion over garden-photos-prod/* would let this
# function permanently destroy any version of any real photo — the exact capability versioning exists
# to prevent. Scoped to ig-staging/*, the worst it can do is delete its own scratch.
IAM_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeleteIgStagingVersions",
      "Effect": "Allow",
      "Action": ["s3:DeleteObjectVersion"],
      "Resource": "arn:aws:s3:::${BUCKET}/${PREFIX}*"
    }
  ]
}
JSON
)

say "[1/2] IAM inline policy '${POLICY_NAME}' on role '${ROLE}'"
if aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" >/dev/null 2>&1; then
  say "     already present — current document:"
  aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" \
    --query 'PolicyDocument' --output json | sed 's/^/     /'
else
  say "     NOT present. Would attach:"
  printf '%s\n' "$IAM_DOC" | sed 's/^/     /'
fi

# ── 2. Lifecycle: expire staging objects and their non-current versions ───────────────────────────
#
# MERGE, NEVER REPLACE. put-bucket-lifecycle-configuration overwrites the ENTIRE configuration for
# the bucket — passing only this rule would silently delete every other rule someone adds later. So
# the existing configuration is read first and this rule is merged into it by Id.
#
# 1 day is the API minimum for both expirations and is far longer than the object needs to live: the
# presigned URL lasts 600s and Meta's fetch completed in under 3s when measured. This rule is a
# BACKSTOP for what a mid-run Lambda timeout leaves behind, not the primary cleanup — the handler's
# own sweep is that, and it runs in a `finally`.
LIFECYCLE_RULE=$(cat <<JSON
{
  "ID": "expire-ig-staging",
  "Status": "Enabled",
  "Filter": { "Prefix": "${PREFIX}" },
  "Expiration": { "Days": 1 },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 1 },
  "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
}
JSON
)

say ""
say "[2/2] Lifecycle rule 'expire-ig-staging' on bucket '${BUCKET}'"
EXISTING=$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --output json 2>/dev/null || echo '{"Rules":[]}')
EXISTING_IDS=$(printf '%s' "$EXISTING" | python3 -c 'import json,sys; print(",".join(r.get("ID","<no-id>") for r in json.load(sys.stdin).get("Rules",[])) or "(none)")')
say "     existing rules: ${EXISTING_IDS}"

MERGED=$(printf '%s' "$EXISTING" | RULE="$LIFECYCLE_RULE" python3 -c '
import json, os, sys
cur = json.load(sys.stdin).get("Rules", [])
new = json.loads(os.environ["RULE"])
# Replace by Id if present, else append — never drop a rule this script did not author.
out = [r for r in cur if r.get("ID") != new["ID"]] + [new]
print(json.dumps({"Rules": out}, indent=2))
')
say "     merged configuration that would be written:"
printf '%s\n' "$MERGED" | sed 's/^/     /'

if [[ "$MODE" != "apply" ]]; then
  say ""
  hr; say "DRY RUN — nothing was changed. Re-run with: $0 apply"; hr
  exit 0
fi

say ""
say "APPLYING…"
printf '%s' "$IAM_DOC" > /tmp/ig-staging-iam.json
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/ig-staging-iam.json
say "  ✓ IAM policy ${POLICY_NAME} attached to ${ROLE}"

printf '%s' "$MERGED" > /tmp/ig-staging-lifecycle.json
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file:///tmp/ig-staging-lifecycle.json
say "  ✓ lifecycle rule expire-ig-staging written to ${BUCKET}"

say ""
say "VERIFY (read-back, not inference):"
aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --query 'PolicyDocument.Statement[0].Action' --output json
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --query "Rules[?ID=='expire-ig-staging']" --output json
hr
say "Done. The handler's version-aware delete now has the permission it needs, and the lifecycle"
say "rule backstops whatever a mid-run timeout strands."
