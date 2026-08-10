// V4-COMPOSEPOST-001 — the Today "compose tonight's post" band. Hidden when there is nothing to
// post, composes from the last logging BATCH (not the calendar day), never publishes anything by
// itself, and never writes prose on Dave's behalf.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
const shareMock = vi.fn()
vi.mock('../lib/shareEntity.js', () => ({ shareEntity: (...a) => shareMock(...a) }))
vi.mock('../components/Icon.jsx', () => ({ default: () => null }))

import ComposeHarvestBand from '../components/ComposeHarvestBand.jsx'

const DAVE = 'user_dave'
// Minutes before "now" so the band's 18h freshness window is satisfied deterministically.
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString()

const entry = (created_at, planting_name, crop_name, quantity, extra = {}) => ({
  event_id: `${planting_name}-${created_at}`,
  event_type: 'harvest',
  created_at,
  created_by: DAVE,
  planting_name,
  variety_name: planting_name,
  crop_name,
  quantity,
  unit: 'count',
  note_excerpt: null,
  ...extra,
})

// Shape of the real 2026-08-06 evening batch: four tomato varieties (-> heading) + two peppers
// (-> flat), plus an earlier same-day cup-unit berry pick that must NOT be swept in.
const BATCH = [
  entry(ago(20), '1884', 'Tomato', 3),
  entry(ago(19), 'Moskvich Heirloom', 'Tomato', 2),
  entry(ago(18), 'San Marzano Roma', 'Tomato', 2),
  entry(ago(17), 'Ukrainian Purple', 'Tomato', 1, { note_excerpt: 'Knocked off plant, very green' }),
  entry(ago(16), 'Cubanelle', 'Pepper', 1),
  entry(ago(15), 'Piri Piri', 'Pepper', 1),
]
const EARLIER = [{ ...entry(ago(600), 'Blueberries', 'Blueberry', 2), unit: 'cup' }]

const payload = (entries) => fetchMock.mockResolvedValue({ entries })

beforeEach(() => { fetchMock.mockReset(); shareMock.mockReset(); shareMock.mockResolvedValue('shared') })

describe('ComposeHarvestBand', () => {
  it('renders nothing when there are no harvests at all', async () => {
    payload([])
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the only recent batch is too old to be "tonight"', async () => {
    payload([entry(ago(19 * 60), 'Moskvich Heirloom', 'Tomato', 2)])
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the batch has no postable (count) rows', async () => {
    payload([{ ...entry(ago(10), 'Blueberries', 'Blueberry', 2), unit: 'cup' }])
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('counts only the batch, not everything logged that day', async () => {
    payload([...EARLIER, ...BATCH])
    render(<ComposeHarvestBand />)
    // 6 picks in the batch; the cup-unit berry pick from ten hours earlier is excluded.
    expect(await screen.findByText(/6 picks/)).toBeTruthy()
  })

  it('swallows a fetch error rather than surfacing it onto Today', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('composes the post in Dave’s shape, and does not publish anything by itself', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))

    const ta = screen.getByLabelText('Post text')
    expect(ta.value).toContain('Tomatoes:')
    expect(ta.value).toContain('  3 1884')
    expect(ta.value).toContain('  2 Moskvich')      // ' Heirloom' stripped
    expect(ta.value).toContain('  2 San Marzano')   // evidence-backed override applied
    expect(ta.value).toContain('1 Cubanelle pepper')
    // Two pepper varieties stay flat — a >=2 heading rule would invent "Peppers:".
    expect(ta.value).not.toContain('Peppers:')
    // Nothing has left the device.
    expect(shareMock).not.toHaveBeenCalled()
  })

  it('starts with an empty lead and never writes prose', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Opening line').value).toBe('')
    expect(screen.getByLabelText('Post text').value.startsWith('Tomatoes:')).toBe(true)
  })

  it('offers the logged note as a suggestion but never publishes it verbatim', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    // The raw note is shown as context...
    expect(screen.getByText(/Knocked off plant, very green/)).toBeTruthy()
    // ...and the annotation field is empty, so nothing clinical reaches the post unedited.
    expect(screen.getByLabelText(/Note for Ukrainian Purple/i).value).toBe('')
    expect(screen.getByLabelText('Post text').value).not.toContain('Knocked off plant')
  })

  it('drops a line from the post when Dave taps it out', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Post text').value).toContain('Cubanelle')
    await user.click(screen.getByRole('button', { name: /1 Cubanelle/ }))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).not.toContain('Cubanelle'))
  })

  it('adds "1st harvest!" only when Dave marks the line', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Post text').value).not.toContain('1st harvest')
    await user.click(screen.getAllByRole('button', { name: '1st' })[0])
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('(1st harvest!)'))
  })

  it('keeps Dave’s hand edits when a toggle changes underneath them', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    const ta = screen.getByLabelText('Post text')
    await user.clear(ta)
    await user.type(ta, 'my own words')
    await user.click(screen.getAllByRole('button', { name: '1st' })[0])
    expect(screen.getByLabelText('Post text').value).toBe('my own words')
    // ...and there is an explicit way back to the generated version.
    await user.click(screen.getByRole('button', { name: /Rebuild from selections/i }))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('Tomatoes:'))
  })

  it('hands the post text to the share sheet, with no app URL attached', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    const arg = shareMock.mock.calls[0][0]
    expect(arg.text).toContain('Tomatoes:')
    expect(arg.url).toBeUndefined()
  })
})
