// iconWire4.test.jsx — V4-ICON-001, fourth wiring slice: the four data maps whose emoji were
// blocked on a consumer, plus the two consumers that were blocking them.
//
// WHAT THIS FILE PINS, and why each arm is separate:
//
//   1. THE EMOJI ARE GONE. eslint's designsys rule visits JSXText and literal JSX attributes only,
//      so a glyph living in a plain `icon:` / `emoji:` / `drops:` object field in a .js data module
//      was never reachable by it. A static codepoint scan is the only thing that sees these.
//
//   2. EVERY KEY RESOLVES. getIcon() returns NEUTRAL_ICON rather than throwing (§15), so a typo
//      renders a small grey dot and ships looking deliberate. The scan matches BOTH quote styles
//      because this slice genuinely uses both: single-quoted object fields in the data maps
//      (iconName: 'event.cover') and double-quoted JSX attributes in the components
//      (name="action.check"). A single-quote-only version of this scan shipped once already and
//      let a double-quoted attribute typo through.
//
//   3. THE FIELD MOVED, NOT JUST THE CHARACTER. Renaming `icon`->`iconName` without moving the
//      consumer in the same commit renders NOTHING AT ALL, silently — it does not degrade. So each
//      map is asserted against its consumer's actual output, not just against its own source text.
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { GLYPHS, NEUTRAL_ICON, getIcon } from '../lib/iconRegistry.js'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'
import WaterDepthChips, { WaterDepthDrops } from '../components/WaterDepthChips.jsx'
import LifeStoryTimeline from '../components/planting/LifeStoryTimeline.jsx'
import { OVERWINTER_REGIME_OPTIONS } from '../lib/overwinterRegimes.js'
import { INVENTORY_TYPES } from '../lib/inventoryEnums.js'
import { WATER_DEPTH_CHIPS } from '../lib/waterDepth.js'
import { buildLifeStory } from '../lib/lifeStory.js'
import { EVENT_TYPES } from '../lib/eventTypes.js'

// cwd-relative, not import.meta.url: under vitest the module URL is an http: one and
// fileURLToPath rejects it. Same convention as iconWire2/3.
const src = (rel) => readFileSync(resolve(process.cwd(), 'src', rel), 'utf8')

const WIRED = [
  'components/forms/ChoiceGrid.jsx',
  'lib/overwinterRegimes.js',
  'lib/inventoryEnums.js',
  'lib/waterDepth.js',
  'components/WaterDepthChips.jsx',
  'lib/lifeStory.js',
  'components/planting/LifeStoryTimeline.jsx',
]

const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu
const ESCAPED_PICTOGRAPHIC = /\\u\{1F[0-9A-Fa-f]{3}\}|\\u2[6-7][0-9A-Fa-f]{2}/g

// Registry-key-shaped literals in BOTH quote styles. `inventory` is in the alternation because
// this slice ADDED that family — a scan copied forward from slice 3 would silently skip every new
// key, which is the precise shape of a guard that passes over the thing it was written for.
const KEY_RE = /['"]((?:action|care|event|facet|inventory|lifecycle|media|mode|nav|severity|status)\.[A-Za-z][A-Za-z0-9_]*)['"]/g
const keysIn = (rel) => [...new Set([...src(rel).matchAll(KEY_RE)].map(m => m[1]))]

describe('V4-ICON-001 slice 4 — the wired files carry no pictographic characters', () => {
  it.each(WIRED)('%s has no emoji left', (rel) => {
    expect(src(rel).match(PICTOGRAPHIC) ?? []).toEqual([])
  })

  it.each(WIRED)('%s has no escaped emoji either', (rel) => {
    expect(src(rel).match(ESCAPED_PICTOGRAPHIC) ?? []).toEqual([])
  })

  it('the scanner actually matches emoji (this file is not passing on a dead regex)', () => {
    // Codepoint escapes, not literals: this file scans for emoji, so it must not contain any.
    expect('\u{1F9C4}'.match(PICTOGRAPHIC)).toHaveLength(1)  // garlic, the 1F300-1FAFF arm
    expect('\u2713'.match(PICTOGRAPHIC)).toHaveLength(1)     // check mark, the 2600-27BF arm
    expect("icon: '\\u{1F4A7}'".match(ESCAPED_PICTOGRAPHIC)).toHaveLength(1)
    expect('plain text'.match(PICTOGRAPHIC)).toBeNull()
  })

  it('the old field shapes are gone by NAME, not just by character', () => {
    // A glyph-bearing `icon:`/`emoji:` string literal is what this slice removed. ChoiceGrid still
    // accepts an `icon` NODE (AddSeeds passes <Icon> elements), so the assertion is scoped to the
    // two data maps, where the field held a string.
    expect(src('lib/overwinterRegimes.js')).not.toMatch(/\bicon:\s*['"]/)
    expect(src('lib/inventoryEnums.js')).not.toMatch(/\bemoji\s*:/)
    expect(src('lib/overwinterRegimes.js')).toContain("iconName: 'event.cover'")
    expect(src('lib/inventoryEnums.js')).toContain("iconName: 'inventory.durable'")
  })

  it('the consumer moved in the same commit as the map it renders', () => {
    // The failure this guards is silent: InventoryAdd maps the option list field-by-field, so a
    // renamed field with an un-updated map yields `iconName: undefined` and draws nothing at all.
    expect(src('pages/InventoryAdd.jsx')).toMatch(/iconName:\s*t\.iconName/)
    expect(src('pages/InventoryAdd.jsx')).not.toMatch(/icon:\s*t\.emoji/)
    expect(src('components/forms/ChoiceGrid.jsx')).toMatch(/o\.iconName/)
  })
})

describe('V4-ICON-001 slice 4 — every registry key named in the wired files resolves', () => {
  it('the scan found keys at all (guards the whole describe from going vacuous)', () => {
    expect(WIRED.flatMap(keysIn).length).toBeGreaterThanOrEqual(6)
  })

  it('the scan sees BOTH quote styles', () => {
    // Asserted on literal samples so it holds even if a future edit normalizes every quote in the
    // lane's files to one style — the point is the regex, not today's source.
    expect([...'<Icon name="action.check" />'.matchAll(KEY_RE)].map(m => m[1])).toEqual(['action.check'])
    expect([..."iconName: 'event.cover'".matchAll(KEY_RE)].map(m => m[1])).toEqual(['event.cover'])
    // And that both styles are really present in the lane, not just supported in theory.
    expect(keysIn('components/forms/ChoiceGrid.jsx')).toContain('action.check')
    expect(keysIn('lib/overwinterRegimes.js')).toContain('care.inground')
  })

  it.each(WIRED)('%s names only real registry entries', (rel) => {
    const missing = keysIn(rel).filter(k => getIcon(k) === NEUTRAL_ICON)
    expect(missing, `${rel} would render the silent neutral dot for these`).toEqual([])
  })

  it('every key reachable from the two data maps resolves', () => {
    for (const k of [...OVERWINTER_REGIME_OPTIONS, ...INVENTORY_TYPES].map(o => o.iconName)) {
      expect(k, 'an option lost its iconName entirely').toBeTruthy()
      expect(getIcon(k), `${k} falls back to the neutral dot`).not.toBe(NEUTRAL_ICON)
    }
  })

  it('the two glyphs this slice DREW are in the registry and are distinct', () => {
    for (const k of ['inventory.consumable', 'inventory.durable']) {
      expect(GLYPHS[k], `${k} missing from the registry`).toBeTruthy()
      expect(GLYPHS[k].svg24, `${k} has no 24 master`).toBeTruthy()
      expect(GLYPHS[k].svg18, `${k} has no 18 master`).toBeTruthy()
    }
    expect(GLYPHS['inventory.consumable'].svg24).not.toBe(GLYPHS['inventory.durable'].svg24)
  })
})

// ── Render arms ──────────────────────────────────────────────────────────────────────────────
// The registry authors self-closing markup; the DOM serializes open/close pairs. Round-tripping
// the registry string through the parser makes both sides comparable.
const parsed = (markup) => {
  const host = document.createElement('div')
  host.innerHTML = `<svg>${markup}</svg>`
  return host.firstChild.innerHTML
}
const isNeutral = (svg) =>
  svg.innerHTML === parsed(NEUTRAL_ICON.svg24) || svg.innerHTML === parsed(NEUTRAL_ICON.svg18)

describe('V4-ICON-001 slice 4 — ChoiceGrid resolves a key instead of interpolating a glyph', () => {
  afterEach(cleanup)

  it('an iconName option draws that key\'s authored shape, never the neutral dot', () => {
    render(<ChoiceGrid layout="grid" ariaLabel="Type" value="consumable" onChange={() => {}}
      options={INVENTORY_TYPES.map(t => ({ value: t.value, label: t.label, iconName: t.iconName }))} />)
    for (const t of INVENTORY_TYPES) {
      const svg = screen.getByText(t.label).closest('button').querySelector('svg')
      expect(svg, `${t.label} renders no icon`).toBeTruthy()
      expect(isNeutral(svg), `${t.label} fell back to the neutral dot`).toBe(false)
      // size 28 -> the 24 master (Icon.jsx crosses over at 21).
      expect(svg.innerHTML).toBe(parsed(GLYPHS[t.iconName].svg24))
    }
  })

  it('the four overwinter regimes draw four DIFFERENT marks, each beside its own text', () => {
    render(<ChoiceGrid layout="list" ariaLabel="Overwinter" value={null} onChange={() => {}}
      options={OVERWINTER_REGIME_OPTIONS} />)
    const shapes = OVERWINTER_REGIME_OPTIONS.map((o) => {
      const btn = screen.getByText(o.label).closest('button')
      const svg = btn.querySelector('svg')
      expect(isNeutral(svg), `${o.value} fell back to the neutral dot`).toBe(false)
      // Never mark-alone: the label and the drying-interval description ride with the glyph.
      expect(btn.textContent).toContain(o.label)
      expect(btn.textContent).toContain(o.description)
      return svg.innerHTML
    })
    expect(new Set(shapes).size, 'two regimes render the same mark').toBe(4)
  })

  it('renders no pictographic character, and really did render icons', () => {
    const { container } = render(<ChoiceGrid layout="list" ariaLabel="Overwinter"
      value="field_hardy" onChange={() => {}} options={OVERWINTER_REGIME_OPTIONS} />)
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
    // Non-vacuity: 4 regime marks + the selected row's check.
    expect(container.querySelectorAll('svg').length).toBe(5)
  })

  it('the selected-row check is the registry mark, not a literal character', () => {
    render(<ChoiceGrid layout="list" ariaLabel="Overwinter" value="field_hardy" onChange={() => {}}
      options={OVERWINTER_REGIME_OPTIONS} />)
    const btn = screen.getByText('Hardy, out in the ground').closest('button')
    const svgs = [...btn.querySelectorAll('svg')]
    expect(svgs).toHaveLength(2)                                  // regime mark + check
    expect(svgs[1].innerHTML).toBe(parsed(GLYPHS['action.check'].svg24))
  })

  it('the legacy `icon` node path still works (AddSeeds passes ready-made elements)', () => {
    // Both paths are live; this is not a migration remnant, and dropping it would break a page
    // outside this lane. Asserted with a node, which is what AddSeeds actually passes.
    render(<ChoiceGrid layout="grid" ariaLabel="Mode" value="photo" onChange={() => {}}
      options={[{ value: 'photo', label: 'Photo', icon: <svg data-testid="legacy-node" /> }]} />)
    expect(screen.getByTestId('legacy-node')).toBeTruthy()
  })

  it('an option with neither field renders no icon slot at all', () => {
    const { container } = render(<ChoiceGrid layout="grid" ariaLabel="Bare" value="a"
      onChange={() => {}} options={[{ value: 'a', label: 'Bare' }]} />)
    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })
})

describe('V4-ICON-001 slice 4 — the water-depth tier stays a COUNT, not a colour', () => {
  afterEach(cleanup)

  it('each chip draws exactly its own number of drops', () => {
    const { container } = render(<WaterDepthChips value="normal" onChange={() => {}} />)
    for (const chip of WATER_DEPTH_CHIPS) {
      const drops = screen.getByTestId(`water-depth-${chip.value}`).querySelectorAll('svg')
      expect(drops, `${chip.value} drew ${drops.length} drops, expected ${chip.dropCount}`)
        .toHaveLength(chip.dropCount)
    }
    // The ladder is monotonic and non-degenerate — 1 < 2 < 3, so the tiers are countable apart.
    expect(WATER_DEPTH_CHIPS.map(c => c.dropCount)).toEqual([1, 2, 3])
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
  })

  it('the drops are the FILLED master, so they survive at chip size', () => {
    // The base care.drop is an outline whose counter closes under ~14px; the filled variant is what
    // keeps the count countable. Asserting the actual markup, because a silent fall back to the
    // base would still render three somethings and still pass a count-only test.
    render(<WaterDepthChips value="deep" onChange={() => {}} />)
    const drop = screen.getByTestId('water-depth-deep').querySelector('svg')
    expect(drop.innerHTML).toBe(parsed(GLYPHS['care.drop'].variants.filled.svg18))
    expect(drop.innerHTML).not.toBe(parsed(GLYPHS['care.drop'].svg18))
  })

  it('every chip keeps its text label, so the tier never reads by mark alone', () => {
    render(<WaterDepthChips value="light" onChange={() => {}} />)
    for (const chip of WATER_DEPTH_CHIPS) {
      const btn = screen.getByTestId(`water-depth-${chip.value}`)
      expect(btn.textContent).toContain(chip.label)
      expect(btn.textContent).toContain(chip.anchor)
      // The accessible name carries the anchor too — the drops are aria-hidden by design.
      expect(btn.getAttribute('aria-label')).toContain(chip.label)
    }
  })

  it('LogMany\'s compact row chip moved in the same commit (the SECOND consumer)', () => {
    // The sibling lane's census named WaterDepthChips as the SOLE consumer of this field. It is
    // not: LogMany's per-row override chip reads it too, and would have rendered nothing at all.
    const logMany = src('pages/LogMany.jsx')
    expect(logMany).not.toMatch(/chip\?\.drops\b/)
    expect(logMany).toMatch(/<WaterDepthDrops\s+count=/)
    expect(logMany).toMatch(/WaterDepthChips\.jsx/)
  })

  it('WaterDepthDrops renders nothing for a missing count rather than throwing', () => {
    // LogMany can reach it with an unrecognised stored class, where find() yields undefined.
    const { container } = render(<WaterDepthDrops count={undefined} />)
    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })
})

describe('V4-ICON-001 slice 4 — the life-story timeline, and the planted_out decision', () => {
  afterEach(cleanup)

  // Every milestone dated, so all five rows render and the adjacency under test is real.
  const FULL = {
    sown_at: '2026-02-01', germinated_at: '2026-02-10', transplanted_at: '2026-04-15',
    planted_out_at: '2026-05-20', first_harvest_at: '2026-06-30',
  }
  const rowSvg = (label) => screen.getByText(label).closest('li').querySelector('svg')

  it('every milestone draws its own authored shape, never the neutral dot', () => {
    const { container } = render(<LifeStoryTimeline planting={FULL} />)
    expect(container.querySelectorAll('li')).toHaveLength(5)
    for (const r of buildLifeStory(FULL)) {
      const svg = rowSvg(r.label)
      expect(svg, `${r.key} renders no icon`).toBeTruthy()
      expect(isNeutral(svg), `${r.key} fell back to the neutral dot`).toBe(false)
      // size 22 -> the 24 master.
      expect(svg.innerHTML).toBe(parsed(GLYPHS[r.iconName].svg24))
    }
  })

  it('THE DESIGN CALL: planted_out is NOT the transplant mark, and they are adjacent', () => {
    render(<LifeStoryTimeline planting={FULL} />)
    const rows = buildLifeStory(FULL).map(r => r.key)
    // The whole reason a glyph was drawn: these two are neighbours in the rendered order, so a
    // reuse would put two identical marks in consecutive rows.
    expect(rows.indexOf('planted_out')).toBe(rows.indexOf('transplanted') + 1)
    expect(rowSvg('Planted out').innerHTML).not.toBe(rowSvg('Transplanted').innerHTML)
    expect(rowSvg('Planted out').innerHTML).toBe(parsed(GLYPHS['care.plantedOut'].svg24))
  })

  it('all five milestones are five DIFFERENT marks', () => {
    render(<LifeStoryTimeline planting={FULL} />)
    const shapes = buildLifeStory(FULL).map(r => rowSvg(r.label).innerHTML)
    expect(new Set(shapes).size, 'two milestones render the same mark').toBe(5)
  })

  it('every row keeps its label and date beside the mark, and no emoji survives', () => {
    const { container } = render(<LifeStoryTimeline planting={FULL} />)
    for (const r of buildLifeStory(FULL)) {
      expect(screen.getByText(r.label)).toBeTruthy()
    }
    expect(container.textContent.match(PICTOGRAPHIC)).toBeNull()
  })

  it('care.plantedOut could not have been an event.* key (the gate that forced care.*)', () => {
    // Recorded as an assertion, not just a comment: eventTypeIconWiring.test.js holds event.* and
    // EVENT_TYPES at exactly 1:1, so `planted_out` — a date field, not an event type — has no
    // event.* slot available. If that ever changes, this test is the reminder to revisit the name.
    expect(EVENT_TYPES).not.toContain('planted_out')
    expect(getIcon('event.planted_out')).toBe(NEUTRAL_ICON)
    expect(GLYPHS['care.plantedOut']).toBeTruthy()
  })
})
