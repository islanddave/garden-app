// Public-repo literals (V5-SITECONSTANTS-001, multi-space Phase 1 step 1.13).
//
// WHY THIS EXISTS. The repository is public. Multi-space work writes new migrations and a harness that handle real
// Spaces, and the easy leak is a value pasted from production: a weather station's MAC address, or a garden's
// coordinates to four or more decimals (about 10 m). The directories below must hold neither.
//
// SCOPE is this explicit list, not "directories newer than a date": the four Phase 1 migration directories, the
// browser harness, and the Space harness. A directory that does not exist yet is skipped, not an error. Every file
// in them is read, tests and fixtures included, because a fixture is published like anything else.
//
// What is matched (MAC and DECIMAL4 in scripts/repo-constants-scan.mjs): six hex pairs joined by `:` or `-`, or
// the dotted `xxxx.xxxx.xxxx` form; a decimal with 4+ fractional digits and magnitude 1..180 that is not the
// seconds of a timestamp.
//
// KNOWN_AT_BASE. tests/harness/ already held such literals at 51a97146 (base of this change). They are listed as
// per-file counts (never the literal, so this file does not copy one), and the list can only shrink: a file not
// listed, or a count above its entry, reds; a count below its entry reds too (lower or delete the entry). Do not
// raise an entry: remove the literal instead. Print the current counts with
// `node scripts/repo-constants-scan.mjs public <DIRS…>`.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPublicLiterals, publicLiteralFindings, countPublicFindings } from '../scripts/repo-constants-scan.mjs'

const DIRS = [
  'migrations/v5-spaceguard-001',
  'migrations/v5-spacefk-001',
  'migrations/v5-platformoperators-001',
  'migrations/v5-tenantgates-001',
  'tests/harness',
  'scripts/space-harness',
]

const KNOWN_AT_BASE = {
  // station_mac copied from a production dump (raincard.jsx and both _todaymeasure dailyplan dumps); a follow-up
  // removes it (reported in the lane hand-back). The dumps' lat/lng is the centre of the contiguous US, a placeholder.
  'tests/harness/raincard.jsx': { mac: 1 },
  'tests/harness/_todaymeasure/dailyplan.dave.json': { mac: 7, latlng: 2 },
  'tests/harness/_todaymeasure/dailyplan.jen.json': { mac: 7, latlng: 2 },
  'tests/harness/_todaymeasure/README.md': { latlng: 2 },
  // Obviously fake MACs (all AA..FF).
  'tests/harness/wxbanner.jsx': { mac: 1 },
  'tests/harness/wxoutage.jsx': { mac: 2 },
  // Computed averages in days, not coordinates.
  'tests/harness/_todaymeasure/harvests.json': { latlng: 18 },
  'tests/harness/_todaymeasure/harvests.batchwindow.json': { latlng: 18 },
}

// Every (file, kind) whose count differs from KNOWN_AT_BASE, with what to do about it.
function drift(counts, known) {
  const out = []
  for (const file of new Set([...Object.keys(counts), ...Object.keys(known)])) {
    for (const kind of ['mac', 'latlng']) {
      const have = counts[file]?.[kind] || 0
      const allowed = known[file]?.[kind] || 0
      if (have > allowed) out.push(`${file} ${kind}: ${have} > ${allowed} — NEW literal; remove it`)
      else if (have < allowed) out.push(`${file} ${kind}: ${have} < ${allowed} — STALE entry; lower it to ${have}${have ? '' : ' (delete it)'}`)
    }
  }
  return out
}

describe('public-repo literals (1.13)', () => {
  const { files, findings } = scanPublicLiterals(DIRS)

  it('read the directories that exist (anti-vacuity: tests/harness does)', () => {
    expect(files.some((f) => f.startsWith('tests/harness/'))).toBe(true)
  })

  it('MAC-shaped and 4+-decimal lat/lng literals match KNOWN_AT_BASE exactly (new red, stale red)', () => {
    const d = drift(countPublicFindings(findings), KNOWN_AT_BASE)
    // On a red, the findings themselves say where.
    expect(d.length ? { drift: d, findings } : []).toEqual([])
  })

  // The positive control kept as a test: a fixture file with a fake MAC in a scoped directory reds.
  it('a planted fake MAC and a planted coordinate are found and red the comparison', () => {
    const root = mkdtempSync(join(tmpdir(), 'pubrepo-'))
    try {
      mkdirSync(join(root, 'tests/harness'), { recursive: true })
      writeFileSync(join(root, 'tests/harness/planted.json'), '{"station_mac": "02:00:5e:10:00:01", "lat": 42.1234}\n')
      const r = scanPublicLiterals(DIRS, { root })
      expect(r.files).toEqual(['tests/harness/planted.json'])
      expect(countPublicFindings(r.findings)).toEqual({ 'tests/harness/planted.json': { mac: 1, latlng: 1 } })
      expect(drift(countPublicFindings(r.findings), {})).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the matcher: forms found, near-misses not', () => {
    const lit = (s) => publicLiteralFindings('x', s).map((f) => f.split(' literal ')[1].split(' ')[0])
    expect(lit('mac 02-00-5E-10-00-01')).toEqual(['02-00-5E-10-00-01'])
    expect(lit('mac 0200.5e10.0001')).toEqual(['0200.5e10.0001'])
    expect(lit('"lng":-72.6012')).toEqual(['-72.6012'])
    expect(lit("at '2026-06-07T05:22:01.245082Z', tol 0.0001, lat 42.5, v 5.1.4, id 1a2b3c4d5e6f")).toEqual([])
  })
})
