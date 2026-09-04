import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { breedingNotice } from '../components/planting/SaveSeedSheet.jsx'

// V5-VARIETYHYBRIDFLAG-001 — binds the F1 warning's arms to the DB CHECK that defines the vocabulary.
//
// WHY THIS FILE EXISTS. breedingNotice's `default` arm returns null, which renders nothing. That is
// correct for NULL (never assessed, 404 of 483 live cultivars) and is the property the whole design
// rests on. But it also swallows any value added to the enum LATER: widen the CHECK, ship rows with
// the new value, and the warning silently declines to speak about them with nothing failing anywhere.
// The design text already shows how that happens — it describes an `f2_or_later` state that was never
// shipped, so a reader written from the design alone would have had a dead arm, and a reader written
// from prod alone would go quiet the day someone adds it.
//
// The migration DDL is the single source: it is where the vocabulary is DEFINED, and it is in the
// same repo as the reader, so this binding cannot drift the way a hand-copied list would.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const DDL_PATH = join(repoRoot, 'migrations', 'v5-varietyhybridflag-001', '0a-additive-ddl.sql')

// Strip SQL line comments BEFORE parsing. This is not hygiene, it is load-bearing: the ARRAY in the
// DDL carries a `--` comment that itself contains the literal 'open_pollinated' (explaining why
// landrace is separate from it). Parse the raw text and that comment donates a value, so the guard
// would appear to pass while reading prose rather than the enum — and would keep passing if the real
// literal were deleted.
function checkValues(sql) {
  const noComments = sql.replace(/--[^\n]*/g, '')
  const m = noComments.match(
    /CONSTRAINT\s+chk_plant_varieties_breeding_system[\s\S]*?ARRAY\s*\[([\s\S]*?)\]/i)
  expect(m, 'could not find the breeding_system CHECK ARRAY in the migration DDL').toBeTruthy()
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
}

describe('the F1 warning covers every breeding_system the schema allows', () => {
  const ddl = readFileSync(DDL_PATH, 'utf8')
  const VALUES = checkValues(ddl)

  it('parses a plausible enum out of the DDL rather than an empty set', () => {
    // Anti-vacuity. Every assertion below is a no-op over an empty list, so an extraction that
    // silently matched nothing would turn this whole file green while checking nothing at all.
    expect(VALUES.length).toBeGreaterThanOrEqual(4)
    expect(VALUES).toContain('f1')
    expect(VALUES).toContain('open_pollinated')
    expect(new Set(VALUES).size).toBe(VALUES.length)
  })

  it('did not harvest its values out of the DDL comments', () => {
    // The comment inside the ARRAY mentions 'open_pollinated'. If comment-stripping regressed, the
    // parsed list would gain a duplicate — caught above — but this pins the mechanism directly so a
    // future reader knows the stripping is deliberate.
    expect(ddl).toMatch(/--[^\n]*'open_pollinated'/)
    expect(checkValues(ddl).filter((v) => v === 'open_pollinated')).toHaveLength(1)
  })

  it('gives every allowed value an arm — no allowed value falls through to silence', () => {
    for (const v of VALUES) {
      const notice = breedingNotice({ breeding_system: v })
      expect(notice, `breeding_system '${v}' is allowed by the CHECK but breedingNotice says nothing about it`).toBeTruthy()
      expect(typeof notice.line, `'${v}' must carry a sentence`).toBe('string')
      expect(notice.line.length).toBeGreaterThan(20)
    }
  })

  it('stays silent for never-assessed, and for a value this build predates', () => {
    // The empty state, which is the design's important one.
    expect(breedingNotice({ breeding_system: null })).toBeNull()
    expect(breedingNotice({})).toBeNull()
    expect(breedingNotice(null)).toBeNull()
    expect(breedingNotice(undefined)).toBeNull()
    // Forward compatibility: an unknown future value must not throw or render a half-built notice.
    // It goes quiet, and the coverage test above is what makes that loud at the right moment.
    expect(breedingNotice({ breeding_system: 'f2_or_later' })).toBeNull()
  })

  it('fires the warn badge on exactly one value', () => {
    // "The only arm that fires" (design V101 §5). A second warn arm would start the wolf-crying the
    // design's whole credibility argument depends on avoiding.
    const warned = VALUES.filter((v) => breedingNotice({ breeding_system: v })?.tone === 'warn')
    expect(warned).toEqual(['f1'])
  })

  it('does not call saving F1 seed a mistake', () => {
    // Deliberate F2 growing-out is how dehybridizing starts. The copy names the consequence and the
    // alternative; it must not moralise.
    const line = breedingNotice({ breeding_system: 'f1' }).line.toLowerCase()
    expect(line).not.toMatch(/mistake|don't|do not save|shouldn't|avoid/)
    expect(line).toMatch(/vary|come true/)
  })

  it('does not claim open-pollinated seed comes true unconditionally', () => {
    // Breeding status and PURITY are different facts (design V101 §8) — an OP variety in a shared
    // pool still crosses. The hedge is the difference between a true statement and a wrong one.
    const line = breedingNotice({ breeding_system: 'open_pollinated' }).line.toLowerCase()
    expect(line).toMatch(/cross|isolat|nearby/)
  })

  it('open-pollinated is NOT silent — silence has to keep meaning "unknown"', () => {
    // If only F1 ever spoke, absence would mean both "checked, fine" and "never looked", and the
    // warning's absence would carry no information.
    expect(breedingNotice({ breeding_system: 'open_pollinated' })).toBeTruthy()
  })
})

describe('the notice renders from the variety being saved', () => {
  // Rendering breedingNotice's own output rather than mounting the whole sheet: the sheet needs a
  // router, a toast provider and a stubbed fetch, and none of that is what these assertions are
  // about. The sheet-level wiring (that it reads `variety` and not the `planting` prop) is covered
  // in SaveSeedSheet.test.jsx, where the fixtures already exist.
  const Notice = ({ v }) => {
    const n = breedingNotice(v)
    return n ? <div data-testid="breeding-notice">{n.badge ? <span>{n.badge}</span> : null}<span>{n.line}</span></div> : null
  }

  it('shows the hybrid badge for an F1', () => {
    render(<Notice v={{ breeding_system: 'f1' }} />)
    expect(screen.getByTestId('breeding-notice')).toBeTruthy()
    expect(screen.getByText('F1 hybrid')).toBeTruthy()
  })

  it('renders no element at all when the cultivar was never assessed', () => {
    const { container } = render(<Notice v={{ breeding_system: null }} />)
    expect(container.querySelector('[data-testid="breeding-notice"]')).toBeNull()
    // Not merely empty — absent. A reserved empty box is the thing the design ruled out.
    expect(container.textContent).toBe('')
  })
})
