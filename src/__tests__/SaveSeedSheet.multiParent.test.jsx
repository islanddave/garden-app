// V5-SEEDMULTIPARENT-001 release 2b — the Save seed sheet keeps a SET of plantings.
//
// WHAT IS PINNED HERE is the rule the whole release hangs on: DERIVE, DO NOT SEED. The variety, the
// default lot name, the adder's crop and the legacy source_plant_id used to be read once at mount.
// That was already wrong at the Seeds door (picking a plant changed neither the name nor the variety)
// and becomes wrong at every door once a row can be removed: a jar that came off plant B would stay
// filed under plant A's variety and name a parent no longer in the set. So every case below changes
// the set and then reads what the sheet shows AND what it sends.
//
// The siblings own the rest: SaveSeedSheet.mix.test.jsx the mix call and every refusal,
// SaveSeedSheet.events.test.jsx the timeline writes, SaveSeedSheet.seedMeasure.test.jsx the plant
// count's request. The last describe here is the FLAG-OFF pin: SEED_MULTI_PARENT false must render
// and send exactly what shipped before this release, because the flag is its forward undo.
//
// PlantingSelect is stubbed for the agnostic file's reason (it self-fetches) and one more: the stub
// offers EVERY planting in `garden.plants`, whatever its crop, so a test can build a set the real
// crop-filtered picker would never offer. What the sheet ASKS the picker for is read off the props
// (crop, excluded ids, empty text, footer); that the picker honours them is PlantingSelect.exclude's
// job, and EventNew.seedSaveDoor.test.jsx drives the real one end to end. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, toastSpy, flags, garden } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(),
  flags: { multi: true }, garden: { plants: [] },
}))

// A getter rather than the bare literal, so ONE file can hold both halves: the flag is read on every
// render and by seedParents.js on every call. SaveSeedSheet.backNav.test.jsx does the same.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SEED_MULTI_PARENT() { return flags.multi },
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => apiFetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../context/ToastContext.jsx', () => ({
  useOptionalToast: () => ({ show: toastSpy }),
  useToast: () => ({ show: toastSpy }),
}))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value, onChange }) => (
    <div data-testid="variety-picker-stub">
      <span data-testid="variety-picker-value">{value?.id ?? 'none'}</span>
      <button
        type="button" data-testid="stub-pick-variety"
        onClick={() => onChange({ id: 'v-hand', name: 'Empress of India', breeding_system: 'open_pollinated' })}
      >
        pick variety
      </button>
    </div>
  ),
}))
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: (props) => (
    <div
      data-testid={props['data-testid']}
      data-crop={props.cropSlug ?? ''}
      data-exclude={(props.excludeIds ?? []).join(',')}
      data-empty={props.emptyText ?? ''}
      data-footer={props.footerNote ?? ''}
      data-auto-open={String(!!props.autoOpen)}
    >
      {garden.plants.map((p) => (
        <button key={p.id} type="button" data-testid={`offer-${p.id}`} onClick={() => props.onChange(p.id, p)}>
          {p.name}
        </button>
      ))}
    </div>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { T } from '../components/forms/formStyles.js'

const YEAR = todayLocalISO().slice(0, 4)

const V_JEWEL = { id: 'v-jewel', name: 'Jewel Mix Nasturtium', crop_type_slug: 'nasturtium', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const V_ALASKA = { id: 'v-alaska', name: 'Alaska Mix', crop_type_slug: 'nasturtium', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const JEWEL = { id: 'pl-jewel', name: 'Jewel Mix Nasturtium', quantity: 2, variety_id: 'v-jewel', variety_ref: V_JEWEL }
const JEWEL_2 = { id: 'pl-jewel2', name: 'Jewel Mix Nasturtium 2', quantity: 1, variety_id: 'v-jewel', variety_ref: V_JEWEL }
const ALASKA = { id: 'pl-alaska', name: 'Alaska Mix Nasturtium 1', quantity: 7, variety_id: 'v-alaska', variety_ref: V_ALASKA }
const ONE_PLANT = { id: 'pl-one', name: 'Lone Jewel', quantity: 1, variety_id: 'v-jewel', variety_ref: V_JEWEL }
const NO_VARIETY = { id: 'pl-vol', name: 'Volunteer squash', quantity: 1 }
// R2B-CONTRACT O-4: a soft-deleted variety arrives as an id with no joined row.
const VARIETY_GONE = { id: 'pl-gone', name: 'Old bed row', quantity: 3, variety_id: 'v-gone', variety_ref: null }
const NO_CROP = { id: 'pl-nocrop', name: 'Mystery vine', quantity: 1, variety_id: 'v-nc', variety_ref: { id: 'v-nc', name: 'Mystery', crop_type_slug: null } }

// Both names already say "mix", so the joined name takes no " mix" of its own (blend.js's rule).
const MIX_NAME = 'Alaska Mix + Jewel Mix Nasturtium'
const MIX_REASON = 'These plants are recorded under different varieties, so this lot is filed as a mix.'

const onClose = vi.fn()
const mount = (planting) => render(<SaveSeedSheet planting={planting} onClose={onClose} />)

const rowNames = () => screen.queryAllByTestId('save-seed-from-row').map((li) => li.querySelector('span').textContent)
const removeLabels = () => screen.queryAllByTestId('save-seed-from-remove').map((b) => b.getAttribute('aria-label'))
const nameValue = () => screen.getByTestId('save-seed-name').value
const varietyShown = () => screen.queryByTestId('save-seed-variety-name')?.textContent ?? null
const openAdder = () => fireEvent.click(screen.getByTestId('save-seed-add-plant'))
const addPlanting = (p) => { openAdder(); fireEvent.click(screen.getByTestId(`offer-${p.id}`)) }
const removePlanting = (p) => fireEvent.click(screen.getByRole('button', { name: `Remove ${p.name}` }))
const submit = () => fireEvent.click(screen.getByTestId('save-seed-submit'))

const callsTo = (path, method) => apiFetchSpy.mock.calls
  .filter(([p, o]) => String(p) === path && (!method || o?.method === method))
const lotBody = () => JSON.parse(callsTo('/api/inventory-items', 'POST')[0][1].body)

beforeEach(() => {
  flags.multi = true
  garden.plants = [JEWEL, JEWEL_2, ALASKA]
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset()
  apiFetchSpy.mockResolvedValue({ id: 'inv-9' })
})

describe('the "From" block, opened from a planting', () => {
  it('lists the planting as the one row, with no way to remove it, and costs no request', () => {
    mount(JEWEL)
    expect(screen.getByText('From')).toBeTruthy()
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium'])
    // The sheet was opened FOR this planting: its row carries no remove control.
    expect(screen.queryAllByTestId('save-seed-from-remove')).toHaveLength(0)
    // The one-line "From <planting> — the lot remembers…" gave way to the block.
    expect(screen.queryByText(/the lot remembers which plant/)).toBeNull()
    expect(screen.getByTestId('save-seed-add-plant').textContent).toBe('+ Add seed from another plant')
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('the adder asks the picker for the set’s crop, without the plantings already chosen', () => {
    mount(JEWEL)
    // Closed until asked for: the picker fetches the planting list when it mounts.
    expect(screen.queryByTestId('save-seed-add-select')).toBeNull()
    openAdder()
    const picker = screen.getByTestId('save-seed-add-select')
    expect(picker.getAttribute('data-crop')).toBe('nasturtium')
    expect(picker.getAttribute('data-exclude')).toBe('pl-jewel')
    expect(picker.getAttribute('data-empty')).toBe('No other nasturtium plantings to add.')
    expect(picker.getAttribute('data-footer'))
      .toBe('A plant with no variety recorded is not listed here. Give it a variety first.')
    // The tap that asked for the list is the gesture that opens it: no second tap on the field.
    expect(picker.getAttribute('data-auto-open')).toBe('true')
    expect(screen.getByText('Your other nasturtium plantings')).toBeTruthy()
    expect(screen.getByTestId('save-seed-add-plant').getAttribute('aria-expanded')).toBe('true')
  })

  it('a crop slug is spoken as words', () => {
    const pepper = { ...JEWEL, variety_ref: { ...V_JEWEL, crop_type_slug: 'sweet_pepper' } }
    mount(pepper)
    openAdder()
    expect(screen.getByTestId('save-seed-add-select').getAttribute('data-empty'))
      .toBe('No other sweet pepper plantings to add.')
    expect(screen.getByText('Your other sweet pepper plantings')).toBeTruthy()
  })

  it('adding a planting adds a removable row named for it, and leaves it out of the next list', () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium', 'Jewel Mix Nasturtium 2'])
    // Only the added row: the page's own planting stays fixed.
    expect(removeLabels()).toEqual(['Remove Jewel Mix Nasturtium 2'])
    // The picker closes on a pick, and the next one opened leaves out both chosen plantings.
    expect(screen.queryByTestId('save-seed-add-select')).toBeNull()
    openAdder()
    expect(screen.getByTestId('save-seed-add-select').getAttribute('data-exclude')).toBe('pl-jewel,pl-jewel2')
  })

  it('a pick hands focus to the adder once the picker is gone, so the next Tab stays inside the sheet', () => {
    // The picker unmounts with the pick, and its field goes while focused: typed in, or handed focus by
    // the click itself, because the picker sits inside a <label> and the browser focuses a label's
    // field AFTER the click's own handlers have run. Left alone, focus falls to <body>, and the sheet's
    // Tab trap wraps only at its first and last control. The order is modelled here: the handler, then
    // focus arriving inside the picker, and only then React's commit (one act), so focus moved by the
    // handler itself would be taken back and lost.
    mount(JEWEL)
    openAdder()
    const offer = screen.getByTestId(`offer-${JEWEL_2.id}`)
    act(() => {
      fireEvent.click(offer)
      offer.focus()
    })
    expect(screen.queryByTestId('save-seed-add-select')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('save-seed-add-plant'))
  })

  it('the same planting cannot be added twice', () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    addPlanting(JEWEL_2)
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium', 'Jewel Mix Nasturtium 2'])
  })

  it('removing a row takes it back out', () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    removePlanting(JEWEL_2)
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium'])
    expect(screen.queryAllByTestId('save-seed-from-remove')).toHaveLength(0)
  })

  it('nothing is requested while plantings are added and removed', () => {
    // The mix is made at Save, for the set being saved. A request per pick would leave a mix behind
    // for every set passed through on the way, in a variety list every picker in the app reads.
    mount(JEWEL)
    addPlanting(ALASKA)
    addPlanting(JEWEL_2)
    removePlanting(ALASKA)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('the remove and add controls are full tap targets', () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    const remove = screen.getByTestId('save-seed-from-remove')
    expect(remove.style.minHeight).toBe(`${T.tapMinHeight}px`)
    expect(remove.style.minWidth).toBe(`${T.tapMinHeight}px`)
    expect(screen.getByTestId('save-seed-add-plant').style.minHeight).toBe(`${T.tapMinHeight}px`)
  })
})

describe('one variety across the plantings: filed under it', () => {
  it('two plantings of one variety keep the variety, its "Change", and send both as parents', async () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    expect(varietyShown()).toBe('Jewel Mix Nasturtium')
    expect(screen.getByTestId('save-seed-variety-change')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-mix-reason')).toBeNull()
    expect(nameValue()).toBe(`Jewel Mix Nasturtium — saved ${YEAR}`)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    // No mix: the first request is the lot.
    expect(callsTo('/api/varieties/blend')).toHaveLength(0)
    expect(apiFetchSpy.mock.calls[0][0]).toBe('/api/inventory-items')
    const body = lotBody()
    expect(body.variety_id).toBe('v-jewel')
    expect(body.source_plant_ids).toEqual(['pl-jewel', 'pl-jewel2'])
    // The legacy key is the FIRST row, built from the same array.
    expect(body.source_plant_id).toBe('pl-jewel')
  })

  it('says "From 2 plantings of X." under today’s breeding line, in the one block above Save', () => {
    mount(JEWEL)
    addPlanting(JEWEL_2)
    const blocks = screen.getAllByTestId('breeding-notice')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].getAttribute('data-breeding')).toBe('open_pollinated')
    expect(blocks[0].textContent).toContain('Open-pollinated')
    expect(blocks[0].textContent).toContain('From 2 plantings of Jewel Mix Nasturtium.')
    const save = screen.getByTestId('save-seed-submit')
    expect(blocks[0].compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('one planting says nothing new: the block is today’s line alone', () => {
    mount(JEWEL)
    const block = screen.getByTestId('breeding-notice')
    expect(block.textContent)
      .toBe('Open-pollinated — its seed comes true, as long as it did not cross with something flowering nearby.')
    expect(screen.queryAllByTestId('breeding-notice-set')).toHaveLength(0)
  })

  it('an F1 across two plantings keeps the F1 warning and adds the count', () => {
    const f1 = { ...V_JEWEL, id: 'v-f1', name: 'Big Boy', crop_type_slug: 'tomato', breeding_system: 'f1' }
    const a = { id: 'pl-a', name: 'Big Boy east', quantity: 1, variety_ref: f1 }
    const b = { id: 'pl-b', name: 'Big Boy west', quantity: 1, variety_ref: f1 }
    garden.plants = [a, b]
    mount(a)
    addPlanting(b)
    const block = screen.getByTestId('breeding-notice')
    expect(block.getAttribute('data-breeding')).toBe('f1')
    expect(block.textContent).toContain('F1 hybrid')
    expect(block.textContent).toContain('From 2 plantings of Big Boy.')
  })
})

describe('two or more varieties: the jar is a mix', () => {
  it('shows the joined names at once, no "Change", and the one-line reason', () => {
    mount(JEWEL)
    addPlanting(ALASKA)
    expect(varietyShown()).toBe(MIX_NAME)
    expect(screen.queryByTestId('save-seed-variety-change')).toBeNull()
    expect(screen.queryByTestId('save-seed-variety-picker')).toBeNull()
    expect(screen.getByTestId('save-seed-mix-reason').textContent).toBe(MIX_REASON)
    expect(nameValue()).toBe(`${MIX_NAME} — saved ${YEAR}`)
  })

  it('removing the second variety puts the one variety, its name and "Change" back', () => {
    mount(JEWEL)
    addPlanting(ALASKA)
    removePlanting(ALASKA)
    expect(varietyShown()).toBe('Jewel Mix Nasturtium')
    expect(screen.getByTestId('save-seed-variety-change')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-mix-reason')).toBeNull()
    expect(nameValue()).toBe(`Jewel Mix Nasturtium — saved ${YEAR}`)
  })

  it('the lot name follows the mix ONLY while it has not been typed in', () => {
    mount(JEWEL)
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Front bed nasturtiums' } })
    addPlanting(ALASKA)
    expect(nameValue()).toBe('Front bed nasturtiums')
    removePlanting(ALASKA)
    expect(nameValue()).toBe('Front bed nasturtiums')
    // The variety still follows the set: only the NAME became the user's.
    expect(varietyShown()).toBe('Jewel Mix Nasturtium')
  })

  it('the block above Save speaks for the set, and does not repeat the reason under the Variety row', () => {
    mount(JEWEL)
    addPlanting(ALASKA)
    const block = screen.getByTestId('breeding-notice')
    // No single variety's line is true of a mixed jar, so today's line is not printed.
    expect(block.hasAttribute('data-breeding')).toBe(false)
    expect(block.textContent).not.toContain('Open-pollinated')
    expect(block.textContent).toBe(
      'Mixed seed from Alaska Mix and Jewel Mix Nasturtium. Each seed came off one or the other, '
      + 'and some may be crosses. Expect more than one kind of plant from this lot.')
    expect(block.textContent).not.toContain(MIX_REASON)
    expect(screen.getAllByText(MIX_REASON)).toHaveLength(1)
  })

  it('two F1 varieties: the set’s two sentences, and no single-variety F1 line', () => {
    const f1a = { id: 'v-fa', name: 'Big Boy', crop_type_slug: 'tomato', breeding_system: 'f1', variety_rank: 'cultivar' }
    const f1b = { id: 'v-fb', name: 'Sungold', crop_type_slug: 'tomato', breeding_system: 'f1', variety_rank: 'cultivar' }
    const a = { id: 'pl-a', name: 'Big Boy east', quantity: 1, variety_ref: f1a }
    const b = { id: 'pl-b', name: 'Sungold west', quantity: 1, variety_ref: f1b }
    garden.plants = [a, b]
    mount(a)
    addPlanting(b)
    const said = screen.getAllByTestId('breeding-notice-set').map((s) => s.textContent)
    expect(said).toHaveLength(2)
    expect(said[0]).toMatch(/^Mixed seed from Big Boy and Sungold\./)
    expect(said[1]).toBe('Every plant here is an F1 hybrid, so none of this seed will come true.')
    expect(screen.getByTestId('breeding-notice').textContent).not.toContain('Worth saving if you want to see')
  })
})

describe('a variety picked by hand is kept apart from the set’s', () => {
  it('wins while the plantings are one variety, yields to a mix, and comes back when the mix goes', async () => {
    mount(JEWEL)
    fireEvent.click(screen.getByTestId('save-seed-variety-change'))
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    expect(screen.getByTestId('variety-picker-value').textContent).toBe('v-hand')

    // A second variety: the mix is shown and the picker is gone, because a hand choice would be
    // refused at Save. The hand choice is not thrown away.
    addPlanting(ALASKA)
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
    expect(varietyShown()).toBe(MIX_NAME)

    // Back to one variety: NOT the plant's own variety, the one that was chosen.
    removePlanting(ALASKA)
    expect(screen.getByTestId('variety-picker-value').textContent).toBe('v-hand')
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotBody().variety_id).toBe('v-hand')
    expect(callsTo('/api/varieties/blend')).toHaveLength(0)
  })

  it('the notice follows the Variety row, not the plant, on a one-variety set', () => {
    const f1 = { ...V_JEWEL, breeding_system: 'f1' }
    mount({ ...JEWEL, variety_ref: f1 })
    expect(screen.getByTestId('breeding-notice').getAttribute('data-breeding')).toBe('f1')
    fireEvent.click(screen.getByTestId('save-seed-variety-change'))
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    expect(screen.getByTestId('breeding-notice').getAttribute('data-breeding')).toBe('open_pollinated')
  })

  it('the lot name still follows the SET, not the hand-picked variety', () => {
    mount(JEWEL)
    fireEvent.click(screen.getByTestId('save-seed-variety-change'))
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    expect(nameValue()).toBe(`Jewel Mix Nasturtium — saved ${YEAR}`)
  })
})

describe('the adder is not offered where it could only mislead', () => {
  it('a first plant with no variety: no adder, and the picker says why a variety is needed', async () => {
    mount(NO_VARIETY)
    expect(rowNames()).toEqual(['Volunteer squash'])
    expect(screen.queryByTestId('save-seed-add-plant')).toBeNull()
    expect(screen.getByTestId('save-seed-no-variety')).toBeTruthy()
    submit()
    await act(async () => {})
    expect(apiFetchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('save-seed-error').textContent).toMatch(/has to name one/)
  })

  it('a planting whose variety was deleted is treated as having none (O-4)', async () => {
    // variety_id is set and the joined row is null. Filing the jar under a variety that shows
    // nowhere would be the silent version; the sheet asks instead.
    mount(VARIETY_GONE)
    expect(screen.queryByTestId('save-seed-add-plant')).toBeNull()
    expect(screen.getByTestId('save-seed-no-variety')).toBeTruthy()
    expect(screen.getByTestId('variety-picker-value').textContent).toBe('none')
    expect(nameValue()).toBe(`Old bed row — saved ${YEAR}`)
    submit()
    await act(async () => {})
    expect(apiFetchSpy).not.toHaveBeenCalled()
    // A variety picked by hand makes it saveable, with the planting still the parent.
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotBody().variety_id).toBe('v-hand')
    expect(lotBody().source_plant_ids).toEqual(['pl-gone'])
  })

  it('a variety with no crop: no adder, because the list could not be narrowed', () => {
    mount(NO_CROP)
    expect(varietyShown()).toBe('Mystery')
    expect(screen.queryByTestId('save-seed-add-plant')).toBeNull()
  })

  it('stops offering at twelve plantings, the most one jar can name', () => {
    const many = Array.from({ length: 11 }, (_, i) => (
      { id: `pl-m${i}`, name: `Jewel row ${i}`, quantity: 1, variety_ref: V_JEWEL }))
    garden.plants = many
    mount(JEWEL)
    for (const p of many.slice(0, 10)) addPlanting(p)
    expect(rowNames()).toHaveLength(11)
    expect(screen.getByTestId('save-seed-add-plant')).toBeTruthy()
    addPlanting(many[10])
    expect(rowNames()).toHaveLength(12)
    expect(screen.queryByTestId('save-seed-add-plant')).toBeNull()
  })
})

// The crop-filtered adder cannot list a planting with no variety, so this set is reachable only when a
// planting changed after the picker listed it. The stub offers it regardless, which is how the sheet's
// behaviour in that state gets a test at all.
describe('a set the real picker would not have offered: a plant with no variety beside one with', () => {
  it('is not a mix: one variety to file under, no mix call, and the route’s refusal names the plant', async () => {
    garden.plants = [NO_VARIETY]
    apiFetchSpy.mockImplementation((path) => (String(path) === '/api/inventory-items'
      ? Promise.reject(Object.assign(new Error('server sentence'), {
        status: 400, body: { error: 'server sentence', code: 'parent_without_variety', plant_id: 'pl-vol' },
      }))
      : Promise.resolve({ id: 'x' })))
    mount(JEWEL)
    addPlanting(NO_VARIETY)
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium', 'Volunteer squash'])
    // One variety the mix route could be given is not two: the jar stays filed under it.
    expect(varietyShown()).toBe('Jewel Mix Nasturtium')
    expect(screen.queryByTestId('save-seed-mix-reason')).toBeNull()
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(callsTo('/api/varieties/blend')).toHaveLength(0)
    expect(lotBody().variety_id).toBe('v-jewel')
    expect(screen.getByTestId('save-seed-error').textContent)
      .toBe("Volunteer squash has no variety recorded, so it can't share a lot. Remove it, or save it as its own lot.")
  })

  it('the block above Save does not print the one variety’s line over a set that is two kinds of plant', () => {
    // Truth-table row 10: the set says "Mixed seed from …", and "its seed comes true" would sit
    // directly above it contradicting it.
    garden.plants = [NO_VARIETY]
    mount(JEWEL)
    addPlanting(NO_VARIETY)
    const block = screen.getByTestId('breeding-notice')
    expect(block.textContent).toMatch(/^Mixed seed from Jewel Mix Nasturtium and a plant with no variety recorded\./)
    expect(block.textContent).not.toContain('Open-pollinated')
    expect(block.hasAttribute('data-breeding')).toBe(false)
  })
})

describe('a planting-less door (Seeds, and the standalone Saved seeds host)', () => {
  const pickFirst = (p) => {
    fireEvent.click(screen.getByTestId('seed-origin-plant'))
    fireEvent.click(within('seed-plant-select', p))
  }
  const within = (pickerId, p) => screen.getByTestId(pickerId).querySelector(`[data-testid="offer-${p.id}"]`)

  it('fills the variety and the name from the first pick, and closes the variety picker', () => {
    mount()
    // Nothing chosen: the default name, and the picker open because there is no variety to show.
    expect(nameValue()).toBe(`Saved seed ${YEAR}`)
    expect(screen.getByTestId('variety-picker-stub')).toBeTruthy()
    pickFirst(JEWEL)
    expect(rowNames()).toEqual(['Jewel Mix Nasturtium'])
    expect(nameValue()).toBe(`Jewel Mix Nasturtium — saved ${YEAR}`)
    expect(varietyShown()).toBe('Jewel Mix Nasturtium')
    expect(screen.queryByTestId('variety-picker-stub')).toBeNull()
  })

  it('every row is removable, the first included', () => {
    mount()
    pickFirst(JEWEL)
    addPlanting(ALASKA)
    expect(removeLabels()).toEqual(['Remove Jewel Mix Nasturtium', 'Remove Alaska Mix Nasturtium 1'])
  })

  it('removing the FIRST pick re-derives everything from what is left, and that is what is sent', async () => {
    mount()
    pickFirst(JEWEL)
    addPlanting(ALASKA)
    removePlanting(JEWEL)
    expect(rowNames()).toEqual(['Alaska Mix Nasturtium 1'])
    expect(varietyShown()).toBe('Alaska Mix')
    expect(nameValue()).toBe(`Alaska Mix — saved ${YEAR}`)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const body = lotBody()
    // The jar came off Alaska: neither its variety nor its parent may still be Jewel's.
    expect(body.variety_id).toBe('v-alaska')
    expect(body.source_plant_id).toBe('pl-alaska')
    expect(body.source_plant_ids).toEqual(['pl-alaska'])
    expect(body.name).toBe(`Alaska Mix — saved ${YEAR}`)
  })

  it('with two rows the legacy key is the FIRST one picked, and both are in the set', async () => {
    // MUTATION: build source_plant_id from the last pick and this goes red; with a planting prop
    // the first row is the prop either way, so only a planting-less door can tell the two apart.
    mount()
    pickFirst(JEWEL)
    addPlanting(JEWEL_2)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotBody().source_plant_id).toBe('pl-jewel')
    expect(lotBody().source_plant_ids).toEqual(['pl-jewel', 'pl-jewel2'])
    // One event per row here too, in the same order.
    expect(callsTo('/api/events', 'POST').map(([, o]) => JSON.parse(o.body).plant_id))
      .toEqual(['pl-jewel', 'pl-jewel2'])
  })

  it('removing the last row returns to "Which plant?" with everything typed still there', () => {
    mount()
    pickFirst(JEWEL)
    fireEvent.change(screen.getByTestId('save-seed-name'), { target: { value: 'Hedge nasturtiums' } })
    fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '40' } })
    fireEvent.change(screen.getByTestId('save-seed-weight'), { target: { value: '2.5 g' } })
    fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('save-seed-process-dry'))
    removePlanting(JEWEL)

    expect(screen.getByText('Which plant?')).toBeTruthy()
    expect(screen.getByTestId('seed-plant-select')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-from')).toBeNull()
    expect(nameValue()).toBe('Hedge nasturtiums')
    expect(screen.getByTestId('save-seed-count').value).toBe('40')
    expect(screen.getByTestId('save-seed-weight').value).toBe('2.5 g')
    expect(screen.getByTestId('save-seed-process-dry').getAttribute('aria-pressed')).toBe('true')
    // And the plant count is still there when a planting is chosen again.
    fireEvent.click(within('seed-plant-select', JEWEL))
    expect(screen.getByTestId('save-seed-plant-count').value).toBe('2')
  })

  it('an untouched name goes back to the default when the last row is removed', () => {
    mount()
    pickFirst(JEWEL)
    removePlanting(JEWEL)
    expect(nameValue()).toBe(`Saved seed ${YEAR}`)
  })

  it('"Somewhere else" shows no From block and no plant count', () => {
    mount()
    fireEvent.click(screen.getByTestId('seed-origin-other'))
    expect(screen.queryByTestId('save-seed-from')).toBeNull()
    expect(screen.queryByTestId('save-seed-plant-count')).toBeNull()
  })
})

describe('the plant count: asked only when the rows do not already answer it', () => {
  const LABEL = 'About how many separate plants did you gather this seed from?'
  const HELPER = 'Single plants, not the plantings listed above. Count each plant once, however often you picked from it. Leave it blank if you can\'t say.'
  const helperText = () => screen.getByTestId('save-seed-plant-count-note').textContent.replace(/\s+/g, ' ').trim()

  it('one planting holding exactly one plant: no field at all', () => {
    mount(ONE_PLANT)
    expect(screen.queryByTestId('save-seed-plant-count')).toBeNull()
    expect(screen.queryByText(LABEL)).toBeNull()
  })

  it('reads a quantity of "1.000" (numeric off the wire) as one plant', () => {
    mount({ ...ONE_PLANT, quantity: '1.000' })
    expect(screen.queryByTestId('save-seed-plant-count')).toBeNull()
  })

  it('one planting holding several plants: the field, blank, with the label, helper and hint', () => {
    mount(JEWEL)
    const field = screen.getByTestId('save-seed-plant-count')
    // Never prefilled, and no example digit standing in the field.
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBeNull()
    expect(field.getAttribute('inputmode')).toBe('numeric')
    expect(screen.getByText(LABEL)).toBeTruthy()
    expect(helperText().startsWith(HELPER)).toBe(true)
    expect(screen.getByTestId('save-seed-plant-count-hint').textContent).toBe('This planting holds 2 plants today.')
  })

  it('two plantings: the hint adds them up', () => {
    mount(JEWEL)
    addPlanting(ALASKA)
    expect(screen.getByTestId('save-seed-plant-count-hint').textContent)
      .toBe('These 2 plantings hold 9 plants today.')
    expect(screen.getByTestId('save-seed-plant-count').value).toBe('')
  })

  it('two plantings of one plant each: the field, and no hint (the rows already say it)', () => {
    mount(ONE_PLANT)
    addPlanting(JEWEL_2)
    expect(screen.getByTestId('save-seed-plant-count')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-plant-count-hint')).toBeNull()
    expect(helperText()).toBe(HELPER)
  })

  it('no hint when any planting’s quantity is unknown: a partial sum would be a wrong number', () => {
    garden.plants = [{ ...ALASKA, quantity: null }]
    mount(JEWEL)
    addPlanting(ALASKA)
    expect(rowNames()).toHaveLength(2)
    expect(screen.getByTestId('save-seed-plant-count')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-plant-count-hint')).toBeNull()
  })

  it('sits in the From block, above the seed count it must not be confused with', () => {
    mount(JEWEL)
    const plants = screen.getByTestId('save-seed-plant-count')
    const seeds = screen.getByTestId('save-seed-count')
    expect(screen.getByTestId('save-seed-from').contains(plants)).toBe(true)
    expect(plants.compareDocumentPosition(seeds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // And the seed field now says what it counts.
    expect(seeds.closest('label').textContent).toMatch(/^How many seeds\? \(optional\)/)
  })

  it.each([['0'], ['1.5'], ['-2']])('refuses %s before any request', async (typed) => {
    mount(JEWEL)
    fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: typed } })
    submit()
    await act(async () => {})
    expect(screen.getByTestId('save-seed-error').textContent).toBe('A plant count is a whole number, 1 or more.')
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a number past the column’s 9999 before any request', async () => {
    mount(JEWEL)
    fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: '10000' } })
    submit()
    await act(async () => {})
    expect(screen.getByTestId('save-seed-error').textContent).toBe('A plant count can be 9999 at most.')
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('a count typed for two plantings is NOT sent once its field is gone', async () => {
    // Typed while two plantings were chosen, then one was removed and the field with it. A number
    // the sheet no longer shows must not ride along on the save.
    mount(ONE_PLANT)
    addPlanting(JEWEL_2)
    fireEvent.change(screen.getByTestId('save-seed-plant-count'), { target: { value: '2' } })
    removePlanting(JEWEL_2)
    expect(screen.queryByTestId('save-seed-plant-count')).toBeNull()
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(apiFetchSpy.mock.calls.filter(([p]) => String(p).endsWith('/seed-measure'))).toHaveLength(0)
  })
})

// ── FLAG OFF ────────────────────────────────────────────────────────────────────────────────────
// SEED_MULTI_PARENT is this release's forward undo, so OFF has to be the sheet that shipped before it:
// nothing added to the screen and every request body byte-equal. The bodies below are compared as
// STRINGS (key order included), against literals typed from the pre-release save().
describe('SEED_MULTI_PARENT off — the sheet renders and sends exactly what it did', () => {
  const PL = {
    id: 'pl1', project_id: 'proj1', name: 'Brandywine #2', status: 'fruiting', quantity: 4,
    variety_id: 'v-brandywine',
    variety_ref: { id: 'v-brandywine', name: 'Brandywine', crop_type_slug: 'tomato', breeding_system: 'open_pollinated' },
  }
  beforeEach(() => { flags.multi = false })
  afterEach(() => { flags.multi = true })

  it('renders the one-line "From", and none of the new controls', () => {
    mount(PL)
    expect(screen.getByText('From Brandywine #2 — the lot remembers which plant it came off.')).toBeTruthy()
    for (const id of ['save-seed-from', 'save-seed-from-row', 'save-seed-from-remove', 'save-seed-add-plant',
      'save-seed-add-select', 'save-seed-plant-count', 'save-seed-mix-reason', 'breeding-notice-set']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.getByTestId('save-seed-count').closest('label').textContent).toMatch(/^How many\? \(optional\)/)
    expect(screen.getByTestId('save-seed-variety-name').textContent).toBe('Brandywine')
    expect(screen.getByTestId('save-seed-variety-change')).toBeTruthy()
    expect(screen.getByTestId('breeding-notice').textContent)
      .toBe('Open-pollinated — its seed comes true, as long as it did not cross with something flowering nearby.')
  })

  it('the lot POST body is byte-equal to the pre-release body: no source_plant_ids', async () => {
    mount(PL)
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(callsTo('/api/varieties/blend')).toHaveLength(0)
    const [path, opts] = apiFetchSpy.mock.calls[0]
    expect(path).toBe('/api/inventory-items')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBe(JSON.stringify({
      name: `Brandywine — saved ${YEAR}`,
      category: 'seeds',
      type: 'consumable',
      unit: 'packet',
      quantity_on_hand: 1,
      variety_id: 'v-brandywine',
      source_plant_id: 'pl1',
    }))
  })

  it('the measure, stage and event bodies are byte-equal too, in the same order', async () => {
    mount(PL)
    fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '185' } })
    fireEvent.change(screen.getByTestId('save-seed-weight'), { target: { value: '2.5' } })
    fireEvent.click(screen.getByTestId('save-seed-process-wet'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(apiFetchSpy.mock.calls.map(([p, o]) => `${o.method} ${p}`)).toEqual([
      'POST /api/inventory-items',
      'PUT /api/inventory-items/inv-9/seed-measure',
      'POST /api/inventory-items/inv-9/seed-stage',
      'POST /api/events',
    ])
    expect(apiFetchSpy.mock.calls[1][1].body)
      .toBe(JSON.stringify({ seed_count: 185, seed_count_estimated: false, seed_weight_g: 2.5 }))
    expect(apiFetchSpy.mock.calls[2][1].body)
      .toBe(JSON.stringify({ stage: 'fermenting', seed_process: 'wet' }))
    expect(apiFetchSpy.mock.calls[3][1].body).toBe(JSON.stringify({
      plant_id: 'pl1',
      event_type: 'seed_saved',
      event_date: todayLocalISO(),
      notes: `Seed lot "Brandywine — saved ${YEAR}", fermenting. No count yet — recorded when it's marked stored.`,
      metadata: { seed_lot_id: 'inv-9' },
    }))
    expect(toastSpy.mock.calls[0][0]).toEqual({ message: 'Seed lot saved', tone: 'success' })
  })

  it('a failed measure keeps the pre-release wording, "the count"', async () => {
    apiFetchSpy.mockImplementation((path) => (String(path).endsWith('/seed-measure')
      ? Promise.reject(new Error('boom')) : Promise.resolve({ id: 'inv-9' })))
    mount(PL)
    fireEvent.change(screen.getByTestId('save-seed-count'), { target: { value: '185' } })
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0])
      .toEqual({ message: "Seed lot saved — couldn't record the count", tone: 'error' })
  })

  it('a failed create prints what the request threw, as it did', async () => {
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('variety_id is required for seeds'), { status: 400 }))
    mount(PL)
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(screen.getByTestId('save-seed-error').textContent).toBe('variety_id is required for seeds')
  })

  it('a 409 parents_changed is NOT retried', async () => {
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('One of those plants changed just now. Reload and try again.'),
      { status: 409, body: { error: 'x', code: 'parents_changed' } }))
    mount(PL)
    submit()
    await waitFor(() => expect(screen.getByTestId('save-seed-error')).toBeTruthy())
    expect(callsTo('/api/inventory-items', 'POST')).toHaveLength(1)
  })

  it('a variety_id with no joined row still seeds the bare id (the pre-release rule)', async () => {
    mount({ id: 'pl-gone', name: 'Old bed row', variety_id: 'v-gone', variety_ref: null })
    expect(screen.getByTestId('save-seed-variety-name').textContent).toBe("this planting's variety")
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(lotBody().variety_id).toBe('v-gone')
  })

  it('at a planting-less door a pick is seeded-once as before: neither the name nor the variety moves', async () => {
    mount()
    fireEvent.click(screen.getByTestId('seed-origin-plant'))
    fireEvent.click(screen.getByTestId('offer-pl-jewel'))
    expect(screen.getByText('From Jewel Mix Nasturtium — the lot remembers which plant it came off.')).toBeTruthy()
    expect(nameValue()).toBe(`Saved seed ${YEAR}`)
    expect(screen.getByTestId('variety-picker-value').textContent).toBe('none')
    fireEvent.click(screen.getByTestId('stub-pick-variety'))
    submit()
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(apiFetchSpy.mock.calls[0][1].body).toBe(JSON.stringify({
      name: `Saved seed ${YEAR}`,
      category: 'seeds',
      type: 'consumable',
      unit: 'packet',
      quantity_on_hand: 1,
      variety_id: 'v-hand',
      source_plant_id: 'pl-jewel',
    }))
    expect(callsTo('/api/events', 'POST')).toHaveLength(1)
  })
})
