// V4-DRAFTFULLPAGE-001 (b) — the dirty channel: overlay content reports in-progress state via
// useReportOverlayDirty; OverlayHost (the REAL one, exported from App.jsx) owns the state and
// forwards it to Sheet's shipped §5.2 dirty guard, which had ZERO consumers until now. Pins the
// full path: dirty -> backdrop tap no-ops; Escape (and the labelled Close) stay live; content
// unmount resets the host so the next overlay's backdrop is never left locked. Uses the real
// react-router (MemoryRouter) because OverlayHost dismisses via useOverlayDismiss -> navigate.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { OverlayHost } from '../App.jsx'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'

function DirtyToggle() {
  const [dirty, setDirty] = React.useState(false)
  useReportOverlayDirty(dirty)
  return <button onClick={() => setDirty(d => !d)}>toggle-dirty</button>
}

function Loc() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}

// Outside an OverlayProvider background is undefined, so dismiss falls back to replace('/today') —
// the location sink observing that move is the proof onClose fired.
function renderHost(children) {
  return render(
    <MemoryRouter initialEntries={['/log']}>
      <Loc />
      <OverlayHost ariaLabel="Log an event" size="full">{children}</OverlayHost>
    </MemoryRouter>
  )
}

const backdrop = () => screen.getByRole('dialog').previousSibling

describe('OverlayHost — dirty wiring (V4-DRAFTFULLPAGE-001 b)', () => {
  it('clean content: a backdrop tap dismisses (baseline unchanged)', () => {
    renderHost(<DirtyToggle />)
    expect(screen.getByTestId('loc').textContent).toBe('/log')
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('dirty content: backdrop tap no-ops, Escape still dismisses (Sheet §5.2 through the host)', () => {
    renderHost(<DirtyToggle />)
    fireEvent.click(screen.getByText('toggle-dirty'))
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/log')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('going clean again re-enables the backdrop', () => {
    renderHost(<DirtyToggle />)
    fireEvent.click(screen.getByText('toggle-dirty'))
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/log')
    fireEvent.click(screen.getByText('toggle-dirty'))
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('unmounting dirty content resets the host — the next content cannot inherit a locked backdrop', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/log']}>
        <Loc />
        <OverlayHost ariaLabel="Log an event" size="full"><DirtyToggle /></OverlayHost>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('toggle-dirty'))
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/log') // locked while dirty
    rerender(
      <MemoryRouter initialEntries={['/log']}>
        <Loc />
        <OverlayHost ariaLabel="Log an event" size="full"><div>swapped content</div></OverlayHost>
      </MemoryRouter>
    )
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('useReportOverlayDirty is a strict no-op outside a provider (full-page render never throws)', () => {
    render(<DirtyToggle />)
    fireEvent.click(screen.getByText('toggle-dirty'))
    expect(screen.getByText('toggle-dirty')).toBeTruthy()
  })
})
