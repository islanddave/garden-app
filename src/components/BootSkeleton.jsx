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
import React from 'react'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'

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
