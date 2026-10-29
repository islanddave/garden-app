#!/usr/bin/env bash
# Builds lambda/<fn>.zip, the package a deploy leg uploads. deploy-lambda.yml (prod) and deploy-staging.yml (staging)
# both call this and no other step packages (scripts/test_workflow_steps.py), so staging soaks the zip prod gets.
# check-lambda-current.py lists this file: a change here redeploys every Lambda.
# Usage, from the checkout root: bash scripts/package-lambda.sh <folder under lambda/>
# set -e without pipefail, as the runner's `bash -e {0}`: under pipefail unzip's SIGPIPE decides `unzip -l | grep -q`.
set -e
FN="${1:?usage: scripts/package-lambda.sh <folder under lambda/>}"
cd "$(dirname "$0")/.."

# The events vocabulary is regenerated from src/lib/eventTypes.js before zipping, so a stale committed copy never
# ships. The check reads what the generation just wrote, so it fails only if generation is not deterministic; ci.yml's
# own check:event-types step is what reds a stale commit.
if [ "$FN" = events ]; then
  npm run gen:event-types
  npm run check:event-types
fi

cd "lambda/$FN"
if [ "$FN" = photocdn-derivative ]; then
  # nodejs22.x on arm64 with native `sharp`: the runner is x86_64, so a plain install packages the x64 binary and the
  # function fails to load (502). Staging runs this too: it is the one packaging failure CI's Lambda tests cannot see.
  node -v && npm -v
  npm install --omit=dev --os=linux --cpu=arm64 --include=optional
  zip -r ../photocdn-derivative.zip . -x '*.test.js' '*.test.js.map'
  if ! unzip -l ../photocdn-derivative.zip | grep -q 'sharp-linux-arm64'; then
    echo "FATAL: linux-arm64 sharp binary missing from zip — refusing to deploy an x64 build to an arm64 Lambda"; exit 1
  fi
  unzip -l ../photocdn-derivative.zip | grep -q 'node_modules/blurhash' || { echo "FATAL: blurhash dep missing from zip"; exit 1; }
  echo "arm64 sharp + blurhash present in photocdn-derivative.zip"
else
  npm install --omit=dev
  # zip's -x wildcards span `/`, so one pattern drops test files at every depth, node_modules included. The listing
  # check proves the zip rather than the command; it must stay a subset of the exclude (anchored `$`, so the excluded
  # *.test.js.map never counts) or it can never pass. Pinned by lambda/deploy-zip-excludes-tests.test.js.
  zip -r "../$FN.zip" . -x '*.test.js' '*.test.js.map'
  if unzip -l "../$FN.zip" | grep -qE '\.test\.js$'; then
    echo "FATAL: test files present in $FN.zip — the -x exclude stopped matching"; exit 1
  fi
fi
