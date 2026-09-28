// BUG-TODAYGROUPREORDER-001 — Dave, 2026-09-17: the Needs-care SECTIONS stay where they were when he
// opened Today, and move ONLY when he taps the By location / By type control. Re-report of
// BUG-TODAYCAREREORDER-001, whose fix (CareNeededPinnedOrder.test.jsx) froze the order against
// LOGGING only. Two other paths still re-derived it from the list as it drained:
//   · a skip — withheld from the ordering set on purpose, as "an explicit user action";
//   · a plan refetch — useDailyPlan revalidates on every wake (BUG-PLANNOREVALIDATE-001, prod since
//     v4.134.0), and the read path stamps the rows he has logged as `done`, so the ordering set
//     loses them and the page re-ranks without anyone touching it. That is the "every action"
//     report: log, pocket the phone, look again, and the section has moved.
// Each case asserts the rendered headers after EVERY step, never the component's internals — the
// mis-tap happens on the NEXT tap, so an order that is only right at the end still moved.
//
// What is held is the SECTION order. Row order inside a section is the plan's and follows each
// refresh; the last block pins that as a characterisation, so holding rows too would be a
// deliberate test edit rather than a silent change. Cases marked [QA Pn] came from the lane's QA
// review (2026-09-28), each written against a mutant that survived every other test.
//
// No jest-dom (L-182): role/attr/text + toBe/toEqual/toBeTruthy/toBeNull only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'

// Arrival ranking (groupSeverity = sum of rows; water row = 1 + overdue days, any other row = 0.5):
//   Drive Rows  4 water @1d + 1 pest  = 8.5   leads, and is the one group auto-expanded (5 rows;
//                                              adding Bag's 5 would overrun the 8-row budget)
//   Bag Area    5 water @0d           = 5
//   Pasture     3 water @0d + 2 pest  = 4
// Taking three Drive water rows out of the ranking leaves Drive at 2.5, so ANY re-rank puts it last:
// [Bag Area, Pasture, Drive Rows]. The pest rows are what keep Drive (and Pasture) on the page after
// a bulk watering, so the bulk cases have a surviving group whose place can be checked.
const w = (id, name, project, projectId, overdue) => ({
  id, name, crop: 'pepper', project, project_id: projectId, overdue_by: overdue, in_ground: false,
})
const bug = (id, name, project, projectId) => ({
  id, name, crop: 'pepper', project, project_id: projectId, label: 'Scout for aphids',
})
const ARRIVAL = ['Drive Rows', 'Bag Area', 'Pasture']
const RERANKED = ['Bag Area', 'Pasture', 'Drive Rows']

// `order` hands the water rows over in the order the ENGINE would emit them (engine.js sorts due rows
// by overdue_by, most first; ties keep their query order), for the row-order characterisation.
function plan({ done = [], over = {}, extra = [], order = null } = {}) {
  let water = [
    w('d1', 'Drive One', 'Drive Rows', 'prD', 1),
    w('d2', 'Drive Two', 'Drive Rows', 'prD', 1),
    w('d3', 'Drive Three', 'Drive Rows', 'prD', 1),
    w('d4', 'Drive Four', 'Drive Rows', 'prD', 1),
    w('b1', 'Bag One', 'Bag Area', 'prB', 0),
    w('b2', 'Bag Two', 'Bag Area', 'prB', 0),
    w('b3', 'Bag Three', 'Bag Area', 'prB', 0),
    w('b4', 'Bag Four', 'Bag Area', 'prB', 0),
    w('b5', 'Bag Five', 'Bag Area', 'prB', 0),
    w('c1', 'Pasture One', 'Pasture', 'prC', 0),
    w('c2', 'Pasture Two', 'Pasture', 'prC', 0),
    w('c3', 'Pasture Three', 'Pasture', 'prC', 0),
    ...extra,
  ].map(it => ({
    ...it,
    ...(it.id in over ? { overdue_by: over[it.id] } : null),
    // What the read path does to a row whose care landed today (annotateDone): the plan keeps the
    // item and stamps it, and buildCareNeeded drops it.
    ...(done.includes(it.id) ? { done: true } : null),
  }))
  if (order) water = [...water].sort(order)
  return {
    hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
    rain_skipped: [],
    water_due: water,
    no_history: [], fertilize: [],
    pest: [bug('dp1', 'Drive Bug', 'Drive Rows', 'prD'), bug('cp1', 'Pasture Bug', 'Pasture', 'prC'), bug('cp2', 'Pasture Bug Two', 'Pasture', 'prC')],
    cold: [], dormant: [],
  }
}
const engineOrder = (a, b) => (b.overdue_by ?? -1) - (a.overdue_by ?? -1)

// Group headers: the disclosure button inside each care-group. Scoped to care-group so no other
// aria-expanded control on the surface can join the census.
const headers = () => screen.queryAllByTestId('care-group').map(g => g.querySelector('button[aria-expanded]'))
const headerLabels = () => headers().map(b => b.querySelector('span').textContent)
const expandedLabels = () => headers().filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('span').textContent)
const rowNamesIn = (label) => {
  const g = screen.queryAllByTestId('care-group').find(x => x.querySelector('button[aria-expanded] span').textContent === label)
  return g ? [...g.querySelectorAll('[data-testid="care-row"]')].map(r => r.querySelector('a > div > div').textContent) : null
}
const expand = (label) => fireEvent.click(headers().find(b => b.querySelector('span').textContent === label))
const StrictWrap = (x) => <React.StrictMode>{x}</React.StrictMode>

function todayISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

// Let the two enrichment fetches (/api/plants, /api/locations/with-path) settle before acting, so a
// case measures what it names and not the page's own load. They answer [] here, so the grouping stays
// on the project proxy — the same labels before and after.
async function arrive(p = plan(), wrap = (x) => x) {
  const view = render(wrap(<CareNeeded plan={p} />))
  await waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/locations/with-path')).toBe(true))
  await act(async () => { await Promise.resolve() })
  await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
  return view
}

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  prefsMock.fetchNotificationPrefs.mockReset(); prefsMock.fetchNotificationPrefs.mockImplementation(async () => null)
  prefsMock.saveTodaySkipped.mockReset(); prefsMock.saveTodaySkipped.mockImplementation(async () => null)
  let n = 0
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-' + (++n) }))
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(cleanup)

describe('BUG-TODAYGROUPREORDER-001 — the section order is set when Today opens', () => {
  it('fixture is valid: Drive Rows leads and is the one section open on arrival', async () => {
    await arrive()
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })
})

describe('BUG-TODAYGROUPREORDER-001 — nothing Dave does to a row moves a section', () => {
  it('(a) logging three Drive rows moves no section', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      expect(headerLabels()).toEqual(ARRIVAL)
    }
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })

  it('(b) skipping three Drive rows moves no section', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Skip ' + name + ' today' }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      expect(headerLabels()).toEqual(ARRIVAL)
    }
    // The skips genuinely left the list — otherwise the order held because nothing changed.
    expect(rowNamesIn('Drive Rows')).toEqual(['Drive Four', 'Drive Bug'])
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })

  it('(b) skipping EVERY row of the lead section, then Undo, puts it back at the top [QA P2]', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three', 'Drive Four', 'Drive Bug']) {
      fireEvent.click(screen.getByRole('button', { name: 'Skip ' + name + ' today' }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
    }
    // A skipped row leaves the ordering set, so this is the path where a section truly LEAVES it.
    expect(headerLabels()).toEqual(['Bag Area', 'Pasture'])
    const undos = toastMock.showUndo.mock.calls.filter(c => c[0].group === 'care-skip').map(c => c[0].onUndo)
    expect(undos.length).toBe(5)
    await act(async () => { for (const u of undos) u() })
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
  })

  it('(b) marking three Drive rows "still moist" moves no section', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Checked ' + name + ' — still moist' }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      expect(headerLabels()).toEqual(ARRIVAL)
    }
  })

  it('(b) the section bulk "Water all" leaves its own section where it was', async () => {
    await arrive()
    fireEvent.click(screen.getByRole('button', { name: 'Water all 4 in Drive Rows' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(4))
    await waitFor(() => expect(screen.queryByText('Drive One')).toBeNull())
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(rowNamesIn('Drive Rows')).toEqual(['Drive Bug'])
  })

  it('(b) the global "Log all watering" leaves the surviving sections in arrival order', async () => {
    await arrive()
    fireEvent.click(screen.getByRole('button', { name: 'Log all watering (12)' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(12))
    await waitFor(() => expect(screen.queryByText('Bag One')).toBeNull())
    // Only the pest rows survive: Drive Rows (0.5) and Pasture (1.0). A re-rank says [Pasture, Drive].
    expect(headerLabels()).toEqual(['Drive Rows', 'Pasture'])
  })

  it('(a)(b) a tap removes only its own row: the rows left keep the plan\'s order, and no section moves', async () => {
    const view = await arrive()
    expand('Bag Area')
    expect(rowNamesIn('Bag Area')).toEqual(['Bag One', 'Bag Two', 'Bag Three', 'Bag Four', 'Bag Five'])
    fireEvent.click(screen.getByRole('button', { name: 'Log Water for Bag Two' }))
    await waitFor(() => expect(screen.queryByText('Bag Two')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Skip Bag Four today' }))
    await waitFor(() => expect(screen.queryByText('Bag Four')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Checked Bag One — still moist' }))
    await waitFor(() => expect(screen.queryByText('Bag One')).toBeNull())
    expect(rowNamesIn('Bag Area')).toEqual(['Bag Three', 'Bag Five'])
    // A refresh that keeps the plan's row order changes nothing else (one that re-orders the plan is
    // the characterisation block at the end of this file).
    view.rerender(<CareNeeded plan={plan({ done: ['b1', 'b2'] })} />)
    expect(rowNamesIn('Bag Area')).toEqual(['Bag Three', 'Bag Five'])
    expect(headerLabels()).toEqual(ARRIVAL)
  })

  it('(b) skips arriving from another device after Today opened move no section', async () => {
    let land
    prefsMock.fetchNotificationPrefs.mockImplementation(() => new Promise(r => { land = r }))
    await arrive()
    await act(async () => {
      land({ today_skipped: { date: todayISO(), keys: ['d1:water_due', 'd2:water_due', 'd3:water_due'] } })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByText('Drive One')).toBeNull())
    expect(headerLabels()).toEqual(ARRIVAL)
  })
})

describe('BUG-TODAYGROUPREORDER-001 — a plan refetch moves no section', () => {
  it('(c) the refetch after Dave logged three Drive rows (the read path marks them done)', async () => {
    const view = await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
    }
    expect(headerLabels()).toEqual(ARRIVAL)
    // The wake refetch: a NEW plan object, CareNeeded stays mounted (useDailyPlan's refresh never
    // blanks the screen), and the three logged rows now come back stamped done.
    view.rerender(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />)
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(rowNamesIn('Drive Rows')).toEqual(['Drive Four', 'Drive Bug'])
  })

  it('(c) a refetch that re-ranks the sections on its own (the hourly plan moved the overdue days)', async () => {
    const view = await arrive()
    // Pasture's water rows are now 3 days overdue: 3 x 4 + 1 = 13, ahead of Drive's 8.5 and Bag's 5.
    view.rerender(<CareNeeded plan={plan({ over: { c1: 3, c2: 3, c3: 3 } })} />)
    expect(headerLabels()).toEqual(ARRIVAL)
  })

  it('(c) the refetch does not open or close a section', async () => {
    const view = await arrive()
    view.rerender(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />)
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })

  it('(c) a section that empties is dropped and the rest keep their places', async () => {
    const view = await arrive()
    // Bag Area fully done; Pasture now outweighs Drive (3 x 4 + 1 = 13 vs 8.5).
    view.rerender(<CareNeeded plan={plan({ done: ['b1', 'b2', 'b3', 'b4', 'b5'], over: { c1: 3, c2: 3, c3: 3 } })} />)
    expect(headerLabels()).toEqual(['Drive Rows', 'Pasture'])
  })

  it('(c) a section emptied by one refetch and refilled by a later one comes back to its own slot [QA P1]', async () => {
    const view = await arrive()
    // Jen watered the whole Bag Area (her logs stamp Dave's rows done too), then undid it.
    view.rerender(<CareNeeded plan={plan({ done: ['b1', 'b2', 'b3', 'b4', 'b5'] })} />)
    expect(headerLabels()).toEqual(['Drive Rows', 'Pasture'])
    view.rerender(<CareNeeded plan={plan()} />)
    expect(headerLabels()).toEqual(ARRIVAL)
  })

  it('(c) a section that first appears on a refetch goes at the END, however heavy it is', async () => {
    const view = await arrive()
    const gh = [w('g1', 'Glass One', 'Greenhouse', 'prG', 6), w('g2', 'Glass Two', 'Greenhouse', 'prG', 6)]
    view.rerender(<CareNeeded plan={plan({ extra: gh })} />)
    expect(headerLabels()).toEqual([...ARRIVAL, 'Greenhouse'])
    // ...and stays there as it drains (it is part of this visit's order now, not re-ranked each time).
    view.rerender(<CareNeeded plan={plan({ extra: gh, over: { c1: 9, c2: 9, c3: 9 } })} />)
    expect(headerLabels()).toEqual([...ARRIVAL, 'Greenhouse'])
  })

  it('(c) a section first seen on a refetch arrives collapsed — the row budget was spent at open [QA P3]', async () => {
    const view = await arrive()
    const gh = [w('g1', 'Glass One', 'Greenhouse', 'prG', 6), w('g2', 'Glass Two', 'Greenhouse', 'prG', 6)]
    view.rerender(<CareNeeded plan={plan({ extra: gh })} />)
    expect(headerLabels()).toEqual([...ARRIVAL, 'Greenhouse'])
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })

  it('(c) two new sections keep the order they arrived in, even when their weights later flip', async () => {
    const view = await arrive()
    const shed = [w('s1', 'Shed One', 'Shed', 'prS', 4)]                 // 5
    const glass = [w('g1', 'Glass One', 'Greenhouse', 'prG', 1)]         // 2
    view.rerender(<CareNeeded plan={plan({ extra: [...shed, ...glass] })} />)
    expect(headerLabels()).toEqual([...ARRIVAL, 'Shed', 'Greenhouse'])
    // Greenhouse now outweighs Shed. Appended sections are part of this visit's order, not a
    // re-ranked tail — otherwise the bottom of the page still swaps under a finger.
    view.rerender(<CareNeeded plan={plan({ extra: [w('s1', 'Shed One', 'Shed', 'prS', 0), w('g1', 'Glass One', 'Greenhouse', 'prG', 9)] })} />)
    expect(headerLabels()).toEqual([...ARRIVAL, 'Shed', 'Greenhouse'])
  })

  it('(c) when everything on the list is done and new work arrives, it opens like a fresh list', async () => {
    const view = await arrive()
    const all = ['d1', 'd2', 'd3', 'd4', 'b1', 'b2', 'b3', 'b4', 'b5', 'c1', 'c2', 'c3']
    const bare = (p) => ({ ...p, pest: [] })
    view.rerender(<CareNeeded plan={bare(plan({ done: all }))} />)
    expect(headerLabels()).toEqual([])
    // Nothing held is on screen, so nothing can move: the new section leads and opens.
    view.rerender(<CareNeeded plan={bare(plan({ done: all, extra: [w('g1', 'Glass One', 'Greenhouse', 'prG', 2), w('g2', 'Glass Two', 'Greenhouse', 'prG', 2)] }))} />)
    expect(headerLabels()).toEqual(['Greenhouse'])
    expect(expandedLabels()).toEqual(['Greenhouse'])
  })

  it('(c) a section emptied by logging returns to its own place on Undo', async () => {
    await arrive()
    fireEvent.click(screen.getByRole('button', { name: 'Water all 4 in Drive Rows' }))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Log Check for Drive Bug' }))
    await waitFor(() => expect(headerLabels()).toEqual(['Bag Area', 'Pasture']))
    const undo = toastMock.showUndo.mock.calls[0][0].onUndo
    await act(async () => { await undo() })
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
  })

  it('(c) "Show N more" is not a re-sort, even after the ranking has drifted [QA P11]', async () => {
    // Drive: 30 water rows @1d (60) leads and is capped at 20 -> "Show 10 more". Bag 5, Pasture 4.
    const drive = () => Array.from({ length: 30 }, (_, i) => w('dd' + i, 'Drive Bulk ' + i, 'Drive Rows', 'prD', 1))
    const big = ({ pastureOver = 0 } = {}) => {
      const p = plan({ over: { c1: pastureOver, c2: pastureOver, c3: pastureOver } })
      return { ...p, water_due: [...drive(), ...p.water_due.filter(r => r.project !== 'Drive Rows')] }
    }
    const view = await arrive(big())
    // The hourly run: Pasture's rows are now 30 days overdue (3 x 31 + 1 = 94, past Drive's 60). Held.
    view.rerender(<CareNeeded plan={big({ pastureOver: 30 })} />)
    expect(headerLabels()).toEqual(ARRIVAL)
    fireEvent.click(screen.getByTestId('care-show-more'))
    await waitFor(() => expect(screen.queryByTestId('care-show-more')).toBeNull())
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows'])
  })
})

describe('BUG-TODAYGROUPREORDER-001 — the By location / By type control DOES re-sort', () => {
  it('(d) By type then By location re-ranks against what is left on the list', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Skip ' + name + ' today' }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
    }
    fireEvent.click(screen.getByRole('button', { name: 'By type' }))
    await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })

  it('(d) tapping the By location it is already on re-sorts too — it is the sort control', async () => {
    const view = await arrive()
    view.rerender(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />)
    expect(headerLabels()).toEqual(ARRIVAL)
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
    // A re-sort also re-picks the section that opens: the new lead.
    expect(expandedLabels()).toEqual(['Bag Area'])
  })

  it('(d) a SECOND re-sort in the same visit re-ranks again [QA P4]', async () => {
    await arrive()
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))   // re-sort 1: nothing done yet
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      expect(headerLabels()).toEqual(ARRIVAL)                               // held between sorts
    }
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))   // re-sort 2
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })

  it('(d) a re-sort after logging ranks the work that is LEFT, not the work already logged', async () => {
    await arrive()
    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
    }
    expect(headerLabels()).toEqual(ARRIVAL)
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })

  it('(d) a re-sort is itself held: the next refetch does not undo it', async () => {
    const view = await arrive()
    view.rerender(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />)
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
    view.rerender(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'], over: { d4: 12 } })} />)
    expect(headerLabels()).toEqual(RERANKED)
  })

  it('opening Today again re-ranks from the plan it opens on', async () => {
    const first = await arrive()
    first.unmount()
    render(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />)
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })
})

describe('BUG-TODAYGROUPREORDER-001 — the location names landing is part of opening Today', () => {
  it('re-keys the sections once, ranked fresh, even when some plantings keep their project section', async () => {
    let landPlants, landPaths
    fetchMock.mockImplementation((path) => {
      if (path === '/api/plants') return new Promise(r => { landPlants = r })
      if (path === '/api/locations/with-path') return new Promise(r => { landPaths = r })
      return Promise.resolve({ id: 'ev' })
    })
    render(<CareNeeded plan={plan()} />)
    // First paint groups by the project proxy, until /api/plants and the location paths land.
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    expect(expandedLabels()).toEqual(['Drive Rows'])
    // Drive and Bag plantings have a location; Pasture's do not, so Pasture keeps its PROJECT section
    // — the one key the first layout already holds. Without the re-take, that leftover would keep its
    // slot and lead the page with nothing open.
    const at = (ids, loc) => ids.map(id => ({ id, location_id: loc }))
    await act(async () => {
      landPlants([...at(['d1', 'd2', 'd3', 'd4', 'dp1'], 'locD'), ...at(['b1', 'b2', 'b3', 'b4', 'b5'], 'locB'), ...at(['c1', 'c2', 'c3', 'cp1', 'cp2'], null)])
      landPaths([{ id: 'locD', full_path: 'Drive Bed' }, { id: 'locB', full_path: 'Bag Row' }])
      await Promise.resolve()
    })
    await waitFor(() => expect(headerLabels()).toEqual(['Drive Bed', 'Bag Row', 'Pasture']))
    expect(expandedLabels()).toEqual(['Drive Bed'])
  })
})

describe('BUG-TODAYGROUPREORDER-001 — StrictMode (the app mounts under <StrictMode>, src/main.jsx)', () => {
  it('the held order, a refetch and a re-sort behave the same, with no render-loop error [QA P7]', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const view = await arrive(plan(), StrictWrap)
      for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
        fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
        await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      }
      view.rerender(StrictWrap(<CareNeeded plan={plan({ done: ['d1', 'd2', 'd3'] })} />))
      expect(headerLabels()).toEqual(ARRIVAL)
      fireEvent.click(screen.getByRole('button', { name: 'By location' }))
      await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
      const loopish = errs.mock.calls.map(c => String(c[0])).filter(m => /Too many re-renders|Cannot update a component|Maximum update depth/.test(m))
      expect(loopish).toEqual([])
    } finally { errs.mockRestore() }
  })
})

// CHARACTERISATION — current behaviour, pinned on purpose, NOT a statement of what is wanted. The fix
// holds SECTIONS. Rows inside a section are the plan's own order and follow each refresh, exactly as
// they did before this change (these pass on the pre-fix code too). If rows are ever held, these are
// the tests that must change, deliberately.
describe('BUG-TODAYGROUPREORDER-001 — row order inside a section follows the plan (characterisation)', () => {
  it('a refresh that makes a more-overdue plant due puts it at the TOP of the open section [QA P5]', async () => {
    const view = await arrive()
    expand('Bag Area')
    expect(rowNamesIn('Bag Area')).toEqual(['Bag One', 'Bag Two', 'Bag Three', 'Bag Four', 'Bag Five'])
    view.rerender(<CareNeeded plan={plan({ extra: [w('b6', 'Bag Six', 'Bag Area', 'prB', 2)], order: engineOrder })} />)
    expect(rowNamesIn('Bag Area')).toEqual(['Bag Six', 'Bag One', 'Bag Two', 'Bag Three', 'Bag Four', 'Bag Five'])
    expect(headerLabels()).toEqual(ARRIVAL)   // the SECTION held; the rows under the finger moved down one
  })

  it('a refresh whose engine order changed inside a section re-orders that section\'s rows [QA P6]', async () => {
    const view = await arrive()
    expand('Bag Area')
    // The hourly run raised one Bag row's overdue days (a shorter effective interval on a hot forecast).
    view.rerender(<CareNeeded plan={plan({ over: { b4: 1 }, order: engineOrder })} />)
    expect(rowNamesIn('Bag Area')).toEqual(['Bag Four', 'Bag One', 'Bag Two', 'Bag Three', 'Bag Five'])
    expect(headerLabels()).toEqual(ARRIVAL)
  })

  it('By type: a section first seen on a refresh takes its fixed need slot, not the end [QA P12]', async () => {
    const view = await arrive()
    fireEvent.click(screen.getByRole('button', { name: 'By type' }))
    await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
    const p = plan()
    view.rerender(<CareNeeded plan={{ ...p, fertilize: [{ id: 'f1', name: 'Feed One', crop: 'pepper', project: 'Bag Area', project_id: 'prB' }] }} />)
    // Existing sections never swap; the new one lands mid-page in NEED_ORDER (water, feed, check).
    expect(headerLabels()).toEqual(['Water', 'Feed', 'Check'])
  })
})
