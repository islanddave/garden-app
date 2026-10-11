// BUG-GARDENTAGGROUPREPAINT-001, review I-2 — "+ → Add a planting" must not wait for the tag map.
//
// BottomNav's "+" sends /garden?add=1 from any tab. With a tag grouping remembered Garden holds its list for the tag
// map (Garden.tagGroupHold.test.jsx), and the add sheet sat below that early return: the ?add effect ran and
// stripped the param, and no form was on the page until the hold ended. The sheet is now rendered in the held
// branch too — the SAME sheet, so what is typed during the hold is still there when the list paints under it.
//
// A REAL router (helpers/routerHarness.jsx; OPS-GARDENROUTERMOCK-001 is why) and the REAL tags hook: only `fetch`
// is faked, and the tag map is a request each test answers when it chooses. gate:page-scroll's garden-add flow runs
// with the tags hook inert, so this file is where the add form with the tags API on is held.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, act, cleanup } from '@testing-library/react'
import { renderWithRouter, currentParams, resetRouterHarness } from './helpers/routerHarness.jsx'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
const getToken = async () => 'tok'
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker" /> }))

import Garden from '../pages/Garden.jsx'
import { saveGroupBy, saveGroupsExpanded } from '../lib/projectTree.js'
import { __resetDataCache } from '../lib/dataCache.js'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: null, status: 'growing', quantity: 1, variety_ref: { name: 'Sungold F1', crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Fish', project_id: null, status: 'growing', quantity: 1, variety_ref: { name: 'Fish pepper', crop_type_slug: 'pepper' } },
]
const heat = (slug, label) => ({ id: `t-${slug}`, facet: 'heat', label, slug, source: 'derived' })
const TAGS = { entities: { p1: { direct: [], projected: [heat('mild', 'Mild')] }, p2: { direct: [], projected: [heat('hot', 'Hot')] } } }

let tagMaps        // every tag-map request, in order: { resolve, reject }
const control = () => document.querySelector('select#garden-groupby')
const addForm = () => screen.queryByRole('dialog', { name: 'Add planting' })
const answerTags = () => act(async () => { tagMaps[tagMaps.length - 1].resolve(TAGS) })

beforeEach(() => {
  vi.stubEnv('VITE_API_TAGS', 'https://tags.test')
  tagMaps = []
  localStorage.clear()
  __resetDataCache()
  resetRouterHarness()
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url.startsWith('/api/entity-tags')) return new Promise((resolve, reject) => { tagMaps.push({ resolve, reject }) })
    if (url === '/api/projects') return Promise.resolve(PROJECTS)
    if (url === '/api/plants?view=grid' && !opts.method) return Promise.resolve(PLANTS)
    return Promise.resolve([])
  })
  saveGroupsExpanded(new Set(['tomato', 'pepper', 'mild', 'hot']))
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

// "+ → Add a planting", everything BUT the tag map landed: the list is in hand, the map is the test's to answer.
const openAdd = async () => {
  const view = await renderWithRouter(<Garden />, { route: '/garden?add=1' })
  await act(async () => {})
  expect(tagMaps.length).toBe(1)
  return view
}

describe('"+ → Add a planting" with a tag grouping remembered and the tag map still out', () => {
  beforeEach(() => { saveGroupBy('heat') })

  it('the add form is up at once, over the held page', async () => {
    await openAdd()
    // The list is still held: its loading state, no control, no action row…
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(control()).toBeNull()
    expect(screen.queryByText(/Log many/)).toBeNull()
    // …and the form is on the page, its first field ready, the param spent.
    expect(addForm()).toBeTruthy()
    expect(screen.getByLabelText(/Name/i)).toBeTruthy()
    expect(currentParams().get('add')).toBeNull()
  })

  it('what is typed during the hold is still there when the map lands: the same form, not a new one', async () => {
    await openAdd()
    const name = screen.getByLabelText(/Name/i)
    fireEvent.change(name, { target: { value: 'Typed while the tags were out' } })

    await answerTags()
    expect(control().value).toBe('heat')
    expect(screen.getByText('Mild')).toBeTruthy()
    expect(screen.getByText(/Log many/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByLabelText(/Name/i)).toBe(name)
    expect(name.value).toBe('Typed while the tags were out')
    expect(screen.getAllByRole('dialog', { name: 'Add planting' }).length).toBe(1)
  })

  it('the form closes during the hold, and the page goes on holding', async () => {
    await openAdd()
    await act(async () => { fireEvent.click(addForm().querySelector('[data-sheet-close]')) })
    expect(addForm()).toBeNull()
    expect(screen.getByText('Loading…')).toBeTruthy()
    await answerTags()
    expect(control().value).toBe('heat')
    expect(addForm()).toBeNull()
  })
})

describe('"+ → Add a planting" with a structural grouping remembered', () => {
  it('Type, the tag map still out: the form and the list are both up at once, as they always were', async () => {
    saveGroupBy('crop_type')
    await openAdd()
    expect(addForm()).toBeTruthy()
    expect(control().value).toBe('crop_type')
    expect(screen.getByText(/Log many/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})
