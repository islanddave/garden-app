// src/pages/HarvestLog.jsx
// V5-HARVESTONEDOOR-001 — ONE door for logging a harvest, with a selector for which way.
//
// WHY. Harvest had two logging surfaces reachable from two unrelated places: the voice flow at
// /log/voice, sitting as the fifth row of the ＋ sheet, and the weigh-in session at
// /log?session=harvest, reachable from the header circle, the Harvests page and the installed-PWA
// shortcut. Nothing on either surface mentioned the other, so which one you got depended on which
// door you happened to use. Dave 2026-09-03: combine them into one page with a selector, defaulting
// to voice, "and ensure any menu/quick shortcuts go to this combined page like weigh in session is
// now."
//
// This page owns NO harvest logic. It is a shell: a title, a selector, and whichever surface the
// selector names. Both surfaces keep their own behaviour byte-for-byte — that is deliberate, because
// the voice flow carries a lot of hard-won failure handling (wake lock, cue-refusal accounting, the
// one-breath resolver) and the weigh-in session carries the ledger and per-row undo. Merging their
// internals would have put all of that at risk to save a wrapper.
//
// DEFAULT IS VOICE, AND IT IS NOT REMEMBERED. `?mode=manual` selects the other one. A remembered
// last-choice would quietly defeat "default to the by voice version" the first time he used the
// manual form once, so the default is re-asserted on every arrival and switching costs one tap.
//
// ONLY THE ACTIVE MODE IS MOUNTED. Switching unmounts the other, which is safe and checked:
// VoiceHarvest's unmount effect releases the recogniser, the wake lock and the mic token
// (VoiceHarvest.jsx:1250). Mounting both and hiding one would keep two live fetch sets and, worse,
// a mounted recogniser behind a hidden div. Switching therefore costs the in-progress state of the
// surface you leave — exactly as navigating between the two pages does today, so this is not a new
// loss.
//
// THE URL IS THE STATE, and mode changes use replace: Dave is on Android where Back is the primary
// gesture, and a push per toggle would make Back walk him through his own indecision instead of
// leaving the page.
import React, { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import VoiceHarvest from './VoiceHarvest.jsx'
import EventNew from './EventNew.jsx'
import { P } from '../lib/constants.js'

export const DEFAULT_MODE = 'voice'

export const HARVEST_MODES = [
  { value: 'voice',  label: 'By voice' },
  { value: 'manual', label: 'Manual' },
]

// Exported so the redirect in App.jsx and the tests name the same strings this page reads, rather
// than each spelling '/log/harvest?mode=manual' separately and drifting.
export const HARVEST_LOG_PATH = '/log/harvest'
export const HARVEST_LOG_MANUAL = '/log/harvest?mode=manual'

// An unknown ?mode= resolves to the default rather than rendering nothing. A typo in a shortcut, or
// a stale launcher URL from a future rename, must still land on a working harvest page.
export function resolveMode (raw) {
  return HARVEST_MODES.some(m => m.value === raw) ? raw : DEFAULT_MODE
}

export default function HarvestLog () {
  const [params, setParams] = useSearchParams()
  const mode = resolveMode(params.get('mode'))

  const onChange = useCallback((next) => {
    const p = new URLSearchParams(params)
    // The default mode carries NO param, so the canonical URL for the common case stays clean and
    // the manifest shortcut, the header circle and a bookmark all produce the same string.
    if (next === DEFAULT_MODE) p.delete('mode')
    else p.set('mode', next)
    setParams(p, { replace: true })
  }, [params, setParams])

  return (
    <div data-testid="harvest-log">
      <div style={SELECTOR_BAR}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, maxWidth: 680, margin: '0 auto' }}>
          <h1 style={TITLE}>Log a harvest</h1>
          <SegmentedControl
            options={HARVEST_MODES}
            value={mode}
            onChange={onChange}
            small
            ariaLabel="How to log this harvest"
            data-testid="harvest-log-mode"
          />
        </div>
      </div>

      {/* `embedded` drops VoiceHarvest's own <h1> and intro paragraph — this shell supplies the
          title, and two headings stacked is the thing that made the first draft look bolted
          together. Everything else on that page is untouched. */}
      {mode === 'voice'
        ? <VoiceHarvest embedded />
        : <EventNew harvestSession />}
    </div>
  )
}

// Sticky so the selector survives a scroll into a long ready-tray or a long session ledger: the way
// back to the other mode must not require scrolling to the top of a surface you are mid-way through.
const SELECTOR_BAR = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  padding: '10px 16px',
  background: P.cream,
  borderBottom: `1px solid ${P.border}`,
}

const TITLE = {
  fontSize: '1.15rem',
  fontWeight: 700,
  color: P.dark,
  margin: 0,
}
