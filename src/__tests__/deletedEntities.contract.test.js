// V4-RESTORESURFACE-001 — the same contract deletedPhotos.contract.test.js enforces, for the four
// non-photo entity types.
//
// WHY THIS EXISTS, in the words of the file it mirrors: a component and its test once each declared
// the same private route literal, so the UI shipped pointing at an endpoint the server does not
// serve — with 33 tests green, because the test was asserting the component's own typo back at
// itself. A literal that appears twice is not a contract; it is two guesses that happen to agree.
//
// So this test asserts the descriptors in src/lib/deletedEntities.js against TWO surfaces it does
// not write: the real route matchers in the four Lambda sources, and the real prefix table in
// src/lib/api.js. Agreement between those and the descriptors cannot be self-fulfilling.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DELETED_ENTITY_KINDS, rowsFromResponse } from '../lib/deletedEntities.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(__dirname, rel), 'utf8')
const SRC = {
  projects: read('../../lambda/projects/index.js'),
  plants: read('../../lambda/plants/index.js'),
  locations: read('../../lambda/locations/index.js'),
  varieties: read('../../lambda/varieties/index.js'),
}
const API_SRC = read('../lib/api.js')

const UUID = '11111111-1111-4111-8111-111111111111'

describe('V4-RESTORESURFACE-001 — the deleted/restore paths are served by the Lambdas', () => {
  for (const kind of DELETED_ENTITY_KINDS) {
    it(`${kind.key}: the Lambda declares an exact-match route for ${kind.listPath}`, () => {
      // The handler tests this with `rawPath === '<path>'`, so the literal must be present verbatim.
      expect(SRC[kind.key]).toContain(`rawPath === '${kind.listPath}'`)
    })

    it(`${kind.key}: /deleted is EXCLUDED from the by-id matcher`, () => {
      // The hazard this whole surface sits on: `/api/<x>/deleted` is a single trailing segment, so a
      // bare-:id matcher captures it and answers 404 from the by-id GET. Every one of the four
      // Lambdas has to opt it out explicitly.
      expect(SRC[kind.key], `${kind.key} would parse "deleted" as an id`)
        .toContain(`rawPath !== '${kind.listPath}'`)
    })

    it(`${kind.key}: the Lambda declares a :id/restore matcher`, () => {
      const seg = kind.listPath.replace('/deleted', '')
      // The Lambda source spells it `/^\/api\/<x>\/([^/]+)\/restore$/` — single backslashes.
      const escaped = seg.replace(/\//g, '\\/')
      expect(SRC[kind.key]).toContain(`${escaped}\\/([^/]+)\\/restore$`)
    })

    it(`${kind.key}: both paths resolve through api.js's prefix table`, () => {
      // resolveUrl matches on prefix, so the entity's base path must be a key there or the request
      // goes nowhere.
      const prefix = kind.listPath.replace('/deleted', '')
      expect(API_SRC).toContain(`'${prefix}':`)
      expect(kind.restorePath(UUID)).toBe(`${prefix}/${UUID}/restore`)
      expect(kind.restorePath(UUID).startsWith(prefix)).toBe(true)
    })
  }

  it('containers are listed FIRST — restoring one unblocks the plantings inside it', () => {
    // Not cosmetic. Every container-reaching read in lambda/plants requires the container to be
    // live (the F4 gate), so a planting under a deleted container is invisible to the plantings
    // list until the container is restored. Ordering the sections container-first means a user
    // working top-to-bottom hits the unblocking action before the blocked one.
    expect(DELETED_ENTITY_KINDS[0].key).toBe('projects')
    expect(DELETED_ENTITY_KINDS.find((k) => k.key === 'projects').invalidatePrefixes)
      .toContain('/api/plants')
  })

  it('every kind has a distinct key, label, list path and response key', () => {
    for (const field of ['key', 'label', 'listPath', 'responseKey']) {
      const values = DELETED_ENTITY_KINDS.map((k) => k[field])
      expect(new Set(values).size, `duplicate ${field} across kinds`).toBe(values.length)
    }
  })

  it('rowsFromResponse tolerates a missing or malformed key rather than throwing', () => {
    // One entity type failing to load must not blank the other three — the same reasoning the page
    // uses to keep load and restore errors apart.
    const kind = DELETED_ENTITY_KINDS[0]
    expect(rowsFromResponse(kind, undefined)).toEqual([])
    expect(rowsFromResponse(kind, {})).toEqual([])
    expect(rowsFromResponse(kind, { [kind.responseKey]: null })).toEqual([])
    expect(rowsFromResponse(kind, { [kind.responseKey]: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
  })

  it('no kind exposes a permanent-delete verb', () => {
    // Soft-Delete-Only, visibly. The only action on this surface is Restore, and that is a rule
    // rather than an omission to be tidied up later.
    for (const kind of DELETED_ENTITY_KINDS) {
      expect(Object.keys(kind).join(' ')).not.toMatch(/purge|permanent|hardDelete/i)
    }
  })
})
