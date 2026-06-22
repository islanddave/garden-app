import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { ToastProvider, useToast } from '../context/ToastContext.jsx'

function Harness({ onApi }) {
  const t = useToast()
  onApi(t)
  return <div>harness</div>
}

describe('ToastContext — global operational toast layer', () => {
  it('useToast throws outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Harness onApi={() => {}} />)).toThrow(/ToastProvider/)
    spy.mockRestore()
  })

  it('show() renders a confirmation toast that auto-dismisses', async () => {
    let api
    render(<ToastProvider><Harness onApi={t => { api = t }} /></ToastProvider>)
    act(() => { api.show({ message: 'Saved it', duration: 50 }) })
    expect(screen.getByText('Saved it')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Saved it')).toBeNull())
  })

  it('showUndo() renders an undo toast and fires onUndo on click', async () => {
    let api; const onUndo = vi.fn()
    render(<ToastProvider><Harness onApi={t => { api = t }} /></ToastProvider>)
    act(() => { api.showUndo({ message: 'Logged event for Bed 1', onUndo, duration: 9999 }) })
    expect(screen.getByText('Logged event for Bed 1')).toBeTruthy()
    fireEvent.click(screen.getByText('Undo'))
    expect(onUndo).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Logged event for Bed 1')).toBeNull())
  })

  it('dismiss button removes the undo toast without firing onUndo', () => {
    let api; const onUndo = vi.fn()
    render(<ToastProvider><Harness onApi={t => { api = t }} /></ToastProvider>)
    act(() => { api.showUndo({ message: 'Logged event for Bed 2', onUndo, duration: 9999 }) })
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByText('Logged event for Bed 2')).toBeNull()
  })
})
