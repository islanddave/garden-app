// V3-WXFRESH-001 — honest-presentation layer for the Today weather snapshot.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import WeatherWidget, { hydrologySourceLabel } from '../components/today/WeatherWidget.jsx'

const weather = { tonightLow: 50, highToday: 78, code: 3, hot: false }
const hydrology = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }

describe('WeatherWidget — honest snapshot presentation', () => {
  it('shows an "As of … · Open-Meteo" stamp when generatedAt is provided', () => {
    // 06:00:41Z == 02:00 ET (EDT) on 2026-06-22 → same ET day as the plan → no stale warning
    render(<WeatherWidget weather={weather} hydrology={hydrology} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/As of/i)).toBeTruthy()
    expect(screen.getByText(/Open-Meteo/i)).toBeTruthy()
    expect(screen.queryByText(/older snapshot/i)).toBeNull()
  })

  it('omits the stamp entirely when generatedAt is absent (back-compat with callers that pass none)', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} />)
    expect(screen.queryByText(/As of/i)).toBeNull()
  })

  it('warns when the snapshot is from an earlier ET day than the plan (missed nightly run)', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()
    expect(screen.getByText(/out of date/i)).toBeTruthy()
  })
})

describe('WeatherWidget — V4-WATERWHY-002 the why-expander is gone', () => {
  // Explicit supersede of V3-WATERWHY-001. These assert the ABSENCE of the old surface, so a
  // re-introduction is caught rather than silently landing.
  const hydro = { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 70, rain_coming: true }

  it('renders no watering-explanation region and no Why? affordance', () => {
    render(<WeatherWidget weather={weather} hydrology={hydro} />)
    expect(screen.queryByRole('region', { name: /watering explanation/i })).toBeNull()
    expect(screen.queryByText(/why\?/i)).toBeNull()
  })

  it('lanes are non-interactive — no buttons, no aria-expanded', () => {
    const { container } = render(<WeatherWidget weather={weather} hydrology={hydro} />)
    expect(screen.queryByRole('button', { name: /recommendation/i })).toBeNull()
    expect(container.querySelector('[aria-expanded]')).toBeNull()
    expect(container.querySelector('[aria-controls]')).toBeNull()
  })

  it('each lane announces its own recommendation THROUGH THE A11Y TREE', () => {
    // beds: already moist AND a qualifying soak is coming -> the engine's `incoming` branch -> hold.
    // containers: 0.6" of MEASURED rain eases them one can but never zeroes them (BUG-TODAYWATER-001
    // decision 3 — a forecast may not suppress a container at all, and 0.6 is under SOAK_CAP_IN).
    // Was `{recent 0, tomorrow 0.74@63}`, which held beds only under the widget's old private 0.3"/50%
    // bar; the engine requires the media to ALREADY be wet before incoming rain justifies a skip, so a
    // bone-dry bed with rain coming tomorrow now correctly gets watered today.
    //
    // getByRole, NOT getByLabelText. getByLabelText matches the aria-label ATTRIBUTE and passes even
    // when the name never reaches the accessibility tree — it passed against the first cut of this
    // change, where the lanes were bare aria-labelled divs (role=generic, unnameable) and were in
    // fact TOTALLY SILENT to screen readers. The role query is the only assertion that can tell the
    // difference, so it is the contract: it fails if role="img" is ever dropped.
    render(<WeatherWidget weather={weather} hydrology={hydro} />)
    expect(screen.getByRole('img', { name: /In-ground beds: hold, no water needed today/i })).toBeTruthy()
    expect(screen.getByRole('img', { name: /Containers: water — 1 of 3 cans/i })).toBeTruthy()
  })
})


describe('WeatherWidget — DRG-WX Phase 2 snapshot-volatility caveat', () => {
  const uncertainHydro = (extra = {}) => ({
    recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88,
    tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true,
    status: { ok: true, uncertainty: { flag: true, reason: 'showery today (88% on 0.21")' } },
    ...extra,
  })

  it('shows the showery caveat + softened ("could climb") note when the engine flags uncertainty', () => {
    render(<WeatherWidget weather={weather} hydrology={uncertainHydro()} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
    expect(screen.getByText(/could climb/i)).toBeTruthy()
    expect(screen.getByText(/plays it safe/i)).toBeTruthy()
  })

  it('shows the chance-forward note even when the snapshot has a trace amount (88% / 0")', () => {
    const h = uncertainHydro({ today_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 5,
      status: { ok: true, uncertainty: { flag: true, reason: 'rain likely today (88%) ... may climb' } } })
    render(<WeatherWidget weather={weather} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/88% chance today/i)).toBeTruthy()
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
  })

  it('does NOT show the caveat when no uncertainty status is present (back-compat)', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }
    render(<WeatherWidget weather={weather} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
    expect(screen.getByText(/0\.21″ today · 88% chance/)).toBeTruthy()
  })

  it('prior-day stale warning takes precedence over the showery caveat (no double-up)', () => {
    render(<WeatherWidget weather={weather} hydrology={uncertainHydro()} generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
  })
})


describe('WeatherWidget — DRG-WXROLL-001 live intraday rain overlay', () => {
  const nightlyUncertain = {
    recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63,
    status: { ok: true, uncertainty: { flag: true, reason: 'showery today (88% on 0.21")' } },
  }
  const live = { recent_precip_in: 0.10, today_precip_in: 0.61, today_pop: 92, tomorrow_precip_in: 0.20, tomorrow_pop: 30 }

  it('overlays the LIVE figure + "Updated … live" stamp, and the caveats survive it', () => {
    // BUG-WXLIVESTAMPSTALE-001 — the stale assertion here used to read "suppressed when live", and
    // that WAS the defect: a prior-day plan under a fresh-looking stamp is the worst case to go quiet
    // on. The overlay still owns the FIGURE and the stamp line (DRG-WXROLL-001, unchanged); it no
    // longer owns the caveats. Showery stays absent on THIS fixture only because `stale` outranks it
    // — one banner, not two — and `could climb` stays absent because the note's number-level hedge is
    // still live-gated. Both of those are asserted positively in the BUG-WXLIVESTAMPSTALE-001 block
    // at the end of this file, so neither null below is carrying the new behaviour's proof.
    render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={live}
      refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    // The live D0 amount beside its chance — not the 0.21 nightly, and not 0.56 (0.61 x 92%), the product
    // BUG-RAINFCSTONEMODEL-001 (b) removed.
    expect(screen.getByText(/0\.61″ today · 92% chance/)).toBeTruthy()
    expect(screen.queryByText(/0\.56/)).toBeNull()
    expect(screen.getByText(/· live/i)).toBeTruthy()
    expect(screen.queryByText(/As of/i)).toBeNull()       // live stamp still replaces the as-of stamp
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()   // NO LONGER suppressed by the overlay
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()  // outranked by stale, not hidden by live
    expect(screen.queryByText(/could climb/i)).toBeNull()
  })

  it('falls back to the nightly snapshot + caveats when no liveHydrology (back-compat)', () => {
    render(<WeatherWidget weather={weather} hydrology={nightlyUncertain}
      generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/As of/i)).toBeTruthy()
    expect(screen.queryByText(/· live/i)).toBeNull()
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
  })

  it('still shows the rain line live even when nothing fell today (reassurance, not blank)', () => {
    const dry = { recent_precip_in: 0, today_precip_in: 0, today_pop: 8, tomorrow_precip_in: 0, tomorrow_pop: 5 }
    render(<WeatherWidget weather={weather} hydrology={{ ...dry }} liveHydrology={dry}
      refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/· live/i)).toBeTruthy()
    // A known 0.00 is no amount to print -> chance-only line (BUG-RAINFCSTONEMODEL-001 (b) keeps this).
    expect(screen.getByText(/5% chance of rain/i)).toBeTruthy()
    expect(screen.queryByText(/\d″/)).toBeNull()   // no "0.00″" beside it
  })

  // ── BUG-LIVEWEATHERNUMOR0-001, the consumer half ────────────────────────────────────────────────
  // src/lib/liveWeather.js no longer coerces a missing precipitation_sum to 0, so every precip field
  // on liveHydrology is now nullable. This widget is its ONLY consumer (useLiveRain -> Today.jsx ->
  // here), and it is where a `?? 0` would have quietly restored the fabrication one layer down.
  describe('a live payload with an unknown amount', () => {
    it('shows the chance, never a fabricated "0.00″ rain expected"', () => {
      // A real partial payload: D0 came back as 0.00 (so the live overlay legitimately engages) and
      // the forecast tail is missing, which under the old mapper made D1 a confident 0.00 too. pop 63
      // is above the display threshold — exactly the branch that used to print an amount. With the
      // amount unknown there is nothing honest to weight, so the pop-only sentence (already the copy
      // for the below-threshold case) is what renders.
      const liveNoAmount = { recent_precip_in: null, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: null, upcoming_precip_in: null, tomorrow_pop: 63 }
      render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={liveNoAmount}
        refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/63% chance of rain tomorrow/i)).toBeTruthy()
      expect(screen.queryByText(/″ tomorrow/)).toBeNull()
      expect(screen.queryByText(/0\.00/)).toBeNull()
    })

    it('a payload with NO usable amount at all does not engage the live overlay at all', () => {
      // The `live` gate already required a non-null precip figure — it was simply unreachable while
      // the mapper fabricated zeros. With absence preserved, an unusable payload now correctly falls
      // back to the nightly snapshot, caveats and stamp included, instead of overlaying zeros on it.
      const unusable = { recent_precip_in: null, today_precip_in: null, tomorrow_precip_in: null, upcoming_precip_in: null, today_pop: null, tomorrow_pop: null }
      render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={unusable}
        refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.queryByText(/· live/i)).toBeNull()
      expect(screen.getByText(/As of/i)).toBeTruthy()
      expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
    })

    it('a known amount still renders — the fix is not a suppression', () => {
      render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={live}
        refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/0\.61″ today · 92% chance/)).toBeTruthy()
    })

    // WAS: 'on the NIGHTLY path an unknown amount renders no rain line at all — CHARACTERIZED, not fixed
    // here'. That test documented a deliberate gap and said so; BUG-RAINTOMORROWMISLABEL-001 (a) closed
    // it, so this flips from characterizing the gap to asserting the fix. The old body expected
    // queryByText(/chance of rain/) to be NULL — it is now the whole point.
    //
    // Why it changed: dropping the `?? upcoming_precip_in` fallback (which rendered a D+1+D+2 total under
    // "tomorrow" copy) leaves rainIn null more often, and the render gate keyed on `rainIn > 0`. Left
    // alone, removing a WRONG number would also have removed the RIGHT one — the probability. The gate
    // now also opens on `rainPop >= RAIN_POP_DISPLAY_THRESHOLD`, which makes the pre-existing
    // `!rainAmtKnown` branch reachable on the nightly path for the first time.
    it('on the NIGHTLY path an unknown amount now renders the probability, never a two-day total', () => {
      const nightlyNoAmount = { recent_precip_in: null, today_precip_in: null, today_pop: 10, tomorrow_precip_in: null, tomorrow_pop: 63 }
      const { unmount } = render(<WeatherWidget weather={weather} hydrology={nightlyNoAmount}
        generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/63% chance of rain tomorrow/i)).toBeTruthy()
      // Still no invented AMOUNT — the honest half is the probability, and only the probability.
      expect(screen.queryByText(/″ tomorrow/)).toBeNull()
      unmount()
      // ANTI-VACUITY: the same query DOES find a line when the amount is known, so the null above
      // is the widget's behaviour and not a query that matches nothing.
      render(<WeatherWidget weather={weather} hydrology={{ ...nightlyNoAmount, tomorrow_precip_in: 0.84 }}
        generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/0\.84″ tomorrow · 63% chance/)).toBeTruthy()
    })
  })
})


describe('WeatherWidget — BUG-RAINFCSTONEMODEL-001 (b) amount and chance, side by side', () => {
  // Supersedes the DRG-WXPROB-001 block that stood here, which pinned `amount x PoP / 100` and hid the amount
  // below 30%. Dave's call 2026-09-25: print both and let the reader combine them. Hydrology numbers and the
  // watering lanes are untouched — this is the informational line only.
  const w = { tonightLow: 50, highToday: 78, code: 3, hot: false }
  const at = { generatedAt: '2026-09-25T20:00:00Z', planDate: '2026-09-25' }

  it('2026-09-25: prints 0.14″ at 37% as itself, and the 1.72″ Sunday it had been hiding', () => {
    // The stored hydrology behind Dave's report, with the day-after fields this change adds.
    const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.14, tomorrow_pop: 37,
      upcoming_precip_in: 1.86, day2_precip_in: 1.72, day2_pop: 82, day2_date: '2026-09-27' }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} {...at} />)
    expect(screen.getByText(/0\.14″ tomorrow · 37% chance/)).toBeTruthy()
    expect(screen.getByTestId('weather-next-rain').textContent).toBe('1.72″ Sunday · 82% chance')
    // 0.14 x 37% = 0.05, the figure Dave saw; 1.72 x 82% = 1.41.
    expect(container.textContent).not.toMatch(/0\.05/)
    expect(container.textContent).not.toMatch(/1\.41/)
  })

  it('shows the amount beside a LOW chance instead of hiding it', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: 0.84, tomorrow_pop: 20 }
    render(<WeatherWidget weather={w} hydrology={h} {...at} />)
    expect(screen.getByText(/0\.84″ tomorrow · 20% chance/)).toBeTruthy()
    expect(screen.queryByText(/0\.17/)).toBeNull()   // 0.84 x 20%
  })

  it('never prints the product at any chance', () => {
    for (const [amt, pop, product] of [[0.84, 63, '0.53'], [1.0, 30, '0.30'], [0.5, 100, null]]) {
      const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: amt, tomorrow_pop: pop }
      const { container, unmount } = render(<WeatherWidget weather={w} hydrology={h} {...at} />)
      expect(container.textContent).toContain(`${amt.toFixed(2)}″ tomorrow · ${pop}% chance`)
      if (product) expect(container.textContent).not.toContain(product)
      unmount()
    }
  })

  it('keeps the chance-only sentence for a known 0.00, and prints no amount', () => {
    const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 40 }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} {...at} />)
    expect(screen.getByText(/40% chance of rain tomorrow/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/\d″/)
  })

  describe('the following-day line', () => {
    const base = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.14, tomorrow_pop: 37,
      day2_precip_in: 1.72, day2_pop: 82, day2_date: '2026-09-27' }
    const next = (h, extra = {}) => {
      render(<WeatherWidget weather={w} hydrology={h} {...at} {...extra} />)
      return screen.queryByTestId('weather-next-rain')
    }

    it('stays shut when the following day is not the bigger rain', () => {
      expect(next({ ...base, day2_precip_in: 0.14 })).toBeNull()   // equal is not more
    })

    it('stays shut below a measurable 0.10″, however much bigger than a dry tomorrow', () => {
      expect(next({ ...base, tomorrow_precip_in: 0, day2_precip_in: 0.09 })).toBeNull()
    })

    it('opens at exactly 0.10″ over a dry tomorrow — the card\'s own line is shut, this one is not', () => {
      const el = next({ ...base, tomorrow_precip_in: 0, tomorrow_pop: 10, day2_precip_in: 0.1, day2_pop: 40 })
      expect(el.textContent).toBe('0.10″ Sunday · 40% chance')
    })

    it('prints nothing it cannot name: no date, or an unknown amount', () => {
      expect(next({ ...base, day2_date: null })).toBeNull()
      cleanup()
      expect(next({ ...base, day2_precip_in: null })).toBeNull()
      cleanup()
      expect(next(base)).toBeTruthy()   // anti-vacuity: the same fixture, whole, does open it
    })

    it('prints the amount alone when the following day has no chance figure', () => {
      expect(next({ ...base, day2_pop: null }).textContent).toBe('1.72″ Sunday')
    })

    it('is absent on a plan that predates the day2 fields (every stored plan before this change)', () => {
      const { day2_precip_in, day2_pop, day2_date, ...old } = base
      expect(next({ ...old, upcoming_precip_in: 1.86 })).toBeNull()
    })

    it('after a measured day, the following day is TOMORROW, compared against what fell', () => {
      // Forecast fields zeroed for today, as Open-Meteo leaves a day whose rain has already fallen: the
      // gauge alone makes today "the line above", so the next line must be tomorrow, not D2.
      const gauged = { recent_precip_in: 0, today_precip_in: 0, today_observed_in: 0.29, today_remaining_in: 0,
        today_pop: 0, tomorrow_precip_in: 1.5, tomorrow_pop: 80, day2_precip_in: 0.2, day2_pop: 30, day2_date: '2026-09-27' }
      expect(next(gauged).textContent).toBe('1.50″ tomorrow · 80% chance')
      cleanup()
      expect(next({ ...gauged, tomorrow_precip_in: 0.25 })).toBeNull()   // 0.25 < 0.29 fallen
    })

    it('reads the live overlay when there is one, and its own date', () => {
      const liveH = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.2, tomorrow_pop: 50,
        day2_precip_in: 0.9, day2_pop: 70, day2_date: '2026-09-28' }
      const el = next(base, { liveHydrology: liveH, refreshedAt: '2026-09-25T21:00:00Z' })
      expect(el.textContent).toBe('0.90″ Monday · 70% chance')
    })
  })
})


describe('WeatherWidget — V200 Slice 6 derived no-wrap headline', () => {
  const w = { tonightLow: 50, highToday: 78, code: 3, hot: false }
  // The headline is derived from the two lane verdicts (pillState of computeWateringScale). It carries the
  // FULL untruncated sentence in the a11y tree via aria-label; the visible text is aria-hidden so screen
  // readers never double-announce. The lanes + rain note restate the guidance (WCAG 1.4.10).
  // V4-WATERWHY-002: the headline used to be `<div aria-label={sentence}>` and this helper found it
  // by scanning [aria-label]. That pattern was BROKEN — aria-label on a role-less div is ignored, so
  // the headline had been silent to AT since V200 Slice 6, and this helper's attribute-scan could
  // not tell. The sentence now ships as real visually-hidden TEXT, so the helper reads text, and
  // "is it in the a11y tree" is answered by an aria-hidden ancestor check rather than by trusting an
  // attribute. Returns the AT-readable node carrying the headline sentence.
  const headlineEl = (container) => {
    const nodes = container.querySelectorAll('span, div')
    for (const n of nodes) {
      const t = (n.textContent || '').trim()
      if (!/^(Water both|Water containers|Water the beds|All set)/i.test(t)) continue
      if (n.children.length) continue                       // innermost node only
      if (n.closest('[aria-hidden="true"]')) continue       // the truncated visual copy — not AT-readable
      return n
    }
    return null
  }

  it('reads "Water both" when both lanes water (dry, no rain coming)', () => {
    const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, rain_coming: false }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} />)
    const el = headlineEl(container)
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('Water both — containers and beds today.')
  })

  it('reads "Water containers, skip the beds" when only containers water (rain coming for beds)', () => {
    // BUG-TODAYWATER-001: bumped from {recent 0.05, tomorrow 0.74@63} to a bag that satisfies the
    // ENGINE's incoming branch — already moist (windowPrecip >= SOAK_WET_FLOOR_IN) AND >= SOAK_FCST_QPF_IN
    // more coming at >= SOAK_FCST_POP_PCT. The old bag zeroed beds only under the widget's private
    // thresholds, which is the divergence this change exists to remove.
    const h = { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 70, rain_coming: true }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} />)
    const el = headlineEl(container)
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('Water containers, skip the beds today.')
  })

  it('reads "All set" when both lanes hold (already soaked)', () => {
    // 0.9 -> 1.0: the zero-both bar is now SOAK_CAP_IN (the engine's), not the widget's old private
    // 0.8. At 0.9 the lanes deliberately do NOT both hold any more — see the sibling test below.
    // No waterDueCount is passed, so the absolute sentence is still the correct output here.
    const h = { recent_precip_in: 1.0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, rain_coming: false }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} />)
    const el = headlineEl(container)
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('All set — no watering needed today.')
  })

  it('hides the VISIBLE headline copy from the a11y tree so it does not double-announce', () => {
    // Same intent as before the V4-WATERWHY-002 restructure: the sentence must reach AT exactly
    // once. It now appears in TWO nodes — a visually-hidden span (AT-readable) and the truncated
    // visible div (aria-hidden). Assert both exist and that exactly one is readable.
    const h = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, rain_coming: false }
    const { container } = render(<WeatherWidget weather={w} hydrology={h} />)
    const SENTENCE = 'Water both — containers and beds today.'
    const all = [...container.querySelectorAll('span, div')]
      .filter(n => !n.children.length && (n.textContent || '').trim() === SENTENCE)
    expect(all.length).toBe(2)
    const hidden = all.filter(n => n.closest('[aria-hidden="true"]'))
    const readable = all.filter(n => !n.closest('[aria-hidden="true"]'))
    expect(hidden.length).toBe(1)    // the truncated visual copy
    expect(readable.length).toBe(1)  // the visually-hidden AT copy — announced once, not twice
  })

  it('headlineFor survives the V4-WATERWHY-002 cut AND is actually readable by AT', () => {
    // The headline is the load-bearing restatement surface now that the Why panel is gone. Asserted
    // via getByText (real text in the DOM), NOT getByLabelText — the old aria-label-on-a-div was
    // silent, and getByLabelText could not detect that. Two nodes carry the sentence: the
    // visually-hidden span (AT) and the aria-hidden truncated div (sighted), so scope to the former.
    const h = { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 70, rain_coming: true }
    render(<WeatherWidget weather={w} hydrology={h} />)
    const nodes = screen.getAllByText('Water containers, skip the beds today.')
    const readable = nodes.filter(n => !n.closest('[aria-hidden="true"]'))
    expect(readable.length).toBe(1)
  })
})


describe('WeatherWidget — DRG-WXSTATION-002 weather-station source on Today (V200 §3)', () => {
  const w = { tonightLow: 50, highToday: 78, code: 3, hot: false }
  // Nightly snapshot with no uncertainty flag and no live overlay, so the "As of … · <source>" stamp is
  // the branch under test. GEN in ET == the plan day, so no stale banner competes.
  const GEN = '2026-06-22T06:00:41Z'
  const DAY = '2026-06-22'
  const AS_OF = 'As of Jun 22 · 2:00 AM'
  const base = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: 0.84, tomorrow_pop: 63 }
  const withProv = (station) => ({ ...base, station })
  // The stamp is the ONLY node whose own text starts with "As of" (getNodeText reads direct text children).
  const stamp = () => screen.getByText(/^As of/)

  it('DEGRADES to the shipped copy when the payload carries no station provenance at all', () => {
    // The frontend may ship before any Lambda change, and Spaces with no bound WS-2902 never get the key.
    // Nothing is guessed: the stamp is byte-identical to what ships today, and no gauge copy appears.
    render(<WeatherWidget weather={w} hydrology={base} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · Open-Meteo`)
    expect(screen.queryByText(/gauge/i)).toBeNull()
  })

  it('says "rain gauge + forecast" when the gauge supplied the recent total', () => {
    const h = withProv({ recent_source: 'station', today_source: 'station+forecast', station_fresh: true, station_age_min: 4 })
    render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · rain gauge + forecast`)
    expect(screen.queryByText(/Open-Meteo/i)).toBeNull()
  })

  it('credits the gauge when it supplied only TODAY (recent still on forecast)', () => {
    // Warm-up window: no 2-day lookback yet, but the station's own since-midnight accumulator is truthful.
    const h = withProv({ recent_source: 'forecast', today_source: 'station+forecast', station_uncertainty: 'warmup' })
    render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · rain gauge + forecast`)
  })

  it('names the fallback REASON when the station went stale (§3: a silent fallback defeats the point)', () => {
    const h = withProv({ recent_source: 'forecast', today_source: 'forecast', station_uncertainty: 'stale', station_fresh: false, station_age_min: 900 })
    render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · forecast · gauge offline`)
    expect(screen.queryByText(/rain gauge/i)).toBeNull()   // never credit a gauge that is not contributing
  })

  it('does NOT call a warming-up station "offline" (distinct hardware claim, distinct copy)', () => {
    const h = withProv({ recent_source: 'forecast', today_source: 'forecast', station_uncertainty: 'warmup' })
    render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · forecast · gauge warming up`)
    expect(screen.queryByText(/offline/i)).toBeNull()
  })

  it('claims NO source when the bag says nothing was usable', () => {
    const h = withProv({ recent_source: 'unavailable', today_source: 'unavailable' })
    render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(AS_OF)                // no suffix invented
    expect(screen.queryByText(/Open-Meteo/i)).toBeNull()
    expect(screen.queryByText(/gauge/i)).toBeNull()
  })

  it('qualifies the LIVE stamp as forecast when a gauge exists to be confused with', () => {
    const live = { recent_precip_in: 0.10, today_precip_in: 0.61, today_pop: 92, tomorrow_precip_in: 0.20, tomorrow_pop: 30 }
    const h = withProv({ recent_source: 'station', today_source: 'station' })
    render(<WeatherWidget weather={w} hydrology={h} liveHydrology={live}
      refreshedAt="2026-06-22T17:15:00Z" generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByText(/^Updated/).textContent).toBe('Updated 1:15 PM · live forecast')
  })

  it('leaves the LIVE stamp unqualified with no station provenance (no copy churn for gaugeless users)', () => {
    const live = { recent_precip_in: 0.10, today_precip_in: 0.61, today_pop: 92, tomorrow_precip_in: 0.20, tomorrow_pop: 30 }
    render(<WeatherWidget weather={w} hydrology={base} liveHydrology={live}
      refreshedAt="2026-06-22T17:15:00Z" generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByText(/^Updated/).textContent).toBe('Updated 1:15 PM · live')
  })

  it('is AMBIENT, not an alert — no role=alert and no warn banner from provenance alone', () => {
    // Reward UX: an observability chip is ambient information. The offline case is the most alert-shaped
    // state there is, so it is the one pinned: it must render in the existing muted stamp and nowhere else.
    const h = withProv({ recent_source: 'forecast', today_source: 'forecast', station_uncertainty: 'stale' })
    const { container } = render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(screen.queryByText(/older snapshot/i)).toBeNull()
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
    expect(screen.getAllByText(/gauge offline/i).length).toBe(1)  // one place, not a banner + a chip
  })

  it('keeps engine internals OFF Today (Jen-invisible: no MAC, no ages, no raw enums)', () => {
    const h = withProv({
      recent_source: 'station', today_source: 'station+forecast', yesterday_actual_source: 'station',
      today_remaining_basis: 'hourly', today_remaining_from_hour: 14, station_age_min: 4,
      station_fresh: true, station_mac: 'AA:BB:CC:DD:EE:FF', station_temp_f: 61.2, microclimate_offset: -1.4,
      low_source: 'station_floor',
    })
    const { container } = render(<WeatherWidget weather={w} hydrology={h} generatedAt={GEN} planDate={DAY} />)
    const text = container.textContent
    // MUST match the station_mac set on the fixture above, or this assertion is vacuous — it would pass
    // while the real MAC rendered. (It was pinned to the old hardcoded MAC and silently went vacuous the
    // moment the fixture moved to a synthetic one.)
    for (const leak of ['AA:BB:CC', 'station+forecast', 'station_floor', 'hourly', '61.2', '-1.4', '4 min']) {
      expect(text).not.toContain(leak)
    }
  })

  it('degrades to the shipped copy when the station key is present but malformed', () => {
    // A non-object bag tells us nothing, so it is treated as absent rather than mined for a source.
    render(<WeatherWidget weather={w} hydrology={withProv('station')} generatedAt={GEN} planDate={DAY} />)
    expect(stamp().textContent).toBe(`${AS_OF} · Open-Meteo`)
  })

  it('hydrologySourceLabel returns null for an absent or empty bag', () => {
    // The degrade contract at the unit level: the component's fallback only fires on null.
    expect(hydrologySourceLabel(undefined)).toBeNull()
    expect(hydrologySourceLabel(null)).toBeNull()
    expect(hydrologySourceLabel({})).toBeNull()
  })
})

// BUG-RAINCARDFORECASTONLY-001 — the card must lead with what the GAUGE measured, not a probability-weighted
// forecast. Reported by Dave 2026-09-06: the card read "0.03″ rain expected" on a morning his WS-2902 finished
// at 0.29″. Every fixture below is that real day or a degradation of it. Before this block the file set
// `today_observed_in` exactly ZERO times, so the whole gauge path shipped unexercised — the failure class the
// suite is least able to notice, because the other 46 tests stay green either way.
describe('WeatherWidget — a measurement outranks a forecast (BUG-RAINCARDFORECASTONLY-001)', () => {
  // 2026-09-06 15:30 ET, verbatim from prod daily_plan.items->hydrology.
  const gauged = {
    recent_precip_in: 0.05, today_precip_in: 0.29, today_observed_in: 0.29, today_remaining_in: 0,
    today_pop: 40, tomorrow_precip_in: 0, tomorrow_pop: 0, rain_coming: false,
    station: { station_fresh: true, today_source: 'station', station_mac: 'F8:B3:B7:82:1F:0D' },
  }

  it('prints the measured amount, not the PoP-weighted forecast', () => {
    render(<WeatherWidget weather={weather} hydrology={gauged} />)
    expect(screen.getByText(/0\.29″ fallen today/)).toBeTruthy()
    // the specific wrong number from the report: 0.29 x 40% = 0.12, and the live-forecast form was ~0.03
    expect(screen.queryByText(/0\.12″/)).toBeNull()
    expect(screen.queryByText(/% chance/)).toBeNull()   // no forecast sentence in place of the measurement
  })

  it('shows BOTH halves when rain has fallen and more is still coming', () => {
    const mid = { ...gauged, today_observed_in: 0.14, today_remaining_in: 0.15, today_precip_in: 0.29 }
    render(<WeatherWidget weather={weather} hydrology={mid} />)
    expect(screen.getByText(/0\.14″ fallen · 0\.15″ more expected · 40%/)).toBeTruthy()
  })

  // The gate, not just the sentence. Open-Meteo drops a delivered event from the current day's total, so a
  // fully-rained day can carry zeroes in every forecast field — which is when the card most needs to speak.
  it('renders the line at all when every forecast field is zero but the gauge has a number', () => {
    const allZeroForecast = { ...gauged, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 }
    render(<WeatherWidget weather={weather} hydrology={allZeroForecast} />)
    expect(screen.getByText(/0\.29″ fallen today/)).toBeTruthy()
  })

  // Fail-safe: no gauge (or a dry day) must leave the pre-existing forecast sentence byte-identical, or this
  // change would have silently rewritten the card for every plan that has no bound station.
  it('leaves the forecast wording in place when there is no measured rain', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} />)
    expect(screen.getByText(/0\.21″ today · 88% chance/)).toBeTruthy()
    expect(screen.queryByText(/fallen/)).toBeNull()
  })

  it('does not treat a zero or absent gauge reading as a measurement', () => {
    for (const observed of [0, null, undefined]) {
      const { unmount } = render(<WeatherWidget weather={weather} hydrology={{ ...hydrology, today_observed_in: observed }} />)
      expect(screen.queryByText(/fallen/), `observed=${observed}`).toBeNull()
      unmount()
    }
  })
})

// BUG-WXLIVESTAMPSTALE-001 — the live overlay made the card look current and then told two lies about
// what that meant. Dave's gauge read 0.79" by midday on 2026-09-13 while the card read
// `0.07" fallen · 0.38" more expected · 83%` under `Updated 12:10 · live forecast`, with the stored
// showery caveat — the ONE line that would have explained the gap — hidden by its `!live` gate.
// Every fixture below is that morning. Both defects are one mistake: a client-side forecast fetch
// refreshes the rain FIGURE and nothing else, so it may not stamp, nor silence, anything else.
describe('WeatherWidget — a live stamp covers only what is live (BUG-WXLIVESTAMPSTALE-001)', () => {
  const GEN = '2026-09-13T09:30:00Z'        // 5:30 AM ET — when the plan (and the gauge read) froze
  const REFRESHED = '2026-09-13T16:10:00Z'  // 12:10 PM ET — when the client re-fetched the forecast
  const DAY = '2026-09-13'
  // Verbatim shape of that morning's stored hydrology: the gauge total and the remainder are the
  // plan's, and the uncertainty reason is the engine's current string (OPS-PLANHOURLY-001 replaced
  // the old "pre-dawn snapshot" wording; do not reintroduce it).
  const SEP13 = {
    recent_precip_in: 0.12, today_precip_in: 0.45, today_observed_in: 0.07, today_remaining_in: 0.38,
    today_pop: 83, tomorrow_precip_in: 0.10, tomorrow_pop: 20, rain_coming: true,
    station: { recent_source: 'station', today_source: 'station+forecast', station_fresh: true },
    status: { ok: true, uncertainty: { flag: true, reason: 'showery today (83% on 0.45") — showery amounts shift through the day' } },
  }
  // The midday overlay. Its chance (90) deliberately differs from the plan's (83) so an assertion can
  // tell which basis the measured sentence is quoting.
  const SEP13_LIVE = { recent_precip_in: 0.12, today_precip_in: 0.52, today_pop: 90, tomorrow_precip_in: 0.10, tomorrow_pop: 20 }
  const overlaid = (extra = {}) => render(
    <WeatherWidget weather={weather} hydrology={{ ...SEP13, ...extra }} liveHydrology={SEP13_LIVE}
      refreshedAt={REFRESHED} generatedAt={GEN} planDate={DAY} />
  )

  // ── defect 1: a current timestamp over a frozen measurement ────────────────────────────────────
  it('attaches the measurement\'s OWN basis time to the measurement', () => {
    overlaid()
    // ONE node, not two: getByText matches a single element's text, so this is the attachment proof
    // — a basis time floating elsewhere on the card is what the 12:10 stamp already was.
    expect(screen.getByText(/0\.07″ fallen as of 5:30 AM · 0\.38″ more expected · 83%/)).toBeTruthy()
    expect(screen.getByText(/^Updated/).textContent).toBe('Updated 12:10 PM · live forecast')
  })

  it('never lets the overlay\'s chance into the sentence its own two figures predate', () => {
    // The sentence is stamped "as of 5:30 AM". The overlay says 90%; the plan said 83%. A sentence
    // cannot be as-of one time and quote a number from another.
    overlaid()
    expect(screen.getByText(/· 83%/)).toBeTruthy()
    expect(screen.queryByText(/90%/)).toBeNull()
  })

  it('swaps "today" for the basis time rather than stacking both, on the nothing-more-coming form', () => {
    overlaid({ today_observed_in: 0.79, today_remaining_in: 0 })
    expect(screen.getByText(/0\.79″ fallen as of 5:30 AM · none more expected/)).toBeTruthy()
    expect(screen.queryByText(/fallen today/)).toBeNull()
  })

  it('qualifies the live stamp as FORECAST whenever a measured figure is on the card', () => {
    // DRG-WXSTATION-002 qualified this on the provenance bag. A card showing "0.07″ fallen" has
    // something to be confused with whether or not the bag came through, and a bagless gauge day is
    // exactly the card the stamp was misread on.
    const { station, ...noBag } = SEP13
    render(<WeatherWidget weather={weather} hydrology={noBag} liveHydrology={SEP13_LIVE}
      refreshedAt={REFRESHED} generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByText(/^Updated/).textContent).toBe('Updated 12:10 PM · live forecast')
  })

  it('adds NOTHING on the nightly path — the As-of stamp under the note is already that basis', () => {
    // Scope proof. The inline basis appears only when the overlay has taken the stamp line; repeating
    // it under the stamp that already says it would just lengthen the line on a 390px phone.
    render(<WeatherWidget weather={weather} hydrology={SEP13} generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByText(/0\.07″ fallen · 0\.38″ more expected · 83%/)).toBeTruthy()
    expect(screen.queryByText(/fallen as of/)).toBeNull()
    expect(screen.getByText(/^As of/).textContent).toBe('As of Sep 13 · 5:30 AM · rain gauge + forecast')
  })

  // ── defect 2: the overlay suppressed the caveats ───────────────────────────────────────────────
  it('shows the showery caveat THROUGH the overlay — the line that explained the 0.79" gap', () => {
    overlaid()
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
    expect(screen.getByText(/plays it safe/i)).toBeTruthy()
  })

  it('shows the older-snapshot banner through the overlay, and names the PLAN not the forecast', () => {
    // The prior-day case: freshest-looking card, oldest plan. The old copy ("today's forecast hasn't
    // refreshed yet") would have been a false statement on this branch — a live forecast is exactly
    // what HAS arrived. What has not refreshed is the plan the lanes and totals still come from.
    render(<WeatherWidget weather={weather} hydrology={SEP13} liveHydrology={SEP13_LIVE}
      refreshedAt={REFRESHED} generatedAt="2026-09-12T09:30:00Z" planDate={DAY} />)
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()
    expect(screen.getByText(/watering call and rain totals may be out of date/i)).toBeTruthy()
    expect(screen.queryByText(/forecast hasn.t refreshed/i)).toBeNull()
  })

  it('still shows ONE banner, not two, when the plan is both stale and flagged', () => {
    // Ungating both did not ungate the precedence between them.
    render(<WeatherWidget weather={weather} hydrology={SEP13} liveHydrology={SEP13_LIVE}
      refreshedAt={REFRESHED} generatedAt="2026-09-12T09:30:00Z" planDate={DAY} />)
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
  })

  it('does NOT restate the engine\'s hedge over the overlay\'s own numbers', () => {
    // The scope line between the two caveats. The BANNER is regime-level ("showery pattern") and is
    // true of the day however you read it, so it shows. The NOTE's hedge restates the STORED
    // snapshot's figures and drops the PoP weighting, so over live numbers it would swap a hedged
    // figure for a raw one while adding a hedging word — it stays live-gated. No gauge on this
    // fixture, or the measured sentence would win before either branch is reached.
    const noGauge = { ...SEP13, today_observed_in: 0, today_remaining_in: null, station: undefined }
    render(<WeatherWidget weather={weather} hydrology={noGauge} liveHydrology={SEP13_LIVE}
      refreshedAt={REFRESHED} generatedAt={GEN} planDate={DAY} />)
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()      // banner: shown
    expect(screen.queryByText(/could climb/i)).toBeNull()          // note hedge: still live-gated
    expect(screen.getByText(/0\.52″ today · 90% chance/)).toBeTruthy()  // the live figure, beside its chance
    expect(screen.queryByText(/0\.47/)).toBeNull()                      // not 0.52 x 90%
  })
})

// BUG-RAINTOMORROWMISLABEL-001 (a) — a two-day total must never render under "tomorrow" copy.
describe('tomorrow amount is D+1 only, never the D+1+D+2 sum', () => {
  it('a null tomorrow amount falls back to the PoP-only string, NOT to upcoming_precip_in', () => {
    const hydrology = {
      today_precip_in: 0, today_pop: 0, today_observed_in: 0, today_remaining_in: 0,
      recent_precip_in: 0,
      tomorrow_precip_in: null, tomorrow_pop: 70,
      upcoming_precip_in: 1.8,          // D+1 + D+2 — the number that used to leak through
      status: { ok: true, uncertainty: { flag: false } },
    }
    const { container } = render(
      <WeatherWidget weather={{}} hydrology={hydrology} generatedAt="2026-09-14T09:30:00Z"
        planDate="2026-09-14" waterDueCount={0} />
    )
    const text = container.textContent
    expect(text).toMatch(/70% chance of rain tomorrow/)
    // The two-day figure, and anything weighted from it, must be absent.
    expect(text).not.toMatch(/1\.8/)
    expect(text).not.toMatch(/1\.26/)   // 1.8 * 70/100, what rainAmtWeighted would have printed
  })
})
