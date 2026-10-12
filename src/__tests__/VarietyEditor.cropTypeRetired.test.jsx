/**
 * V4-CROPTYPERETIRE-001 — the variety editor's inline "New crop type" form, when the name typed
 * matches a type the admin retired.
 *
 * VarietyEditor.test.jsx hands the editor a stub creator, which cannot show what the real one says.
 * This file wires the editor to the real useCropTypes().createCropType, as src/pages/VarietyEdit.jsx
 * does, over a mocked useApiFetch — so the line on screen is the one a person gets.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import VarietyEditor from '../components/forms/VarietyEditor.jsx'
import { useCropTypes } from '../hooks/useCropTypes.js'
import { CROP_TYPE_RETIRED_CODE, CROP_TYPE_RETIRED_LINE } from '../lib/cropTypeRetired.js'

const OWNER = 'user_owner_1'
const VARIETY = { id: 'v-1', name: 'Kousa', created_by: OWNER, crop_type_slug: null }
const CROPS = [{ slug: 'pepper', display_name: 'Pepper', default_lifecycle: null, category: 'vegetable', sort_order: 0 }]

function Page({ onSave }) {
  const { cropTypes, createCropType } = useCropTypes()
  return (
    <VarietyEditor
      variety={VARIETY}
      cropTypes={cropTypes}
      onCreateCropType={createCropType}
      currentUserId={OWNER}
      onSave={onSave}
      onSaved={() => {}}
      onCancel={() => {}}
    />
  )
}

beforeEach(() => { fetchSpy.mockReset() })

describe('VarietyEditor — a retired crop type typed into the inline form', () => {
  it('shows the one plain line, selects nothing, and saves nothing', async () => {
    // The message differs from the line on purpose: the line must come from the code.
    const err = Object.assign(new Error('Admin only'), {
      status: 403, body: { error: 'Admin only', code: CROP_TYPE_RETIRED_CODE },
    })
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types' && opts?.method === 'POST') return Promise.reject(err)
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    const onSave = vi.fn()
    render(<Page onSave={onSave} />)

    fireEvent.click(await screen.findByText(/New crop type/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dogwood'), { target: { value: 'Tatsoi' } })
    fireEvent.click(screen.getByText('Create crop type'))

    await waitFor(() => screen.getByText("That crop type was retired. Ask the garden's admin to bring it back."))
    expect(CROP_TYPE_RETIRED_LINE).toBe("That crop type was retired. Ask the garden's admin to bring it back.")
    expect(screen.queryByText(/Admin only/)).toBeNull()
    expect(screen.queryByText(/^Use "/)).toBeNull()
    expect(screen.getByLabelText(/Crop type/).value).toBe('')
    expect(onSave).not.toHaveBeenCalled()
    const post = fetchSpy.mock.calls.find(c => c[0] === '/api/varieties/crop-types' && c[1]?.method === 'POST')
    expect(JSON.parse(post[1].body).display_name).toBe('Tatsoi')
  })

  it('any other refusal still prints the server\'s own words', async () => {
    const err = Object.assign(new Error('Crop type "Pepper" already exists'), {
      status: 409, body: { reason: 'exists', existing: CROPS[0] },
    })
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/varieties/crop-types' && opts?.method === 'POST') return Promise.reject(err)
      if (path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
      return Promise.resolve([])
    })
    render(<Page onSave={vi.fn()} />)
    fireEvent.click(await screen.findByText(/New crop type/))
    fireEvent.change(screen.getByPlaceholderText('e.g. Dogwood'), { target: { value: 'Pepper' } })
    fireEvent.click(screen.getByText('Create crop type'))
    await waitFor(() => screen.getByText(/already exists/))
    expect(screen.queryByText(CROP_TYPE_RETIRED_LINE)).toBeNull()
  })
})
