import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkCropGuess } from '../lib/parseSowProfile.js'
import CORPUS from '../data/crop-guess-corpus.json'

// V4-CROPGUESS-001 corpus gate (croptype-mistyping-20260721 Pending 1).
//
// The unit tests prove checkCropGuess behaves; this proves the ACTUAL seed data is clean, and keeps
// it that way. Every packet must resolve to match / synonym / none. An `unresolved` packet is a
// wrong-but-valid crop guess of exactly the class that shipped three times (Radicchio->endive,
// Chervil->parsley, Borage->basil), each one valid, each one silently wrong, each one carrying a
// wrong harvest model because crop_types holds harvest_habit.
//
// This gate is what converts a one-time audit into a closed failure mode: adding a new packet with a
// nearest-valid-neighbour guess fails CI instead of being discovered months later by eye.
//
// Fixing a failure is a JUDGMENT CALL, never a mechanical silence — either correct the guess (it was
// a defect) or add a reviewed entry to CROP_GUESS_SYNONYMS with its reason (it was a legitimate
// grouping). Do not widen slugifyCropName to make a mismatch disappear.
//
// ── 20260804: THE GATE DID NOT ACTUALLY GATE ─────────────────────────────────────────────────────
// It read the two source datasets directly, and the larger of them lives in the sibling
// gardening-docs repo — present on Dave's Mac, ABSENT in CI, so it `skipIf`'d itself away. Every
// instance of the defect class so far has been found in THAT corpus, including today's
// Pumpkin->squash, which had been sitting red on one laptop. A gate that fires on one machine is a
// habit, not a gate.
//
// So the assertion now reads an in-repo PROJECTION (src/data/crop-guess-corpus.json — four fields
// per packet, emitted by scripts/gen-crop-guess-corpus.mjs) and therefore ALWAYS runs, CI included.
// The obvious risk of a committed snapshot is that it silently goes stale, so that is gated too:
// wherever a source file IS present its sha256 is re-checked against the one recorded in the
// projection. CI proves the CONTENT is clean; a dev machine additionally proves the snapshot still
// MATCHES upstream. Neither half can go quiet without the other failing.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

describe('crop-guess corpus gate — no wrong-but-valid crop guesses in the seed datasets', () => {
  it('the projection itself is well formed — guard the guard', () => {
    // A projection that read as empty, or that quietly lost a corpus, would pass every assertion
    // below vacuously. That is the failure mode a committed snapshot introduces, so it is checked
    // first and explicitly.
    expect(CORPUS.schema).toBe('crop-guess-corpus/v1')
    expect(CORPUS.rows.length, 'projection parsed to zero rows').toBeGreaterThan(0)
    expect(CORPUS.sources.length, 'a corpus went missing from the projection').toBeGreaterThanOrEqual(2)
    for (const s of CORPUS.sources) {
      expect(s.packets, `${s.name} recorded zero packets`).toBeGreaterThan(0)
      expect(s.sha256, `${s.name} has no source hash`).toMatch(/^[0-9a-f]{64}$/)
      const rows = CORPUS.rows.filter(r => r.corpus === s.name)
      expect(rows.length, `${s.name}: projected row count != recorded packet count`).toBe(s.packets)
    }
  })

  for (const s of CORPUS.sources) {
    it(`${s.name}: every packet resolves (match | synonym | none)`, () => {
      const rows = CORPUS.rows.filter(r => r.corpus === s.name)
      const unresolved = rows
        .map(r => ({ r, v: checkCropGuess({ crop: r.crop, crop_type_slug_guess: r.guess }) }))
        .filter(({ v }) => v.status === 'unresolved')
        .map(({ r, v }) => `${r.crop} (${r.variety}): crop slugifies to '${v.cropSlug}' but guess is '${v.guess}'`)

      expect(unresolved, `wrong-but-valid crop guess(es) in ${s.name} — correct the guess, or add a reviewed CROP_GUESS_SYNONYMS entry`).toEqual([])
    })

    // Freshness. Runs wherever the source file exists (dev), skips where it does not (CI). This is
    // now the ONLY thing allowed to skip — the content assertion above never does.
    const abs = join(repoRoot, s.rel_path)
    const present = existsSync(abs)

    it.skipIf(!present)(`${s.name}: the committed projection still matches its source file`, () => {
      const sha = createHash('sha256').update(readFileSync(abs, 'utf8')).digest('hex')
      expect(sha, `${s.rel_path} has changed since the projection was generated — run: node scripts/gen-crop-guess-corpus.mjs`).toBe(s.sha256)
    })

    it.skipIf(present)(`${s.name}: freshness check SKIPPED — source not present at ${s.rel_path}`, () => {
      expect(present).toBe(false)
    })
  }
})
