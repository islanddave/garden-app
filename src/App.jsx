import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { FavoritesProvider } from './context/FavoritesContext.jsx'
import { ZoneProvider } from './context/ZoneContext.jsx'
import { ModeProvider } from './context/ModeContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import TopChrome from './components/TopChrome.jsx'
import BottomNav from './components/BottomNav.jsx'
import PlantsRedirect from './components/PlantsRedirect.jsx'
import TodayBand from './components/TodayBand.jsx'
import CritterArrivalController from './components/CritterArrivalController.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Search from './pages/Search.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Locations from './pages/Locations.jsx'
import ProjectList from './pages/ProjectList.jsx'
import ProjectNew from './pages/ProjectNew.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import ProjectPublic from './pages/ProjectPublic.jsx'
import AuthCallback from './pages/AuthCallback.jsx'
import ZonePicker from './pages/ZonePicker.jsx'
import Inventory from './pages/Inventory.jsx'
import InventoryAdd from './pages/InventoryAdd.jsx'
import InventoryDetail from './pages/InventoryDetail.jsx'
import EventNew from './pages/EventNew.jsx'
import PhotoLibrary from './pages/PhotoLibrary.jsx'
import RecentlyDeleted from './pages/RecentlyDeleted.jsx'
import Favorites from './pages/Favorites.jsx'
import ProjectTypes from './pages/ProjectTypes.jsx'
import Garden from './pages/Garden.jsx'
import FeedPage from './pages/FeedPage.jsx'
import LogMany from './pages/LogMany.jsx'
import PlantsCatchUp from './pages/PlantsCatchUp.jsx'
import LocationDetail from './pages/LocationDetail.jsx'
import EventDetail from './pages/EventDetail.jsx'
import PlantingDetail from './pages/PlantingDetail.jsx'
import Harvests from './pages/Harvests.jsx'
import Achievements from './pages/Achievements.jsx'
import InactiveProjects from './pages/InactiveProjects.jsx'
import ProjectsAdminClassify from './pages/ProjectsAdminClassify.jsx'
import GardenActivity from './pages/GardenActivity.jsx'
import VoiceDebug from './pages/VoiceDebug.jsx'
import GardenHelper from './pages/GardenHelper.jsx'
import FieldCapture from './pages/FieldCapture.jsx'
import Settings from './pages/Settings.jsx'
import SettingsNotifications from './pages/SettingsNotifications.jsx'
import Findings from './pages/Findings.jsx'
import About from './pages/About.jsx'
import ReleaseNotes from './pages/ReleaseNotes.jsx'
import Today from './pages/Today.jsx'
import CaptureFlow from './pages/CaptureFlow.jsx'
import AddSeeds from './pages/AddSeeds.jsx'
import SowNow from './pages/SowNow.jsx'
import PutUp from './pages/PutUp.jsx'
import SpaceDetail from './pages/SpaceDetail.jsx'
import VarietyEdit from './pages/VarietyEdit.jsx'
import SplashScreen from './components/SplashScreen.jsx'
import { RouteSkeleton, NavSkeleton, IdentityUnavailable } from './components/BootSkeleton.jsx'
import { dismissBootSplash } from './lib/bootSplash.js'
import { BOTTOM_NAV_HEIGHT_PX } from './lib/constants.js'
import UpdateBanner from './components/UpdateBanner.jsx'
import Sheet from './components/forms/Sheet.jsx'
import { OverlayProvider, OverlaySurfaceProvider, OverlayDirtyProvider, useOverlay, useOverlayDismiss } from './context/OverlayContext.jsx'
import { DismissRegistryProvider } from './context/DismissRegistry.jsx'
import { OVERLAY_ROUTES_ENABLED, PROJECTS_HIDDEN, SPACE_PHOTOS_ENABLED, CRITTERS_QUIET } from './lib/featureFlags.js'

// V4-COLLECTIONSPLIT-001 — the ONE lazy route. Every other page above is a static import on purpose:
// they share components, so splitting them fragments the critical path into extra requests for no
// byte win. Collection.jsx is the exception — critters-roster.json (39KB) and CritterOfDay.jsx are
// single-owner subgraphs no other route reaches, so this import boundary moves real bytes off the
// Android boot path while the critical path stays a SINGLE file.
//
// DO NOT convert this back to a static import. A static import here is re-bundled into the entry
// chunk silently — the tests stay green and the feature still works, which is exactly the inert-
// regression class this repo has been bitten by (V4-CIGUARD-002). App.collectionSplit.test.jsx
// asserts at RUNTIME that this module is NOT evaluated at App module-eval time and IS reached when
// /collection renders; a static import turns it red.
const Collection = React.lazy(() => import('./pages/Collection.jsx'))

// Suspense fallback for the lazy route above. Deliberately quiet: the chunk is ~40KB gzip off a
// warm CDN, so a spinner would flash more often than it would inform.
function ChunkFallback() {
  return <div role="status" aria-live="polite" data-testid="route-chunk-fallback" style={{ padding: '32px 20px', textAlign: 'center', color: '#7a7266' }}>Loading…</div>
}

function AppFallback({ error, retry } = {}) {
  return (
    <div role="alert" style={{ padding: '48px 20px', textAlign: 'center', color: '#b94a3a' }}>
      <p style={{ marginBottom: 8 }}>Something went wrong loading this page.</p>
      {error && (
        <pre style={{ fontSize: '0.72rem', color: '#666', marginBottom: 16, textAlign: 'left', maxWidth: 600, margin: '0 auto 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {error.message}
        </pre>
      )}
      <button onClick={retry}
        style={{ color: '#4a7c59', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', textDecoration: 'underline' }}>
        Try again
      </button>
    </div>
  )
}

function RouteFallback({ error, retry } = {}) {
  return (
    <div role="alert" style={{ padding: '32px 20px', textAlign: 'center', color: '#b94a3a' }}>
      <p style={{ marginBottom: 8 }}>This page failed to load.</p>
      {error && (
        <pre style={{ fontSize: '0.72rem', color: '#666', marginBottom: 12, textAlign: 'left', maxWidth: 600, margin: '0 auto 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {error.message}
        </pre>
      )}
      <button onClick={retry}
        style={{ color: '#4a7c59', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', textDecoration: 'underline' }}>
        Try again
      </button>
    </div>
  )
}

// V4-PERFCLERK-001 C — the render gate is SPLIT from the fetch gate.
//
// It used to `return null` while auth resolved, which withheld the entire route tree for the ~2.5s
// Clerk window (measured 2026-08-12: isLoaded at t=3376ms) to protect the subset that needs a token.
// The FETCH gate is structural and is UNCHANGED: `children` is still not rendered while `loading`,
// so no page component mounts, no useEffect fires, and no tokenless request reaches a
// token-requiring endpoint. What changed is only what occupies the slot in the meantime — an
// identity-free skeleton instead of nothing, so the shell around it is worth painting.
//
// The three states are kept distinct on purpose. `loading` is NOT "signed out": collapsing them is
// what would redirect a signed-in user to /login mid-boot, and what made the header advertise
// "Sign in" during the window.
function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <RouteSkeleton />
  return user ? children : <Navigate to="/login" replace />
}

// V4-UNSCOPEDROUTES-001: detail routes are canonically UN-scoped (/plantings/:id, /events/:id) —
// project-less plantings (CaptureFlow creates them) had no reachable detail page under the
// /projects/:id/* forms, and PlantingDetail.jsx 404s a mismatched pair. The scoped forms live on
// as redirects so every existing link/bookmark keeps working; query strings are preserved
// (PlantingDetail reads ?edit= deep-links).
function ScopedPlantingRedirect() {
  const { plantingId } = useParams()
  const location = useLocation()
  return <Navigate to={{ pathname: `/plantings/${plantingId}`, search: location.search }} replace />
}

function ScopedEventRedirect() {
  const { eventId } = useParams()
  const location = useLocation()
  return <Navigate to={{ pathname: `/events/${eventId}`, search: location.search }} replace />
}

// V4-OVERLAY-001 Slice 1 (design V102 §3) — OverlayHost is a pure Sheet wrapper. It renders ONLY
// inside the overlay tree, which itself renders only when a background exists — so `open` is always
// true here. It wraps AROUND route.element (which already carries <Protected> + route-level
// <ErrorBoundary>), so a form throw is still caught by the route boundary and its fallback renders
// INSIDE the sheet. Passes ariaLabel (not title) so the dialog gets an accessible name with no
// duplicate visible heading (SC 4.1.2). onClose routes both backdrop tap and Escape to §4 dismiss.
// V4-DRAFTFULLPAGE-001 (b): hosts the dirty channel — content reports via useReportOverlayDirty and
// the value feeds Sheet's §5.2 dirty guard (backdrop tap no-ops while dirty; Escape/Close stay live).
// Exported for the wiring test only; App renders it solely inside the overlay tree.
export function OverlayHost({ ariaLabel, size = 'peek', children }) {
  const dismiss = useOverlayDismiss()
  const [dirty, setDirty] = React.useState(false)
  return (
    <Sheet open onClose={dismiss} ariaLabel={ariaLabel} size={size} dirty={dirty} kind="route">
      <OverlaySurfaceProvider>
        <OverlayDirtyProvider onDirtyChange={setDirty}>{children}</OverlayDirtyProvider>
      </OverlaySurfaceProvider>
    </Sheet>
  )
}

// SINGLE source of truth for BOTH route trees (design V102 §3). Each `element` is IDENTICAL to the
// historical inline JSX — <Protected> + route-level <ErrorBoundary> preserved verbatim — so the two
// trees cannot drift and the overlay tree can never drop a boundary. Only `overlayable` routes
// appear in the overlay tree, where their element is wrapped in <OverlayHost>; in the page tree the
// SAME element renders unwrapped (full page). Declaration order is preserved from the original for
// reviewability; react-router v6 ranks by specificity, so order does not affect matching. The route
// rationale comments that used to sit here live in git history (pre-Slice-1 App.jsx).
export function renderRoutes({ overlay, user, loading }) {
  const routes = [
    { path: '/',              element: <Navigate to="/today" replace /> },
    { path: '/garden/:slug',  element: <ProjectPublic /> },
    // ErrorBoundary is NOT decorative here: /garden was the only data-fetching route without one,
    // and it is the app's most-used surface. A throw escaped to the app-level boundary and blanked
    // the whole PWA — and because the service worker serves the bundle cache-first, a reload gets
    // the same broken bundle, so the user cannot recover without relaunching the installed app.
    // Scoped like every sibling route so a Garden throw costs Garden, not the application.
    { path: '/garden',        element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Garden /></ErrorBoundary></Protected> },
    { path: '/feed',          element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><FeedPage /></ErrorBoundary></Protected> },
    { path: '/auth/callback', element: <AuthCallback /> },
    // V4-PERFCLERK-001 C — the INVERSE leak, and the one easiest to miss. Every other route is
    // Protected, so `loading` is handled once inside <Protected>; /login is the only route whose
    // element branches on `user` itself. Left as `user ? … : <Login/>` it would render the SIGN-IN
    // PAGE to an already-signed-in user for the whole Clerk window and then yank it away — the
    // signed-out-shell flash, just pointing the other way. Previously invisible because the splash
    // covered it; now that the shell paints during the window it would be on screen.
    { path: '/login',         element: loading ? <RouteSkeleton /> : (user ? <Navigate to="/today" replace /> : <Login />) },
    { path: '/dashboard',     element: <Protected><Dashboard /></Protected> },
    { path: '/locations',     element: <Protected><Locations /></Protected> },
    { path: '/locations/:id', element: <Protected><LocationDetail /></Protected> },
    // V4-SPACEPHOTO-001 Lane C. Spread-in, NOT a `flag ? A : B` element swap: with the flag off the
    // paths are ABSENT from the table entirely (so /space falls through to the '*' catch-all exactly
    // as it does today, and App.routes.test.jsx's exact route-count pin is the mechanical proof of
    // inertness). /space is the single-space entry point; /space/:spaceId is the multi-space form.
    ...(SPACE_PHOTOS_ENABLED ? [
      { path: '/space',           element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><SpaceDetail /></ErrorBoundary></Protected> },
      { path: '/space/:spaceId',  element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><SpaceDetail /></ErrorBoundary></Protected> },
    ] : []),
    { path: '/tasks',         element: <Navigate to="/today" replace /> },
    // UNLINKED ON PURPOSE (Dave directive 2026-05-22), and this comment is now the ONLY record of
    // that: the entry point was TopBar's zone pill, and its "TO RESTORE: uncomment this block" note
    // died with TopBar.jsx in V4-APPBAR-003. The reason still holds — picking a zone here is a no-op.
    // ZoneContext.activeZone has ZERO readers anywhere (V4-ZONEDECIDE-001 removed the last one, a
    // dead destructure in Dashboard), and it is session-only state, so a pick does not survive a
    // reload. The page says so on screen.
    //
    // NOT to be confused with the zone filtering that DOES ship: Log Many's "By zone" scope
    // (ScopeChecklist.jsx tier-1 chips -> POST /api/events/batch `scope.type:'space'`, cascading
    // through the location subtree). That mechanism is per-invocation and does not touch
    // ZoneContext — so this page is not the thing keeping zone filtering alive, and retiring it
    // would not remove any working filter. Dave 2026-08-20 chose to KEEP zone filtering; this
    // picker stays parked, unlinked, pending a decision about an ambient app-wide zone.
    // Re-link only when such a zone actually filters something — and note the More menu's "Zones"
    // row already points at /locations, so a second entry would need a different name to not read
    // as a duplicate door.
    { path: '/zone',          element: <Protected><ZonePicker /></Protected> },
    // V4-PROJHIDE-001: the /projects tree is no longer a user-facing view — redirect its index to
    // /garden when hidden. Every other project route (new/:id/inactive/project-types/scoped shims/
    // admin classify) stays reachable-but-unlinked. Flag OFF renders the exact prior ProjectList.
    { path: '/projects',      element: PROJECTS_HIDDEN ? <Navigate to="/garden" replace /> : <Protected><ProjectList /></Protected> },
    { path: '/projects/new',  element: <Protected><ProjectNew /></Protected> },
    { path: '/projects/:id',  element: <Protected><ProjectDetail /></Protected> },
    // Unlinked per the PROJHIDE note above, but flipping that flag back does NOT restore its entry
    // point: Dashboard gates the link on `!PROJECTS_HIDDEN && inactiveCount > 0`, and the count
    // counts containers in status harvested/ended — of which prod had ZERO on 2026-08-20 (as it has
    // zero dismissals ever recorded). The surface works; nothing currently qualifies to appear on it.
    { path: '/inactive',      element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><InactiveProjects /></ErrorBoundary></Protected> },
    { path: '/inventory',     element: <Protected><Inventory /></Protected> },
    { path: '/inventory/add', element: <Protected><InventoryAdd /></Protected> },
    { path: '/inventory/add-seeds', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><AddSeeds /></ErrorBoundary></Protected> },
    { path: '/inventory/:id', element: <Protected><InventoryDetail /></Protected> },
    { path: '/sow',           element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><SowNow /></ErrorBoundary></Protected> },
    { path: '/log',           overlayable: true, ariaLabel: 'Log an event',      size: 'full', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><EventNew /></ErrorBoundary></Protected> },
    { path: '/log/many',      overlayable: true, ariaLabel: 'Log many',          size: 'full', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><LogMany /></ErrorBoundary></Protected> },
    { path: '/put-up',        overlayable: true, ariaLabel: 'Log a put-up',       size: 'full', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><PutUp /></ErrorBoundary></Protected> },
    { path: '/photos',        element: <Protected><PhotoLibrary /></Protected> },
    // W-RESTORE. Declared AFTER /photos and matched with `end: true` by react-router v6, so the two
    // never compete. Boundaried like its data-fetching siblings: a throw here must cost this page,
    // not the shell — and this is the page a user reaches specifically because something already
    // went wrong, so it is the worst possible place to white-screen the PWA.
    { path: '/photos/deleted', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><RecentlyDeleted /></ErrorBoundary></Protected> },
    { path: '/harvests',      element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Harvests /></ErrorBoundary></Protected> },
    { path: '/favorites',     element: <Protected><Favorites /></Protected> },
    { path: '/search',        overlayable: true, ariaLabel: 'Search your garden', size: 'peek', element: <Protected><Search /></Protected> },
    { path: '/project-types', element: <Protected><ProjectTypes /></Protected> },
    { path: '/plants',        element: <PlantsRedirect /> },
    { path: '/plants/catch-up', element: <Protected><PlantsCatchUp /></Protected> },
    { path: '/events/:eventId', element: <Protected><EventDetail /></Protected> },
    { path: '/plantings/:plantingId', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><PlantingDetail /></ErrorBoundary></Protected> },
    { path: '/varieties/:varietyId/edit', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><VarietyEdit /></ErrorBoundary></Protected> },
    { path: '/projects/:id/events/:eventId', element: <ScopedEventRedirect /> },
    { path: '/projects/:id/plantings/:plantingId', element: <ScopedPlantingRedirect /> },
    { path: '/achievements',  element: <Protected><Achievements /></Protected> },
    { path: '/findings',      element: <Protected><Findings /></Protected> },
    { path: '/today',         element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Today /></ErrorBoundary></Protected> },
    { path: '/capture',       element: <Protected><CaptureFlow /></Protected> },
    // V4-COLLECTIONSPLIT-001 — the Suspense boundary belongs HERE, at the route, not at the shell:
    // a shell-level boundary would blank TopChrome/BottomNav while the chunk lands.
    { path: '/collection',    element: <Protected><React.Suspense fallback={<ChunkFallback />}><Collection /></React.Suspense></Protected> },
    { path: '/admin/classify', element: <Protected><ProjectsAdminClassify /></Protected> },
    { path: '/admin/garden-activity', element: <Protected><GardenActivity /></Protected> },
    // BUG-VOICEDUPE-002 raw Web Speech capture. Unlinked + Jen-invisible, same convention as
    // /admin/garden-activity. Shows only this browser's own localStorage — no server call.
    { path: '/admin/voice-debug', element: <Protected><VoiceDebug /></Protected> },
    { path: '/helper',        element: <Protected><GardenHelper /></Protected> },
    { path: '/settings',      element: <Protected><Settings /></Protected> },
    { path: '/settings/notifications', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><SettingsNotifications /></ErrorBoundary></Protected> },
    { path: '/field',         element: <Protected><FieldCapture /></Protected> },
    { path: '/about',         element: <Protected><About /></Protected> },
    { path: '/releases',      element: <Protected><ReleaseNotes /></Protected> },
    { path: '*',              element: <Navigate to="/today" replace /> },
  ]
  const list = overlay ? routes.filter(r => r.overlayable) : routes
  return list.map(r => (
    <Route
      key={r.path}
      path={r.path}
      element={overlay && r.overlayable ? <OverlayHost ariaLabel={r.ariaLabel} size={r.size}>{r.element}</OverlayHost> : r.element}
    />
  ))
}

// The authenticated shell. Reads the effective PAGE location (background when an overlay is open,
// else the real location) so the page tree and chrome stay on the background while the overlay tree
// (if any) renders at the real URL. See OverlayContext.
function AppShell({ user, loading, identity }) {
  const { pageLocation, overlayLocation, background } = useOverlay()

  // V4-COLDSTART-001 — the ONE place the `unknown` identity renders, and it renders INSTEAD OF the
  // whole tree rather than inside a slot in it.
  //
  // Placing the gate here, above <TopChrome>, the <Routes>, <NavSkeleton>, <TodayBand>, <BottomNav>
  // and the critter controller, is what makes the leak review a structural argument instead of an
  // enumeration: in this state the app renders exactly one prop-less, context-free component and
  // NOTHING else mounts, so there is no surface left to audit for a title, a count or a photo.
  // Swapping only the route slot (the tempting smaller diff) would keep the pending chrome up and
  // leave every future header/nav change needing to re-prove itself against this state.
  //
  // The providers ABOVE AppShell (Favorites/Zone/Mode/Toast) do still mount, but `unknown` is a
  // subset of `loading` — they are in exactly the state authRenderGate property 3 already pins as
  // issuing zero requests, and the new suite re-pins it for this state specifically.
  if (identity === 'unknown') return <IdentityUnavailable />

  return (
    <>
      <TopChrome />
      <div style={{
        // The pending state reserves the nav's height from the CONSTANT rather than from
        // --bottom-nav-height: that variable is written by BottomNav's layout effect and BottomNav is
        // not mounted yet, so the var is unset and the whole calc() would be invalid (i.e. no
        // padding, i.e. the skeleton nav covers the last row of the skeleton content).
        display: 'flex', flexDirection: 'column', minHeight: '100dvh',
        paddingBottom: user ? 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))'
          : loading ? `calc(${BOTTOM_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom))`
          : 0,
      }}>
        <div style={{ flex: 1 }}>
          {/* PAGE tree — renders at pageLocation (== the real location when flag off / no overlay). */}
          <Routes location={pageLocation}>
            {renderRoutes({ overlay: false, user, loading })}
          </Routes>
        </div>
      </div>
      {/* OVERLAY tree — mounts ONLY when a background exists (flag on + an overlay was opened).
          Renders at the REAL location so overlay content reads the true URL (reads/writes aligned). */}
      {OVERLAY_ROUTES_ENABLED && background && (
        <Routes location={overlayLocation}>
          {renderRoutes({ overlay: true, user, loading })}
        </Routes>
      )}
      {user && <TodayBand />}
      {user && <BottomNav />}
      {/* V4-PERFCLERK-001 C — the nav SLOT while identity is unresolved. Gated on `loading`, never on
          `!user`, so it appears only in the pending window and never for a genuinely signed-out user
          (who gets the login page, which has no nav). Mutually exclusive with <BottomNav> above:
          loading true implies user null, and user non-null implies loading false. */}
      {loading && <NavSkeleton />}
      {/* V4-CRITTERQUIET-001: the arrival animation is THE interrupt — it plays over whatever route
          Dave is on, mid-task. Gated at the mount site rather than inside the controller so quiet
          mode also stops the per-navigation /api/critters/active poll it exists to drive; nothing
          else consumes that poll (the BottomNav dot and Collection fetch their own). The controller
          and its tests are untouched, so flipping CRITTERS_QUIET false restores it exactly. */}
      {user && !CRITTERS_QUIET && <CritterArrivalController />}
      {/* BUG-STALECLIENT-001: update affordance renders regardless of auth — a stale shell
          on the login screen needs the Refresh path too. */}
      <UpdateBanner />
    </>
  )
}

function AppRoutes() {
  const { user, loading, identity } = useAuth()
  return (
    <BrowserRouter>
      <ErrorBoundary scope="app" fallback={<AppFallback />}>
        {/* V4-BACKNAV-001 Slice 1 — DismissRegistryProvider wraps OverlayProvider so that route
            overlays (OverlayHost's Sheet) register in the SAME stack as non-route sheets and
            Lightbox. One stack is the point: two stacks would each believe they own "topmost" and
            a single Escape (later, a single Back) would resolve against whichever answered first. */}
        <DismissRegistryProvider>
          <OverlayProvider>
            <AppShell user={user} loading={loading} identity={identity} />
          </OverlayProvider>
        </DismissRegistryProvider>
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default function App() {
  // V4-PERFTHEMEA-001: hand the screen over from index.html's pre-React #boot-splash to
  // SplashScreen. LAYOUT effect, not a passive one, so the removal commits in the same frame that
  // paints SplashScreen — both are P.cream, so the handover is invisible. A passive effect would
  // allow a paint in between, i.e. one frame of the white flash this whole change removes.
  React.useLayoutEffect(dismissBootSplash, [])

  // ModeProvider — Field/Desk mode scaffold (Post-V2 UX overhaul Inc 2 Bite 2).
  // Global app-state (Open Q #2 → global, not per-page). Sits inside Auth so
  // it can later read user prefs if needed, outside Zone so the mode chip
  // remains stable as zones change. Session-persistent via sessionStorage.
  return (
    <AuthProvider>
      {/* V4-PERFTHEMEA-001 moved this INSIDE AuthProvider so it could read `loading` and exit on
          readiness. V4-PERFCLERK-001 C removed that coupling — Protected now paints a skeleton, so
          the shell is behind the splash from the first commit and the brand hold is the exit again.
          Left in place rather than hoisted: it is a sibling overlay (position:fixed) covering login
          and every route, and moving it would change nothing except the diff. */}
      <SplashScreen />
      <ModeProvider>
        <ZoneProvider>
          <FavoritesProvider>
            <ToastProvider>
              <AppRoutes />
            </ToastProvider>
          </FavoritesProvider>
        </ZoneProvider>
      </ModeProvider>
    </AuthProvider>
  )
}

