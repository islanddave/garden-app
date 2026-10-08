// V5-SEEDLOTADDITION-001 — Sheet's additive `confirmCopy` prop: the discard question's words for the
// state the sheet is in right now (Save seed's add form uses it once a request has left unanswered).
//
// Sheet has ~20 render sites and one of them asked for this. Two properties matter to the others:
// WITHOUT the prop the question is exactly what it was, and WITH it the sheet is not registered again
// when the words change (a second registration moves the sheet above whatever opened after it, and
// re-arms its Back entry). Each case names the mutation that reds it. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const text = (id) => screen.queryByTestId(id)?.textContent ?? null
const asked = () => ['title', 'body', 'confirm', 'cancel'].map((part) => text(`confirm-sheet-${part}`))
const escape = () => act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const REGISTERED = ['Registered title', 'Registered body', 'Discard', 'Keep editing']
const LIVE = { title: 'Live title', body: 'Live body', confirmLabel: 'Go', cancelLabel: 'Stay' }

const One = ({ copy, onClose }) => (
  <DismissRegistryProvider>
    <Sheet open dirty confirmOnDirty confirmTitle="Registered title" confirmBody="Registered body" confirmCopy={copy} onClose={onClose} ariaLabel="one">
      <p>body</p>
    </Sheet>
  </DismissRegistryProvider>
)

describe('Sheet — confirmCopy', () => {
  // KILLING MUTATION: give ConfirmSheet's labels a value when no live copy is passed, or read the
  // live copy before the registered words when it is null. RESULT: RED.
  it('absent: the question is the registered title and body with the registry\'s own two buttons', async () => {
    const onClose = vi.fn()
    render(<One onClose={onClose} />)
    await escape()
    expect(asked()).toEqual(REGISTERED)
    await tap('confirm-sheet-confirm')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // KILLING MUTATION: `const live = null` in raiseConfirm, or the two labels not passed to
  // ConfirmSheet. RESULT: RED.
  it('present: all four words are the live ones, and the two answers still do what they did', async () => {
    const onClose = vi.fn()
    render(<One copy={LIVE} onClose={onClose} />)
    await escape()
    expect(asked()).toEqual(['Live title', 'Live body', 'Go', 'Stay'])
    await tap('confirm-sheet-cancel')
    expect(onClose).not.toHaveBeenCalled()
    await escape()
    await tap('confirm-sheet-confirm')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // KILLING MUTATION: replace the per-word fallback with "live copy or registered copy" as a whole.
  // RESULT: RED — a copy that names one word would blank the others.
  it('a word the live copy leaves out is the registered one', async () => {
    render(<One copy={{ body: 'Live body' }} onClose={vi.fn()} />)
    await escape()
    expect(asked()).toEqual(['Registered title', 'Live body', 'Discard', 'Keep editing'])
  })

  // KILLING MUTATION: read the copy when the sheet registers instead of when the question is raised
  // (store the object, not the ref). RESULT: RED on the second and third question.
  it('is read when the question is raised: the words follow the sheet\'s state, there and back', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<One onClose={onClose} />)
    await escape()
    expect(asked()).toEqual(REGISTERED)
    await tap('confirm-sheet-cancel')
    rerender(<One copy={LIVE} onClose={onClose} />)
    await escape()
    expect(asked()).toEqual(['Live title', 'Live body', 'Go', 'Stay'])
    await tap('confirm-sheet-cancel')
    rerender(<One onClose={onClose} />)
    await escape()
    expect(asked()).toEqual(REGISTERED)
    expect(onClose).not.toHaveBeenCalled()
  })

  // Two sheets of one layer: the one registered LAST is topmost and owns aria-modal. A sheet that is
  // registered again moves to the top. So the second sheet's aria-modal is the instrument.
  const Two = ({ copy, title = 'Registered title' }) => (
    <DismissRegistryProvider>
      <Sheet open dirty confirmOnDirty confirmTitle={title} confirmBody="Registered body" confirmCopy={copy} onClose={vi.fn()} ariaLabel="under">
        <p>under</p>
      </Sheet>
      <Sheet open onClose={vi.fn()} ariaLabel="over"><p>over</p></Sheet>
    </DismissRegistryProvider>
  )
  const modal = (name) => screen.getByRole('dialog', { name }).getAttribute('aria-modal')

  // KILLING MUTATION: add confirmCopy to the registration effect's deps, or register the object
  // itself. RESULT: RED — the sheet underneath takes the top.
  it('changing the live words does not register the sheet again: the sheet over it stays on top', async () => {
    const { rerender } = render(<Two />)
    expect([modal('under'), modal('over')]).toEqual([null, 'true'])
    rerender(<Two copy={LIVE} />)
    rerender(<Two copy={{ ...LIVE }} />)
    rerender(<Two />)
    await act(async () => {})
    expect([modal('under'), modal('over')]).toEqual([null, 'true'])
  })

  // The instrument, shown working: the REGISTERED title is a registration-time constant, and changing
  // it does register the sheet again. This is why state-dependent words do not travel in it.
  it('changing the registered title does: the sheet underneath takes the top (why the words are not sent that way)', async () => {
    const { rerender } = render(<Two />)
    expect([modal('under'), modal('over')]).toEqual([null, 'true'])
    rerender(<Two title="Another registered title" />)
    await act(async () => {})
    expect([modal('under'), modal('over')]).toEqual(['true', null])
  })
})
