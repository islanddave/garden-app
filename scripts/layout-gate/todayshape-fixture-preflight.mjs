#!/usr/bin/env node
// todayshape-fixture-preflight.mjs — refuse to ship a Today-shape fixture that carries a live
// credential-shaped identifier or a real coordinate.
//
//   node scripts/layout-gate/todayshape-fixture-preflight.mjs             # npm run gate:today-shape:preflight
//   node scripts/layout-gate/todayshape-fixture-preflight.mjs --self-test # prove the scanner can FAIL
//
// WHY IT RUNS BEFORE ANYTHING ELSE. Every other thing this lane built can be undone by a later
// commit. Committing a live `user_*` sub or a residence coordinate cannot: git keeps the object,
// and a rewrite of published history is a different and much larger operation. So this is the one
// check that is ordered FIRST — it runs as step 0 of gate:today-shape, and it is its own CI step so
// a fixture re-dump that reintroduces a sub reds the build in ~200ms without booting a browser.
//
// WHAT IT REFUSES, and why these two classes and not "PII" in general:
//   (a) `user_[A-Za-z0-9]{10,}` — the Clerk sub shape. The repo's standing position (auto-memory
//       `clerk-sub-is-public-and-inert`) is that the sub is a public, inert identifier, and that is
//       still true; this guard is not a retraction of it. What it refuses is the CLASS — anything
//       shaped like a live credential — because the cost of being wrong once is unbounded and the
//       cost of the guard is a regex.
//   (b) a lat/lng/lon/latitude/longitude key whose value is not the ONE declared synthetic site.
//       Rounding a residence coordinate is not scrubbing it; a single allowed pair is.
//   (c) two cheap credential shapes that would be catastrophic and are free to check: `sk_live_` /
//       `pk_live_` and a JWT header prefix.
// Real plant names and location paths are DELIBERATELY NOT refused — see the note at ALLOWED below.
//
// THE SELF-TEST IS NOT OPTIONAL EITHER. A scanner that has never been shown to fire is a claim.
// `--self-test` runs every matcher against a known-positive string built here (never read from the
// corpus it guards — a filter validated against its own input cannot surface the case it misses)
// and against a known-negative, and exits 1 unless every matcher fires on the positive and stays
// silent on the negative.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// The single allowed coordinate pair. Geographic centre of the contiguous United States (Lebanon,
// Kansas) — a published landmark, not anybody's address, and a valid pair so the shape of every
// consumer stays exercised. Spelled to the same precision the fixtures carry so an exact compare is
// meaningful; a scrub that "rounds" a real coordinate would pass a proximity test and fail this one.
export const SYNTHETIC_SITE = { lat: 39.8283, lng: -98.5795 }

// Scanned surfaces. The instrument's own source is included: a harness entry that hardcodes a sub to
// make a band render is the same exposure as a fixture that carries one.
const TARGETS = [
  'tests/harness/_todaymeasure',
  'tests/harness/todaymeasure.html',
  'tests/harness/todaymeasure.jsx',
]

const GEO_KEY = /^(lat|lng|lon|latitude|longitude)$/i

// Textual matchers. Applied to every scanned file regardless of type, so a .md of provenance SQL is
// held to the same bar as a .json payload.
const TEXT_RULES = [
  {
    id: 'clerk-sub',
    re: /user_[A-Za-z0-9]{10,}/g,
    why: 'a live-shaped Clerk sub. Scrub it with scripts/layout-gate/todayshape-fixture-scrub.mjs before tracking.',
  },
  {
    id: 'live-key',
    re: /\b(sk_live_|pk_live_)[A-Za-z0-9]{8,}/g,
    why: 'a live Stripe/Clerk publishable-or-secret key prefix.',
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    why: 'a JSON Web Token. A captured bearer token has no business in a fixture.',
  },
  {
    id: 'pg-url',
    re: /postgres(?:ql)?:\/\/[^\s"']+/g,
    why: 'a Postgres connection string.',
  },
]

const findings = []
const note = (file, rule, excerpt) => findings.push({ file, rule, excerpt })

// A redacted excerpt: enough to locate the hit, never enough to reproduce the secret.
const redact = (s) => (s.length <= 8 ? '*'.repeat(s.length) : s.slice(0, 4) + '…' + '*'.repeat(6))

function scanText(rel, text) {
  for (const rule of TEXT_RULES) {
    rule.re.lastIndex = 0
    const hits = new Set()
    let m
    while ((m = rule.re.exec(text))) hits.add(m[0])
    for (const h of hits) note(rel, rule, redact(h))
  }
}

// STRUCTURAL, not textual, for coordinates. `"lat": 51.477912345678` and `"lat":51.5` and a lat
// nested six levels down inside an array of plan items are the same exposure and one regex over the
// serialized bytes would have to guess at all three. Walking the parsed object cannot miss a shape.
function scanJson(rel, value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanJson(rel, v, `${path}[${i}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (GEO_KEY.test(k) && typeof v === 'number') {
        const allowed = (/^lat/i.test(k) ? SYNTHETIC_SITE.lat : SYNTHETIC_SITE.lng)
        if (v !== allowed) {
          note(rel, { id: 'coordinate', why: `a real coordinate. The only permitted value for a "${k}" key in a tracked fixture is the declared synthetic site (${SYNTHETIC_SITE.lat} / ${SYNTHETIC_SITE.lng}).` }, `${path}.${k} = ${v}`)
        }
      }
      scanJson(rel, v, `${path}.${k}`)
    }
  }
}

function walk(abs, acc = []) {
  let st
  try { st = statSync(abs) } catch { return acc }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) {
      // `out/` is the recorder's scratch output (screenshots + raw captures) and is gitignored.
      // Scanning it would report on files nobody is about to track and would hide the real hits.
      if (name === 'out' || name === 'node_modules') continue
      walk(join(abs, name), acc)
    }
    return acc
  }
  acc.push(abs)
  return acc
}

// This file is also IMPORTED (by todayshape-fixture-scrub.mjs, for SYNTHETIC_SITE). Everything below
// is the CLI, so importing it must not run a scan — an import that scanned nothing would exit 1 on
// the empty-corpus check and take the scrubber down with it.
const RUN_AS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// ── the self-test: a scanner that has never fired is a claim, not a guard ────────────────────────
if (RUN_AS_CLI && process.argv.includes('--self-test')) {
  // Built here, deliberately NOT sampled from the corpus this file guards: an allowlist validated
  // against its own input is green by construction and cannot surface the case it misses.
  const positive = [
    'user_3AbCdEfGhIjKlMnOpQrStUvWx',
    'sk_live_0123456789abcdef',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'postgresql://user:pw@host/db',
  ].join('\n')
  const negative = 'harness_user\nharness_member_jen\nplanting_id\nuser_short'
  const before = findings.length
  scanText('<self-test positive>', positive)
  const firedIds = new Set(findings.slice(before).map(f => f.rule.id))
  const missed = TEXT_RULES.filter(r => !firedIds.has(r.id)).map(r => r.id)
  findings.length = before
  scanText('<self-test negative>', negative)
  scanJson('<self-test negative>', { coords: SYNTHETIC_SITE })
  const falsePositives = findings.slice(before)
  findings.length = before
  // And the structural half, which the text rules cannot cover.
  // Greenwich, deliberately. The matcher above is STRUCTURAL — it flags any lat/lng value that is
  // not SYNTHETIC_SITE — so the specific number here does no work, and this self-test used to carry
  // the site's actual coordinates. In a PUBLIC repo, the one file whose job is keeping real
  // coordinates out of tracked fixtures should not be the file that commits them.
  scanJson('<self-test positive>', { plan: { coords: { lat: 51.4779, lng: -0.0015 } } })
  const geoFired = findings.length > before
  findings.length = before

  const problems = []
  if (missed.length) problems.push(`text matcher(s) did not fire on a known positive: ${missed.join(', ')}`)
  if (!geoFired) problems.push('the structural coordinate matcher did not fire on a known real coordinate')
  if (falsePositives.length) problems.push(`matched a known negative: ${falsePositives.map(f => f.rule.id).join(', ')}`)
  if (problems.length) {
    console.error('[preflight] SELF-TEST FAILED — this scanner cannot be trusted to refuse anything:')
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
  console.log(`[preflight] self-test PASS — all ${TEXT_RULES.length} text matchers + the structural coordinate matcher fired on known positives and stayed silent on known negatives.`)
  process.exit(0)
}

// ── the real scan ────────────────────────────────────────────────────────────────────────────────
if (!RUN_AS_CLI) { /* imported for SYNTHETIC_SITE only */ } else {
let scanned = 0
let bytes = 0
for (const t of TARGETS) {
  for (const abs of walk(resolve(ROOT, t))) {
    const rel = relative(ROOT, abs)
    let text
    try { text = readFileSync(abs, 'utf8') } catch (e) {
      console.error(`[preflight] could not read ${rel}: ${e.message}`)
      process.exit(1)
    }
    scanned++
    bytes += text.length
    scanText(rel, text)
    if (abs.endsWith('.json')) {
      // A fixture that does not parse is not "clean", it is unscannable — and an unscannable file is
      // exactly where something would hide. Refuse it rather than skipping it.
      let doc
      try { doc = JSON.parse(text) } catch (e) {
        console.error(`[preflight] FAIL — ${rel} is not parseable JSON (${e.message}); it cannot be scanned structurally, so it cannot be cleared.`)
        process.exit(1)
      }
      scanJson(rel, doc)
    }
  }
}

// A preflight that scanned nothing passes trivially — the same vacuity trap as a layout gate that
// measures nothing. Demand a corpus.
if (scanned === 0 || bytes === 0) {
  console.error(`[preflight] FAIL — scanned ${scanned} file(s) / ${bytes} bytes. There is nothing here to clear, so "clean" is a statement about an empty set. Expected the tracked Today-shape fixture set under ${TARGETS[0]}.`)
  process.exit(1)
}

if (findings.length) {
  console.error(`\n[preflight] HARD ABORT — ${findings.length} finding(s). These files must NOT be tracked as they stand.\n`)
  for (const f of findings) console.error(`  · ${f.file}: ${f.excerpt} — ${f.rule.why}`)
  console.error('\nA later commit cannot undo this. Scrub first: node scripts/layout-gate/todayshape-fixture-scrub.mjs\n')
  process.exit(1)
}
console.log(`[preflight] PASS — ${scanned} file(s) / ${(bytes / 1024).toFixed(0)} KB scanned, 0 findings (${TEXT_RULES.map(r => r.id).join(', ')}, coordinate).`)
}
