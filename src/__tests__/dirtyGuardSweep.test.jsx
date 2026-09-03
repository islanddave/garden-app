// V4-DIRTYGUARDSWEEP-001 — proves the dirty-guard contract is CONNECTED on the five surfaces this
// row wired, and — just as importantly — that it stays disconnected where it should.
//
// Why the assertions are integration-shaped: V4-RELOADGATEWIRE-001 shipped reloadGate.js fully built
// and mutation-proved while nothing in the app ever CALLED setReloadBlocked, and reloadGate.test.js
// stayed green throughout, because a primitive's own unit tests cannot see that it has no callers.
// So every test below drives the real page against the real reloadGate and the real draftStash.
// Spying on setReloadBlocked would rebuild the exact blind spot this row exists to close.
//
// The false-positive tests are load-bearing, not padding. A guard that fires on a merely-visited
// form holds a service-worker update (BUG-STALECLIENT-001's failure mode, deferred rather than
// cancelled precisely so it cannot recur) and deadens the sheet backdrop. Every surface here
// therefore gets a "pristine mount does NOT hold" test, and three of them get a "user did something
// real, it was STASHED, and the guard still did not fire" test — that pair is what proves the stash
// predicate and the guard predicate are two separate predicates and not one reused twice.
//
// Harness mirrors EventNew.reloadGateWire.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, navigateSpy, uploadSpy, createItemSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  uploadSpy: vi.fn(),
  createItemSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  // V4-SEEDNOPLANTING-001 — InventoryAdd reads search params now (the seed flow links in with
  // type/category/return pre-set). An empty set keeps every assertion in this file about the
  // ORDINARY, unparameterised Add-item route, which is what it was already testing.
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ createItem: createItemSpy }) }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => null }))
vi.mock('../lib/captureQueue.js', () => ({
  setTranscript: vi.fn(async () => ({})),
  incrementTranscribeAttempt: vi.fn(async () => ({})),
  markHandedOff: vi.fn(async () => ({})),
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => false,
  startLiveTranscription: vi.fn(),
  START_TIMEOUT_MS: 3500,
  NO_SPEECH_TIMEOUT_MS: 8000,
}))

import ProjectNew from '../pages/ProjectNew.jsx'
import InventoryAdd from '../pages/InventoryAdd.jsx'
import AddSeeds from '../pages/AddSeeds.jsx'
import CaptureFlow from '../pages/CaptureFlow.jsx'
import TapCaptureFallback from '../components/TapCaptureFallback.jsx'
import TranscriptReview from '../components/TranscriptReview.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { readDraft } from '../lib/draftStash.js'

const PROJECT_TYPE = { id: 'pt-1', name: 'Tomatoes', category: 'garden', icon: '🍅', description: null, default_fields: {} }

function routeFetch() {
  fetchSpy.mockImplementation((path, options = {}) => {
    if ((options.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'new-1' })
    if (path === '/api/projects/types') return Promise.resolve([PROJECT_TYPE])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([])
    if (path.startsWith('/api/varieties')) return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); uploadSpy.mockReset(); createItemSpy.mockReset()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  createItemSpy.mockResolvedValue({ item: { id: 'inv-1' } })
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  sessionStorage.clear()
  clearReloadBlocks()
  routeFetch()
})

const renderPage = async (el) => {
  let out
  await act(async () => { out = render(<ToastProvider>{el}</ToastProvider>) })
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
describe('ProjectNew ↔ dirty guard', () => {
  it('a merely-VISITED form does not hold the gate; one keystroke does', async () => {
    await renderPage(<ProjectNew />)
    // form.start_date is today and form.status is 'planning' on arrival. A truthiness guard over
    // those two would pin the gate for every user who merely opened /projects/new.
    expect(screen.getByLabelText('Status').value).toBe('planning')
    expect(isReloadBlocked(), 'a merely-visited form must not hold a deploy').toBe(false)
    // The flip is asserted in the SAME test on purpose: a lone "does not hold" assertion also
    // passes when nothing is wired at all, so it proves nothing on its own. Pairing them makes the
    // clean-mount assertion a real discriminator rather than a green line.
    fireEvent.change(screen.getByLabelText('Project name *'), { target: { value: 'S' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('a typed project name holds the gate AND lands in the stash', async () => {
    await renderPage(<ProjectNew />)
    fireEvent.change(screen.getByLabelText('Project name *'), { target: { value: 'Shishito 2027' } })
    expect(isReloadBlocked()).toBe(true)
    expect(readDraft('projectnew')?.form?.name).toBe('Shishito 2027')
  })

  it('a picked project type is STASHED but does NOT hold the gate — two predicates, not one', async () => {
    await renderPage(<ProjectNew />)
    await waitFor(() => expect(screen.getByText('Tomatoes')).toBeDefined())
    fireEvent.click(screen.getByText('Tomatoes').closest('button'))
    // Broad stash: the pick is captured, so it survives a dismissal.
    expect(readDraft('projectnew')?.form?.project_type_id).toBe('pt-1')
    // Narrow guard: one tap on a chip is not grounds to hold a deploy.
    expect(isReloadBlocked(), 'a chip tap must not hold the SW reload').toBe(false)
  })

  it('unmounting a dirty form RELEASES the hold (never wedge updates)', async () => {
    const { unmount } = await renderPage(<ProjectNew />)
    fireEvent.change(screen.getByLabelText('Project name *'), { target: { value: 'half typed' } })
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('a stashed draft is restored on the next mount', async () => {
    const first = await renderPage(<ProjectNew />)
    fireEvent.change(screen.getByLabelText('Project name *'), { target: { value: 'Interrupted' } })
    first.unmount()
    await renderPage(<ProjectNew />)
    expect(screen.getByLabelText('Project name *').value).toBe('Interrupted')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('InventoryAdd ↔ dirty guard', () => {
  it('a merely-VISITED form does not hold the gate; one keystroke does', async () => {
    await renderPage(<InventoryAdd />)
    expect(isReloadBlocked(), 'a merely-visited form must not hold a deploy').toBe(false)
    fireEvent.change(screen.getByLabelText("What's the item?"), { target: { value: 'P' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('a typed item name holds the gate AND lands in the stash', async () => {
    await renderPage(<InventoryAdd />)
    fireEvent.change(screen.getByLabelText("What's the item?"), { target: { value: 'Pro-Mix HP' } })
    expect(isReloadBlocked()).toBe(true)
    expect(readDraft('inventoryadd')?.form?.name).toBe('Pro-Mix HP')
  })

  it('choosing a type is STASHED but does NOT hold the gate', async () => {
    await renderPage(<InventoryAdd />)
    fireEvent.click(screen.getByText('Consumable'))
    expect(readDraft('inventoryadd')?.form?.type).toBe('consumable')
    expect(isReloadBlocked(), 'an enum pick must not hold the SW reload').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AddSeeds ↔ dirty guard', () => {
  it('a merely-VISITED chooser does not hold the gate; pasted text does', async () => {
    await renderPage(<AddSeeds />)
    expect(screen.getByRole('radio', { name: 'Paste an order' })).toBeDefined()
    expect(isReloadBlocked(), 'a merely-visited chooser must not hold a deploy').toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Paste an order' })) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Order #123' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('opening the paste pane is STASHED but does NOT hold the gate', async () => {
    await renderPage(<AddSeeds />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Paste an order' })) })
    expect(readDraft('addseeds')?.mode).toBe('paste')
    // `mode` alone is navigation, not content — counting it would hold a deploy for a user who
    // opened the textarea and typed nothing.
    expect(isReloadBlocked(), 'opening the pane must not hold the SW reload').toBe(false)
  })

  it('pasted order text holds the gate AND lands in the stash', async () => {
    await renderPage(<AddSeeds />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Paste an order' })) })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Order #123: 6 packets' } })
    expect(isReloadBlocked()).toBe(true)
    expect(readDraft('addseeds')?.pasteText).toBe('Order #123: 6 packets')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('CaptureFlow ↔ dirty guard', () => {
  const stagePhoto = async () => {
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  }

  it('a merely-VISITED Snap does not hold the gate; a staged photo does', async () => {
    await renderPage(<CaptureFlow />)
    // Six seeded fields on arrival: evType 'watering', invType 'consumable', invCat 'other',
    // invQty '1', invUnit 'each', plus evDate set to today. (Was eight — BUG-LOCEVENT400-001 dropped
    // the location destination's locType/locDate along with the event it could never write.) A
    // truthiness guard over any of them would hold every deploy for anyone who opened Snap.
    expect(isReloadBlocked(), 'a merely-visited Snap must not hold a deploy').toBe(false)
    // A staged File is the one piece of state the stash cannot carry, so it is the whole guard.
    await stagePhoto()
    expect(isReloadBlocked()).toBe(true)
  })

  it('a typed planting name is stashed, and the restore refills it WITHOUT restoring step or file', async () => {
    const first = await renderPage(<CaptureFlow />)
    await stagePhoto()
    await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
    await act(async () => {
      fireEvent.change(document.getElementById('cap-plant-name'), { target: { value: 'Charentais' } })
    })
    expect(readDraft('snap')?.plantForm?.name).toBe('Charentais')
    // Neither is serialisable, and restoring step would hand the user a Save button with no file.
    expect(readDraft('snap')).not.toHaveProperty('step')
    expect(readDraft('snap')).not.toHaveProperty('file')
    first.unmount()

    await renderPage(<CaptureFlow />)
    // Back at the photo step (the file is genuinely gone) with the typed name already restored.
    expect(screen.getByTestId('cap-choose')).toBeDefined()
    expect(document.getElementById('cap-plant-name')).toBeNull()
    await stagePhoto()
    await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
    expect(document.getElementById('cap-plant-name').value).toBe('Charentais')
  })

  it('a successful save clears the stash and releases the hold', async () => {
    await renderPage(<CaptureFlow />)
    await stagePhoto()
    await act(async () => { fireEvent.click(screen.getByTestId('mode-inventory')) })
    fireEvent.change(screen.getByTestId('cap-invname'), { target: { value: 'Pro-Mix HP' } })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(screen.getByTestId('cap-result')).toBeDefined())
    expect(readDraft('snap')).toBeNull()
    // `file` is still set at step 'done' — only the step term releases the hold here.
    expect(isReloadBlocked(), 'a landed save has nothing left to protect').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FieldCapture's user-authored text lives in TapCaptureFallback: the page's own queue is already
// durable in IndexedDB, so this component IS the FieldCapture surface for dirty-guard purposes.
describe('FieldCapture / TapCaptureFallback ↔ dirty guard', () => {
  it('a merely-VISITED textarea does not hold the gate; one keystroke does', async () => {
    await renderPage(<TapCaptureFallback onSubmit={vi.fn()} />)
    expect(isReloadBlocked(), 'a merely-visited textarea must not hold a deploy').toBe(false)
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'a' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('typed text holds the gate AND lands in the stash', async () => {
    await renderPage(<TapCaptureFallback onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'aphids on the kale' } })
    expect(isReloadBlocked()).toBe(true)
    expect(readDraft('fieldnote')?.text).toBe('aphids on the kale')
  })

  it('whitespace alone is STASHED but does NOT hold the gate — the guard is the trimmed one', async () => {
    await renderPage(<TapCaptureFallback onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: '   ' } })
    expect(readDraft('fieldnote')?.text).toBe('   ')
    expect(isReloadBlocked(), 'a stray space must not hold the SW reload').toBe(false)
  })

  it('submitting clears the stash and releases the hold', async () => {
    const onSubmit = vi.fn()
    await renderPage(<TapCaptureFallback onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'bean beetles' } })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(screen.getByTestId('tap-capture-submit')) })
    expect(onSubmit).toHaveBeenCalledWith('bean beetles')
    expect(readDraft('fieldnote')).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  it('restores an interrupted note on the next mount', async () => {
    const first = await renderPage(<TapCaptureFallback onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'half a thought' } })
    first.unmount()
    await renderPage(<TapCaptureFallback onSubmit={vi.fn()} />)
    expect(screen.getByTestId('tap-capture-textarea').value).toBe('half a thought')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('TranscriptReview ↔ dirty guard', () => {
  const ENTRY = { id: 'q-1', kind: 'audio', status: 'transcribed', transcript: 'tomatoes are ripe', blob: null }

  it('merely EXPANDING a tile does not hold the gate, even though its textarea is pre-filled', async () => {
    await renderPage(<TranscriptReview entry={ENTRY} />)
    // draft is seeded from entry.transcript, so the textarea is non-empty on arrival. FieldCapture
    // renders a scrollable list of these — a truthiness guard would hold every deploy for a user
    // who did nothing but open one. This is the sharpest false-positive case in the sweep.
    expect(screen.getByTestId('transcript-draft').value).toBe('tomatoes are ripe')
    expect(isReloadBlocked(), 'an expanded-but-unedited tile must not hold a deploy').toBe(false)
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'tomatoes are ripe and split' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('editing the transcript holds the gate, and reverting the edit releases it', async () => {
    await renderPage(<TranscriptReview entry={ENTRY} />)
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'tomatoes are ripe and split' } })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => {
      fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'tomatoes are ripe' } })
    })
    expect(isReloadBlocked(), 'back at the seed value is not a pending edit').toBe(false)
  })
})
