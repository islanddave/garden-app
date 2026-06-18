// V3-ARCHIVE-001 completion: the daily-plan engine query must exclude soft-archived
// plantings (p.archived_at) AND plantings under an archived project (pj.archived_at),
// not just status='archived'. Static source guard (the query is a template literal;
// a live-DB assertion lives in the integration suite). Mirrors events/archive-award.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(__dirname, 'handler.js'), 'utf8')

describe('daily-plan engine excludes archived (V3-ARCHIVE-001)', () => {
  it('filters archived plantings (p.archived_at is null)', () => {
    expect(SRC).toMatch(/p\.archived_at is null/)
  })
  it('filters plantings under an archived project (pj.archived_at is null)', () => {
    expect(SRC).toMatch(/pj\.archived_at is null/)
  })
})
