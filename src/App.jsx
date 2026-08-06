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
import Collection from './pages/Collection.jsx'
import InactiveProjects from './pages/InactiveProjects.jsx'
import ProjectsAdminClassify from './pages/ProjectsAdminClassify.jsx'
import GardenActivity from './pages/GardenActivity.jsx'
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
import SplashScreen from './components/SplashScreen.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import Sheet from './components/forms/Sheet.jsx'
import { OverlayProvider, OverlaySurfaceProvider, OverlayDirtyProvider, useOverlay, useOverlayDismiss } from './context/OverlayContext.jsx'
import { DismissRegistryProvider } from './context/DismissRegistry.jsx'
import { OVERLAY_ROUTES_ENABLED, PROJECTS_HIDDEN, SPACE_PHOTOS_ENABLED } from './lib/featureFlags.js'

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

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
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
export function renderRoutes({ overlay, user }) {
  const routes = [
    { path: '/',              element: <Navigate to="/today" replace /> },
    { path: '/garden/:slug',  element: <ProjectPublic /> },
    { path: '/garden',        element: <Protected><Garden /></Protected> },
    { path: '/feed',          element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><FeedPage /></ErrorBoundary></Protected> },
    { path: '/auth/callback', element: <AuthCallback /> },
    { path: '/login',         element: user ? <Navigate to="/today" replace /> : <Login /> },
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
    { path: '/zone',          element: <Protected><ZonePicker /></Protected> },
    // V4-PROJHIDE-001: the /projects tree is no longer a user-facing view — redirect its index to
    // /garden when hidden. Every other project route (new/:id/inactive/project-types/scoped shims/
    // admin classify) stays reachable-but-unlinked. Flag OFF renders the exact prior ProjectList.
    { path: '/projects',      element: PROJECTS_HIDDEN ? <Navigate to="/garden" replace /> : <Protected><ProjectList /></Protected> },
    { path: '/projects/new',  element: <Protected><ProjectNew /></Protected> },
    { path: '/projects/:id',  element: <Protected><ProjectDetail /></Protected> },
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
    { path: '/harvests',      element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Harvests /></ErrorBoundary></Protected> },
    { path: '/favorites',     element: <Protected><Favorites /></Protected> },
    { path: '/search',        overlayable: true, ariaLabel: 'Search your garden', size: 'peek', element: <Protected><Search /></Protected> },
    { path: '/project-types', element: <Protected><ProjectTypes /></Protected> },
    { path: '/plants',        element: <PlantsRedirect /> },
    { path: '/plants/catch-up', element: <Protected><PlantsCatchUp /></Protected> },
    { path: '/events/:eventId', element: <Protected><EventDetail /></Protected> },
    { path: '/plantings/:plantingId', element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><PlantingDetail /></ErrorBoundary></Protected> },
    { path: '/projects/:id/events/:eventId', element: <ScopedEventRedirect /> },
    { path: '/projects/:id/plantings/:plantingId', element: <ScopedPlantingRedirect /> },
    { path: '/achievements',  element: <Protected><Achievements /></Protected> },
    { path: '/findings',      element: <Protected><Findings /></Protected> },
    { path: '/today',         element: <Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Today /></ErrorBoundary></Protected> },
    { path: '/capture',       element: <Protected><CaptureFlow /></Protected> },
    { path: '/collection',    element: <Protected><Collection /></Protected> },
    { path: '/admin/classify', element: <Protected><ProjectsAdminClassify /></Protected> },
    { path: '/admin/garden-activity', element: <Protected><GardenActivity /></Protected> },
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
function AppShell({ user }) {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <TopChrome />
      <div style={{
        display: 'flex', flexDirection: 'column', minHeight: '100dvh',
        paddingBottom: user ? 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' : 0,
      }}>
        <div style={{ flex: 1 }}>
          {/* PAGE tree — renders at pageLocation (== the real location when flag off / no overlay). */}
          <Routes location={pageLocation}>
            {renderRoutes({ overlay: false, user })}
          </Routes>
        </div>
      </div>
      {/* OVERLAY tree — mounts ONLY when a background exists (flag on + an overlay was opened).
          Renders at the REAL location so overlay content reads the true URL (reads/writes aligned). */}
      {OVERLAY_ROUTES_ENABLED && background && (
        <Routes location={overlayLocation}>
          {renderRoutes({ overlay: true, user })}
        </Routes>
      )}
      {user && <TodayBand />}
      {user && <BottomNav />}
      {user && <CritterArrivalController />}
      {/* BUG-STALECLIENT-001: update affordance renders regardless of auth — a stale shell
          on the login screen needs the Refresh path too. */}
      <UpdateBanner />
    </>
  )
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <BrowserRouter>
      <ErrorBoundary scope="app" fallback={<AppFallback />}>
        {/* V4-BACKNAV-001 Slice 1 — DismissRegistryProvider wraps OverlayProvider so that route
            overlays (OverlayHost's Sheet) register in the SAME stack as non-route sheets and
            Lightbox. One stack is the point: two stacks would each believe they own "topmost" and
            a single Escape (later, a single Back) would resolve against whichever answered first. */}
        <DismissRegistryProvider>
          <OverlayProvider>
            <AppShell user={user} />
          </OverlayProvider>
        </DismissRegistryProvider>
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default function App() {
  // ModeProvider — Field/Desk mode scaffold (Post-V2 UX overhaul Inc 2 Bite 2).
  // Global app-state (Open Q #2 → global, not per-page). Sits inside Auth so
  // it can later read user prefs if needed, outside Zone so the mode chip
  // remains stable as zones change. Session-persistent via sessionStorage.
  return (
    <>
      <SplashScreen />
    <AuthProvider>
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
    </>
  )
}

