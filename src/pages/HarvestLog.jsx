// The one door for logging a harvest, with a selector for which way: the voice flow (/log/voice) or
// the weigh-in session (/log?session=harvest). The header circle, the Harvests page and the
// installed-PWA shortcut all land here.
//
// This page owns no harvest logic. It is a shell: a title, a selector, and whichever surface the
// selector names. Both surfaces keep their own behaviour untouched, because the voice flow carries
// hard-won failure handling (wake lock, cue-refusal accounting, the one-breath resolver) and the
// weigh-in session carries the ledger and per-row undo.
//
// Default is voice and it is NOT remembered; `?mode=manual` selects the other one. A remembered
// last choice would quietly defeat the voice default after one manual use, so the default is
// re-asserted on every arrival and switching costs one tap.
//
// Only the active mode is mounted. Switching unmounts the other, and VoiceHarvest's unmount effect
// releases the recogniser, the wake lock and the mic token. Mounting both and hiding one would keep
// two live fetch sets and a live recogniser behind a hidden div. Switching therefore costs the
// in-progress state of the surface you leave, as navigating between the two pages always did.
//
// The URL is the state, and mode changes use replace: on Android Back is the primary gesture, and a
// push per toggle would make Back walk through the toggles instead of leaving the page.
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

      {/* `embedded` drops VoiceHarvest's own <h1> and intro paragraph: this shell supplies the title,
          and two stacked headings look bolted together. */}
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
