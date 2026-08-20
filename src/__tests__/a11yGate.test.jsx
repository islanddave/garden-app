// V4-A11YGATE-001 — LAYER 2 of the a11y gate: axe-core over RENDERED components.
//
// Layer 1 (a11yProhibitedAttr.test.js) sweeps all of src/ statically, but only for the one rule a
// static sweep can honestly decide. This layer is the truthful check — real DOM, real computed
// roles, the full rule set in helpers/axe.js — and pays for it in coverage: it only ever sees what
// this file renders.
//
// >>> WHAT THIS GATE COVERS, stated plainly so nobody reads a green run as "the app is accessible":
//     - The components rendered below, in the states rendered below. That is a SMOKE SET, not the
//       app: the shared badges/chips/tiles/uploader/weather surfaces plus the four form primitives
//       every screen is built from.
//     - PAGES ARE NOT COVERED HERE. Harvests, PlantingDetail, EventDetail, FeedPage, GardenActivity
//       and ProjectsAdminClassify each carry fixes from this ledger item, and each is guarded ONLY
//       by Layer 1, i.e. only for aria-prohibited-attr. Rendering them needs their own fetch/router
//       mock scaffolding; adding them here would duplicate it and put an axe pass on the suite's
//       slowest renders. Ratchet: fold `expectNoA11yViolations(container)` into those pages' own
//       existing test files, one page at a time, and measure the cost each time.
//     - Rules deliberately left OFF (contrast, target-size, landmarks, headings…) are listed with
//       their reasons in helpers/axe.js RULES_OFF. Nothing here says anything about them.
//
// A finding is a finding whether axe calls it a violation or "incomplete" — see helpers/axe.js.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(() => Promise.resolve(null)) }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: () => Promise.resolve(null), isUploading: false, error: null }),
}))
// FavoriteToggle reaches for AuthContext, which would drag Clerk into a component smoke test. Stub
// it as a correctly-named button so the tile's a11y shape is preserved — it has its own tests.
vi.mock('../components/FavoriteToggle.jsx', () => ({
  default: () => <button type="button" aria-label="Favorite" />,
}))

import { expectNoA11yViolations, A11Y_RULES } from './helpers/axe.js'
import PlantStatusBadge from '../components/PlantStatusBadge.jsx'
import ProjectStatusBadge from '../components/ProjectStatusBadge.jsx'
import TagChip from '../components/forms/TagChip.jsx'
import CropWeightLine from '../components/CropWeightLine.jsx'
import PlantingTile from '../components/PlantingTile.jsx'
import PhotoUpload from '../components/PhotoUpload.jsx'
import PhotoImg from '../components/PhotoImg.jsx'
import Icon from '../components/Icon.jsx'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import SpaceAttachPicker from '../components/SpaceAttachPicker.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'
import TileGrid from '../components/forms/TileGrid.jsx'

afterEach(() => cleanup())

const w = (o = {}) => ({ grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o })
const PLANTING = { id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia', status: 'growing', quantity: 1, featured_photo_view_url: null }
const WEATHER = { tonightLow: 50, highToday: 78, code: 3, hot: false }
const WET = { recent_precip_in: 1.4, today_precip_in: 0.9, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }
const DRY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 4, tomorrow_precip_in: 0, tomorrow_pop: 6, rain_coming: false }

// [name, element] — one row per surface/state the gate promises to hold.
const SURFACES = [
  // The four sites this ledger item re-roled, each in the state that produced the finding.
  ['PlantStatusBadge growing',    <PlantStatusBadge status="growing" />],
  ['PlantStatusBadge harvesting', <PlantStatusBadge status="harvesting" size="lg" />],
  ['ProjectStatusBadge',          <ProjectStatusBadge status="planning" />],
  ['TagChip plain',               <TagChip tag={{ facet: 'type', slug: 'basil', label: 'Basil' }} />],
  ['TagChip removable',           <TagChip tag={{ facet: 'group', slug: 'herbs', label: 'Herbs', source: 'user' }} onRemove={() => {}} />],
  ['TagChip derived',             <TagChip tag={{ facet: 'type', slug: 'basil', label: 'Basil', source: 'derived' }} onRemove={() => {}} />],
  ['CropWeightLine estimated',    <CropWeightLine weight={w({ grams: 2400, measured_grams: 400, estimated_grams: 2000, measured: 3, estimated: 12 })} />],
  ['CropWeightLine measured',     <CropWeightLine weight={w({ grams: 900, measured_grams: 900, measured: 2 })} />],
  ['CropWeightLine unweighed',    <CropWeightLine weight={w({ unweighed: 2 })} />],
  ['PlantingTile with photos',    <PlantingTile planting={{ ...PLANTING, photo_count: 3 }} />],
  ['PlantingTile no photos',      <PlantingTile planting={PLANTING} />],
  // PhotoUpload: the icon-only single mode is the case that was a hard violation — the <label> had
  // an aria-label it could not carry AND no text of its own, so the control was nameless.
  ['PhotoUpload icon-only',       <PhotoUpload keyPrefix="standalone" buttonLabel={<Icon name="action.camera" decorative />} ariaLabel="Add photo" />],
  ['PhotoUpload text label',      <PhotoUpload keyPrefix="standalone" buttonLabel="Add Photo" />],
  ['PhotoUpload both mode',       <PhotoUpload keyPrefix="standalone" mode="both" />],
  // PhotoImg is the one site where role is computed at runtime, so Layer 1 exempts it by design.
  ['PhotoImg meaningful',         <PhotoImg photoId="p1" initialUrl="https://x/1.jpg" alt="Sungold truss" />],
  ['PhotoImg decorative',         <PhotoImg photoId="p2" initialUrl="https://x/2.jpg" alt="" />],
  ['PhotoImg empty',              <PhotoImg alt="" />],
  ['Icon titled',                 <Icon name="nav.today" title="Today" />],
  ['Icon decorative',             <Icon name="nav.today" decorative />],
  // WeatherWidget is where the WATERWHY blackout happened. Both lane verdicts, both branches.
  ['WeatherWidget dry (water)',   <WeatherWidget weather={WEATHER} hydrology={DRY} waterDueCount={4} />],
  ['WeatherWidget wet (hold)',    <WeatherWidget weather={WEATHER} hydrology={WET} />],
  ['WeatherWidget stamped',       <WeatherWidget weather={WEATHER} hydrology={DRY} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />],
  ['SegmentedControl',            <SegmentedControl options={[{ value: 'plants', label: 'Plants' }, { value: 'photos', label: 'Photos' }]} value="plants" onChange={() => {}} ariaLabel="View" />],
  ['ChoiceGrid',                  <ChoiceGrid layout="grid" ariaLabel="Type" value="" onChange={() => {}} options={[{ value: 'tool', label: 'Tool', icon: '🔧', description: 'e.g. pruners' }, { value: 'consumable', label: 'Consumable', icon: '🧪' }]} />],
  ['TileGrid',                    <TileGrid items={[{ id: 'a', n: 'Basil' }, { id: 'b', n: 'Sage' }]} ariaLabel="Plants" renderItem={(it) => <span>{it.n}</span>} />],
]

describe('a11y gate layer 2 — axe over the rendered smoke set (V4-A11YGATE-001)', () => {
  it.each(SURFACES)('%s is clean under the gate rule set', async (label, el) => {
    const { container } = render(el)
    // An empty render passes axe trivially. Several components here early-return null on a missing
    // or malformed prop (TagChip on !tag, the badges on !status, CropWeightLine on an absent
    // weight), so a fixture that drifts out of shape would go green over nothing at all.
    // This catches "rendered nothing"; it does NOT catch "rendered, but without the element the row
    // exists to cover" — that needs a positive name assertion, and the block further down is where
    // those live. That case is not hypothetical either: the PlantingTile row was first written with
    // a `photoCount` prop the component never reads (it reads planting.photo_count), so the badge
    // row rendered a tile with no badge in it.
    expect(container.querySelectorAll('*').length, `${label} rendered nothing`).toBeGreaterThan(0)
    await expectNoA11yViolations(container, { label })
  })

  // Needs an async render + a wired list, so it does not fit the it.each table above. It is here
  // because it is the surface that carried the repo's largest finding (236 aria-allowed-attr) and
  // Layer 1 is blind to it — that class has nothing to do with aria naming.
  it('SpaceAttachPicker tile grid is clean under the gate rule set', async () => {
    fetchSpy.mockImplementation((path) => (
      path.startsWith('/api/photos?')
        ? Promise.resolve([
            { id: 'p1', caption: 'wide shot', thumb_url: 'https://x/1.jpg', space_id: null },
            { id: 'p2', caption: 'drive', thumb_url: 'https://x/2.jpg', space_id: null },
          ])
        : Promise.resolve(null)
    ))
    const { container } = render(
      <SpaceAttachPicker spaceId="space-1" spaceName="Gardens at Mathews Ridge" onClose={() => {}} onAttached={() => {}} />
    )
    await screen.findByRole('list', { name: 'Photos you can add' })
    await expectNoA11yViolations(container, { label: 'SpaceAttachPicker' })
  })

  // axe going quiet proves the label is no longer PROHIBITED. It does not prove the label now
  // ARRIVES. These do — by role+name, which is the real contract (getByLabelText matches the
  // attribute and passes on a silent element; that is precisely how the WATERWHY blackout stayed
  // invisible). Each line is also the before/after of what a screen reader says.
  describe('the re-roled surfaces are actually NAMED now, not merely un-flagged', () => {
    it.each([
      // [what, was announced BEFORE the fix, role, name announced NOW, element]
      ['PlantStatusBadge', 'Growing', 'img', 'Status: Growing', <PlantStatusBadge status="growing" />],
      ['ProjectStatusBadge', 'Planning', 'img', 'Status: Planning', <ProjectStatusBadge status="planning" />],
      ['CropWeightLine', '900 g', 'img', 'Total harvest weight: 900 g', <CropWeightLine weight={w({ grams: 900, measured_grams: 900, measured: 2 })} />],
      ['PlantingTile photo count', '3', 'img', '3 photos', <PlantingTile planting={{ ...PLANTING, photo_count: 3 }} />],
      ['TagChip', 'Basil', 'group', 'type: Basil', <TagChip tag={{ facet: 'type', slug: 'basil', label: 'Basil' }} />],
    ])('%s announced "%s", now announces %s "%s"', (_what, _before, role, name, el) => {
      render(el)
      expect(screen.getByRole(role, { name })).toBeTruthy()
    })

    it('PhotoUpload icon-only: the name is on the file input, and the label no longer claims it', () => {
      const { container } = render(
        <PhotoUpload keyPrefix="standalone" buttonLabel={<Icon name="action.camera" decorative />} ariaLabel="Add photo" />
      )
      // Before: <label aria-label="Add photo"> with an icon-only body — label has no ARIA role, so
      // nothing carried the name and the control was anonymous.
      expect(container.querySelector('label').hasAttribute('aria-label')).toBe(false)
      expect(screen.getByLabelText('Add photo').tagName).toBe('INPUT')
    })

    it('GardenActivity-style decorative markers stay out of the tree rather than double-announcing', () => {
      // The canary line's only fact ("canary at N%") is printed unconditionally as visible text
      // beside it, so aria-hidden is the correct treatment, not a second role="img" announcement.
      const { container } = render(
        <div>
          <div aria-hidden="true" data-testid="canary" />
          <p>52% accepted (13/25) · canary at 40%</p>
        </div>
      )
      expect(screen.getByTestId('canary').getAttribute('aria-hidden')).toBe('true')
      expect(container.textContent).toContain('canary at 40%')
    })
  })

  it('the rule set is pinned — widening or narrowing it is a deliberate act, not a drift', () => {
    // A silent edit to A11Y_RULES is the one change that could make every test above pass
    // vacuously. aria-prohibited-attr is the reason this gate exists and may never leave the set.
    expect(A11Y_RULES).toContain('aria-prohibited-attr')
    expect(A11Y_RULES).toContain('role-img-alt')
    expect(A11Y_RULES.length).toBe(12)
  })

  it('the gate actually fails: a role-less aria-label is caught, the same shape as the WATERWHY blackout', async () => {
    // Standing proof that a green run above means something. This is the pre-fix markup of the
    // watering lane, byte-for-byte in shape: a div with a label it cannot carry, wrapping
    // aria-hidden children — total silence, and getByLabelText would still have found it.
    const { container } = render(
      <div aria-label="Containers: water — 2 of 3 cans">
        <span aria-hidden="true">Containers</span>
      </div>
    )
    await expect(expectNoA11yViolations(container, { label: 'canary' }))
      .rejects.toThrow(/aria-prohibited-attr/)
  })

  it('the gate catches a nameless icon-only button', async () => {
    const { container } = render(<button type="button"><span aria-hidden="true">✎</span></button>)
    await expect(expectNoA11yViolations(container, { label: 'canary' })).rejects.toThrow(/button-name/)
  })
})
