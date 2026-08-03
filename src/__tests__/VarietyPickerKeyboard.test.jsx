// VarietyPickerKeyboard.test.jsx — V4-PICKERKB-001.
//
// Dave, device pass 2026-08-02: "do not have it default to text box selected for keyboard —
// I'll tap the variety selector, be presented with the choice list, no keyboard. Find a way then
// to allow me to activate the keyboard if desired."
//
// WHAT THIS CAN PROVE. Whether Chrome Android actually raises the on-screen keyboard is not
// observable in jsdom — there is no keyboard, and `inputMode` has no runtime behavior here. What
// IS deterministic is the CONTRACT that governs it: the `inputmode` attribute the browser reads,
// and the focus state the combobox depends on. So this pins those, and the device pass covers the
// pixels. Pinning the attribute is not a proxy for the behavior — it is the whole of the app's
// side of the bargain; the rest belongs to the browser.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const apiFetchSpy = vi.hoisted(() => vi.fn())
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

import VarietyPicker from '../components/VarietyPicker.jsx'

const VARIETIES = [
  { id: 'v-1', name: 'Cherokee Purple', crop_type_slug: 'tomato' },
  { id: 'v-2', name: 'Brandywine', crop_type_slug: 'tomato' },
]

beforeEach(() => {
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation(() => Promise.resolve(VARIETIES))
})

const field = () => screen.getByRole('combobox')
const kbBtn = () => screen.queryByLabelText('Type to search varieties')

// Real .focus(), not fireEvent.focus() — the latter dispatches the event without moving DOM
// focus, so document.activeElement would stay on <body> and the focus assertion below would be
// testing the harness rather than the component.
async function openPicker() {
  render(<VarietyPicker value={null} onChange={() => {}} aria-label="Variety" />)
  field().focus()
  await act(async () => { await Promise.resolve() })
}

describe('V4-PICKERKB-001 — the picker opens without asking for the keyboard', () => {
  it('declares inputmode="none" when the list opens, so the on-screen keyboard stays down', async () => {
    await openPicker()
    expect(field().getAttribute('inputmode')).toBe('none')
  })

  it('still holds focus — the combobox contract survives suppressing the keyboard', async () => {
    await openPicker()
    // This is the reason inputMode was chosen over blurring the field. aria-expanded, the
    // arrow-key handler and the 150ms blur-close all assume focus is here.
    expect(document.activeElement).toBe(field())
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('offers a labelled control to summon the keyboard, only while the list is open', async () => {
    render(<VarietyPicker value={null} onChange={() => {}} aria-label="Variety" />)
    expect(kbBtn()).toBeNull()                 // closed: nothing to type into yet
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(kbBtn()).toBeTruthy()
  })

  it('switches to inputmode="text" when that control is used', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))
  })

  it('keeps the list open through the deliberate blur+refocus the swap requires', async () => {
    // The regression this guards: Chrome will not raise the keyboard on an inputMode change to an
    // already-focused element, so the swap blurs and refocuses. If onBlur treated that as the user
    // leaving, it would schedule the dropdown shut ~150ms later — the list would vanish exactly
    // when the user asked to type into it.
    await openPicker()
    fireEvent.click(kbBtn())
    fireEvent.blur(field())
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('hides the control once the keyboard is up — it would be a no-op', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))
    expect(kbBtn()).toBeNull()
  })

  it('reverts to keyboard-free on the next open — one opt-in does not become the default', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))

    // Close, then reopen. Real .blur() so activeElement actually leaves the field — after a mere
    // fireEvent.blur the element is still focused, and the .focus() below would be a silent no-op
    // that never fires onFocus, so this would pass for the wrong reason.
    field().blur()
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    field().focus()
    await act(async () => { await Promise.resolve() })

    expect(field().getAttribute('inputmode')).toBe('none')
    expect(kbBtn()).toBeTruthy()
  })

  it('typing still works with the keyboard suppressed — hardware keyboards are unaffected', async () => {
    // inputMode governs the on-screen keyboard only. A Bluetooth keyboard, or any programmatic
    // input, must still reach the field; suppressing the VKB must not make the input read-only.
    await openPicker()
    fireEvent.change(field(), { target: { value: 'Cher' } })
    expect(field().value).toBe('Cher')
  })
})
