import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkCropGuess } from '../lib/parseSowProfile.js'

// V4-CROPGUESS-001 corpus gate (croptype-mistyping-20260721 Pending 1).
//
// The unit tests prove checkCropGuess behaves; this proves the ACTUAL seed data is clean, and keeps
// it that way. Every packet must resolve to match / synonym / none. An `unresolved` packet is a
// wrong-but-valid crop guess of exactly the class that shipped three times (Radicchio->endive,
// Chervil->parsley, Borage->basil) — each one valid, each one silently wrong, each one carrying a
// wrong harvest model because crop_types holds harvest_habit.
//
// This gate is what converts a one-time audit into a closed failure mode: adding a new packet with a
// nearest-valid-neighbour guess fails CI instead of being discovered months later by eye.
//
// Fixing a failure is a JUDGMENT CALL, never a mechanical silence — either correct the guess (it was
// a defect) or add a reviewed entry to CROP_GUESS_SYNONYMS with its reason (it was a legitimate
// grouping). Do not widen slugifyCropName to make a mismatch disappear.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const CORPORA = [
  // In-repo, so this one always runs in CI.
  { name: 'v4-seedinv-002-jul-intake', path: join(repoRoot, 'migrations', 'v4-seedinv-002-jul-intake', 'dataset.json') },
  // Lives in the sibling gardening-docs repo. Present on a dev machine, absent in CI — skipped
  // rather than failed, since a missing file is not a data defect.
  { name: 'seed-load-dataset-V1', path: join(repoRoot, '..', 'seeds', 'seed-load-dataset-V1.json') },
]

function packetsOf(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(doc) ? doc : (doc.packets ?? [])
}

describe('crop-guess corpus gate — no wrong-but-valid crop guesses in the seed datasets', () => {
  for (const { name, path } of CORPORA) {
    const present = existsSync(path)

    it.skipIf(!present)(`${name}: every packet resolves (match | synonym | none)`, () => {
      const packets = packetsOf(path)
      // Guard the guard: a corpus that silently read as empty would pass vacuously.
      expect(packets.length, `${name} parsed to zero packets`).toBeGreaterThan(0)

      const unresolved = packets
        .map(p => ({ p, r: checkCropGuess(p) }))
        .filter(({ r }) => r.status === 'unresolved')
        .map(({ p, r }) => `${p.crop} (${p.variety}): crop slugifies to '${r.cropSlug}' but guess is '${r.guess}'`)

      expect(unresolved, `wrong-but-valid crop guess(es) in ${name} — correct the guess, or add a reviewed CROP_GUESS_SYNONYMS entry`).toEqual([])
    })

    it.skipIf(present)(`${name}: SKIPPED — dataset not present at ${path}`, () => {
      expect(present).toBe(false)
    })
  }
})
