/**
 * src/__tests__/InventoryAdd.navTimer.test.jsx
 * BUG-INVADDNAVLEAK-001 — the 2500ms post-toast navigate must not survive unmount.
 *
 * The defect is SILENT: useNavigate()'s function dispatches through the router's shared
 * history, so a stale call after unmount neither throws nor warns — it just teleports the
 * user back to /inventory from wherever they walked to during the toast. So the assertion
 * has to be on navigateSpy itself; "a cleanup function exists" would prove nothing.
 *
 * Non-vacuity is carried by the first test (the positive control): the SAME setup, minus
 * the unmount, must still navigate. Without it, a test that broke the submit path entirely
 * would also report green. Mutation-checked both ways — see the file's lane report.
 *
 * House conventions: vi.hoisted spies + vi.mock react-router-dom + ToastProvider wrap.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { navigateSpy, createItemSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  createItemSpy: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ createItem: createItemSpy }) }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))

import InventoryAdd from '../pages/InventoryAdd.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const renderPage = () => render(<ToastProvider><InventoryAdd /></ToastProvider>)

// Minimum durable-item path: name + type + category + quantity. Durable is the cheaper of the
// two branches (consumable additionally demands a unit) and 'tools' is durable-only, so a
// category-filtering regression would fail loudly here rather than silently pass.
async function submitMinimalDurable() {
  fireEvent.change(screen.getByLabelText("What's the item?"), { target: { value: 'Hori hori' } })
  fireEvent.click(screen.getByText('Durable'))
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'tools' } })
  fireEvent.change(screen.getByLabelText('Quantity (how many?)'), { target: { value: '1' } })
  // `getByText` is ambiguous here — the breadcrumb also reads "Add item".
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add item' })) })
}

describe('InventoryAdd — post-toast navigate timer (BUG-INVADDNAVLEAK-001)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    navigateSpy.mockReset()
    createItemSpy.mockReset().mockResolvedValue({ error: null })
  })
  afterEach(() => { vi.useRealTimers() })

  it('POSITIVE CONTROL: still mounted, the timer fires and navigates to /inventory', async () => {
    renderPage()
    await submitMinimalDurable()

    expect(createItemSpy).toHaveBeenCalledTimes(1)     // the success path really ran
    expect(navigateSpy).not.toHaveBeenCalled()         // ...and the toast window is real, not 0ms

    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(navigateSpy).toHaveBeenCalledWith('/inventory')
  })

  it('unmounting during the toast window cancels the navigate', async () => {
    const { unmount } = renderPage()
    await submitMinimalDurable()
    expect(createItemSpy).toHaveBeenCalledTimes(1)

    unmount()                                          // user taps away while the toast is up
    await act(async () => { vi.advanceTimersByTime(10000) })

    expect(navigateSpy).not.toHaveBeenCalled()
  })
})
