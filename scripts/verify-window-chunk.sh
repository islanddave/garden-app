#!/usr/bin/env bash
# V4-RIPENESSCUES-001 — differential build verification for the harvest colour-window chunk.
#
# WHY THIS EXISTS. The colour-window feature shipped INERT in v4.9.x — resolver imported, nothing
# called it, every test green, and ~110KB gzip of JSON rode the single entry bundle to every user.
# The fix put the resolver module (src/lib/harvestWindows.js + its static JSON import) behind
# CropCard's lazy import — the app's first code-split point. This script is the ONLY detector for
# the regression that recreates the inert-payload class: a reintroduced static
# `import { resolveHarvestWindow }` at/above CropCard. jsdom cannot exercise the real chunk graph
# (vitest resolves the import at test time), so this runs the REAL `vite build` and asserts the
# split at the artifact level:
#   (a) exactly ONE hashed chunk contains the dataset marker string;
#   (b) that chunk is NOT the entry — and by (a), the marker is absent from every other JS chunk;
#   (c) gzip sizes for entry + window chunk are printed for the commit/pstate record.
# Run pre-push; paste the output into the S6 commit message. Boss condition C3: ledger follow-up
# to wire this into CI post-ship — until then this script guards the class only at commit time.
#
# MARKER: a data string unique to src/data/harvestWindows.json (uniqueness verified 2026-08-12 via
# rg -uuu over src/, scripts/, lambda/, public/). String data survives minification, and it is
# ASCII-only so encoding never bites the grep. If the Cherokee Green record ever rewords this
# phrase, update MARKER to another string unique to the JSON and re-verify uniqueness.
set -euo pipefail
cd "$(dirname "$0")/.."

MARKER='chartreuse with an amber blossom end'

echo "== npx vite build =="
npx vite build

ENTRY_BASENAME=$(sed -n 's/.*<script[^>]*src="\/assets\/\([^"]*\.js\)".*/\1/p' dist/index.html | head -1)
if [ -z "$ENTRY_BASENAME" ]; then
  echo "FAIL: could not identify the entry chunk from dist/index.html"
  exit 1
fi
ENTRY="dist/assets/$ENTRY_BASENAME"
if [ ! -f "$ENTRY" ]; then
  echo "FAIL: entry chunk $ENTRY not found"
  exit 1
fi

WINDOW_CHUNK=''
OTHER_CLEAN=0
FAILED=0
for f in dist/assets/*.js; do
  if grep -q "$MARKER" "$f"; then
    if [ -n "$WINDOW_CHUNK" ]; then
      echo "FAIL: marker found in MULTIPLE chunks: $WINDOW_CHUNK and $f"
      FAILED=1
    fi
    WINDOW_CHUNK="$f"
  else
    OTHER_CLEAN=$((OTHER_CLEAN + 1))
  fi
done

if [ -z "$WINDOW_CHUNK" ]; then
  echo "FAIL: no JS chunk contains the dataset marker — the window dataset is missing from the build"
  exit 1
fi
if [ "$WINDOW_CHUNK" = "$ENTRY" ]; then
  echo "FAIL: the dataset marker is in the ENTRY chunk ($ENTRY) — a static import of"
  echo "      harvestWindows.js has been reintroduced at/above CropCard (the inert-payload class)."
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

rawsize() { wc -c < "$1" | tr -d ' '; }
gzsize() { gzip -c "$1" | wc -c | tr -d ' '; }

echo "== verify-window-chunk: PASS =="
echo "entry chunk:  $ENTRY  raw=$(rawsize "$ENTRY")B  gzip=$(gzsize "$ENTRY")B  (marker ABSENT)"
echo "window chunk: $WINDOW_CHUNK  raw=$(rawsize "$WINDOW_CHUNK")B  gzip=$(gzsize "$WINDOW_CHUNK")B  (marker present)"
echo "other JS chunks checked clean (marker absent): $OTHER_CLEAN (includes entry)"
