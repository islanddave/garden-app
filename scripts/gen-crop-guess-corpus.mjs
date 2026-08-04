#!/usr/bin/env node
// Regenerates src/data/crop-guess-corpus.json — the in-repo PROJECTION that lets the
// V4-CROPGUESS-001 corpus gate actually run in CI.
//
// THE PROBLEM THIS SOLVES. cropGuessCorpus.test.js asserts that no seed packet carries a
// wrong-but-valid crop guess. One of its two corpora lives in the sibling gardening-docs repo
// (`../seeds/seed-load-dataset-V1.json`), which is present on Dave's Mac and ABSENT in CI, so the
// test `skipIf`s it away. That is the larger corpus and it is where all four known instances of the
// defect class have been found (Radicchio->endive, Chervil->parsley, Borage->basil, and on
// 20260804 Pumpkin->squash plus two the detector could not yet see). A gate that fires on exactly
// one laptop is not a gate; it is a habit.
//
// WHY A PROJECTION AND NOT A COPY. Copying a 162 KB seed dataset into garden-app would fork data
// that has a canonical home, and the fork would rot. This emits only the four fields the gate reads
// — corpus, crop, variety, guess — a few KB, obviously derived, regenerable by re-running this
// script, and useless for anything except the check. The source datasets stay canonical.
//
// STALENESS IS THE REAL RISK, so it is gated rather than trusted: each source records its sha256
// and packet count, and the test re-hashes any source file that IS present and fails if the
// projection no longer matches. So the dev machine catches drift the moment upstream moves, and CI
// still runs the full content assertion against the last verified snapshot. Neither gate can go
// quiet on its own.
//
// Usage: node scripts/gen-crop-guess-corpus.mjs [--check]
//   (no flag)  rewrite src/data/crop-guess-corpus.json
//   --check    exit non-zero if the committed file is not what this script would write

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const OUT = join(repoRoot, 'src', 'data', 'crop-guess-corpus.json')

// Keep in lockstep with CORPORA in src/__tests__/cropGuessCorpus.test.js.
const SOURCES = [
  { name: 'v4-seedinv-002-jul-intake', path: join(repoRoot, 'migrations', 'v4-seedinv-002-jul-intake', 'dataset.json'), in_repo: true },
  { name: 'seed-load-dataset-V1', path: join(repoRoot, '..', 'seeds', 'seed-load-dataset-V1.json'), in_repo: false },
]

function packetsOf(raw) {
  const doc = JSON.parse(raw)
  return Array.isArray(doc) ? doc : (doc.packets ?? [])
}

function build() {
  const sources = []
  const rows = []
  for (const s of SOURCES) {
    if (!existsSync(s.path)) throw new Error(
      `source corpus missing: ${s.path}\n` +
      `Regeneration needs BOTH datasets, including the sibling gardening-docs checkout. ` +
      `Run this on a machine that has ~/AI/Claude/Projects/Gardening/seeds/.`)
    const raw = readFileSync(s.path, 'utf8')
    const packets = packetsOf(raw)
    if (!packets.length) throw new Error(`${s.name} parsed to zero packets — refusing to emit a vacuous corpus`)
    sources.push({
      name: s.name,
      in_repo: s.in_repo,
      // Relative so the hash check is machine-independent.
      rel_path: s.in_repo ? s.path.slice(repoRoot.length + 1) : '../seeds/seed-load-dataset-V1.json',
      packets: packets.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
    })
    for (const p of packets) {
      rows.push({
        corpus: s.name,
        crop: p.crop ?? null,
        variety: p.variety ?? null,
        guess: p.crop_type_slug_guess ?? null,
      })
    }
  }
  return {
    schema: 'crop-guess-corpus/v1',
    note: 'DERIVED — do not hand-edit. Regenerate with: node scripts/gen-crop-guess-corpus.mjs. '
        + 'Canonical packet data lives in the source datasets listed under `sources`; this file '
        + 'carries only the four fields checkCropGuess reads, so the gate can run in CI where the '
        + 'gardening-docs sibling checkout does not exist.',
    generator: 'scripts/gen-crop-guess-corpus.mjs',
    sources,
    rows,
  }
}

const next = JSON.stringify(build(), null, 2) + '\n'

if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (cur !== next) {
    console.error('crop-guess corpus projection is STALE — run: node scripts/gen-crop-guess-corpus.mjs')
    process.exit(1)
  }
  console.log('crop-guess corpus projection is current')
} else {
  writeFileSync(OUT, next)
  const doc = JSON.parse(next)
  console.log(`wrote ${OUT.slice(repoRoot.length + 1)} — ${doc.rows.length} rows from ${doc.sources.length} corpora`)
  for (const s of doc.sources) console.log(`  ${s.name}: ${s.packets} packets  sha256=${s.sha256.slice(0, 12)}…`)
}
