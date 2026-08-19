// V4-PERFCLERK-001 C — the shapes that stand in for the app while Clerk is still resolving.
//
// THE ONE INVARIANT, and the reason this file has no imports beyond React + the palette:
// nothing here may take a prop, read a context, call a hook that touches identity, or issue a
// request. These render during the window where the app does not yet know WHO the user is — Dave
// and Jen share one installed PWA, so anything identity-derived painted here is a cross-user leak.
// Keeping them prop-less and context-free makes that structural rather than a review promise: there
// is no channel through which user data could reach them.
//
// They are also deliberately UNLABELLED. A skeleton that spelled out "Today · Garden · Harvests"
// would be the signed-IN navigation shown to someone who may turn out to be signed out — the same
// wrong-identity flash the 'pending' header class exists to kill, one layer down. Shapes read as
// "loading"; words read as "you are in".
//
// V4-COLDSTART-001 adds IdentityUnavailable to this file rather than to a new one, ON PURPOSE: it
// renders in the same "we do not know who this is" window and is bound by the same invariant, and
// authRenderGate's structural scan reads THIS file — so the new terminal screen inherits that proof
// instead of needing a parallel one. The single added import (reloadApp) touches window.location and
// nothing else. Keep the invariant true for anything else added here.
import React from 'react'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { reloadApp } from '../lib/bootReload.js'

const BONE = 'rgba(74,124,89,0.10)'

function Bone({ w, h, r = 8, style }) {
  return <div aria-hidden="true" style={{ width: w, height: h, borderRadius: r, background: BONE, ...style }} />
}

// The content slot while <Protected> is withholding a page. aria-busy + a polite status role so a
// screen reader announces "loading" rather than reading out a pile of empty divs.
export function RouteSkeleton() {
  return (
    <div
      role="status" aria-busy="true" aria-live="polite" aria-label="Loading your garden"
      data-testid="route-skeleton"
      style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <Bone w="42%" h={18} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Bone w={56} h={56} r={12} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Bone w="70%" h={13} />
            <Bone w="45%" h={11} />
          </div>
        </div>
      ))}
    </div>
  )
}

// The bottom-nav slot. Five bones on the real nav's geometry so the frame is complete and the
// content area does not jump when the real <BottomNav> replaces it. Not interactive, not focusable,
// and it does NOT write --bottom-nav-height: BottomNav owns that variable, and two writers for one
// value is how the two silently disagree. App.jsx reserves the space for this state explicitly.
export function NavSkeleton() {
  return (
    <nav
      aria-hidden="true" data-app-chrome="bottom" data-testid="nav-skeleton"
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90,
        height: `${BOTTOM_NAV_HEIGHT_PX}px`, paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-around',
        background: P.white, borderTop: '1px solid rgba(0,0,0,0.06)',
        pointerEvents: 'none',
      }}
    >
      {[0, 1, 2, 3, 4].map((i) => <Bone key={i} w={26} h={26} r={7} />)}
    </nav>
  )
}

// The heading is branched rather than fixed because BOTH causes are real and they want different
// next actions. `navigator.onLine === false` is the airplane-mode/dead-zone case (walk into signal,
// retry); a false reading with the radio up is Clerk being unreachable or down (wait, retry). Saying
// "you're offline" to someone holding five bars sends them debugging their phone. Wrapped because
// navigator is absent in a non-browser render.
function isOffline() {
  try { return typeof navigator !== 'undefined' && navigator.onLine === false } catch { return false }
}

// V4-COLDSTART-001 — the terminal state of an offline cold start, and the whole point of this lane.
//
// WHAT IT DELIBERATELY IS NOT, since each rejected option is the one a later change will be tempted
// by. Not a read-only shell of cached content: rendering ANY data before identity resolves is
// precisely the two-household-members leak authRenderGate exists to prevent, and the SW's per-subject
// partitions cannot be keyed without a subject. Not a guessed or remembered identity: that is offline
// sign-in, a larger design, out of scope. Not a redirect to /login: it cannot work offline and it
// reads as "you got signed out", which is false and alarming.
//
// So: a statement of fact and a way out. No data of any kind, and — like its siblings above — no
// props, no context, no hooks that touch identity, no request.
export function IdentityUnavailable() {
  const offline = isOffline()
  return (
    <div
      role="alert" data-testid="identity-unavailable"
      style={{
        minHeight: '100dvh', background: P.cream, color: P.dark,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: '32px 28px', textAlign: 'center',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600, color: P.green }}>
        {offline ? "You're offline" : 'Can’t reach your account'}
      </h1>
      <p style={{ margin: 0, maxWidth: 320, fontSize: '0.92rem', lineHeight: 1.5, color: P.mid }}>
        {offline
          ? 'The garden needs a connection the first time it opens after a restart. Nothing has been lost — find some signal and try again.'
          : 'The app could not confirm who is signed in. Try again, or give it a moment and reopen.'}
      </p>
      <button
        type="button" data-testid="identity-retry" onClick={() => reloadApp()}
        style={{
          marginTop: 6, padding: '11px 26px', minHeight: 44, borderRadius: 10,
          border: 'none', background: P.green, color: P.white,
          fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  )
}
