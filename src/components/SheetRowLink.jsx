// src/components/SheetRowLink.jsx — a link inside an Android-Back-armed sheet that CONSUMES the armed
// entry when it navigates.
//
// BUG-BACKNAVMORE-001 (BD-009) wrote this for BottomNav's two sheets; V5-SEEDSTAB-001 moved it here
// because Saved seeds' "Track a saved-seed lot" sheet now arms Back too and holds a navigating link
// ("Add the packet →"). It had already been copied by hand once, for sign-out; a second private copy
// is how the two drift. Not in the forms barrel — import it by path (FROZEN.md, non-barrel table).
//
// THE PROBLEM IT SOLVES. An armed sheet pushes a marker entry. A plain push from inside it strands
// that marker MID-STACK ([page, page+marker, dest]) — a permanent dead Back press, because no browser
// API can remove a mid-stack entry. So at click time, if the CURRENT entry is the session marker
// (readMarker — the predicate disarm() guards on), the link REPLACE-navigates, collapsing the marker
// into the destination ([page, dest]); one Back from there lands on the page under the sheet.
// disarm() already treats a replace-while-armed as "marker deleted, do nothing".
//
// When the marker is NOT current — flags off, no provider (isolated tests), or anything else — the
// click falls through to the Link's own push, byte-identical to an unarmed link. Modified or
// non-primary clicks (a new tab) fall through untouched.
//
// `state` is forwarded on BOTH paths. The replace path used to drop it, which was harmless while
// every caller was a nav row carrying none; a Seeds door carries the page it should return to.
//
// Two variants rather than one component calling every hook: the overlay one needs the location as
// well as navigate, and a plain row in a page that is not an overlay host has no use for either.
import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOverlayNavigate, OverlayLink } from '../context/OverlayContext.jsx'
import { readMarker } from '../lib/backNav.js'

function consumeOnClick(e, onClick, go, to, state) {
  onClick?.(e)
  if (e.defaultPrevented) return
  // Mirror Link's own navigation guards: only a plain primary-button click navigates in-tab.
  if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
  if (typeof window === 'undefined' || !window.history) return
  if (!readMarker(window.history.state)) return
  e.preventDefault()
  go(to, state === undefined ? { replace: true } : { replace: true, state })
}

function PlainSheetRowLink({ to, state, onClick, children, ...rest }) {
  const navigate = useNavigate()
  return (
    <Link to={to} state={state} onClick={(e) => consumeOnClick(e, onClick, navigate, to, state)} {...rest}>
      {children}
    </Link>
  )
}

function OverlaySheetRowLink({ to, state, onClick, children, ...rest }) {
  const overlayNavigate = useOverlayNavigate()
  return (
    <OverlayLink to={to} state={state} onClick={(e) => consumeOnClick(e, onClick, overlayNavigate, to, state)} {...rest}>
      {children}
    </OverlayLink>
  )
}

export default function SheetRowLink({ overlay = false, ...props }) {
  return overlay ? <OverlaySheetRowLink {...props} /> : <PlainSheetRowLink {...props} />
}
