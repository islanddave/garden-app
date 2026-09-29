/**
 * stats-kit registry + verdicts, against the v1 contract fixture (tests/fixtures/season-stats.v1.json).
 * The fixture is the source of truth for section ids and shapes (plan D4); a section id the server
 * sends that this client cannot draw is a silent hole on the page, so every fixture id must resolve.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STATS_REGISTRY, STATS_SECTION_ORDER, getRenderer, drawableSectionIds, seasonHasPicks } from '../lib/stats-kit/registry.js'
import { verdictFor, limitLines, limitsText } from '../lib/stats-kit/verdicts.js'
import { buildEnvelope, SECTION_IDS } from '../../lambda/harvests/season-stats-sections.js'

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/season-stats.v1.json'), 'utf8'))
const ids = Object.keys(fixture.sections)
const STATUS_WORDS = /\b(failed|failure|dead|died|harvested|ended)\b/i

describe('registry', () => {
  it('SELF-TEST: the fixture carries the eight sections of the plan', () => {
    expect(ids.sort()).toEqual(['heat_clock', 'heat_ladder', 'longest', 'ribbon', 'seed_lots', 'sep_size', 'sources', 'tomato_keep'])
  })

  // KILLING MUTATION: delete any registry entry. RESULT: RED.
  it('every fixture section id has a renderer with a title, a Body and a table builder', () => {
    for (const id of ids) {
      const r = getRenderer(id)
      expect(r, id).not.toBeNull()
      expect(typeof r.title, id).toBe('string')
      expect(typeof r.Body, id).toBe('function')
      expect(typeof r.table, id).toBe('function')
    }
  })

  it('the page order is exactly the registry, and the fixture draws in that order', () => {
    expect([...STATS_SECTION_ORDER].sort()).toEqual(Object.keys(STATS_REGISTRY).sort())
    expect(drawableSectionIds(fixture)).toEqual(STATS_SECTION_ORDER)
  })

  it('an unknown id renders nothing, and prototype keys are not renderers', () => {
    expect(getRenderer('frost_race')).toBeNull()
    expect(getRenderer('constructor')).toBeNull()
    expect(getRenderer('__proto__')).toBeNull()
    const withExtra = { ...fixture, sections: { ...fixture.sections, frost_race: { section: 'frost_race', meta: {}, series: {} } } }
    expect(drawableSectionIds(withExtra)).toEqual(STATS_SECTION_ORDER)
  })

  it('a missing section is skipped; a junk envelope draws nothing', () => {
    const { longest, ...rest } = fixture.sections
    void longest
    expect(drawableSectionIds({ ...fixture, sections: rest })).toEqual(STATS_SECTION_ORDER.filter(id => id !== 'longest'))
    expect(drawableSectionIds(null)).toEqual([])
    expect(drawableSectionIds({ sections: null })).toEqual([])
    expect(drawableSectionIds({ sections: { ribbon: null } })).toEqual([])
  })

  it('every table builder returns rows for the fixture, with one cell per column', () => {
    for (const id of ids) {
      const t = getRenderer(id).table(fixture.sections[id])
      const tables = Array.isArray(t) ? t : [t]
      for (const one of tables) {
        expect(one.rows.length, id).toBeGreaterThan(0)
        for (const row of one.rows) expect(row, id).toHaveLength(one.columns.length)
        for (const row of one.rows) for (const cell of row) expect(String(cell), id).not.toMatch(/NaN|undefined|null/)
      }
    }
  })

  it('table builders survive an empty section', () => {
    for (const id of ids) expect(() => getRenderer(id).table({}), id).not.toThrow()
  })
})

describe('verdicts', () => {
  it('every fixture section gets a verdict sentence in plain words', () => {
    for (const id of ids) {
      const s = verdictFor(id, fixture.sections[id])
      expect(s.length, id).toBeGreaterThan(20)
      expect(s, id).not.toMatch(/NaN|undefined|null/)
      expect(s, id).not.toMatch(STATUS_WORDS)
    }
  })

  // KILLING MUTATION: drop a LIMIT_TEXT entry. RESULT: RED — the fixture's code would vanish silently.
  it('every limit code in the fixture has a sentence', () => {
    for (const id of ids) {
      const codes = fixture.sections[id].meta.limits.map(l => l.code)
      expect(limitLines(fixture.sections[id]), `${id}: ${codes}`).toHaveLength(codes.length)
      expect(limitsText(fixture.sections[id]), id).not.toMatch(STATUS_WORDS)
    }
  })

  it('limit sentences carry their numbers', () => {
    expect(limitsText(fixture.sections.sources)).toContain('187.1 lb')
    expect(limitsText(fixture.sections.tomato_keep)).toContain('70%')
    expect(limitsText(fixture.sections.sep_size)).toContain('at least 5 fruit')
    expect(limitsText(fixture.sections.ribbon)).toContain('May 10')
  })

  it('an unknown limit code is left out, never shown raw', () => {
    expect(limitLines({ meta: { limits: [{ code: 'mystery_code' }, { code: 'so_far' }] } })).toHaveLength(1)
    expect(limitsText({ meta: { limits: [{ code: 'mystery_code' }] } })).toBe('')
  })

  it('verdicts read the fixture numbers', () => {
    expect(verdictFor('ribbon', fixture.sections.ribbon)).toContain('Jul 2 at 96°F')
    expect(verdictFor('sources', fixture.sections.sources)).toMatch(/^Starview Gardens gave the most: 154\.3 lb from 46 plantings \(34% of 449\.6 lb\)/)
    expect(verdictFor('heat_clock', fixture.sections.heat_clock)).toContain('the typical tomato took 1,151 heat units and the typical pepper 1,184.')
    expect(verdictFor('tomato_keep', fixture.sections.tomato_keep)).toContain('The typical single tomato plant gave 2.05 lb')
    expect(verdictFor('sep_size', fixture.sections.sep_size)).toContain('about 24% lighter overall (Ukrainian Purple 114 g → 75 g)')
  })

  it('the real empty-season envelope: nothing drawable, no verdicts, no limit line with a hole in it', () => {
    const env = buildEnvelope({ year: 2027, sections: SECTION_IDS, results: {}, generatedAt: '2026-11-02T12:00:00Z' })
    expect(drawableSectionIds(env)).toEqual([])
    expect(seasonHasPicks(env)).toBe(false)
    expect(seasonHasPicks(fixture)).toBe(true)
    for (const id of SECTION_IDS) {
      expect(verdictFor(id, env.sections[id]), id).toBe('')
      const lim = limitsText(env.sections[id])
      expect(lim, id).not.toMatch(/start ,|0\.0 lb|NaN|undefined|null/)
    }
    // Weather but no care and no picks: no "most common care, on 0 days".
    const ribbon = { ...env.sections.ribbon, series: { days: [{ date: '2026-11-02', tmax_f: 50, tmin_f: 30, precip_in: 0, care: [] }], weeks: [] } }
    expect(verdictFor('ribbon', ribbon)).not.toMatch(/0 days/)
  })

  it('an unknown id or an empty section gets no verdict and does not throw', () => {
    expect(verdictFor('frost_race', {})).toBe('')
    for (const id of ids) expect(() => verdictFor(id, { meta: {}, series: {} }), id).not.toThrow()
  })
})
