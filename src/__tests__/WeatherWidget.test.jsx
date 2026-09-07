// V3-WXFRESH-001 — honest-presentation layer for the Today weather snapshot.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    expect(screen.getByText(/rain expected/i)).toBeTruthy()
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

  it('overlays the LIVE figure + "Updated … live" stamp and suppresses the stale + uncertainty caveats', () => {
    render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={live}
      refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/0\.56/)).toBeTruthy()        // live D0 amount probability-weighted (0.61 * 92%), not the raw 0.61 or the 0.21 nightly
    expect(screen.getByText(/· live/i)).toBeTruthy()
    expect(screen.queryByText(/As of/i)).toBeNull()       // live stamp replaces the as-of stamp
    expect(screen.queryByText(/older snapshot/i)).toBeNull()   // stale suppressed when live
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()  // uncertainty suppressed when live
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
    // tomorrow_pop 5 is below the display threshold -> chance-only line, no amount (DRG-WXPROB-001)
    expect(screen.getByText(/5% chance of rain/i)).toBeTruthy()
    expect(screen.queryByText(/rain expected/i)).toBeNull()
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
      expect(screen.queryByText(/rain expected/i)).toBeNull()
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

    it('a known amount still renders exactly as before — the fix is not a suppression', () => {
      render(<WeatherWidget weather={weather} hydrology={nightlyUncertain} liveHydrology={live}
        refreshedAt="2026-06-22T17:15:00Z" generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/0\.56/)).toBeTruthy()
    })

    it('on the NIGHTLY path an unknown amount renders no rain line at all — CHARACTERIZED, not fixed here', () => {
      // The nightly hydrology reaches the identical lines, so it is worth stating what it does. It
      // never reaches the `!rainAmtKnown` branch: the rain line renders only when `rainIn > 0 ||
      // uncertain || live`, and an unknown amount satisfies none of those without a live overlay. So
      // the unknown-amount guard is reachable ONLY on the live path — which is the one this fix is
      // about. Recorded so a later reader does not mistake the guard for dead code.
      const nightlyNoAmount = { recent_precip_in: null, today_precip_in: null, today_pop: 10, tomorrow_precip_in: null, tomorrow_pop: 63 }
      const { unmount } = render(<WeatherWidget weather={weather} hydrology={nightlyNoAmount}
        generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.queryByText(/chance of rain/i)).toBeNull()
      expect(screen.queryByText(/rain expected/i)).toBeNull()
      unmount()
      // ANTI-VACUITY: the same queries DO find a line when the amount is known, so the nulls above
      // are the widget's behaviour and not a query that matches nothing.
      render(<WeatherWidget weather={weather} hydrology={{ ...nightlyNoAmount, tomorrow_precip_in: 0.84 }}
        generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
      expect(screen.getByText(/0\.53″ rain expected tomorrow · 63%/)).toBeTruthy()
    })
  })
})


describe('WeatherWidget — DRG-WXPROB-001 probability-gated rain AMOUNT', () => {
  // Clean nightly snapshot (no uncertainty flag, no live overlay) — the branch the deterministic
  // Open-Meteo amount over-reports on. Below the PoP threshold the amount is suppressed; at/above it
  // the displayed amount is probability-weighted. Hydrology numbers + watering pills are untouched.
  const w = { tonightLow: 50, highToday: 78, code: 3, hot: false }

  it('suppresses the amount and shows ONLY "% chance of rain" when tomorrow_pop < 30', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: 0.84, tomorrow_pop: 20 }
    render(<WeatherWidget weather={w} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/20% chance of rain tomorrow/i)).toBeTruthy()
    expect(screen.queryByText(/rain expected/i)).toBeNull()  // no amount shown
    expect(screen.queryByText(/0\.84/)).toBeNull()           // the raw over-reporting figure is gone
  })

  it('shows a probability-weighted amount (not the raw figure) when tomorrow_pop >= 30', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: 0.84, tomorrow_pop: 63 }
    render(<WeatherWidget weather={w} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    // 0.84 * 63% = 0.5292 -> round2 -> 0.53
    expect(screen.getByText(/0\.53″ rain expected tomorrow · 63%/)).toBeTruthy()
    expect(screen.queryByText(/0\.84/)).toBeNull()           // raw deterministic amount is never shown
  })

  it('treats pop exactly at the threshold (30) as the show-weighted-amount branch', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, tomorrow_precip_in: 1.00, tomorrow_pop: 30 }
    render(<WeatherWidget weather={w} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    // 1.00 * 30% = 0.30
    expect(screen.getByText(/0\.30″ rain expected tomorrow · 30%/)).toBeTruthy()
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
    expect(screen.queryByText(/rain expected/)).toBeNull()
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
  it('leaves the forecast wording untouched when there is no measured rain', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} />)
    expect(screen.getByText(/rain expected/)).toBeTruthy()
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
