// Public-repo literals (V5-SITECONSTANTS-001, multi-space Phase 1 step 1.13).
//
// WHY THIS EXISTS. The repository is public. Multi-space work writes new migrations and a harness that handle real
// Spaces, and the easy leak is a value pasted from production: a weather station's MAC address, or a garden's
// coordinates to four or more decimals (about 10 m). The directories below must hold neither.
//
// SCOPE is this explicit list, not "directories newer than a date": the four Phase 1 migration directories, the
// browser harness, and the Space harness. A directory that does not exist yet is skipped, not an error. Every
// TRACKED file in them is read (git ls-files), tests and fixtures included, because a fixture is published like
// anything else.
//
// What is matched (MAC and DECIMAL4 in scripts/repo-constants-scan.mjs): six hex pairs joined by `:` or `-`, or
// the dotted `xxxx.xxxx.xxxx` form; a decimal with 4+ fractional digits and magnitude 1..180 that is not the
// seconds of a timestamp.
//
// TWO RULES.
//   * STRICT_DIRS (the new Phase 1 dirs): any finding reds. Nothing there can be pinned.
//   * tests/harness/ held such literals at 51a97146 (base of this change), and other workstreams own those files.
//     KNOWN_AT_BASE pins each one by the sha256 of its literal, per file (never the literal, so this file does not
//     copy one, and neither does a failure message). A finding whose hash is not pinned in its file reds: a new
//     literal, or one swapped for another. A pinned hash that is no longer found is printed as a NOTE and does not
//     fail, so a session that scrubs or re-dumps a harness file is not sent here; delete the pin when you see it.
// Print the current pins with `node scripts/repo-constants-scan.mjs public <DIRS…>` (carry `reason` over by hand).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPublicLiterals, publicLiteralFindings, pinPublicFindings, literalHash } from '../scripts/repo-constants-scan.mjs'

const STRICT_DIRS = [
  'migrations/v5-spaceguard-001',
  'migrations/v5-spacefk-001',
  'migrations/v5-platformoperators-001',
  'migrations/v5-tenantgates-001',
  'scripts/space-harness',
]
const PINNED_DIR = 'tests/harness'
const DIRS = [...STRICT_DIRS, PINNED_DIR]

// The station MAC is one literal in three files (one hash).
const STATION_MAC = 'f33ef8fdfbe54e00b60180b1faf5dd150d33986aa0eb6d0b491254cc572ece75'
const DUMP_PLACEHOLDER_LATLNG = [
  'a51acbe2313bdfba201fe356699731122e272828893a373da17ffff8a324e4f8',
  'c60e5e9bf6f91308e34462771766a9f61aaa8b3fec9615f98235badf8fc8ea0d',
]
const FAKE_MAC = '261900fb1113aa4db748173e13abd88ae0faf7536891ee956fea94d58673cbdb'
const HARVEST_AVERAGES = [
  '08774eb02e5d53863cc07831517282b5509cb8631d770d0951dd1956d7533afa',
  '2693973ce44440e2f9287470140dc6d02458985f4dd304d348a11991c2b9bb7a',
  '90607e4d74709519a2942edb3a3b0ff1c607e2e1faf8ffd333c96470131664ff',
  '9c42040b98f7f62c1e866d34f21007900ce9121369cdfc817b06a1b5c7c2ec7e',
  '9de0f17ee4b84c997f18dac147a6597ef7e753f83c11f6cfdd381df52a9b9397',
  'c4364bc5aa62673e27adcaccceba4de31b1ffe7415c7457cd592f804aeebc706',
  'd008775fa2a756eb3b8b889ffaf30501879a32c176c9ec2926e2720ac07ce7d4',
  'ed305013f6f9b47eb3ea713e1153f0cedf0555ef63b1a7d234932cf5267f9553',
]
const REAL_MAC = 'station_mac copied from a production dump; BUG-HARNESSMACLEAK-001 replaces it with a fake (delete the '
  + 'mac pin then). The dumps\' lat/lng is the centre of the contiguous US, a placeholder'
const HARVEST_FP = 'false positive: computed averages in days, not coordinates'

const KNOWN_AT_BASE = {
  'tests/harness/raincard.jsx': { mac: [STATION_MAC], reason: REAL_MAC },
  'tests/harness/_todaymeasure/dailyplan.dave.json': { mac: [STATION_MAC], latlng: DUMP_PLACEHOLDER_LATLNG, reason: REAL_MAC },
  'tests/harness/_todaymeasure/dailyplan.jen.json': { mac: [STATION_MAC], latlng: DUMP_PLACEHOLDER_LATLNG, reason: REAL_MAC },
  'tests/harness/_todaymeasure/README.md': {
    latlng: ['6418cb4858d8b6a376a1d99f2078b73074ba57707ca16305ed2c49953f83e0bb', DUMP_PLACEHOLDER_LATLNG[1]],
    reason: 'the README describes the dumps\' placeholder coordinates',
  },
  'tests/harness/wxbanner.jsx': { mac: [FAKE_MAC], reason: 'obviously fake MAC (all AA..FF)' },
  'tests/harness/wxoutage.jsx': { mac: [FAKE_MAC], reason: 'obviously fake MAC (all AA..FF)' },
  'tests/harness/_todaymeasure/harvests.json': { latlng: HARVEST_AVERAGES, reason: HARVEST_FP },
  'tests/harness/_todaymeasure/harvests.batchwindow.json': { latlng: HARVEST_AVERAGES, reason: HARVEST_FP },
}

const where = (f) => `${f.file}:${f.line} ${f.kind} sha256 ${f.hash.slice(0, 12)}…`

// The failures: every finding in a strict dir, and every tests/harness finding whose hash is not pinned in its file.
function unpinned(findings, known) {
  return findings.filter((f) => !(known[f.file]?.[f.kind] || []).includes(f.hash)).map(where)
}

// The notes: pins no longer found in their file (scrubbed or re-dumped by the file's owner). Never a failure.
function gonePins(findings, known) {
  const have = pinPublicFindings(findings)
  const out = []
  for (const [file, entry] of Object.entries(known)) {
    for (const kind of ['mac', 'latlng']) {
      for (const h of entry[kind] || []) {
        if (!(have[file]?.[kind] || []).includes(h)) out.push(`${file} ${kind} sha256 ${h.slice(0, 12)}… no longer found; delete the pin`)
      }
    }
  }
  return out
}

describe('public-repo literals (1.13)', () => {
  const { files, findings } = scanPublicLiterals(DIRS)

  it('read the directories that exist (anti-vacuity: tests/harness does)', () => {
    expect(files.some((f) => f.startsWith(`${PINNED_DIR}/`))).toBe(true)
  })

  it('pins live under tests/harness only (the strict dirs take none) and each says why', () => {
    for (const [file, entry] of Object.entries(KNOWN_AT_BASE)) {
      expect(file.startsWith(`${PINNED_DIR}/`), file).toBe(true)
      expect(typeof entry.reason, file).toBe('string')
      for (const k of Object.keys(entry)) expect(['mac', 'latlng', 'reason'], `${file} ${k}`).toContain(k)
      for (const h of [...(entry.mac || []), ...(entry.latlng || [])]) expect(h, file).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('no MAC-shaped or 4+-decimal lat/lng literal outside the pins (strict dirs: none at all)', () => {
    const notes = gonePins(findings, KNOWN_AT_BASE)
    if (notes.length) console.info(`[1.13 NOTE] pins no longer found (not a failure):\n  ${notes.join('\n  ')}`)
    expect(unpinned(findings, KNOWN_AT_BASE)).toEqual([])
  })

  // The positive controls kept as tests.
  it('a planted MAC and coordinate red; a swapped literal reds; a scrubbed pin is a note only', () => {
    const root = mkdtempSync(join(tmpdir(), 'pubrepo-'))
    try {
      mkdirSync(join(root, 'tests/harness'), { recursive: true })
      mkdirSync(join(root, 'migrations/v5-spaceguard-001'), { recursive: true })
      writeFileSync(join(root, 'tests/harness/planted.json'), '{"station_mac": "02:00:5e:10:00:01", "lat": 42.1234}\n')
      writeFileSync(join(root, 'tests/harness/pinned.json'), '{"station_mac": "02:00:5e:10:00:02"}\n')
      writeFileSync(join(root, 'migrations/v5-spaceguard-001/zz.sql'), "select 42.4712, -72.6034;\n")
      const r = scanPublicLiterals(DIRS, { root })
      expect(r.files).toEqual(['migrations/v5-spaceguard-001/zz.sql', 'tests/harness/pinned.json', 'tests/harness/planted.json'])
      const known = {
        // pinned to a DIFFERENT MAC than the file now holds (a swap), plus a pin whose literal is gone
        'tests/harness/pinned.json': { mac: [literalHash('02:00:5e:10:00:03')], latlng: [literalHash('10.0001')] },
        // a pin can not excuse a strict-dir finding (the pin test above also forbids writing one)
        'migrations/v5-spaceguard-001/zz.sql': { latlng: [] },
      }
      const red = unpinned(r.findings, known)
      expect(red).toHaveLength(5)
      expect(red.join('\n')).not.toMatch(/02:00:5e|42\.4712|72\.6034|42\.1234/)
      expect(gonePins(r.findings, known)).toHaveLength(2)
      // pin the swapped-in literal and the harness file is green, while its stale pin stays a note
      known['tests/harness/pinned.json'].mac.push(literalHash('02:00:5e:10:00:02'))
      expect(unpinned(r.findings, known).filter((s) => s.startsWith('tests/harness/pinned.json'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the matcher: forms found, near-misses not', () => {
    const lit = (s) => publicLiteralFindings('x', s).map((f) => f.literal)
    expect(lit('mac 02-00-5E-10-00-01')).toEqual(['02-00-5E-10-00-01'])
    expect(lit('mac 0200.5e10.0001')).toEqual(['0200.5e10.0001'])
    expect(lit('"lng":-72.6012')).toEqual(['-72.6012'])
    expect(lit("at '2026-06-07T05:22:01.245082Z', tol 0.0001, lat 42.5, v 5.1.4, id 1a2b3c4d5e6f")).toEqual([])
  })
})
