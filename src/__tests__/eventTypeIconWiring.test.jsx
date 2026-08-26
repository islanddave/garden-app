// V4-ICON-001 — event-type glyphs come from the icon registry, and ONLY from it.
//
// This slice deleted the `emoji` field from EVENT_TYPE_META (51) and EVENT_TYPES_UI (7). Nothing
// rendered those literals by the time they were removed — every surface already drew
// <Icon name={`event.${value}`} /> — so the risk this file guards is not a broken render, it is
// SILENT RE-GROWTH: a future edit adding `emoji:` back to a record, where it would sit unrendered
// and drift away from the SVG until someone wires it up and ships two different glyphs for one
// event type. The runtime arms assert the field is ABSENT rather than merely unused, because
// "unused" is exactly the state it was in for months without anyone noticing.
//
// SCOPE NOTE — the static arm covers eventTypes.js + EventTypePicker.jsx only, deliberately.
// pages/EventNew.jsx still contains two READS of the now-absent field (`eventEmoji:` in the
// confirmation payload, and `{eventMeta?.emoji ?? …}` inside the unreferenced SuccessScreen).
// Both are dead — PostSaveFeedback renders no emoji, and SuccessScreen is never mounted — and
// both are `?? `-guarded, so they degrade to their fallback rather than throwing. That file is
// owned by a concurrent lane; the reads are a hand-off, not a gap in this guard.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_TYPES, EVENT_TYPE_META, REQUIRED_META_FIELDS, buildSecondaryGroups } from '../lib/eventTypes.js'
import { GLYPHS, getIcon, isSvg, NEUTRAL_ICON } from '../lib/iconRegistry.js'
// The picker's `available` default — SELECTABLE_EVENT_TYPES, not EVENT_TYPES. The two
// plant-reduction types are creatable-excluded, so they never reach the "More" panel.
import { SELECTABLE_EVENT_TYPES } from '../lib/constants.js'
import EventTypePicker, { EVENT_TYPES_UI } from '../components/forms/EventTypePicker.jsx'

// Pictographic ranges, matching the census used to size this slice. Variation selectors and
// arrows are excluded: U+FE0F double-counts a glyph already matched, and `→` is prose.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/u

const isCommentLine = (line) => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
}
const codeOf = (src) => src.split('\n').filter((l) => !isCommentLine(l)).join('\n')
const readCode = (rel) => codeOf(readFileSync(join(process.cwd(), 'src', rel), 'utf8'))

// getByRole's `name` option compares the computed accessible name VERBATIM — it does not collapse
// whitespace — and two quick-pick labels carry a hard '\n' (rendered via white-space: pre-line).
// A plain string matcher silently misses those two, so normalize both sides.
const named = (label) => (accessibleName) =>
  accessibleName.replace(/\s+/g, ' ').trim() === label.replace(/\s+/g, ' ').trim()

describe('every event type resolves to a registry glyph', () => {
  it('EVENT_TYPES and the event.* registry keys are exactly 1:1', () => {
    const registryKeys = Object.keys(GLYPHS).filter((k) => k.startsWith('event.')).map((k) => k.slice(6))
    expect(registryKeys.sort()).toEqual([...EVENT_TYPES].sort())
  })

  it('no event type falls through to the neutral fallback', () => {
    // Instrument check FIRST. This arm can only ever fail if NEUTRAL_ICON is genuinely what an
    // unknown key returns — a registry that started throwing, or one whose fallback identity
    // changed, would make the 51 assertions below pass vacuously forever.
    expect(getIcon('event.__no_such_type__')).toBe(NEUTRAL_ICON)
    for (const t of EVENT_TYPES) {
      // getIcon never throws — it returns NEUTRAL_ICON. Identity comparison is the ONLY way to
      // tell "drawn" from "silently missing"; a truthiness check passes for both.
      expect(getIcon(`event.${t}`), `event.${t} fell back to NEUTRAL_ICON`).not.toBe(NEUTRAL_ICON)
      expect(isSvg(GLYPHS[`event.${t}`]), `event.${t} has no svg24/svg18 pair`).toBe(true)
    }
  })

  it('every event glyph carries an accessible name matching its META label', () => {
    for (const t of EVENT_TYPES) {
      expect(GLYPHS[`event.${t}`].accessibleName, `event.${t} has no accessibleName`).toBeTruthy()
      expect(GLYPHS[`event.${t}`].accessibleName).toBe(EVENT_TYPE_META[t].label)
    }
  })

  it('no two event types share a glyph shape', () => {
    const shapes = EVENT_TYPES.map((t) => GLYPHS[`event.${t}`].svg24)
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})

describe('the emoji field is gone and stays gone', () => {
  it('no EVENT_TYPE_META record carries an emoji field', () => {
    for (const t of EVENT_TYPES) {
      expect(EVENT_TYPE_META[t], `${t} re-grew an emoji field`).not.toHaveProperty('emoji')
    }
  })

  it('emoji is not a required META field', () => {
    expect(REQUIRED_META_FIELDS).toEqual(['label', 'category'])
  })

  it('no EVENT_TYPES_UI quick-pick carries an emoji field', () => {
    for (const t of EVENT_TYPES_UI) {
      expect(t, `${t.value} re-grew an emoji field`).not.toHaveProperty('emoji')
    }
  })

  it('no buildSecondaryGroups record carries an emoji field', () => {
    for (const [, types] of buildSecondaryGroups([])) {
      for (const t of types) expect(t, `${t.value} re-grew an emoji field`).not.toHaveProperty('emoji')
    }
  })

  // Static arm: the runtime arms above only see the SHAPE of a record. A stray emoji reintroduced
  // in a fallback expression, a template string, or a comment-free code path would pass them.
  it('eventTypes.js and EventTypePicker.jsx hold no emoji literal in live code', () => {
    for (const f of ['lib/eventTypes.js', 'components/forms/EventTypePicker.jsx']) {
      const offending = readCode(f).split('\n').filter((l) => EMOJI_RE.test(l))
      expect(offending, `${f}: ${offending.join(' | ')}`).toEqual([])
    }
  })

  it('eventTypes.js and EventTypePicker.jsx never name the emoji field in live code', () => {
    for (const f of ['lib/eventTypes.js', 'components/forms/EventTypePicker.jsx']) {
      expect(/\bemoji\b/.test(readCode(f)), `${f} names the emoji field`).toBe(false)
    }
  })
})

describe('EventTypePicker renders SVG, not emoji', () => {
  const renderPicker = () => render(<EventTypePicker value="" onChange={() => {}} />)

  it('renders one inline svg per primary quick-pick tile', () => {
    const { container } = renderPicker()
    expect(container.querySelectorAll('svg').length).toBe(EVENT_TYPES_UI.length)
  })

  it('every rendered svg has real path markup, not an empty shell', () => {
    const { container } = renderPicker()
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.innerHTML.length, 'empty glyph').toBeGreaterThan(0)
    }
  })

  it('the rendered picker contains no emoji character at all', () => {
    const { container } = renderPicker()
    expect(EMOJI_RE.test(container.textContent), container.textContent).toBe(false)
  })

  it('each tile is named by its visible label, and its glyph is hidden from AT', () => {
    const { container } = renderPicker()
    // The glyph is redundant with the label sitting directly beneath it in the same button, so
    // Icon is passed `decorative` — aria-hidden. The BUTTON carries the accessible name; a
    // second name on the svg would double-announce every tile.
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('aria-label')).toBeNull()
    }
    for (const t of EVENT_TYPES_UI) {
      expect(screen.getByRole('button', { name: named(t.label) }), t.value).toBeDefined()
    }
  })

  it('secondary "More" tiles are named too, once revealed', () => {
    const { container } = renderPicker()
    fireEvent.click(screen.getByText('More event types'))
    const flat = buildSecondaryGroups(
      new Set(EVENT_TYPES_UI.map((t) => t.value)), SELECTABLE_EVENT_TYPES,
    ).flatMap(([, ts]) => ts)
    expect(flat.length).toBeGreaterThan(0)
    for (const t of flat) {
      expect(screen.getByRole('button', { name: named(t.label) }), t.value).toBeDefined()
    }
    expect(EMOJI_RE.test(container.textContent), container.textContent).toBe(false)
  })
})
