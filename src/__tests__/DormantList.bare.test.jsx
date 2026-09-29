// V5-TODAYREDESIGN-001 S6 — DormantList's two optional seams for the redesigned Today's Resting section:
// `bare` (rows only; the section is the heading and holds the explainer; Resume at the 44px floor) and a
// caller-held resumed set (`resumed` + `onResumed`: Today V2 unmounts a closed section, so a set kept inside the
// list would forget a resume on the next open). V1 without either: CareNeededDormant.test.jsx, unedited, and an
// identity proof against f47337da's CareNeeded.jsx (S6 build report).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { fetchMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import { DormantList } from '../components/today/CareNeeded.jsx'

const GARLIC = { id: 'g1', crop: 'garlic', name: 'Garlic', project: 'Garlic', project_id: 'pg', reason: 'status' }
const FIG = { id: 'f1', crop: 'fig', name: 'Fig', project: 'Fig', project_id: 'pf', reason: 'status' }
const LITHOPS = { id: 'l1', crop: 'lithops', name: 'Lithops', project: 'Sill', project_id: 'pl', reason: 'profile' }
const plan = { dormant: [GARLIC, FIG, LITHOPS] }

beforeEach(() => { cleanup(); fetchMock.mockReset(); toastMock.show.mockReset() })

describe('DormantList — bare', () => {
  it('rows only: no "Dormant" heading, no explainer; each resumable row keeps Resume, at 44px', () => {
    const { container } = render(<DormantList plan={plan} bare />)
    expect(container.querySelector('h3')).toBeNull()
    expect(container.textContent).not.toMatch(/Dormant|no routine care/)
    expect(screen.getByText('Garlic')).toBeTruthy()
    expect(screen.getByText('Lithops')).toBeTruthy() // listed, not resumable (a profile dormancy)
    const resumes = screen.getAllByRole('button', { name: /^Resume / })
    expect(resumes.map((b) => b.getAttribute('aria-label'))).toEqual(['Resume Garlic', 'Resume Fig'])
    for (const b of resumes) expect(b.style.minHeight).toBe('44px')
  })
  it('without bare: the heading, the explainer and the 32px Resume, as V1 has them', () => {
    render(<DormantList plan={plan} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Dormant' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Garlic' }).style.minHeight).toBe('32px')
  })
})

describe('DormantList — a caller-held resumed set', () => {
  it('rows in `resumed` are not listed', () => {
    render(<DormantList plan={plan} bare resumed={new Set(['g1'])} onResumed={() => {}} />)
    expect(screen.queryByText('Garlic')).toBeNull()
    expect(screen.getByText('Fig')).toBeTruthy()
  })
  it('a successful Resume reports the id to the caller (the caller hides it); nothing is hidden before the PUT lands', async () => {
    let resolve
    fetchMock.mockImplementation(() => new Promise((r) => { resolve = r }))
    const onResumed = vi.fn()
    render(<DormantList plan={plan} bare resumed={new Set()} onResumed={onResumed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Garlic' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/plants/g1', { method: 'PUT', body: JSON.stringify({ status: 'vegetative' }) })
    expect(screen.getByText('Garlic')).toBeTruthy() // never optimistic
    expect(onResumed).not.toHaveBeenCalled()
    resolve({})
    await waitFor(() => expect(onResumed).toHaveBeenCalledWith('g1'))
  })
  it('a failed Resume leaves the row, tells the caller nothing, and says so (never optimistic)', async () => {
    fetchMock.mockRejectedValue(new Error('500'))
    const onResumed = vi.fn()
    render(<DormantList plan={plan} bare resumed={new Set()} onResumed={onResumed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Fig' }))
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledWith({ message: 'Couldn’t resume Fig', tone: 'error' }))
    expect(onResumed).not.toHaveBeenCalled()
    expect(screen.getByText('Fig')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume Fig' }).disabled).toBe(false)
  })
})
