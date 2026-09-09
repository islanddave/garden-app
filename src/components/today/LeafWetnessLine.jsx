// src/components/today/LeafWetnessLine.jsx — V5-LEAFWETNESS-001.
//
// ONE ambient line for the whole garden, on the screen Dave already opens daily. Nothing on a day the
// signal is quiet — which, measured against the 122-day archive, is 77% of days (28 of 122 qualify).
//
// MOUNTED IN Today.jsx IN THE SAME CHANGE AS THIS FILE. Stated here because the sibling DroughtLine
// shipped UNMOUNTED and its header still carries the "⚠ NOT MOUNTED" warning it was written with —
// "shipped but never rendered" is the failure this project keeps hitting, and the mount assertion in
// leafWetnessLine.test.jsx exists so this one cannot regress into it silently.
//
// PROP IS THE WHOLE PLAN, NOT plan.leaf_wetness — same reasoning as DroughtLine. daily-plan-read
// returns the stored items payload verbatim as `plan`, and the likeliest failure of a line like this
// is being mounted on the wrong prop path and rendering nothing forever while every test stays green.
// Taking the plan means a test can feed a plan-shaped payload and assert what a caller would see.
//
// VISUAL: the same thin sage left rule as DroughtLine, deliberately. The gold/warn family on Today is
// already crowded (hydrology uncertainty, StorageDeadlineAlert, FrostAlertLine) and a fourth warn item
// is what turns the other three into wallpaper. This is an advisory to go and look, not an alarm, so
// it must not compete with the frost line — which is genuinely time-critical in a way this is not.
//
// House rules for an operational alert, unchanged and absolute: no modal, no toast, no snackbar, no
// banner, no sheet, no overlay, no push, no sound, no haptic, no count badge. Dave's only surface is
// an installed PWA on Android; an interrupt there would need his explicit approval.
import React, { useMemo } from 'react'
import { P } from '../../lib/constants.js'
import { buildLeafWetnessLine } from '../../lib/leafWetnessLine.js'

export default function LeafWetnessLine({ plan = null }) {
  const line = useMemo(() => buildLeafWetnessLine(plan), [plan])

  if (!line) return null

  return (
    <div
      data-testid="leaf-wetness-line"
      data-wet-recent={String(line.recentWetDays)}
      data-wet-ahead={String(line.aheadWetDays)}
      // Provenance on the DOM so a test can prove the modelled basis survived to render. If this ever
      // reads as gauged, the sentence is claiming an on-site measurement the app does not have.
      data-wet-basis={line.basis || 'unknown'}
      style={{
        borderLeft: `3px solid ${P.sage}`,
        paddingLeft: 10,
        fontSize: '0.84rem',
        lineHeight: 1.45,
        color: P.dark,
        fontWeight: 600,
      }}
    >
      {line.text}
    </div>
  )
}
