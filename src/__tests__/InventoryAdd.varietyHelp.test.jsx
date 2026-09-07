// BUG-FIELDCHILDDROP-001 — behavioural half for InventoryAdd's seed-variety hint.
//
// The hint was written as a second child of the <Field> and Field dropped it, so it has never
// reached a screen. Nothing caught that because nothing rendered this branch: it only exists when
// category === 'seeds', and inventoryAddEnums.test.jsx stubs VarietyPicker to null and never picks
// that category. The static sweep in fieldChildren.test.jsx pins the SHAPE; this pins what the user
// actually gets — the sentence on screen, and the aria-describedby association the loose <div>
// never had even when it was intended to render.
//
// VarietyPicker is stubbed as a plain input that spreads whatever Field cloned onto it, because the
// association is the property under test and it can only be observed on a real DOM node.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ createItem: vi.fn() }) }))
// V5-SRCDISCLOSE-001 — picking 'seeds' now opens the "Add more details" pane, which mounts
// SourcePicker -> useSources -> useApiFetch -> Clerk's useAuth, and throws "can only be used within
// <ClerkProvider>" with no provider above. The unit under test here is still the hint's
// aria-describedby, not the network.
//
// `fetch` MUST be a stable identity across renders, which is why it is hoisted instead of minted
// inside the factory. useSources keys its effect on [fetch, enabled] (useSources.js:112) and the
// real useApiFetch hands back a useCallback'd function (api.js:312); a double that returns a fresh
// vi.fn() every render re-fires that effect on every render it causes, and the render loop eats the
// 4GB heap. Not hypothetical — it is what InventoryAdd.seedDoor.test.jsx did.
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn(async () => []) }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchMock, getToken: vi.fn(async () => 'tok') }),
  apiFetch: (...args) => apiFetchMock(...args),
}))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange, placeholder, required, ...cloned }) => (
    <input data-testid="variety-picker" placeholder={placeholder} required={required} readOnly {...cloned} />
  ),
}))

import InventoryAdd from '../pages/InventoryAdd.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const HINT = 'Linking the variety lets future plants and harvest events trace back to this packet.'

describe('InventoryAdd — the seed-variety hint reaches the screen (BUG-FIELDCHILDDROP-001)', () => {
  it('renders the hint and wires it to the picker via aria-describedby', () => {
    render(<MemoryRouter><ToastProvider><InventoryAdd /></ToastProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Consumable'))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'seeds' } })

    const hint = screen.getByText(HINT)
    const picker = screen.getByTestId('variety-picker')
    expect(hint.id, 'help node has no id to point at').toBeTruthy()
    expect(picker.getAttribute('aria-describedby') || '').toContain(hint.id)
  })

  it('does not render the hint for a non-seed category', () => {
    render(<MemoryRouter><ToastProvider><InventoryAdd /></ToastProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Consumable'))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'fertilizer' } })
    expect(screen.queryByText(HINT)).toBeNull()
  })
})
