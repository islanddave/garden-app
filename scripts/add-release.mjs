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

console.log(`add-release: package.json -> v${version}; releases.json entries now ${list.length}`)
