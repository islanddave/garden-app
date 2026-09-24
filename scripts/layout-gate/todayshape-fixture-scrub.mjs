#!/usr/bin/env node
// todayshape-fixture-scrub.mjs — turn a raw prod dump into a trackable Today-shape fixture.
//
//   node scripts/layout-gate/todayshape-fixture-scrub.mjs --from <dir> [--to <dir>] [--dry]
//
// The fixtures under tests/harness/_todaymeasure/ are dumped from live Neon as garden_ro. Dumped
// verbatim they carry two things that must never enter git history: live Clerk subs and the site's
// real coordinates. This is the one-way transform between the two, kept as a file rather than done
// by hand so a re-dump six months from now produces byte-identical scrubbing instead of somebody's
// best recollection of what was replaced last time.
//
// WHAT IT REWRITES
//   · every `user_[A-Za-z0-9]{10,}` -> a stable pseudonym, assigned BY FREQUENCY: the most frequent
//     sub across the whole corpus becomes `harness_user`, which is the id the harness Clerk stub
//     serves (tests/harness/stubs/clerk.jsx:7). That is not cosmetic — ComposeHarvestBand scopes its
//     batch to the VIEWER (`detectLastBatch({createdBy: profile?.id})`), so a fixture whose
//     created_by is anything else renders a band of zero height and the instrument silently measures
//     65px less page than it claims to. Remaining subs become `harness_member_2`, `_3`, … in
//     descending frequency, ties broken by sort order, so the mapping is deterministic.
//   · every lat/lng/lon/latitude/longitude key -> the single declared synthetic site (see
//     SYNTHETIC_SITE in todayshape-fixture-preflight.mjs). Rounding a residence coordinate is not
//     scrubbing it.
//
// WHAT IT DELIBERATELY LEAVES ALONE — plant names, cultivar names and location paths. They are
// horticultural, not credential-shaped, they are already throughout the repo's own tracked tests
// (`git grep "Bag Area" -- src/__tests__` returns ten files), and they are LOAD-BEARING for the
// thing being measured: label length drives row height, group-header wrapping and the ellipsis in
// `Row`. Replacing them with lorem would silently change the geometry this whole lane exists to pin.
// Stated here rather than left implicit, because "we scrubbed the fixtures" should never be read as
// covering more than it does.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNTHETIC_SITE } from './todayshape-fixture-preflight.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argOf = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt }
const DRY = process.argv.includes('--dry')
const FROM = resolve(argOf('--from', join(ROOT, 'tests/harness/_todaymeasure')))
const TO = resolve(argOf('--to', join(ROOT, 'tests/harness/_todaymeasure')))

const SUB_RE = /user_[A-Za-z0-9]{10,}/g
const GEO_KEY = /^(lat|lng|lon|latitude|longitude)$/i

function files(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'out' || name === 'node_modules') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) files(abs, acc)
    else if (/\.(json|md|jsx|html|txt)$/.test(name)) acc.push(abs)
  }
  return acc
}

const SRC = files(FROM)
if (!SRC.length) { console.error(`[scrub] nothing to scrub in ${FROM}`); process.exit(1) }

// Pass 1: build the pseudonym map from the WHOLE corpus, not per file. A per-file map would give the
// same sub two different pseudonyms in two files and break every join the page makes across them.
const freq = new Map()
for (const abs of SRC) {
  const text = readFileSync(abs, 'utf8')
  SUB_RE.lastIndex = 0
  let m
  while ((m = SUB_RE.exec(text))) freq.set(m[0], (freq.get(m[0]) || 0) + 1)
}
const ranked = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
const MAP = new Map(ranked.map(([sub], i) => [sub, i === 0 ? 'harness_user' : `harness_member_${i + 1}`]))

// Pass 2: rewrite.
let wrote = 0
let subHits = 0
let geoHits = 0
const scrubGeo = (v) => {
  if (Array.isArray(v)) return v.map(scrubGeo)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, val] of Object.entries(v)) {
      if (GEO_KEY.test(k) && typeof val === 'number') {
        geoHits++
        o[k] = /^lat/i.test(k) ? SYNTHETIC_SITE.lat : SYNTHETIC_SITE.lng
      } else o[k] = scrubGeo(val)
    }
    return o
  }
  return v
}

mkdirSync(TO, { recursive: true })
for (const abs of SRC) {
  const rel = relative(FROM, abs)
  let text = readFileSync(abs, 'utf8')
  text = text.replace(SUB_RE, (s) => { subHits++; return MAP.get(s) || 'harness_unknown' })
  if (abs.endsWith('.json')) {
    // Re-serialize COMPACT (no pretty-print). These are wire payloads served to a fetch stub, not
    // documents; JSON.stringify with no spacer keeps the diff honest about size and matches how the
    // dump was written.
    text = JSON.stringify(scrubGeo(JSON.parse(text)))
  }
  const dest = join(TO, rel)
  mkdirSync(dirname(dest), { recursive: true })
  if (!DRY) { writeFileSync(dest, text) }
  wrote++
}

console.log(`[scrub] ${DRY ? 'DRY RUN — ' : ''}${wrote} file(s) ${FROM} -> ${TO}`)
for (const [sub, alias] of MAP) console.log(`[scrub]   ${sub.slice(0, 9)}…(${freq.get(sub)} hits) -> ${alias}`)
console.log(`[scrub] ${subHits} sub occurrence(s), ${geoHits} coordinate value(s) replaced with the declared synthetic site.`)
console.log('[scrub] NOW RUN: node scripts/layout-gate/todayshape-fixture-preflight.mjs  (this script is not the guard; that one is)')
