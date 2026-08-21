// V4-COMPOSEPOST-001 — the Today "compose tonight's post" band. Hidden when there is nothing to
// post, composes from the last logging BATCH (not the calendar day), never publishes anything by
// itself, and never writes prose on Dave's behalf.
//
// The second half of this file is V4-COMPOSEPOST-002: one test per defect that reached dev and was
// caught by the 2026-08-10 audit. Each is named for what must never happen again.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
const shareMock = vi.fn()
// canShareFiles is stubbed false here because none of these fixtures carry photos; the photo path has
// its own file (ComposeHarvestBand.photos.test.jsx) where the probe is driven both ways.
vi.mock('../lib/shareEntity.js', () => ({ shareEntity: (...a) => shareMock(...a), canShareFiles: () => false }))
vi.mock('../components/Icon.jsx', () => ({ default: () => null }))
const profileRef = { current: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => ({ user: null, profile: profileRef.current, loading: false }),
}))

import ComposeHarvestBand from '../components/ComposeHarvestBand.jsx'
import { currentGrowYear } from '../lib/growYear.js'

// The line picker is collapsed by default on purpose: rendering at 390px showed 17 rows pushing the
// post and its only action ~1.8 screens down. Tests that touch individual lines open it explicitly,
// which is also the real user path.
const openPicker = async (user) => user.click(screen.getByRole('button', { name: /What.s in the post/ }))

const DAVE = 'user_dave'
const JEN = 'user_jen'
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

// Full-range season totals, as the endpoint's aggregates block returns them.
const AGGREGATES = {
  crops: [
    { crop_name: 'Tomato', crop_type_slug: 'tomato', units: [{ unit: 'count', unit_key: 'count', total: 382, count: 120 }] },
  ],
}

const payload = (entries, aggregates = AGGREGATES) =>
  fetchMock.mockResolvedValue({ entries, aggregates })

beforeEach(() => {
  fetchMock.mockReset()
  shareMock.mockReset()
  shareMock.mockResolvedValue('shared')
  profileRef.current = { id: DAVE }
})

describe('ComposeHarvestBand', () => {
  it('renders nothing when there are no harvests at all', async () => {
    payload([])
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the only recent batch is too old to be "tonight"', async () => {
    payload([entry(ago(19 * 60), 'Moskvich Heirloom', 'Tomato', 2), entry(ago(19 * 60 + 1), 'Big Boy', 'Tomato', 1)])
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
    expect(await screen.findByText(/6 picks/)).toBeTruthy()
  })

  it('asks for recent LOGGING activity and full-range aggregates in one request', async () => {
    payload(BATCH)
    render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = fetchMock.mock.calls[0][0]
    // created_since filters on created_at, so a backdated harvest logged tonight is still included.
    expect(url).toMatch(/created_since=/)
    expect(url).toMatch(/include=entries,aggregates/)
  })

  it('BUG-COMPOSESEASON-001: asks for the season by YEAR — a bare `season` is a 400', async () => {
    // parseTimeframe (lambda/harvests/aggregate.js) matches only /^season:(\d{4})$/. Anything else
    // returns null and index.js answers 400, which this component's catch swallows — so the band
    // just never rendered, silently, for 28 releases. The original URL test asserted created_since
    // and include= but deliberately not the timeframe, which is exactly why nothing caught it.
    payload(BATCH)
    render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = fetchMock.mock.calls[0][0]
    expect(url).toMatch(new RegExp(`timeframe=season:${currentGrowYear(new Date())}(&|$)`))
    // The negative arm matters as much: `toContain('timeframe=season')` passes against the broken
    // string, so pin that the param does NOT end right after `season`.
    expect(url).not.toMatch(/timeframe=season(&|$)/)
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
    expect(ta.value).not.toContain('Peppers:')      // two varieties stay flat
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
    expect(screen.getByText(/Knocked off plant, very green/)).toBeTruthy()
    expect(screen.getByLabelText(/Note for Ukrainian Purple/i).value).toBe('')
    expect(screen.getByLabelText('Post text').value).not.toContain('Knocked off plant')
  })

  it('drops a line from the post when Dave taps it out', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Post text').value).toContain('Cubanelle')
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: /1 Cubanelle/ }))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).not.toContain('Cubanelle'))
  })

  it('adds "1st harvest!" only when Dave marks the line', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Post text').value).not.toContain('1st harvest')
    await openPicker(user)
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
    await openPicker(user)
    await user.click(screen.getAllByRole('button', { name: '1st' })[0])
    expect(screen.getByLabelText('Post text').value).toBe('my own words')
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

// ── V4-COMPOSEPOST-002 — one test per defect that reached dev ─────────────────────────────────────
describe('defects that must never return', () => {
  it('BUG-COMPOSEOWNER-001: never offers one household member another member’s harvest', async () => {
    // The read model is HOUSEHOLD-scoped, so Jen's request returns Dave's rows. Without scoping to the
    // viewer she was shown "Tonight's harvest · 6 picks" built entirely from his batch, in his first
    // person, with a live share button.
    profileRef.current = { id: JEN }
    payload(BATCH)
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('BUG-COMPOSEOWNER-001: composes the viewer’s OWN batch when the household has both', async () => {
    profileRef.current = { id: JEN }
    const jenBatch = [
      { ...entry(ago(5), 'Red Raspberries', 'Raspberry', 4), created_by: JEN },
      { ...entry(ago(4), 'Wild Wineberry', 'Wineberry', 6), created_by: JEN },
    ]
    payload([...BATCH, ...jenBatch])
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    const ta = screen.getByLabelText('Post text')
    expect(ta.value).toContain('Red Raspberries')
    expect(ta.value).not.toContain('1884')
    expect(ta.value).not.toContain('Cubanelle')
  })

  it('renders nothing at all when the viewer is not identified', async () => {
    profileRef.current = null
    payload(BATCH)
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('BUG-COMPOSETOTALS-001: season chips come from aggregates and name their window', async () => {
    // The defect: leadFacts summed the 50-row paginated entries page and published it as a season
    // total — "36 tomatoes" against a true 132. The correct figure was already in the same response.
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByRole('button', { name: '382 tomatoes this season' })).toBeTruthy()
    // 8 tomatoes are in this batch; nothing may publish that batch figure as a season figure.
    expect(screen.queryByRole('button', { name: /^8 tomatoes/ })).toBeNull()
  })

  it('BUG-COMPOSETOTALS-001: emits no season chip when aggregates are absent', async () => {
    payload(BATCH, null)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.queryByRole('button', { name: /this season/ })).toBeNull()
    expect(screen.getByRole('button', { name: '10 picked tonight' })).toBeTruthy()
  })

  it('a pre-checked "1st" can be turned OFF, not only on', async () => {
    // The old additive Set could only add. A row pre-checked from Dave's own first_harvest event type
    // could never be un-checked, which broke the only promise the annotation makes.
    const marked = BATCH.map((r, i) => (i === 0 ? { ...r, event_type: 'first_harvest' } : r))
    payload(marked)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    expect(screen.getByLabelText('Post text').value).toContain('(1st harvest!)')
    await openPicker(user)
    const chips = screen.getAllByRole('button', { name: '1st' })
    const pressed = chips.find((c) => c.getAttribute('aria-pressed') === 'true')
    expect(pressed).toBeTruthy()
    await user.click(pressed)
    await waitFor(() => expect(screen.getByLabelText('Post text').value).not.toContain('1st harvest'))
  })

  it('does not vanish when every line is excluded, and can be recovered', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    await openPicker(user)
    for (const label of [/3 1884/, /2 Moskvich/, /2 San Marzano/, /1 Ukrainian Purple/, /1 Cubanelle/, /1 Piri Piri/]) {
      await user.click(screen.getByRole('button', { name: label }))
    }
    // The band survives with its un-exclude controls intact instead of deleting itself.
    expect(screen.getByTestId('compose-harvest-band')).toBeTruthy()
    expect(screen.getByText(/Everything is left out/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /3 1884/ }))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('1884'))
  })

  it('suppresses a one-item batch rather than offering "tonight’s harvest: 1 tomato"', async () => {
    // N=45 produces a single-item last batch on a straggler evening — the real cost of the threshold.
    payload([entry(ago(200), 'Moskvich Heirloom', 'Tomato', 2), entry(ago(10), 'Big Boy', 'Tomato', 1)])
    const { container } = render(<ComposeHarvestBand />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('never puts a bare integer in the post for a harvest with no name and no crop', async () => {
    const nameless = { ...entry(ago(14), '', '', 2), planting_name: null, variety_name: null, crop_name: null }
    payload([...BATCH, nameless])
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await user.click(await screen.findByRole('button', { name: /Compose post/i }))
    await openPicker(user)
    // Visible in the list so it can be named...
    expect(screen.getByText(/needs a name/)).toBeTruthy()
    // ...and absent from the post body.
    const lines = screen.getByLabelText('Post text').value.split('\n')
    expect(lines.some((l) => /^\s*2\s*$/.test(l))).toBe(false)
  })
})

// ── V4-SEASONRETRO-001 (Track B / B13) ───────────────────────────────────────────────────────────
// The season retrospective shares this band's textarea, share and copy paths — it is a different
// DRAFT, not a different feature. It is also free: the band already fetches
// `timeframe=season:<growYear>&include=aggregates` for the lead-fact chips, and the aggregates block
// is unpaginated, so the retrospective is a second render of data that is already in state.
describe('ComposeHarvestBand — season retrospective', () => {
  // The AGGREGATES fixture above carries no `weekly`, which is what the endpoint returns for a
  // season with nothing in it. That is deliberately kept as the DEFAULT so every pre-existing test
  // in this file also asserts the toggle stays out of the way when there is no season to summarise.
  // Week buckets are relative to NOW, not hardcoded. summarizeSeason compares the last bucket
  // against the real current date to decide whether the garden is still producing, so a fixed date
  // would quietly cross the 14-day threshold and start asserting the opposite of what it says —
  // which is exactly what the first draft of this block did.
  const monday = (weeksAgo) => {
    const d = new Date()
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - weeksAgo * 7)
    return d.toISOString().slice(0, 10)
  }
  const THIS_WEEK = monday(0)
  const LAST_WEEK = monday(1)
  const SEASON_AGGREGATES = {
    weekly: [
      { week_start: LAST_WEEK, count: 4 },
      { week_start: THIS_WEEK, count: 9 },
    ],
    crops: [
      {
        crop_name: 'Tomato', crop_type_slug: 'tomato',
        units: [{ unit: 'count', unit_key: 'count', total: 382, count: 13 }],
        weekly: [{ week_start: LAST_WEEK, count: 4 }, { week_start: THIS_WEEK, count: 9 }],
        varieties: [
          { variety_id: 'v1', variety_name: 'Moskvich Heirloom', units: [{ unit: 'count', unit_key: 'count', total: 60, count: 12 }], unquantified: 0 },
          { variety_id: 'v2', variety_name: 'Floradade', units: [{ unit: 'count', unit_key: 'count', total: 5, count: 1 }], unquantified: 0 },
        ],
      },
    ],
    first_pick: [
      { plant_id: 'p1', planting_name: 'Moskvich Heirloom', crop_type_slug: 'tomato', first_pick_date: LAST_WEEK, units: [{ unit: 'count', unit_key: 'count', total: 60, count: 12 }], unquantified: 0 },
    ],
  }

  const openBand = async (user) =>
    user.click(await screen.findByRole('button', { name: /Compose post/i }))

  it('offers no season draft when the season aggregates are empty', async () => {
    payload(BATCH)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    await waitFor(() => expect(screen.getByLabelText('Post text')).toBeTruthy())
    expect(screen.queryByTestId('compose-mode')).toBeNull()
  })

  it('swaps the draft to the season retrospective and back', async () => {
    payload(BATCH, SEASON_AGGREGATES)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    const box = await screen.findByLabelText('Post text')
    const tonight = box.value
    expect(tonight).toContain('Moskvich')          // non-vacuity: the batch draft really rendered

    await user.click(screen.getByTestId('compose-mode'))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('13 harvests'))
    const retro = screen.getByLabelText('Post text').value
    expect(retro).toContain('Busiest week')
    expect(retro).not.toBe(tonight)

    await user.click(screen.getByTestId('compose-mode'))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toBe(tonight))
  })

  it('reports which draft is showing, for a screen reader as well as a sighted user', async () => {
    payload(BATCH, SEASON_AGGREGATES)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    await screen.findByLabelText('Post text')
    const btn = screen.getByTestId('compose-mode')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.textContent).toMatch(/season/i)
    await user.click(btn)
    await waitFor(() => expect(screen.getByTestId('compose-mode').getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByTestId('compose-mode').textContent).toMatch(/tonight/i)
  })

  it('switching mode REBUILDS rather than silently keeping an edit', async () => {
    // The textarea stops tracking `generated` once Dave edits, so without an explicit dirty reset
    // this button would appear to do nothing at all after any keystroke.
    payload(BATCH, SEASON_AGGREGATES)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    const box = await screen.findByLabelText('Post text')
    await user.click(box)
    await user.keyboard('MY OWN WORDS')
    expect(screen.getByLabelText('Post text').value).toContain('MY OWN WORDS')

    await user.click(screen.getByTestId('compose-mode'))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('13 harvests'))
    expect(screen.getByLabelText('Post text').value).not.toContain('MY OWN WORDS')
  })

  it('shares the SEASON text when the season draft is showing', async () => {
    payload(BATCH, SEASON_AGGREGATES)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    await screen.findByLabelText('Post text')
    await user.click(screen.getByTestId('compose-mode'))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('13 harvests'))
    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(shareMock.mock.calls[0][0].text).toContain('13 harvests')
  })

  it('never writes the garden off while it is still producing', async () => {
    // The single most damaging thing this draft could do is read as an obituary in August.
    payload(BATCH, SEASON_AGGREGATES)
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openBand(user)
    await screen.findByLabelText('Post text')
    await user.click(screen.getByTestId('compose-mode'))
    await waitFor(() => expect(screen.getByLabelText('Post text').value).toContain('13 harvests'))
    expect(screen.getByLabelText('Post text').value).toContain('so far')
  })
})
