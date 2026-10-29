// V5-SEEDLOTADDITION-001 (seed release 3) — FLAG OFF (contract T20). SEED_ADD_TO_LOT false is this
// release's forward undo, and it has to be the sheet release 2b shipped: no link in the From block,
// no request to either new route, and a Save seed whose every request body is the one the flag-on
// sheet sends for the same inputs. "The same inputs" are helpers/saveSeedSameInputs.js, which
// SaveSeedSheet.addToLot.test.jsx drives with both flags on and compares with the same list.
//
// ONE static mock, SEED_MULTI_PARENT on and SEED_ADD_TO_LOT off. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, toastSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(), navigateSpy: vi.fn(), toastSpy: vi.fn(),
}))

vi.mock('../lib/featureFlags.js', async (o) => ({ ...(await o()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: false }))
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
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker-stub" /> }))
vi.mock('../components/forms', async (importActual) => ({
  ...(await importActual()),
  PlantingSelect: (props) => (
    <div data-testid={props['data-testid']}>
      <button type="button" data-testid="offer-second" onClick={() => props.onChange(S_SECOND.id, S_SECOND)}>second</button>
    </div>
  ),
}))

import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
import { addToLotAvailable } from '../components/seed/seedAdditions.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { plantSeedLot } from './fixtures/seedMix.fixture.js'
import { S_FIRST, S_SECOND, sameInputSaves, sameInputSteps, sameInputReply, sameInputSent } from './helpers/saveSeedSameInputs.js'

const OWN = plantSeedLot()
const onClose = vi.fn()
const onSeedAdded = vi.fn()
const newRoutes = () => apiFetchSpy.mock.calls.filter(([url]) => /seed-lots-open|seed-additions/.test(String(url)))

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); toastSpy.mockReset(); onClose.mockReset(); onSeedAdded.mockReset()
  apiFetchSpy.mockImplementation((url, opts) => Promise.resolve(sameInputReply(url, opts)))
})

const mount = () => render(
  <SaveSeedSheet planting={S_FIRST} onClose={onClose} onSeedAdded={onSeedAdded} ownLots={[OWN]} />,
)
const save = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
}
const STEPS = sameInputSteps(mount, save)
const EXPECTED = sameInputSaves(todayLocalISO().slice(0, 4))

describe('SEED_ADD_TO_LOT off — the sheet is release 2b\'s', () => {
  it('the one reader answers off, with SEED_MULTI_PARENT still on', () => {
    expect(addToLotAvailable()).toBe(false)
  })

  it('no link in the From block, whatever lots the host passes, and the From block is still there', () => {
    mount()
    expect(screen.getByTestId('save-seed-from')).toBeTruthy()
    expect(screen.getByTestId('save-seed-add-plant')).toBeTruthy()
    expect(screen.queryByTestId('save-seed-put-in-lot')).toBeNull()
    expect(screen.queryByTestId('seed-lot-list-heading')).toBeNull()
    expect(screen.queryByTestId('seed-add-going-into')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Put it in/)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it.each(Object.keys(EXPECTED))('%s: every request is the flag-on one, and neither new route is asked', async (name) => {
    await STEPS[name]()
    expect(newRoutes()).toEqual([])
    expect(sameInputSent(apiFetchSpy)).toEqual(EXPECTED[name])
    expect(onSeedAdded).not.toHaveBeenCalled()
  })
})
