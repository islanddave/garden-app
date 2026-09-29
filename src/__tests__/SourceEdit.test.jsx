// V5-SOURCECONTACT-001 — SourceEdit (/sources/:id), end to end through the REAL hooks.
//
// Only useApiFetch is mocked: useSources.updateSource and useSourceKinds run for real, so every
// assertion below is about the request that actually leaves the app (method, URL, body) — the
// VarietyEdit.test.jsx lesson, where two Save buttons 405'd for months behind a mocked hook.
// No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import SourceEdit, { sourcePatch, saveErrorMessage } from '../pages/SourceEdit.jsx'

const ID = 'b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SOURCE = {
  id: ID, name: 'Bardwell Farm Stand', kind: 'farm_stand', locality: 'Hatfield, MA',
  address: null, website_url: null, instagram_url: null, facebook_url: 'https://www.facebook.com/bardwell',
  notes: 'honour box',
}
const KINDS = [
  { slug: 'seed_company', display_name: 'Seed company', sort_order: 10 },
  { slug: 'farm_stand', display_name: 'Farm stand', sort_order: 40 },
]

let patchImpl
beforeEach(() => {
  fetchSpy.mockReset()
  patchImpl = (body) => Promise.resolve({ ...SOURCE, ...body })
  fetchSpy.mockImplementation((path, init) => {
    if (init?.method === 'PATCH') return patchImpl(JSON.parse(init.body))
    if (path === `/api/varieties/sources/${ID}`) return Promise.resolve(SOURCE)
    if (path === '/api/varieties/source-kinds') return Promise.resolve(KINDS)
    return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
  })
})

function renderPage(id = ID) {
  return render(
    <MemoryRouter initialEntries={['/back', `/sources/${id}`]} initialIndex={1}>
      <Routes>
        <Route path="/back" element={<div data-testid="went-back" />} />
        <Route path="/sources/:id" element={<SourceEdit />} />
      </Routes>
    </MemoryRouter>,
  )
}

const patchCalls = () => fetchSpy.mock.calls.filter(c => c[1]?.method === 'PATCH')
const typeInto = (testid, value) => fireEvent.change(screen.getByTestId(testid), { target: { value } })

describe('SourceEdit — load', () => {
  it('loads the source by id and fills every field, including the links', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    expect(fetchSpy).toHaveBeenCalledWith(`/api/varieties/sources/${ID}`)
    expect(screen.getByTestId('source-edit-name').value).toBe('Bardwell Farm Stand')
    expect(screen.getByTestId('source-edit-locality').value).toBe('Hatfield, MA')
    expect(screen.getByTestId('source-edit-facebook').value).toBe('https://www.facebook.com/bardwell')
    expect(screen.getByTestId('source-edit-instagram').value).toBe('')
    expect(screen.getByTestId('source-edit-notes').value).toBe('honour box')
    await waitFor(() => expect(screen.getByTestId('source-edit-kind').value).toBe('farm_stand'))
    expect(screen.getByRole('heading').textContent).toBe('Edit Bardwell Farm Stand')
  })

  it('has plain-language labels for every field and NO delete control', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    for (const label of ['Name', 'What kind of place', 'Town', 'Address', 'Website', 'Instagram', 'Facebook', 'Notes']) {
      expect(screen.getByLabelText(new RegExp(`^${label}`)), label).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull()
  })

  it('says so in plain words when the source is gone', async () => {
    renderPage('b1f3c2d4-5e6f-4a7b-8c9d-000000000000')
    await waitFor(() => expect(document.body.textContent).toContain('This source was not found'))
    expect(screen.queryByTestId('source-edit-save')).toBeNull()
  })
})

describe('SourceEdit — save', () => {
  it('PATCHes ONLY the changed fields, links normalised, then goes back', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-instagram', '@bardwellstand')
    typeInto('source-edit-website', 'bardwellfarm.com')
    typeInto('source-edit-address', '  12 River Rd ')
    fireEvent.click(screen.getByTestId('source-edit-save'))

    await screen.findByTestId('went-back')
    expect(patchCalls()).toHaveLength(1)
    const [path, init] = patchCalls()[0]
    expect(path).toBe(`/api/varieties/sources/${ID}`)
    expect(JSON.parse(init.body)).toEqual({
      address: '12 River Rd',
      website_url: 'https://bardwellfarm.com',
      instagram_url: 'https://www.instagram.com/bardwellstand',
    })
  })

  it('clearing a field sends null for it', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-facebook', '')
    typeInto('source-edit-notes', '   ')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ facebook_url: null, notes: null })
  })

  it('changes the kind through the live vocabulary', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    await waitFor(() => expect(screen.getByTestId('source-edit-kind').options.length).toBe(3))
    typeInto('source-edit-kind', 'seed_company')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ kind: 'seed_company' })
  })

  it('a blank name is refused on the page, with no request', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-name', ' ')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least two letters/))
    expect(patchCalls()).toHaveLength(0)
  })

  it('a rename onto another source shows the 409 in plain words, and offers to open that one', async () => {
    patchImpl = () => Promise.reject(Object.assign(new Error('Source "Fedco Seeds" already exists'), {
      status: 409,
      body: { reason: 'exists', existing: { id: 'b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5f', name: 'Fedco Seeds' } },
    }))
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-name', 'Fedco Seeds')
    fireEvent.click(screen.getByTestId('source-edit-save'))

    const err = await screen.findByTestId('source-edit-error')
    expect(err.textContent).toContain('“Fedco Seeds” is already another source')
    expect(err.textContent).not.toMatch(/409|exists"/)
    expect(screen.getByTestId('source-edit-open-existing').textContent).toBe('Open “Fedco Seeds”')
    // Still on the page, with what was typed intact.
    expect(screen.getByTestId('source-edit-name').value).toBe('Fedco Seeds')
    expect(screen.queryByTestId('went-back')).toBeNull()
  })

  it('a 400 on a link field is shown in plain words, never the field name', async () => {
    patchImpl = () => Promise.reject(Object.assign(new Error('instagram_url must start with http:// or https://'), { status: 400, body: { error: 'instagram_url must start with http:// or https://' } }))
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-notes', 'x')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    const err = await screen.findByTestId('source-edit-error')
    expect(err.textContent).toBe("That link doesn't look right. Paste the full address or just the @name.")
    expect(err.textContent).not.toMatch(/_url/)
  })

  it('a 403 says whose sources can be edited', async () => {
    patchImpl = () => Promise.reject(Object.assign(new Error('You can only edit sources you added'), { status: 403, body: {} }))
    renderPage()
    await screen.findByTestId('source-edit-name')
    typeInto('source-edit-notes', 'x')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    expect((await screen.findByTestId('source-edit-error')).textContent).toBe('You can only edit sources you added.')
  })

  it('Save with nothing changed sends nothing and just goes back', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    fireEvent.click(screen.getByTestId('source-edit-save'))
    await screen.findByTestId('went-back')
    expect(patchCalls()).toHaveLength(0)
  })

  it('every button is a real button type — Save submits, Cancel does not', async () => {
    renderPage()
    await screen.findByTestId('source-edit-name')
    expect(screen.getByTestId('source-edit-save').getAttribute('type')).toBe('submit')
    expect(screen.getByTestId('source-edit-cancel').getAttribute('type')).toBe('button')
    fireEvent.click(screen.getByTestId('source-edit-cancel'))
    await screen.findByTestId('went-back')
    expect(patchCalls()).toHaveLength(0)
  })
})

describe('sourcePatch / saveErrorMessage (pure)', () => {
  const blank = { name: 'X', kind: '', locality: '', address: '', website_url: '', instagram_url: '', facebook_url: '', notes: '' }
  it('an untouched form against a mostly-null row is an empty patch', () => {
    expect(sourcePatch({ name: 'X', kind: null }, blank)).toEqual({})
  })
  it('a link typed as the SAME url it already has is not a change', () => {
    expect(sourcePatch({ name: 'X', website_url: 'https://a.com' }, { ...blank, website_url: 'a.com' })).toEqual({})
  })
  it('falls back to the server message, then to a connection sentence', () => {
    expect(saveErrorMessage({ error: 'kind "x" is not a live source kind' })).toMatch(/not a live source kind/)
    expect(saveErrorMessage({})).toMatch(/Check your connection/)
  })
})
