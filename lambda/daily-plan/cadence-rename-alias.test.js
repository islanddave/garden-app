import { describe, it, expect } from 'vitest'
import cad from './cadence-data-v2.json'
import ref from '../../src/data/harvest-weights-v3-reference.json'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// V4-CULTIVARNAME-001 — the standing guard for a cultivar rename.
//
// resolveCadence() in engine.js looks by_variety up on the LITERAL name the database returns
// ([p.variety, p.name] = plant_varieties.name, plants.name) with no normalization of any kind.
// A key that does not match is not an error — it falls through to the genus fallback and the
// planting silently gets a different watering interval. Nothing logs, nothing 500s, and the only
// symptom is a plant watered on the wrong schedule.
//
// That makes a DB rename and a key rename impossible to make atomic, so the discipline is
// WIDEN -> RENAME -> NARROW: ship the new key as a duplicate first, rename the DB second, drop the
// legacy key in a later deploy. These tests pin the middle state, which is the one a well-meaning
// tidy-up ("there are two identical entries, delete one") would quietly destroy.
//
// scripts/verify-cultivar-rename.mjs is the operator-facing one-shot version of this; it also
// covers surfaces vitest cannot reach. This file exists because CI runs vitest and not that script.

const HERE = dirname(fileURLToPath(import.meta.url))

describe('V4-CULTIVARNAME-001 — cadence key aliases survive a rename', () => {
  it('by_variety carries the current DB name for the Czech heirloom', () => {
    expect(cad.by_variety).toHaveProperty("Czech's Bush")
  })

  it('by_variety STILL carries the pre-rename key', () => {
    // Not legacy cruft. Two live reasons:
    //  1. this Lambda deploys BEFORE the migration runs, so the old name is still what the DB
    //     returns during that window;
    //  2. migrations/v4-cultivarname-001/0r-rollback.sql restores the old name and is designed to
    //     be runnable WITHOUT a matching Lambda rollback — which only works while this key lives.
    // Remove it in its own deploy, after the rename is confirmed in prod — following the four-step
    // NARROW CHECKLIST in migrations/v4-cultivarname-001/README-BUILD.md, which deletes this test,
    // deletes 0r-rollback.sql, and flips check 5 of scripts/verify-cultivar-rename.mjs in the SAME
    // commit. Deleting only this test leaves a rollback file that still claims to be safe and no
    // longer is.
    expect(cad.by_variety).toHaveProperty('Czech Bush Slicer')
  })

  it('the two Czech entries are an alias, not a fork that can drift apart', () => {
    expect(cad.by_variety["Czech's Bush"]).toEqual(cad.by_variety['Czech Bush Slicer'])
  })

  it('no stale Floridade key was ever introduced', () => {
    // Neither spelling has a cadence entry — this cultivar resolves via the genus fallback. Pinned
    // so that if someone adds one later they are forced to add it under the corrected name.
    expect(cad.by_variety).not.toHaveProperty('Floridade')
  })

  it('the reference-weight authoring source uses only the corrected names', () => {
    // gen-refweight-seed.mjs turns each of these into `WHERE crop_type_slug=… AND name=…`. A stale
    // name here means a re-run of 0b-seed.sql matches zero rows and that variety silently keeps no
    // reference weight — the same silent-skip failure mode, pointed the other way.
    const names = new Set(ref.by_variety.map((r) => r.variety_name))
    expect(names).toContain("Czech's Bush")
    expect(names).toContain('Floradade')
    expect(names).not.toContain('Czech Bush Slicer')
    expect(names).not.toContain('Floridade')
  })

  it('the generated seed matches those names, with the apostrophe SQL-escaped', () => {
    const sql = readFileSync(resolve(HERE, '../../migrations/v4-cal1-refweight-001/0b-seed.sql'), 'utf8')
    expect(sql).toContain("name='Czech''s Bush'")
    expect(sql).toContain("name='Floradade'")
    expect(sql).not.toContain("name='Czech Bush Slicer'")
    expect(sql).not.toContain("name='Floridade'")
  })

  it('no measured sample is keyed on a pre-rename name', () => {
    // apply-measured-samples.mjs pools on (crop_type_slug, variety_name, unit) and emits a
    // name-matched UPDATE. Neither cultivar has a sample today, so the hazard is latent — this
    // fails the moment someone weighs one and files it under the old spelling.
    const v2 = JSON.parse(readFileSync(resolve(HERE, '../../src/data/harvest-weights-v2.json'), 'utf8'))
    // CORPUS FLOOR, before the filter. `?? []` turns a renamed or removed key into a silently
    // EMPTY corpus, and `expect([]).toEqual([])` is then true forever — a `filter -> toEqual([])`
    // is only as strong as its input. Proven by mutating the guard's input: rename
    // `by_cultivar_samples` -> `cultivar_samples` (what a schema_version bump does) AND add a
    // sample keyed on 'Floridade'. The pre-floor expression returned [] and passed with the
    // defect present. Assert the KEYS, not just their contents: by_cultivar_voids is legitimately
    // empty today (0 entries), so a length floor on it would be wrong — but it must still EXIST,
    // or half this guard's input is gone and nothing says so.
    expect(Array.isArray(v2.by_cultivar_samples),
      'harvest-weights-v2.json no longer has by_cultivar_samples — this guard is reading nothing')
      .toBe(true)
    expect(Array.isArray(v2.by_cultivar_voids),
      'harvest-weights-v2.json no longer has by_cultivar_voids — half this guard\'s corpus is gone')
      .toBe(true)
    expect(v2.by_cultivar_samples.length, 'sample corpus is empty — the guard covers nothing')
      .toBeGreaterThanOrEqual(9) // 9 at d9afab95
    const corpus = [...v2.by_cultivar_samples, ...v2.by_cultivar_voids]
    // Every entry must actually carry the field being filtered on; a renamed FIELD is the same
    // silent miss one level down.
    expect(corpus.every((s) => typeof s.variety_name === 'string'),
      'a corpus entry has no variety_name — the filter below cannot see it').toBe(true)
    const stale = corpus
      .filter((s) => s.variety_name === 'Czech Bush Slicer' || s.variety_name === 'Floridade')
      .map((s) => s.variety_name)
    expect(stale).toEqual([])
  })
})
