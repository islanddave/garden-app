// QuickTagCarousel.test.jsx — V4-PHOTOBULK-001 S6.
//
// Dave's brief for this surface, verbatim: "review in the app the unassigned photos one at a time
// and assign them to plants." So the load-bearing assertions are about the DECK — that it advances
// exactly one photo per assignment, that it does NOT advance past a failure, and that the shortcut
// row learns from what has been assigned so a garden walk collapses to one tap per photo.
//
// THE UNDO SEMANTICS ARE THE SUBTLE PART AND ARE PINNED DELIBERATELY. "Back" reopens the previous
// photo for RE-assignment; it does not return the photo to the inbox. That is not a product
// preference, it is what the server can express: PUT /api/photos/:id sets
// `intake_status = CASE WHEN setsParent THEN NULL ELSE p.intake_status END`, so clearing the parent
// again leaves a parentless row with intake_status NULL — precisely what photos_must_have_parent
// forbids — and the route never reads body.intake_status. A test asserting "Back un-tags the photo"
// would be asserting a 23514.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../components/photo/PhotoView.jsx', () => ({
  default: ({ photo, alt }) => <img data-testid="qt-photo" data-photo-id={photo?.id} alt={alt} />,
}))
// The real picker is a 1400-line component with its own fetch and placement machinery. Stubbed to a
// bare select: this file is about the DECK, and PlantingSelect has its own suites.
vi.mock('../components/forms/PlantingSelect.jsx', () => ({
  default: ({ plants, onChange, disabled }) => (
    <select data-testid="qt-picker" disabled={disabled} onChange={e => onChange(e.target.value)} defaultValue="">
      <option value="">—</option>
      {plants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  ),
}))
vi.mock('../context/DismissRegistry.jsx', () => ({
  useDismissable: ({ onDismiss }) => ({ isTopmost: true, requestDismiss: onDismiss }),
}))

import QuickTagCarousel from '../components/photo/QuickTagCarousel.jsx'

const PLANTS = [
  { id: 'pl1', name: 'Bhut Jolokia', project_id: 'pr1' },
  { id: 'pl2', name: 'Sungold',      project_id: 'pr2' },
  { id: 'pl3', name: 'Genovese Basil', project_id: 'pr1' },
]
const deck = (n) => Array.from({ length: n }, (_, i) => ({
  id: `ph${i + 1}`, storage_path: `s/${i + 1}.jpg`, created_at: `2026-08-29T1${i}:00:00Z`,
  intake_status: 'pending_tag', caption: null,
}))

beforeEach(() => {
  apiFetchSpy.mockReset()
  apiFetchSpy.mockResolvedValue({ ok: true })
})

function mount(props = {}) {
  return render(
    <QuickTagCarousel
      photos={deck(3)}
      plants={PLANTS}
      seedTargets={[]}
      apiFetch={apiFetchSpy}
      onAssigned={props.onAssigned ?? vi.fn()}
      onClose={props.onClose ?? vi.fn()}
      {...props}
    />
  )
}

const shortcuts = () => screen.queryAllByTestId('quicktag-shortcut').map(b => b.textContent)
const currentPhoto = () => screen.getByTestId('qt-photo').getAttribute('data-photo-id')

async function pickOther(plantId) {
  await act(async () => { fireEvent.click(screen.getByTestId('quicktag-other')) })
  await act(async () => { fireEvent.change(screen.getByTestId('qt-picker'), { target: { value: plantId } }) })
}

describe('QuickTagCarousel — one photo at a time', () => {
  it('shows the first photo and how many are left', () => {
    mount()
    expect(currentPhoto()).toBe('ph1')
    expect(screen.getByTestId('quicktag-progress').textContent).toBe('1 of 3 · 3 to go')
  })

  it('assigning a plant PUTs that photo and advances exactly one', async () => {
    const onAssigned = vi.fn()
    mount({ onAssigned })
    await pickOther('pl1')

    expect(apiFetchSpy).toHaveBeenCalledTimes(1)
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/photos/ph1')
    expect(opts.method).toBe('PUT')
    const body = JSON.parse(opts.body)
    expect(body.plant_id).toBe('pl1')
    expect(body.project_id).toBe('pr1')          // derived from the planting, not asked for
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    expect(onAssigned).toHaveBeenCalledWith('ph1', 'pl1', expect.objectContaining({ id: 'pl1' }))
  })

  it('does NOT advance past a failed assignment', async () => {
    apiFetchSpy.mockRejectedValueOnce(new Error('network went away'))
    mount()
    await pickOther('pl1')

    // Advancing here would leave ph1 silently untagged inside a deck the user believes they
    // finished — the "it said it worked" failure this whole track keeps hitting.
    expect(currentPhoto()).toBe('ph1')
    expect(await screen.findByTestId('quicktag-error')).toBeTruthy()
    expect(screen.getByTestId('quicktag-error').textContent).toMatch(/network went away/)
  })

  it('Skip advances without writing anything — the photo stays pending', async () => {
    mount()
    await act(async () => { fireEvent.click(screen.getByTestId('quicktag-skip')) })
    expect(currentPhoto()).toBe('ph2')
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('reaching the end shows a flat statement — no completion celebration', async () => {
    mount({ photos: deck(1) })
    await act(async () => { fireEvent.click(screen.getByTestId('quicktag-skip')) })
    expect(screen.getByTestId('quicktag-empty').textContent).toMatch(/last of them/i)
    // Reward UX rule: a completion badge/animation/count-up here would be a reward surface.
    expect(screen.queryByTestId('quicktag-shortcuts')).toBeNull()
    expect(screen.getByTestId('quicktag-progress').textContent).toMatch(/Nothing left/i)
  })
})

describe('QuickTagCarousel — the shortcut row is what makes it fast', () => {
  it('starts from the seed, so the first photo already has targets', () => {
    mount({ seedTargets: ['pl2', 'pl3'] })
    expect(shortcuts()).toEqual(['Sungold', 'Genovese Basil'])
  })

  it('learns: an assigned planting moves to the front and is not duplicated', async () => {
    mount({ seedTargets: ['pl2', 'pl3'] })
    await act(async () => { fireEvent.click(screen.getAllByTestId('quicktag-shortcut')[1]) })  // Genovese
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    // MRU first, seed after, deduped — the just-used one leads and appears exactly once.
    expect(shortcuts()).toEqual(['Genovese Basil', 'Sungold'])
  })

  it('orders by MOST-RECENT: the second choice leads the first', async () => {
    // TWO assignments, because with one MRU entry front-insert and back-insert are indistinguishable
    // — a mutation run proved the single-assignment test above passes either way. Order is only
    // observable once the list has two entries, and order is the entire value of an MRU: a garden
    // walk moves between a few plants, and the one just used is the likeliest next.
    mount({ seedTargets: [] })
    await pickOther('pl1')                                   // Bhut Jolokia
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    await pickOther('pl2')                                   // Sungold
    await waitFor(() => expect(currentPhoto()).toBe('ph3'))
    expect(shortcuts()).toEqual(['Sungold', 'Bhut Jolokia'])
  })

  it('a target chosen through the full picker also joins the shortcuts', async () => {
    mount({ seedTargets: [] })
    expect(shortcuts()).toEqual([])
    await pickOther('pl1')
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    expect(shortcuts()).toEqual(['Bhut Jolokia'])
  })

  it('ignores seed ids that do not resolve to a live planting', () => {
    mount({ seedTargets: ['gone-1', 'pl2'] })
    expect(shortcuts()).toEqual(['Sungold'])
  })
})

describe('QuickTagCarousel — Back reopens, it does not un-tag', () => {
  it('Back is unavailable on the first photo', () => {
    mount()
    expect(screen.getByTestId('quicktag-undo').disabled).toBe(true)
  })

  it('Back steps to the previous photo and writes NOTHING', async () => {
    mount()
    await pickOther('pl1')
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    apiFetchSpy.mockClear()

    await act(async () => { fireEvent.click(screen.getByTestId('quicktag-undo')) })

    expect(currentPhoto()).toBe('ph1')
    // THE POINT: no request. Un-tagging would need intake_status restored to 'pending_tag', which
    // this route cannot express — clearing the parent leaves a parentless row with a NULL
    // intake_status and photos_must_have_parent rejects it. Back is a correction affordance.
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('re-assigning after Back overwrites the first choice on the SAME photo', async () => {
    mount()
    await pickOther('pl1')
    await waitFor(() => expect(currentPhoto()).toBe('ph2'))
    await act(async () => { fireEvent.click(screen.getByTestId('quicktag-undo')) })
    apiFetchSpy.mockClear()

    await act(async () => { fireEvent.click(screen.getAllByTestId('quicktag-shortcut')[0]) })

    expect(apiFetchSpy).toHaveBeenCalledTimes(1)
    expect(apiFetchSpy.mock.calls[0][0]).toBe('/api/photos/ph1')   // same photo, corrected
  })

  it('says what Back will do, but only when the previous photo was actually assigned', async () => {
    mount()
    await act(async () => { fireEvent.click(screen.getByTestId('quicktag-skip')) })   // ph1 skipped
    expect(screen.queryByTestId('quicktag-undo-hint')).toBeNull()

    await pickOther('pl1')                                                            // ph2 assigned
    await waitFor(() => expect(currentPhoto()).toBe('ph3'))
    expect(screen.getByTestId('quicktag-undo-hint').textContent).toMatch(/assign it somewhere else/i)
  })
})

describe('QuickTagCarousel — the deck is frozen at mount', () => {
  it('does not renumber when the parent list changes underneath', async () => {
    const photos = deck(3)
    const { rerender } = render(
      <QuickTagCarousel photos={photos} plants={PLANTS} seedTargets={[]}
        apiFetch={apiFetchSpy} onAssigned={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByTestId('quicktag-progress').textContent).toBe('1 of 3 · 3 to go')
    // The parent drops a photo (it drained). The deck must NOT shrink under the user's finger —
    // "1 of 3" turning into "1 of 2" mid-drain is disorienting and makes the count untrustworthy.
    rerender(
      <QuickTagCarousel photos={photos.slice(0, 2)} plants={PLANTS} seedTargets={[]}
        apiFetch={apiFetchSpy} onAssigned={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByTestId('quicktag-progress').textContent).toBe('1 of 3 · 3 to go')
  })
})
