#!/usr/bin/env node
// V3-RELEASENOTES-001 — release-notes updater. Run as part of the mandatory pre-promote
// version bump so public/releases.json auto-updates on every prod push WITHOUT touching
// promote-gate.yml / deploy.yml. Newest-first; idempotent on version.
//
// Usage:
//   node scripts/add-release.mjs <version> "<highlight 1>" "<highlight 2>" ...
//   node scripts/add-release.mjs 2.12.0 "Fixed X" "Added Y"
// Effects:
//   1. sets package.json version = <version>
//   2. prepends { version, date(today, ET), highlights } to public/releases.json
//      (replaces an existing same-version entry instead of duplicating)
//   3. writes that same entry ALONE to public/releases-latest.json
//
// V4-PERFTHEMEA-001 — why (3) exists. public/releases.json is 141,722 B and is served no-store, so
// the version probe in useAppUpdate.js re-downloads all 106 releases on every load AND on every
// visibilitychange, to read ONE field. releases-latest.json is that field's entry on its own, under
// 1 KB, and is what the probe reads now; the full file is left for the Release Notes page, which is
// the only surface that wants the history and only fetches it when visited.
//
// THE TWO FILES ARE WRITTEN TOGETHER, HERE, AND NOWHERE ELSE. Two files that can disagree about the
// current version is a worse bug than the bytes this saves: a stale -latest is a client that never
// learns it is out of date (BUG-STALECLIENT-002). scripts/check-release-version.py asserts
// releases-latest.json == releases.json[0] on every CI run, and scripts/smoke-prod.py asserts the
// deployed copy matches the promoted version. Do not hand-edit either file.
//
// BOTH STAY no-store. The win here is payload SIZE, not cacheability — deploy.yml syncs everything
// outside dist/assets/ with `no-cache, no-store, must-revalidate` and that must not change for
// either file.
import { readFileSync, writeFileSync } from 'node:fs'

const [, , version, ...highlights] = process.argv
if (!version || !/^\d+\.\d+(\.\d+)?$/.test(version)) {
  console.error('add-release: first arg must be a version like 2.12.0'); process.exit(1)
}

// 1) package.json version
const pkgPath = 'package.json'
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// 2) releases.json prepend (ET date; newest-first; de-dup same version)
const relPath = 'public/releases.json'
let list
try { list = JSON.parse(readFileSync(relPath, 'utf8')) } catch { list = [] }
if (!Array.isArray(list)) list = []
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // YYYY-MM-DD
const entry = { version, date, highlights: highlights.length ? highlights : ['Maintenance and fixes'] }
list = list.filter(r => r.version !== version)
list.unshift(entry)
writeFileSync(relPath, JSON.stringify(list, null, 2) + '\n')

// 3) releases-latest.json — list[0] alone. Derived from `list` rather than from `entry` so the two
// files cannot drift even if the prepend logic above ever changes what lands at the head.
const latestPath = 'public/releases-latest.json'
writeFileSync(latestPath, JSON.stringify(list[0], null, 2) + '\n')

console.log(`add-release: package.json -> v${version}; releases.json entries now ${list.length}; releases-latest.json -> v${list[0].version}`)
