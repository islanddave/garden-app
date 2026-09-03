#!/usr/bin/env node
// Append highlights to an ALREADY-PUBLISHED release entry in public/releases.json.
//
// Why this is not add-release.mjs: that script sets package.json to the version it is given and
// PREPENDS the entry. Pointing it at an older version would regress package.json and push a stale
// version to the head of a file that check-release-version.py requires to be strictly descending.
// This edits one historical entry in place and touches nothing else.
//
// releases-latest.json is deliberately NOT rewritten — it mirrors the HEAD entry only, and rewriting
// it from a historical version is exactly the two-files-disagree bug (BUG-STALECLIENT-002) that
// add-release.mjs exists to prevent.
//
// Idempotent: a highlight already present on the entry is skipped, so a re-run cannot duplicate.
// Usage: node scripts/backfill-release-highlights.mjs <version> "<highlight>" ...
import { readFileSync, writeFileSync } from 'node:fs';

const [version, ...additions] = process.argv.slice(2);
if (!version || !additions.length) {
  console.error('usage: backfill-release-highlights.mjs <version> "<highlight>" ...');
  process.exit(1);
}

const path = new URL('../public/releases.json', import.meta.url);
const list = JSON.parse(readFileSync(path, 'utf8'));
const entry = list.find((r) => r.version === version);
if (!entry) { console.error(`no release entry for ${version}`); process.exit(1); }

const before = entry.highlights.length;
for (const h of additions) if (!entry.highlights.includes(h)) entry.highlights.push(h);

writeFileSync(path, JSON.stringify(list, null, 2) + '\n');
console.log(`${version}: ${before} -> ${entry.highlights.length} highlights (head is still ${list[0].version})`);
