// src/__tests__/ContinuousVoiceProbe.test.jsx
//
// V5-HARVESTVOICEFLOW-001 (BD-068) S0 — the HOST test. voiceCommitDebounce.test.js already replays
// the device fixture against the layer directly; this file is the thing that did not exist, and its
// absence is why the layer had been edited three times without ever running: nothing tested the
// COMPOSITION of a recogniser, a real host timer, and the layer's `dueAt()` contract.
//
// The scenarios below are the 2026-08-27 device log, not invented cases: the "three" → "three counts"
// revision at 195 ms, the "231" → "231 G" revision at 353 ms, the byte-identical "231 G" re-delivery
// at 274 ms, and 11 empty finals. The one case the device log CANNOT supply is the command axis —
// the run had no "next" that survived to a tick, which is exactly the hole S0 exists to fill.
//
// NO MOCKS OF THE LAYER. Both voiceCommitDebounce.js and voiceHarvestGrammar.js run for real here.
// 11 of 11 existing consumer test files `vi.mock` transcribe.js, which is why a change to it is
// invisible to every one of them (gate B3); this file does not repeat that mistake with the layer it
// is supposed to be exercising.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import ContinuousVoiceProbe from '../components/ContinuousVoiceProbe.jsx'

let mic

beforeEach(() => {
  // `now` is deliberately non-zero: the probe treats t0 === 0 as "no run started".
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  mic = installFakeSpeechRecognition(vi)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function startProbe() {
  await act(async () => { render(<ContinuousVoiceProbe />) })
  await act(async () => { fireEvent.click(screen.getByText('Start probe')) })
  return mic.latest()
}

const advance = (ms) => act(() => { vi.advanceTimersByTime(ms) })

const rows      = () => screen.queryAllByTestId('voice-commit-row').map(n => n.textContent)
const paths     = () => screen.getByTestId('voice-commit-paths').textContent
const held      = () => screen.getByTestId('voice-held-writes').textContent
const layer     = () => screen.getByTestId('voice-debounce-stats').textContent
const dueAt     = () => screen.getByTestId('voice-due-at').textContent
const drift     = () => screen.getByTestId('voice-tick-drift').textContent
const echo      = () => screen.getByTestId('voice-pending-echo').textContent
const probeLog  = () => screen.getByTestId('voice-probe-log').textContent

describe('ContinuousVoiceProbe — S0 debounce host', () => {
  it('arms a recogniser in continuous mode with interim results', async () => {
    const rec = await startProbe()
    expect(rec.continuous).toBe(true)
    expect(rec.interimResults).toBe(true)
    expect(rec.started).toBe(true)
  })

  it('logs resultIndex and results.length for every event (gate B1)', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('cucumber', 0) })
    act(() => { rec.deliverFinal('three counts', 1) })
    expect(probeLog()).toContain('resultIndex=0 len=1')
    expect(probeLog()).toContain('resultIndex=1 len=2')
  })

  it('a prefix and its revision commit ONCE, as the longer utterance', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('three', 0) })
    advance(195)                                   // the measured supersede gap
    act(() => { rec.deliverFinal('three counts', 0) })
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('quantity 3 count')
    expect(paths()).toMatch(/sessionEnd 1/)
    expect(layer()).toMatch(/superseded 1/)
  })

  it('a byte-identical re-delivery inside one session commits ONCE', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('231', 0) })
    advance(353)
    act(() => { rec.deliverFinal('231 G', 0) })
    advance(274)                                   // the measured duplicate gap
    act(() => { rec.deliverFinal('231 G', 0) })
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('weight 231 g')
  })

  it('empty finals never commit and are counted', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('', 0) })
    act(() => { rec.deliverFinal('', 1) })
    act(() => { rec.deliverFinal('', 2) })
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(0)
    expect(layer()).toMatch(/empty 3/)
  })

  // THE HEADLINE. Replaying the device log through a host produced 4 commits via sessionEnd and ZERO
  // via tick, so the entire command axis of this design had never been observed working end to end.
  it('a write command is NOT flushed at sessionEnd — only a tick commits it', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(0)
    expect(held()).toMatch(/never ticked:\s*1/)
    expect(held()).toMatch(/waiting 1/)
    expect(dueAt()).not.toContain('nothing pending')

    advance(500)

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('COMMAND save_and_advance')
    expect(paths()).toMatch(/tick 1/)
    expect(paths()).toMatch(/sessionEnd 0/)
    expect(held()).toMatch(/never ticked:\s*0/)
    expect(held()).toMatch(/committed by tick 1/)
    expect(drift()).not.toContain('no tick fired yet')
    expect(drift()).toMatch(/fired 1/)
  })

  // The design's single most valuable behaviour, and the reason a held write leaving the pending slot
  // is not by itself a defect: a bare "next" pends rather than saving, so the rest of the sentence can
  // still arrive — ACROSS a session boundary, which is where the device spends all its time.
  it('a bare "next" superseded by "next to the fence" saves nothing and becomes a search', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })                // held, not committed
    act(() => { rec.deliverFinal('next to the fence', 0) })   // next session, same pending utterance
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain('search "next to the fence"')
    expect(rows()[0]).not.toContain('COMMAND')
    expect(held()).toMatch(/superseded 1/)
    expect(held()).toMatch(/never ticked:\s*0/)   // superseded is the feature, not a lost save
  })

  it('a repeated save inside the cooldown is suppressed instead of double-committing', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })
    advance(500)
    expect(rows()).toHaveLength(1)

    advance(100)
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })
    advance(500)

    expect(rows()).toHaveLength(1)                 // still one save, not two
    expect(screen.getByTestId('voice-suppressed-reasons').textContent).toMatch(/cooldown 1/)
    expect(held()).toMatch(/suppressed 1/)
  })

  // The scheduled tick has to be CANCELLED when sessionEnd commits the utterance itself, which is the
  // dominant path for data. Left standing, the orphan timer fires into an empty layer — harmless to
  // the data, but it records a drift sample for an utterance that already committed, and drift is one
  // of the three numbers this run exists to produce. A polluted instrument is a wrong instrument.
  it('cancels the pending tick when sessionEnd commits the utterance itself', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('cucumber', 0) })
    act(() => { rec.endSession() })

    expect(rows()).toHaveLength(1)
    advance(5000)

    expect(drift()).toContain('no tick fired yet')
    expect(drift()).toMatch(/fired 0/)
    expect(rows()).toHaveLength(1)
  })

  it('renders dueAt while an utterance is pending and clears it once committed', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('cucumber', 0) })

    expect(dueAt()).toMatch(/in 500ms/)
    expect(echo()).toContain('search "cucumber"')

    act(() => { rec.endSession() })

    expect(dueAt()).toContain('nothing pending')
    expect(rows()).toHaveLength(1)
  })

  it('reports tick drift against dueAt rather than assuming the timer was punctual', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })

    // A hidden page freezes TIMERS while the CLOCK keeps running — the exact asymmetry that made
    // `tick(60000)` commit a sixty-second-old save before C1. Fake timers fire PUNCTUALLY, so
    // advancing them alone yields drift 0 and the instrument would look healthy on the one case it
    // exists to catch. Skewing Date against the timer queue is what reproduces it.
    const clockNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => clockNow.call(Date) + 1900)
    try {
      advance(500)

      const [, min, avg, max] = drift().match(/(-?\d+) \/ (-?\d+) \/ (-?\d+) ms/)
      expect(Number(min)).toBe(1900)
      expect(Number(avg)).toBe(1900)
      expect(Number(max)).toBe(1900)
    } finally {
      Date.now.mockRestore()
    }

    // >2× settleMs, so the layer discards the write rather than resurrecting it against whatever
    // planting is on screen when the page wakes.
    expect(rows()).toHaveLength(0)
    expect(layer()).toMatch(/stale-dropped 1/)
    expect(held()).toMatch(/suppressed 1/)
    expect(held()).toMatch(/never ticked:\s*0/)
  })

  it('the whole run replays end to end: crop, quantity, weight, save', async () => {
    const rec = await startProbe()

    act(() => { rec.deliverFinal('cucumber', 0) })
    act(() => { rec.endSession() })

    act(() => { rec.deliverFinal('three', 0) })
    advance(195)
    act(() => { rec.deliverFinal('three counts', 0) })
    act(() => { rec.endSession() })

    act(() => { rec.deliverFinal('231', 0) })
    advance(353)
    act(() => { rec.deliverFinal('231 G', 0) })
    act(() => { rec.endSession() })

    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })
    advance(500)

    expect(rows().map(r => r.split(' ·')[0])).toEqual([
      'search "cucumber"',
      'quantity 3 count',
      'weight 231 g (231g)',
      'COMMAND save_and_advance',
    ])
    expect(paths()).toMatch(/tick 1/)
    expect(paths()).toMatch(/sessionEnd 3/)
  })

  // C3 — the short budget hard-stops inside gate B6's own fixture, so V101's gate could not be run by
  // V101's instrument. These pin that the raise is real, opt-in, and still bounded.
  describe('run budget (C3)', () => {
    const budget = () => screen.getByTestId('voice-run-budget').textContent
    const toggle = () => screen.getByTestId('voice-longrun-toggle')

    // Drive N complete utterance cycles the way the device does: a final, then a session end that
    // the host auto-re-arms from.
    const cycles = (rec, n) => {
      for (let i = 0; i < n; i++) act(() => { rec.deliverFinal('cucumber', 0); rec.endSession() })
    }

    it('defaults OFF, with the short budget shown', async () => {
      await act(async () => { render(<ContinuousVoiceProbe />) })
      expect(toggle().checked).toBe(false)
      expect(budget()).toContain('24 re-arms / 4 min')
      expect(budget()).not.toContain('LONG RUN')
    })

    it('shows the raised budget once armed', async () => {
      await act(async () => { render(<ContinuousVoiceProbe />) })
      act(() => { fireEvent.click(toggle()) })
      expect(budget()).toContain('150 re-arms / 20 min')
      expect(budget()).toContain('LONG RUN')
    })

    it('stops at 24 re-arms on the short budget — the B6 fixture would die mid-run', async () => {
      const rec = await startProbe()
      cycles(rec, 24)
      expect(rec.started).toBe(true)          // the 24th re-arm is still allowed
      act(() => { rec.endSession() })
      expect(rec.started).toBe(false)
      expect(probeLog()).toMatch(/cap reached \(24 re-arms\)/)
      expect(screen.getByText('Start probe')).toBeTruthy()
    })

    it('survives past 24 re-arms on the long budget', async () => {
      await act(async () => { render(<ContinuousVoiceProbe />) })
      act(() => { fireEvent.click(screen.getByTestId('voice-longrun-toggle')) })
      await act(async () => { fireEvent.click(screen.getByText('Start probe')) })
      const rec = mic.latest()

      cycles(rec, 40)

      expect(rec.started).toBe(true)
      expect(probeLog()).not.toContain('cap reached')
      expect(probeLog()).toContain('LONG RUN')
    })

    it('cannot be changed mid-run, so the captured budget and the shown one never disagree', async () => {
      await startProbe()
      expect(screen.getByTestId('voice-longrun-toggle').disabled).toBe(true)
    })

    it('the long budget is still a hard stop, not an unbounded mic', async () => {
      await act(async () => { render(<ContinuousVoiceProbe />) })
      act(() => { fireEvent.click(screen.getByTestId('voice-longrun-toggle')) })
      await act(async () => { fireEvent.click(screen.getByText('Start probe')) })
      const rec = mic.latest()

      advance(20 * 60 * 1000)

      expect(probeLog()).toContain('wall-clock budget reached')
      expect(rec.started).toBe(false)
    })
  })

  // C4 — Q4 is answered, and the fetch that answered it went on contaminating the measurement it sat
  // inside for one run too long. These pin that it is silent unless asked for, that the log says
  // which mode ran, and that a run cannot change its own mode halfway through.
  describe('search round-trip (C4)', () => {
    const toggle = () => screen.getByTestId('voice-roundtrip-toggle')
    const mode   = () => screen.getByTestId('voice-roundtrip-mode').textContent

    it('defaults OFF and fires no fetch at all', async () => {
      await startProbe()
      expect(toggle().checked).toBe(false)
      advance(10_000)
      expect(fetch).not.toHaveBeenCalled()
      expect(probeLog()).not.toContain('simulating the search round-trip')
      expect(mode()).toContain('OFF')
    })

    it('fires exactly one round-trip at +6s when opted in', async () => {
      await act(async () => { render(<ContinuousVoiceProbe />) })
      act(() => { fireEvent.click(screen.getByTestId('voice-roundtrip-toggle')) })
      await act(async () => { fireEvent.click(screen.getByText('Start probe')) })

      advance(5_999)
      expect(fetch).not.toHaveBeenCalled()
      advance(1)
      expect(fetch).toHaveBeenCalledTimes(1)

      // One shot, not an interval — a repeating fetch would confound every later gap too.
      advance(10_000)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(probeLog()).toContain('simulating the search round-trip')
      expect(mode()).toContain('ON')
    })

    // A copied log is the deliverable of a device run, and the absence of a round-trip line must not
    // be readable as either "off" or "old build".
    it('records which mode the run was in, either way', async () => {
      await startProbe()
      expect(probeLog()).toContain('search round-trip simulation: OFF')

      act(() => { cleanup() })
      await act(async () => { render(<ContinuousVoiceProbe />) })
      act(() => { fireEvent.click(screen.getByTestId('voice-roundtrip-toggle')) })
      await act(async () => { fireEvent.click(screen.getByText('Start probe')) })
      expect(probeLog()).toContain('search round-trip simulation: ON')
    })

    it('cannot be changed mid-run, so the captured mode and the logged one never disagree', async () => {
      await startProbe()
      expect(screen.getByTestId('voice-roundtrip-toggle').disabled).toBe(true)
    })
  })

  it('releases the mic and cancels the pending tick on unmount', async () => {
    const rec = await startProbe()
    act(() => { rec.deliverFinal('next', 0) })
    act(() => { rec.endSession() })
    expect(rec.started).toBe(true)                 // auto re-armed

    act(() => { cleanup() })

    expect(rec.started).toBe(false)
    // A tick landing after unmount would commit against a dead host and warn in React.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
  })
})
