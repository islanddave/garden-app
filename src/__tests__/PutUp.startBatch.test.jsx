// Put-Up release 1a — "Start a batch" opens the shared Start sheet on this page (design V4 §2.2,
// §10.1 "Start a batch → /capture | the shared Start sheet"), and a started batch opens in the shipped
// `?batch=` mode.
//
// THE SEAM. The sheet (src/components/kitchen/StartBatchSheet.jsx, props { open, onClose,
// onStarted(batch) }) and GoingNowView's `onStartBatch` prop belong to the batch lane and do not exist
// on this branch. PutUp resolves the sheet through import.meta.glob (no match = null = GoingNowView gets
// no onStartBatch and keeps its shipped door) and takes it as a prop so this file can hand it a
// stand-in. GoingNowView is replaced here by a stub that honours the same contract the batch lane was
// given: its "Start a batch" calls onStartBatch when it has one.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'tomato', display_name: 'Tomato', category: 'vegetable' }], loading: false }),
}))
const { goingProps } = vi.hoisted(() => ({ goingProps: [] }))
vi.mock('../components/putup/GoingNowView.jsx', () => ({
  default: (props) => {
    goingProps.push(props)
    return (
      <div data-testid="going-now-view">
        {typeof props.onStartBatch === 'function'
          ? <button type="button" onClick={() => props.onStartBatch()}>Start a batch</button>
          : <span data-testid="shipped-start-door">Start a batch (shipped door)</span>}
      </div>
    )
  },
}))

import PutUp, { pickStartBatchSheet, StartBatchSheetImpl } from '../pages/PutUp.jsx'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONTRACT_PATH = 'src/components/kitchen/StartBatchSheet.jsx'

const sheetRenders = []
function makeSheet(started = { id: 'kb-new', label: 'Kraut, second crock' }) {
  return function StubStartBatchSheet({ open, onClose, onStarted }) {
    sheetRenders.push({ open })
    return (
      <div role="dialog" aria-label="Start a batch sheet">
        <button type="button" onClick={() => onStarted(started)}>Start it</button>
        <button type="button" onClick={onClose}>Close sheet</button>
      </div>
    )
  }
}

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches: [] })
    if (/^\/api\/kitchen-batches\/[^/?]+$/.test(path) && method === 'GET') {
      return Promise.resolve({ id: path.split('/').pop(), label: 'Kraut, second crock', inputs: [], stages: [], outputs: [] })
    }
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    return Promise.resolve(null)
  })
}

function Probe() {
  const loc = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
      <div data-testid="probe-state">{JSON.stringify(loc.state ?? null)}</div>
      <button type="button" onClick={() => navigate(-1)}>probe-back</button>
    </>
  )
}
function renderPage(Sheet, entry = '/put-up') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
      <Routes><Route path="/put-up" element={<PutUp StartBatchSheet={Sheet} />} /></Routes>
    </MemoryRouter>,
  )
}
// The segment is picked by hand so nothing here rests on the bare-open promote's rule.
async function toGoingNow() {
  fireEvent.click(await screen.findByRole('radio', { name: 'Going now' }))
  return screen.findByTestId('going-now-view')
}
const probeLoc = () => screen.getByTestId('probe-loc').textContent
const getCount = (p) => fetchMock.mock.calls.filter(([path, o]) => path === p && (o?.method ?? 'GET') === 'GET').length

beforeEach(() => { fetchMock.mockReset(); wire(); goingProps.length = 0; sheetRenders.length = 0; sessionStorage.clear() })

describe('Start a batch — the shared sheet, opened from Going now', () => {
  it('nothing is mounted until the tap; the tap opens the sheet', async () => {
    renderPage(makeSheet())
    await toGoingNow()
    expect(screen.queryByRole('dialog', { name: 'Start a batch sheet' })).toBeNull()
    expect(sheetRenders).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    expect(screen.getByRole('dialog', { name: 'Start a batch sheet' })).toBeTruthy()
    expect(sheetRenders.every(r => r.open === true)).toBe(true)
  })

  it('"Start it" opens the new batch in the shipped ?batch= mode, re-reads the list, and closes the sheet', async () => {
    renderPage(makeSheet())
    await toGoingNow()
    const listReadsBefore = getCount('/api/kitchen-batches?state=going')
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start it' }))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?batch=kb-new'))
    await waitFor(() => expect(getCount('/api/kitchen-batches/kb-new')).toBe(1))
    expect(screen.getByTestId('putup-batch-mode')).toBeTruthy()
    expect(getCount('/api/kitchen-batches?state=going')).toBe(listReadsBefore + 1)
    expect(screen.queryByRole('dialog', { name: 'Start a batch sheet' })).toBeNull()
  })

  it('Back from the new batch returns to the list it was started from', async () => {
    renderPage(makeSheet())
    await toGoingNow()
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start it' }))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?batch=kb-new'))
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }))
    await waitFor(() => expect(probeLoc()).toBe('/put-up'))
    expect(await screen.findByTestId('going-now-view')).toBeTruthy()
  })

  it('an overlay keeps its background through the open', async () => {
    const background = { pathname: '/today', search: '', hash: '', key: 'bg' }
    renderPage(makeSheet(), { pathname: '/put-up', state: { background } })
    await toGoingNow()
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start it' }))
    await waitFor(() => expect(probeLoc()).toBe('/put-up?batch=kb-new'))
    expect(JSON.parse(screen.getByTestId('probe-state').textContent)).toEqual({ background })
  })

  it('closing the sheet leaves the page exactly where it was', async () => {
    renderPage(makeSheet())
    await toGoingNow()
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }))
    expect(screen.queryByRole('dialog', { name: 'Start a batch sheet' })).toBeNull()
    expect(probeLoc()).toBe('/put-up')
    expect(fetchMock.mock.calls.some(([p]) => /^\/api\/kitchen-batches\/[^/?]+$/.test(p))).toBe(false)
  })

  it('a start that reports no id closes the sheet and opens nothing', async () => {
    renderPage(makeSheet({ label: 'no id came back' }))
    await toGoingNow()
    fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start it' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a batch sheet' })).toBeNull())
    expect(probeLoc()).toBe('/put-up')
  })

  it('with no sheet, GoingNowView is handed no onStartBatch — its shipped door stays', async () => {
    renderPage(null)
    await toGoingNow()
    expect(screen.getByTestId('shipped-start-door')).toBeTruthy()
    expect(goingProps.at(-1).onStartBatch).toBeUndefined()
  })
})

describe('the guarded import', () => {
  it('pickStartBatchSheet takes the named export, then the default, else null', () => {
    const Named = () => null
    const Default = () => null
    expect(pickStartBatchSheet({})).toBeNull()
    expect(pickStartBatchSheet(undefined)).toBeNull()
    expect(pickStartBatchSheet({ x: {} })).toBeNull()
    expect(pickStartBatchSheet({ x: { default: Default } })).toBe(Default)
    expect(pickStartBatchSheet({ x: { StartBatchSheet: Named, default: Default } })).toBe(Named)
  })

  // A glob that matches nothing is not an error, so a typo in its path would ship a page that silently
  // never finds the sheet. Bind the literal to the contract path, and the resolved component to the
  // file's existence: green on this branch (no file, null) and after the batch lane merges (file,
  // component); red if the path drifts or the file exports neither name.
  it('the glob literal is the contract path, and it resolves exactly when that file exists', () => {
    const page = readFileSync(resolve(REPO, 'src/pages/PutUp.jsx'), 'utf8')
    const m = page.match(/import\.meta\.glob\('([^']+)', \{ eager: true \}\)/)
    expect(m, 'PutUp.jsx no longer globs the Start sheet — re-anchor this test, do not delete it').not.toBeNull()
    expect(resolve(REPO, 'src/pages', m[1])).toBe(resolve(REPO, CONTRACT_PATH))
    expect(StartBatchSheetImpl !== null).toBe(existsSync(resolve(REPO, CONTRACT_PATH)))
  })
})
