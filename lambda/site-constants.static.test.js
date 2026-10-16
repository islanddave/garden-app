// Site constants: the places where one garden's facts (its latitude, its frost dates, its town, its fitted
// calibration) are compiled into the code (V5-SITECONSTANTS-001, multi-space Phase 1 step 1.4).
//
// WHY THIS EXISTS. A second Space will not live at 42.5 N with a mid-October first frost. Each of these
// declarations becomes a per-Space read later; until then the list below is every one of them, pinned by file and
// name, so a new one cannot slip in unnoticed and a removed one cannot leave the list claiming more than is true.
// Both directions red:
//   * a site-constant declaration that is not on the list (e.g. `const SITE_LNG = …`) — NEW, put it in a per-Space
//     read instead, or add it here with the reviewer looking;
//   * a list entry whose declaration is gone (e.g. `SITE_LAT` removed) — STALE, delete the entry.
// What counts as a site constant (name pattern, content pattern, JSON keys) is SITE_NAME / SITE_TEXT /
// SITE_JSON_KEY in scripts/repo-constants-scan.mjs. Non-test `lambda/**` and `src/**` only.
//
// The nil UUID (all zeros) is the old "no Space" placeholder that step 1.9 folds away; its count in non-test
// lambda/, src/ and scripts/ is 0 and stays 0.
//
// Regenerate the list: `node scripts/repo-constants-scan.mjs site`.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSiteConstants, scanNilUuid, siteConstantsInJs, walk } from '../scripts/repo-constants-scan.mjs'

// Recon §1.4 at 51a97146, plus SITE_FACTOR (src/lib/maturityCalibration.js: time-to-harvest fitted "at this
// site"), which the recon's list did not name and the pattern finds.
const SITE_CONSTANTS = [
  ['lambda/daily-plan/overwinter.js', 'SITE_LAT'],
  ['lambda/harvests/watch.js', 'DERIVED_FROST_WINDOW_DAYS'],
  ['lambda/harvests/watch.js', 'DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD'],
  ['src/data/storageDeadlines.json', 'measured_basis'],
  ['src/lib/helperPrompt.js', 'PREAMBLE'],
  ['src/lib/maturityCalibration.js', 'SITE_FACTOR'],
  ['src/lib/sowEngine.js', 'FROST_ANCHORS'],
  ['src/lib/sowEngine.js', 'OBSERVED_FIRST_FALL_FROST'],
]

const key = ([file, identifier]) => `${file} ${identifier}`

describe('site constants (1.4)', () => {
  const found = scanSiteConstants().map(({ file, identifier }) => key([file, identifier]))
  const pinned = SITE_CONSTANTS.map(key)

  it('walked the trees it claims to (anti-vacuity)', () => {
    expect(walk(['lambda', 'src']).length).toBeGreaterThan(1000)
    expect(found.length).toBeGreaterThan(0)
  })

  it('no site constant outside the pinned list (NEW: read it per Space, or add it here in review)', () => {
    expect(found.filter((k) => !pinned.includes(k))).toEqual([])
  })

  it('no pinned entry without its declaration (STALE: delete the entry)', () => {
    expect(pinned.filter((k) => !found.includes(k))).toEqual([])
  })

  it('the nil UUID appears in no non-test file under lambda/, src/, scripts/ (baseline 0)', () => {
    expect(scanNilUuid()).toEqual({})
  })

  // QA MINOR / RIA MINOR: the three scanners read tracked files, as CI's clean checkout does, so an untracked scratch
  // file or a gitignored dump never reds locally. A tree that is not a work tree (the planted fixtures) is walked.
  it('walk reads tracked files in a git work tree, every file in a plain tree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-')))
    try {
      mkdirSync(join(root, 'lambda/x'), { recursive: true })
      for (const f of ['tracked.js', 'untracked.js', 'ignored.js']) writeFileSync(join(root, 'lambda/x', f), 'const A = 1\n')
      expect(walk(['lambda'], { root })).toEqual(['lambda/x/ignored.js', 'lambda/x/tracked.js', 'lambda/x/untracked.js'])
      writeFileSync(join(root, '.gitignore'), 'ignored.js\n')
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['add', 'lambda/x/tracked.js'], { cwd: root })
      expect(walk(['lambda'], { root })).toEqual(['lambda/x/tracked.js'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The detector itself, so a green run above cannot be a blind one.
  it('the detector finds a declaration and ignores a comment', () => {
    expect(siteConstantsInJs('const SITE_LNG = -72.6;')).toEqual(['SITE_LNG'])
    expect(siteConstantsInJs('export const HOME_LAT = 42.5')).toEqual(['HOME_LAT'])
    expect(siteConstantsInJs("const INTRO = `We garden in South Deerfield`")).toEqual(['INTRO'])
    expect(siteConstantsInJs('// const SITE_LNG = -72.6\nconst LATER = 1')).toEqual([])
  })
})
