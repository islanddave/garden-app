// plantSourceChain.test.jsx — V5-SOURCEPICKER-001. The PLANT chain, end to end, through a real host.
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT PART OF PlantForm.sourcePicker.test.jsx.
//
// PlantForm is a CONTROLLED component: it patches `{ source_id }` up through `onChange` and never
// submits anything. Its own tests correctly assert the patch. But every one of its four host
// builders ENUMERATES the payload keys by hand, and when the picker first landed, none of them named
// the two new ones — so the control rendered, responded, updated form state, and the id could not
// reach the database. The picker looked finished and was a dead control.
//
// That failure is invisible to a component test by construction: the patch WAS correct. It is only
// visible from the host, at the network boundary, which is where this file asserts. The four
// builders are PlantingEditor (two: create and update), ProjectDetail, and CaptureFlow; CaptureFlow
// is driven here because it is the one that mounts the real PlantForm with the real picker and posts
// through a spy-able fetch, so nothing between the tap and the request body is simulated.
//
// The needle is the REQUEST BODY, not a spy call count and not a rendered string — a body that
// omitted the key would look, from every other angle including the UI, exactly like a save that
// worked.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

// Real catalogue rows, and deliberately ones whose names appear NOWHERE else in the rendered tree —
// so an assertion that matches cannot have been satisfied by an unrelated node.
const SOURCES = [
  { id: 'src-gfco', name: 'Greenfield Farmers Co-op', kind: 'retail', locality: 'Greenfield, MA' },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: null },
]
const KINDS = [{ slug: 'retail', display_name: 'Retail', sort_order: 60 }]
const CROPS = [{ slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 }]
const VARIETIES = [{ id: 'var-1', name: 'Charentais', crop_type_slug: 'melon' }]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve([])
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve([])
    if (m === 'GET' && path === '/api/varieties/source-kinds') return Promise.resolve(KINDS)
    if (m === 'GET' && path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (m === 'GET' && path === '/api/varieties/crop-types') return Promise.resolve(CROPS)
    if (m === 'GET' && path.startsWith('/api/varieties')) return Promise.resolve(VARIETIES)
    if (m === 'POST' && path === '/api/plants') return Promise.resolve({ id: 'plant-new', name: 'Ghost' })
    return Promise.resolve({ ok: true })
  })
})

const plantsPost = () => fetchSpy.mock.calls.find(c => c[0] === '/api/plants' && c[1]?.method === 'POST')
const bodyOf = (call) => JSON.parse(call[1].body)

async function snapToPlanting() {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
}

// The provenance fields live inside a disclosure that Snap keeps COLLAPSED by design (fast capture
// is that surface's whole justification). Open it the way a user would rather than reaching past it.
async function openProvenance() {
  const summaries = [...document.querySelectorAll('summary, [role="button"]')]
    .filter(el => /more detail|detail|provenance|source/i.test(el.textContent || ''))
  if (summaries[0]) await act(async () => { fireEvent.click(summaries[0]) })
}

async function pickOrigin(id) {
  const roots = [...document.querySelectorAll('[data-testid="sp-panel"]')]
  expect(roots.length, 'exactly one source panel should be open').toBe(1)
  // Scoped through the one open panel rather than by a global testid: the row is namespaced by the
  // host form's own testid now, and scoping is what the exactly-one assertion above is FOR.
  await act(async () => { fireEvent.click(roots[0].querySelector(`[data-testid$="-opt-${id}"]`)) })
}

describe('V5-SOURCEPICKER-001 — the plant chain reaches the network', () => {
  it('a source chosen on the plant form arrives in the POST /api/plants body', async () => {
    render(<CaptureFlow />)
    await snapToPlanting()
    await openProvenance()

    const nameInput = document.getElementById('cap-plant-name')
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Ghost' } }) })

    // Open the ORIGIN picker. Scoped by its own field so this cannot accidentally drive the venue
    // picker, which is a second instance sharing the same option testids.
    const origin = await waitFor(() => {
      const el = [...document.querySelectorAll('input[role="combobox"]')]
        .find(i => /origin/i.test(i.getAttribute('aria-label') || ''))
      expect(el, 'the Origin combobox should be on the form').toBeDefined()
      return el
    })
    await act(async () => { fireEvent.focus(origin) })
    await act(async () => { fireEvent.change(origin, { target: { value: 'Greenfield' } }) })
    await pickOrigin('src-gfco')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    const post = await waitFor(() => {
      const c = plantsPost()
      expect(c, 'POST /api/plants should have been issued').toBeDefined()
      return c
    })
    const body = bodyOf(post)

    // THE ASSERTION THIS FILE EXISTS FOR. `toHaveProperty` and not a truthiness check: an omitted
    // key and an explicit null are different instructions to the handler, and only the first is the
    // dead-control bug.
    expect(Object.prototype.hasOwnProperty.call(body, 'source_id'),
      'the host builder must NAME source_id — omitting it is the dead-control defect').toBe(true)
    expect(body.source_id).toBe('src-gfco')

    // The free text is a DIFFERENT field and must still ride its own key. If the picker had replaced
    // it rather than joined it, 567 stored order numbers would have nowhere to go.
    expect(Object.prototype.hasOwnProperty.call(body, 'source_ref')).toBe(true)
    // And the transaction axis is untouched — source_type is a different question from source_id.
    expect(Object.prototype.hasOwnProperty.call(body, 'source_type')).toBe(true)
  })

  it('with no source chosen the key is still SENT, as an explicit null', async () => {
    render(<CaptureFlow />)
    await snapToPlanting()
    const nameInput = document.getElementById('cap-plant-name')
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Ghost' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    const post = await waitFor(() => {
      const c = plantsPost()
      expect(c).toBeDefined()
      return c
    })
    const body = bodyOf(post)
    // Present-and-null rather than absent, matching every other optional column this builder sends.
    // The plants PUT reads these by hasOwnProperty, so "absent" and "null" mean different things
    // there; sending the key consistently is what keeps the create and update paths symmetrical.
    expect(Object.prototype.hasOwnProperty.call(body, 'source_id')).toBe(true)
    expect(body.source_id).toBeNull()
    expect(body.acquired_from_source_id).toBeNull()
  })
})
