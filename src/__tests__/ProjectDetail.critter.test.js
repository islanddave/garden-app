import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Static wiring check — ProjectDetail event-create flow is too tangled to mock cleanly
// for a unit test (ux flow + photo upload + variety picker + ...). Verify via source text
// that the Phase B+ critter wiring is in place. Integration verification happens in
// deploy-staging smoke when a real event is logged on a real project.

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SRC = readFileSync(resolve(__dirname, '..', 'pages', 'ProjectDetail.jsx'), 'utf8')

describe('ProjectDetail — Phase B+ critter wiring (static)', () => {
  it('imports awardCritter from critterClient.js', () => {
    expect(SRC).toMatch(/import\s*\{\s*awardCritter\s*\}\s*from\s*['"]\.\.\/lib\/critterClient\.js['"]/)
  })

  it('destructures getToken from useApiFetch', () => {
    expect(SRC).toMatch(/const\s*\{\s*fetch\s*,\s*getToken\s*\}\s*=\s*useApiFetch\(\)/)
  })

  it('fires awardCritter() after successful event POST', () => {
    expect(SRC).toMatch(/awardCritter\(\s*\{\s*getToken\s*,\s*sourceEventId/)
  })

  it('guards the awardCritter call on a non-null event id (defensive against malformed POST response)', () => {
    expect(SRC).toMatch(/if\s*\(\s*newEventId\s*\)\s*\{[\s\S]*?awardCritter\(/)
  })
})
