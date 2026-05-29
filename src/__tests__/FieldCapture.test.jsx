import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'
import FieldCapture from '../pages/FieldCapture.jsx'

function renderAt(initialMode, initialPath = '/field') {
  return render(
    <ModeProvider initialMode={initialMode}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/field" element={<FieldCapture />} />
          <Route path="/dashboard" element={<div data-testid="dashboard-stub" />} />
        </Routes>
      </MemoryRouter>
    </ModeProvider>
  )
}

describe('FieldCapture (Inc 2 Bite 3)', () => {
  beforeEach(() => {
    try { window.sessionStorage.clear() } catch {}
  })

  it('renders the field capture surface when mode === field', () => {
    renderAt(MODE.FIELD)
    expect(screen.getByTestId('field-capture-page')).toBeDefined()
    expect(screen.getByText('Field capture')).toBeDefined()
    expect(screen.getByTestId('mic-capture-button')).toBeDefined()
    expect(screen.getByTestId('tap-capture-fallback')).toBeDefined()
  })

  it('redirects to /dashboard when mode === desk (mode-mismatch bounce)', () => {
    renderAt(MODE.DESK)
    expect(screen.queryByTestId('field-capture-page')).toBeNull()
    expect(screen.getByTestId('dashboard-stub')).toBeDefined()
  })

  it('appends a placeholder entry to the queue on mic tap (Bite 4 wires real audio)', () => {
    renderAt(MODE.FIELD)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    expect(screen.getByTestId('field-queue-preview')).toBeDefined()
    expect(screen.getByText('Queued (1)')).toBeDefined()
    expect(screen.getByText(/Voice capture \(mic wiring in Bite 4\)/)).toBeDefined()
  })

  it('appends typed text to the queue on tap-fallback submit', () => {
    renderAt(MODE.FIELD)
    const textarea = screen.getByTestId('tap-capture-textarea')
    fireEvent.change(textarea, { target: { value: 'broccoli flowering' } })
    fireEvent.click(screen.getByTestId('tap-capture-submit'))
    expect(screen.getByText('Queued (1)')).toBeDefined()
    expect(screen.getByText('broccoli flowering')).toBeDefined()
  })

  it('hides the queue preview when empty (calm-by-default surface)', () => {
    renderAt(MODE.FIELD)
    expect(screen.queryByTestId('field-queue-preview')).toBeNull()
  })

  it('reflects the queued-count badge on the mic button (numeric + label) after appends', () => {
    renderAt(MODE.FIELD)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    expect(screen.getByTestId('mic-queued-count').textContent).toContain('2')
    expect(screen.getByText('2 captures queued')).toBeDefined()
  })
})
