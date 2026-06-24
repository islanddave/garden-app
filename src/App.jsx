import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { FavoritesProvider } from './context/FavoritesContext.jsx'
import { ZoneProvider } from './context/ZoneContext.jsx'
import { ModeProvider } from './context/ModeContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import TopBar from './components/TopBar.jsx'
import BottomNav from './components/BottomNav.jsx'
import PlantsRedirect from './components/PlantsRedirect.jsx'
import TodayBand from './components/TodayBand.jsx'
import CritterArrivalController from './components/CritterArrivalController.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
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

function AppRoutes() {
  const { user } = useAuth()
  return (
    <BrowserRouter>
      <ErrorBoundary scope="app" fallback={<AppFallback />}>
        <TopBar />
        <div style={{
          display: 'flex', flexDirection: 'column', minHeight: '100dvh',
          paddingBottom: user ? 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))' : 0,
        }}>
          <div style={{ flex: 1 }}>
            <Routes>
              <Route path="/"              element={<Navigate to="/today" replace />} />
              <Route path="/garden/:slug"  element={<ProjectPublic />} />
              <Route path="/garden"        element={<Protected><Garden /></Protected>} />
              <Route path="/feed"          element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><FeedPage /></ErrorBoundary></Protected>} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/login"         element={user ? <Navigate to="/today" replace /> : <Login />} />
              <Route path="/dashboard"     element={<Protected><Dashboard /></Protected>} />
              <Route path="/locations"     element={<Protected><Locations /></Protected>} />
              <Route path="/locations/:id" element={<Protected><LocationDetail /></Protected>} />
              <Route path="/tasks"         element={<Navigate to="/today" replace />} />
              <Route path="/zone"          element={<Protected><ZonePicker /></Protected>} />
              <Route path="/projects"      element={<Protected><ProjectList /></Protected>} />
              <Route path="/projects/new"  element={<Protected><ProjectNew /></Protected>} />
              <Route path="/projects/:id"  element={<Protected><ProjectDetail /></Protected>} />
              <Route path="/inactive"      element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><InactiveProjects /></ErrorBoundary></Protected>} />
              <Route path="/inventory"     element={<Protected><Inventory /></Protected>} />
              <Route path="/inventory/add" element={<Protected><InventoryAdd /></Protected>} />
              <Route path="/inventory/:id" element={<Protected><InventoryDetail /></Protected>} />
              <Route path="/log"           element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><EventNew /></ErrorBoundary></Protected>} />
              <Route path="/log/many"      element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><LogMany /></ErrorBoundary></Protected>} />
              <Route path="/photos"        element={<Protected><PhotoLibrary /></Protected>} />
              <Route path="/favorites"     element={<Protected><Favorites /></Protected>} />
              <Route path="/project-types" element={<Protected><ProjectTypes /></Protected>} />
              {/* V3-IA: Plants page retired; legacy links redirect into Garden (query preserved). */}
              <Route path="/plants"        element={<PlantsRedirect />} />
              <Route path="/plants/catch-up" element={<Protected><PlantsCatchUp /></Protected>} />
              <Route path="/projects/:id/events/:eventId" element={<Protected><EventDetail /></Protected>} />
              {/* V3-NAV-001 (Lane C / PR2): dedicated planting detail. Route-level ErrorBoundary
                  (fresh fetch surface) mirrors /inactive, /log, /settings/notifications. */}
              <Route path="/projects/:id/plantings/:plantingId" element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><PlantingDetail /></ErrorBoundary></Protected>} />
              <Route path="/achievements" element={<Protected><Achievements /></Protected>} />
              <Route path="/findings"     element={<Protected><Findings /></Protected>} />
              {/* DRG-TODAY-002: Today / daily care surface. Consumes GET /api/daily-plan (per-user read of
                  the overnight Daily Plan engine, DRG-TODAY-001). Route-level ErrorBoundary (fresh fetch
                  surface) mirrors /findings, /inactive. */}
              <Route path="/today"        element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><Today /></ErrorBoundary></Protected>} />
              <Route path="/capture"      element={<Protected><CaptureFlow /></Protected>} />
              <Route path="/collection" element={<Protected><Collection /></Protected>} />
              {/* V1.2a-4 S6 admin classify route. Jen-invisible (no nav link).
                  Desktop-only viewport guard inside the component. Lambda-side
                  ADMIN_CLERK_SUBS allowlist is the real security; this route
                  shows a placard to non-admins / mobile. */}
              <Route path="/admin/classify" element={<Protected><ProjectsAdminClassify /></Protected>} />
              {/* Inc 0 success-metric diagnostic. Jen-invisible (no nav link).
                  Lambda-side ADMIN_CLERK_SUBS allowlist is the real security;
                  non-admins see a neutral placard. */}
              <Route path="/admin/garden-activity" element={<Protected><GardenActivity /></Protected>} />
              {/* Post-V2 UX overhaul Inc 2 Bite 1: Rung-1 advisory helper-prompt.
                  Non-recording scaffold (no DB writes); composes a prompt with a
                  C4 untrusted-data fence and copies/shares to Claude.
                  See postv2-ux-overhaul-inc2-bite-decomposition-V001-20260528.1145.md */}
              <Route path="/helper"        element={<Protected><GardenHelper /></Protected>} />
              {/* MVP-Critter Session 4 Phase A — Settings → Notifications.
                  /settings parent permissive redirects to /settings/notifications per
                  revision §3.23 (forward-compat for future nested settings).
                  Wrap in ErrorBoundary per §3.23 — mirrors /inactive route-level pattern.
                  See mvp-critter-pre-build-revision-V001-20260528.md §3.17/§3.23/§3.24. */}
              <Route path="/settings"      element={<Protected><Settings /></Protected>} />
              <Route path="/settings/notifications" element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><SettingsNotifications /></ErrorBoundary></Protected>} />
              {/* Post-V2 UX overhaul Inc 2 Bite 3: Field capture surface MVP.
                  Glove-and-glare mic UI + tap-to-type fallback + queued-count
                  indicator. Gated on useMode()==='field'; Desk-mode visits
                  redirect to /dashboard. SURFACE ONLY — Bite 4 wires real
                  getUserMedia + IndexedDB. */}
              <Route path="/field"         element={<Protected><FieldCapture /></Protected>} />
              <Route path="/about"        element={<Protected><About /></Protected>} />
              <Route path="/releases"     element={<Protected><ReleaseNotes /></Protected>} />
              <Route path="*"             element={<Navigate to="/today" replace />} />
            </Routes>
          </div>
        </div>
        {user && <TodayBand />}
        {user && <BottomNav />}
        {user && <CritterArrivalController />}
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
  )
}

