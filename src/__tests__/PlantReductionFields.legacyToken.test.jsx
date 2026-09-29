// V5-LOSSTOKEN-001 — the capture panel renders for a legacy spelling exactly as for the new token.
//
// EventNew canonicalises before the panel ever sees a type (the ?event_type seed and the draft
// restore), so its own suite cannot reach this path: removing the panel's canonicalisation left
// EventNew.reduction.test.jsx green (mutation run, 2026-09-29). This mounts the panel directly with the
// pre-rename tokens, so the guard is proven for any future caller that hands it a stored type.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PlantReductionFields from '../components/PlantReductionFields.jsx'
import { LOSS_REASONS, GIVEAWAY_REASONS } from '../lib/eventTypes.js'

const mount = (eventType) => render(
  <PlantReductionFields eventType={eventType} qty="" reason="" onQty={() => {}} onReason={() => {}} />,
)

describe('PlantReductionFields — legacy spellings', () => {
  for (const [legacy, canonical, reasons, label] of [
    ['failed', 'reduction_lost', LOSS_REASONS, 'Plants lost *'],
    ['given_away', 'reduction_given_away', GIVEAWAY_REASONS, 'Plants given away *'],
  ]) {
    it(`${legacy} renders the ${canonical} panel with its own vocabulary`, () => {
      mount(legacy)
      expect(screen.getByTestId(`reduction-panel-${canonical}`)).toBeTruthy()
      expect(screen.getByText(label)).toBeTruthy()
      for (const r of reasons) expect(screen.getByTestId(`reduction-reason-${r}`), r).toBeTruthy()
    })
  }

  it('non-vacuity: a non-reduction type renders nothing', () => {
    const { container } = mount('watering')
    expect(container.innerHTML).toBe('')
  })
})
