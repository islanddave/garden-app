// V4-EVENTSEL-005 — Log Many and Log Event share ONE form scaffold.
//
// Two things are pinned here, and they fail for different reasons:
//
//   (1) The section CARD is single-sourced. Before this row, `function Section` was declared
//       privately in BOTH src/pages/LogMany.jsx and src/pages/EventNew.jsx, byte-equivalent in
//       behavior, and V4-EVENTSEL-004 had hand-matched them with a comment saying so. Two copies
//       kept in sync by comment is the arrangement that decays; the render assertions below cover
//       the shared component's behavior and the source assertions cover the de-duplication itself.
//
//   (2) ONE When control, `type="date"` on both surfaces. This is asserted as a source invariant
//       because the two pages' render harnesses are heavyweight and mutually incompatible, and
//       because the thing worth pinning is the INPUT TYPE AGREEMENT ACROSS FILES — a cross-file
//       invariant that no single-page render test can express. The per-page render coverage
//       already exists (EventNew.harvestFormOrder / notesCollapsed query the control by label).
//
//       The direction of that agreement is deliberate and is documented at both call sites: Log
//       Event's `datetime-local` was collecting a time and DISCARDING it (`event_date.split('T')[0]`
//       before the POST), after which the server re-synthesized `T12:00:00Z`. Converging Log Many
//       onto datetime-local would have spread a control that manufactures precision the user never
//       entered. So both surfaces use `date`. If a future row restores real times, it moves BOTH —
//       which is the entire point of the shared scaffold, and is why this test asserts on both
//       files rather than on one.
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FormSection from '../components/FormSection.jsx'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel) => fs.readFileSync(path.join(DIR, '..', rel), 'utf8')
const LOG_MANY = readSrc('pages/LogMany.jsx')
const EVENT_NEW = readSrc('pages/EventNew.jsx')

describe('FormSection — the shared event-form section card', () => {
  it('renders its label as the uppercase section heading, above the children', () => {
    render(<FormSection label="When?"><input aria-label="probe" /></FormSection>)
    const label = screen.getByText('When?')
    expect(label.tagName).toBe('LABEL')
    expect(label.style.textTransform).toBe('uppercase')
    expect(label.style.fontWeight).toBe('700')
    const probe = screen.getByLabelText('probe')
    expect(label.compareDocumentPosition(probe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the card chrome — white bordered box, not a bare div', () => {
    const { container } = render(<FormSection label="What happened?">x</FormSection>)
    const card = container.firstChild
    expect(card.style.borderRadius).toBe('10px')
    expect(card.style.padding).toBe('16px 18px')
    expect(card.style.border).toContain('1px solid')
  })

  it('omits the label element entirely when no label is given', () => {
    // This guard came from LogMany's copy; EventNew's was unguarded. Keeping it preserves both
    // behaviors, since every call site on both surfaces passes a label today.
    const { container } = render(<FormSection><span>body</span></FormSection>)
    expect(container.querySelector('label')).toBe(null)
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('merges caller `style` over the card defaults — the surfaces space sections differently', () => {
    // Log Many's sections are loose children of a plain container and carry marginBottom: 16.
    // Log Event's are flex children of a gap:16 <form> and must carry NO outer margin, or the
    // spacing doubles to 32px. The card is shared; the outer spacing stays the caller's.
    const { container: withGap } = render(<FormSection label="a" style={{ marginBottom: 16 }}>x</FormSection>)
    const { container: without } = render(<FormSection label="a">x</FormSection>)
    expect(withGap.firstChild.style.marginBottom).toBe('16px')
    expect(without.firstChild.style.marginBottom).toBe('')
    // The merge must not cost the card its chrome.
    expect(withGap.firstChild.style.borderRadius).toBe('10px')
  })
})

describe('the scaffold is actually shared (source invariants)', () => {
  it('neither page declares its own Section component any more', () => {
    expect(LOG_MANY).not.toMatch(/function Section\s*\(/)
    expect(EVENT_NEW).not.toMatch(/function Section\s*\(/)
  })

  it('both pages take the card from components/FormSection.jsx', () => {
    expect(LOG_MANY).toMatch(/from '\.\.\/components\/FormSection\.jsx'/)
    expect(EVENT_NEW).toMatch(/from '\.\.\/components\/FormSection\.jsx'/)
  })

  it('neither page re-declares the section card chrome inline', () => {
    // `padding: '16px 18px'` is the section card's own signature — it appeared once per page while
    // the construct was duplicated and appears nowhere in either page now. If a surface grows its
    // own card again, this fires. (The uppercase-label style is NOT a usable marker: EventNew has
    // an unrelated sub-label sharing the 0.77rem type ramp.)
    expect(LOG_MANY).not.toMatch(/16px 18px/)
    expect(EVENT_NEW).not.toMatch(/16px 18px/)
  })

  it('ONE When control: both surfaces use type="date", neither uses datetime-local', () => {
    expect(LOG_MANY).toMatch(/type="date"/)
    expect(EVENT_NEW).toMatch(/type="date"/)
    // Comments explaining WHY datetime-local was rejected are allowed; a live JSX prop is not.
    expect(LOG_MANY).not.toMatch(/type="datetime-local"/)
    expect(EVENT_NEW).not.toMatch(/type="datetime-local"/)
  })

  it('Log Event still tolerates a legacy datetime-local draft value in its date input', () => {
    // Stashed drafts written by earlier builds hold '2026-08-01T10:00'; an <input type="date">
    // renders that shape as EMPTY. The slice is load-bearing back-compat, not tidying.
    expect(EVENT_NEW).toMatch(/form\.event_date\.slice\(0,\s*10\)/)
  })
})
