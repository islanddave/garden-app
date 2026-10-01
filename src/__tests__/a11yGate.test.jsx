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
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

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
// The Put-Up 1a sheets read the signed-in person for their draft key; a signed-out stub keeps Clerk
// out of this smoke test the same way the FavoriteToggle stub does (the sheets simply keep no draft).
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

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
import KindChips from '../components/kitchen/KindChips.jsx'
import StartBatchSheet from '../components/kitchen/StartBatchSheet.jsx'
import CheckOnItSheet from '../components/putup/CheckOnItSheet.jsx'
import PutItUpSheet from '../components/putup/PutItUpSheet.jsx'
import MoveJarSheet from '../components/putup/MoveJarSheet.jsx'
import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import LineSheet from '../components/putup/LineSheet.jsx'
import StageEditSheet from '../components/putup/StageEditSheet.jsx'
import ShuSheet from '../components/putup/ShuSheet.jsx'

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

  // ── Put-Up 1a (V4 §6.6: "new components join the a11y smoke set", with `nested-interactive` on the
  // new components' entries). Each is rendered in its FULLEST state — every optional section open —
  // because a closed disclosure is an audit of nothing.
  describe('Put-Up 1a — the new sheets and chips', () => {
    const NEW_RULES = [...A11Y_RULES, 'nested-interactive']
    const PLACES = [{ id: 'loc-1', label: 'Fridge', kind: 'fridge' }, { id: 'loc-2', label: 'Chest Freezer 1', kind: 'deep_freezer' }]
    const batch = (kind) => ({ id: `kb-${kind ?? 'none'}`, label: 'Pepper mash', kind, suspended_at: null, closed_at: null })

    it('KindChips, Other chosen, is clean (with nested-interactive)', async () => {
      const { container } = render(<KindChips value="other" onChange={() => {}} otherText="" onOtherTextChange={() => {}} />)
      expect(screen.getByRole('group', { name: 'What kind of batch?' })).toBeTruthy()
      await expectNoA11yViolations(container, { label: 'KindChips', rules: NEW_RULES })
    })

    it.each([['ferment'], ['dehydrate'], [null]])('CheckOnItSheet (%s), places loaded, is clean (with nested-interactive)', async (kind) => {
      fetchSpy.mockImplementation((path) => Promise.resolve(path === '/api/storage-locations' ? PLACES : null))
      const { container } = render(<CheckOnItSheet open batch={batch(kind)} onClose={() => {}} onSaved={() => {}} />)
      await screen.findByRole('group', { name: 'Moved it' })
      expect(screen.getByRole('dialog', { name: 'Check on it' })).toBeTruthy()
      await expectNoA11yViolations(container, { label: `CheckOnItSheet ${kind}`, rules: NEW_RULES })
    })

    it('StartBatchSheet, Earlier… → Pick a date and the kind row open, is clean (with nested-interactive)', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(null))
      const { container } = render(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} />)
      screen.getByTestId('start-when-earlier').click()
      await screen.findByTestId('start-when-pickdate')
      screen.getByTestId('start-when-pickdate').click()
      screen.getByTestId('start-kind-toggle').click()
      await screen.findByTestId('start-kind-other')
      expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy()
      await expectNoA11yViolations(container, { label: 'StartBatchSheet', rules: NEW_RULES })
    })

    // Put-Up release 1b (V4 §6.6). Two rows, the first one's disclosure open, the sitting's More open,
    // Earlier… open — every control the sheet can show at once.
    it('PutItUpSheet, two rows, every disclosure open, is clean (with nested-interactive)', async () => {
      fetchSpy.mockImplementation((path) => Promise.resolve(path === '/api/storage-locations' ? PLACES : null))
      const { container } = render(<PutItUpSheet open batch={batch('ferment')} onClose={() => {}} onDone={() => {}} />)
      await screen.findByTestId('putup-row-0-place-id:loc-1')
      screen.getByTestId('putup-when-earlier').click()
      await screen.findByTestId('putup-when-pickdate')
      screen.getByTestId('putup-method-hot_sauce').click()
      screen.getByTestId('putup-row-0-place-id:loc-1').click()
      screen.getByTestId('putup-row-add').click()
      await screen.findByTestId('putup-row-1-same')
      screen.getByTestId('putup-row-0-more').click()
      screen.getByTestId('putup-sitting-more').click()
      await screen.findByTestId('putup-row-0-ph-input')
      expect(screen.getByRole('dialog', { name: 'Put it up' })).toBeTruthy()
      await expectNoA11yViolations(container, { label: 'PutItUpSheet', rules: NEW_RULES })
    })

    // Put-Up release F (06 §4 layout gates; V4 §6.6 "new components join the a11y smoke set"): batch
    // detail with What went in (a planting chosen, More open), the Salt block (a step with the % typed),
    // Jar & heat open and a Log entry; then the line sheet, the Log's edit sheet and the heat sheet.
    describe('Put-Up release F — batch detail and its sheets', () => {
      const FB = { id: 'kb-f', user_id: 'u', label: 'Petri Dish', kind: 'ferment', started_at: '2026-09-25T13:00:00.000Z', start_precision: 'day',
        first_recorded_at: '2026-09-25T13:00:00.000Z', suspended_at: null, closed_at: null, current_stage_kind: 'started', input_count: '2',
        output_count: '0', garden_names: ['Megatron jalapeño'], vessel_label: 'Quart jar', vessel_count: 1, shu_est_low: 949, shu_est_high: 3036, shu_est_basis: 'computed' }
      const LINES = [
        { id: 'l1', input_kind: 'garden', plant_id: 'p1', label: 'Megatron jalapeño', qty: '170', qty_unit: 'g', form: 'fresh', ordinal: 1, from_garden: true, put_up_stage_id: null, role: null },
        { id: 'l2', input_kind: 'other', label: 'Water', qty: '250', qty_unit: 'ml', role: 'water', ordinal: 2, put_up_stage_id: null },
      ]
      const STAGES = [{ id: 's1', stage_kind: 'started', entered_at: '2026-09-25T13:00:00.000Z', entered_precision: 'day', amount: null, amount_unit: null },
        { id: 's2', stage_kind: 'tended', entered_at: '2026-09-28T13:00:00.000Z', acts: ['skimmed'], note: 'film', cue_observed: 'All under' }]
      const HITS = { plantings: [{ plant_id: 'p9', label: 'Serranos', crop_type_slug: 'pepper', variety_id: 'v9', recent_picks: [{ harvest_log_id: 'h1', picked_on: '2026-09-27', qty: '230', qty_unit: 'g' }] }], put_ups: [] }

      it('batch detail, every F block open, is clean (with nested-interactive)', async () => {
        fetchSpy.mockImplementation((path) => Promise.resolve(String(path).includes('line-search') ? HITS : null))
        const { container } = render(<BatchDetailView batch={FB} inputs={LINES} stages={STAGES} outputs={[]} loading={false} error={false}
          nowMs={Date.parse('2026-10-02T13:00:00Z')} onChanged={() => {}} />)
        fireEvent.change(screen.getByTestId('line-add-name'), { target: { value: 'ser' } })
        await screen.findByTestId('line-add-hit-planting:p9', {}, { timeout: 2000 })
        screen.getByTestId('line-add-hit-planting:p9').click()
        await screen.findByTestId('line-add-pick-h1')
        screen.getByTestId('line-add-more').click()
        await screen.findByTestId('line-add-more-panel')
        fireEvent.change(screen.getByTestId('salt-step-0-pct'), { target: { value: '3.5' } })
        screen.getByTestId('jar-heat-summary').click()
        await screen.findByTestId('jar-heat-panel')
        await expectNoA11yViolations(container, { label: 'BatchDetailView F', rules: NEW_RULES })
      })

      it('the line sheet, the Log edit sheet and the heat sheet are clean (with nested-interactive)', async () => {
        fetchSpy.mockImplementation((path) => Promise.resolve(String(path).includes('shu-estimate')
          ? { low: 949, high: 3036, denominator_g: 448, denominator_source: 'lines', breakdown: [{ line_id: 'l1', label: 'Megatron jalapeño', grams: 170, form: 'fresh', factor_low: 1, factor_high: 1, rating_low: 2500, rating_high: 8000, rating_source: 'variety' }], not_counted: [{ label: 'Water' }] }
          : null))
        let r = render(<LineSheet open batchId="kb-f" line={LINES[0]} onClose={() => {}} />)
        await expectNoA11yViolations(r.container, { label: 'LineSheet', rules: NEW_RULES })
        cleanup()
        r = render(<StageEditSheet open batch={FB} stage={STAGES[1]} onClose={() => {}} />)
        await expectNoA11yViolations(r.container, { label: 'StageEditSheet', rules: NEW_RULES })
        cleanup()
        r = render(<ShuSheet open batchId="kb-f" scope="batch" onClose={() => {}} onType={() => {}} />)
        await screen.findByTestId('shu-figure')
        await expectNoA11yViolations(r.container, { label: 'ShuSheet', rules: NEW_RULES })
      })
    })

    // Put-Up UX pass R1: Move it is a PANEL inside the Pantry row sheet (a named group, not a dialog of its
    // own). Fullest state: a place tapped so the rule line is said, Earlier… → Pick a date open.
    it('the Move panel (MoveJarSheet), a place tapped and Earlier… → Pick a date open, is clean (with nested-interactive)', async () => {
      fetchSpy.mockImplementation((path) => Promise.resolve(path === '/api/storage-locations' ? PLACES : null))
      const { container } = render(<MoveJarSheet open jar={{ id: 'pl-1', label: 'Megatron reaper', storage_location_id: 'loc-1',
        storage_kind: 'fridge', use_by_target: '2027-02-01', use_by_basis: 'table' }}
        onClose={() => {}} onMoved={() => {}} />)
      fireEvent.click(await screen.findByTestId('move-place-id:loc-2'))
      expect(screen.getByTestId('move-rule').textContent).not.toBe('')
      screen.getByTestId('move-when-earlier').click()
      await screen.findByTestId('move-when-pickdate')
      screen.getByTestId('move-when-pickdate').click()
      await screen.findByTestId('move-when-date')
      expect(screen.getByRole('group', { name: 'Move it' })).toBeTruthy()
      expect(screen.queryByRole('dialog')).toBeNull()
      await expectNoA11yViolations(container, { label: 'MoveJarSheet', rules: NEW_RULES })
    })
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

    it('PhotoUpload icon-only: the name is on the trigger button, and no <label> claims it', () => {
      const { container } = render(
        <PhotoUpload keyPrefix="standalone" buttonLabel={<Icon name="action.camera" decorative />} ariaLabel="Add photo" />
      )
      // Two eras of this bug. V4-A11YGATE-001: <label aria-label="Add photo"> with an icon-only body
      // — label has no ARIA role, so nothing carried the name and the control was anonymous; the fix
      // moved the name to the file input. BUG-PHOTOUPLOADKBD-001: that input is display:none, which
      // is out of the tab order AND out of the a11y tree, so the name landed somewhere no user could
      // reach. The trigger is now a <button>, which both carries a name and is focusable.
      expect(container.querySelector('label')).toBeNull()
      expect(screen.getByRole('button', { name: 'Add photo' })).toBeTruthy()
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
