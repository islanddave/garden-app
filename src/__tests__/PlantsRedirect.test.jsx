// V3-IA: /plants is retired — legacy links redirect to /garden with the query
// string preserved so ?edit= / ?add=1 / packet deep-links keep working.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import PlantsRedirect from '../components/PlantsRedirect.jsx'

function GardenProbe() {
  const location = useLocation()
  return <div data-testid="garden-probe">{location.pathname + location.search}</div>
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/plants" element={<PlantsRedirect />} />
        <Route path="/garden" element={<GardenProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('PlantsRedirect — legacy /plants route', () => {
  it('redirects bare /plants to /garden', () => {
    renderAt('/plants')
    expect(screen.getByTestId('garden-probe').textContent).toBe('/garden')
  })

  it('preserves the ?edit deep-link param (V3-EDIT-001)', () => {
    renderAt('/plants?edit=pl-42')
    expect(screen.getByTestId('garden-probe').textContent).toBe('/garden?edit=pl-42')
  })

  it('preserves ?add=1 and packet deep-link params', () => {
    renderAt('/plants?add=1&source_inventory_item_id=item-1&variety_id=var-1')
    expect(screen.getByTestId('garden-probe').textContent).toBe('/garden?add=1&source_inventory_item_id=item-1&variety_id=var-1')
  })
})
