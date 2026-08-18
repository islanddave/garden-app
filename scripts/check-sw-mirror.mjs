#!/usr/bin/env node
// V4-SWCACHEID-001 gate: public/sw.js is served raw and cannot import from src/lib/, so the pure
// cache-key helpers exist TWICE. The unit tests exercise the src/lib/ copy; the browser runs the
// public/sw.js copy. If they drift, every passing test is a test of code that does not ship.
//
// This gate is a plain `npm run gate:sw-mirror` on purpose: a CI-only gate protects nothing during
// an Actions outage, which is exactly when this work was authored.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const MODULE_PATH = path.join(ROOT, 'src/lib/swCacheKeys.js')
const SW_PATH = path.join(ROOT, 'public/sw.js')
const START = '/* SW-MIRROR-START'
const END = '/* SW-MIRROR-END */'

function extract(file) {
  const src = fs.readFileSync(file, 'utf8')
  const i = src.indexOf(START)
  const j = src.indexOf(END)
  if (i === -1 || j === -1 || j < i) {
    console.error(`FAIL sw-mirror: ${path.relative(ROOT, file)} is missing the SW-MIRROR sentinels.`)
    process.exit(1)
  }
  // Include the END sentinel so a truncated block cannot pass by matching a shorter prefix.
  return src.slice(i, j + END.length)
}

const a = extract(MODULE_PATH)
const b = extract(SW_PATH)

if (a !== b) {
  console.error('FAIL sw-mirror: src/lib/swCacheKeys.js and public/sw.js have DRIFTED.')
  const al = a.split('\n')
  const bl = b.split('\n')
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      console.error(`  first difference at mirrored line ${i + 1}:`)
      console.error(`    src/lib/swCacheKeys.js: ${JSON.stringify(al[i] ?? '<missing>')}`)
      console.error(`    public/sw.js         : ${JSON.stringify(bl[i] ?? '<missing>')}`)
      break
    }
  }
  process.exit(1)
}

console.log(`OK sw-mirror: ${a.length} bytes identical in src/lib/swCacheKeys.js and public/sw.js`)
