import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ZoneProvider } from './context/ZoneContext.jsx'
import TopBar from './components/TopBar.jsx'
import BottomNav from './components/BottomNav.jsx'
import Footer from './components/Footer.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Locations from './pages/Locations.jsx'
import Tasks from './pages/Tasks.jsx'
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
import Plants from './pages/Plants.jsx'
import LocationDetail from './pages/LocationDetail.jsx'
import EventDetail from './pages/EventDetail.jsx'
import Achievements from './pages/Achievements.jsx'

// W1 placeholder — W4 replaces with import InactiveProjects from './pages/InactiveProjects.jsx'
function InactivePlaceholder() {
  return <div style={{ padding: '48px 20px', textAlign: 'center', color: '#777' }}>Loading inactive projects...</div>
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
          paddingBottom: user ? 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))' : 0,
        }}>
          <div style={{ flex: 1 }}>
            <Routes>
              <Route path="/"              element={<Navigate to="/dashboard" replace />} />
              <Route path="/garden/:slug"  element={<ProjectPublic />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/login"         element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
              <Route path="/dashboard"     element={<Protected><Dashboard /></Protected>} />
              <Route path="/locations"     element={<Protected><Locations /></Protected>} />
              <Route path="/locations/:id" element={<Protected><LocationDetail /></Protected>} />
              <Route path="/tasks"         element={<Protected><Tasks /></Protected>} />
              <Route path="/zone"          element={<Protected><ZonePicker /></Protected>} />
              <Route path="/projects"      element={<Protected><ProjectList /></Protected>} />
              <Route path="/projects/new"  element={<Protected><ProjectNew /></Protected>} />
              <Route path="/projects/:id"  element={<Protected><ProjectDetail /></Protected>} />
              <Route path="/inactive"      element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><InactivePlaceholder /></ErrorBoundary></Protected>} />
              <Route path="/inventory"     element={<Protected><Inventory /></Protected>} />
              <Route path="/inventory/add" element={<Protected><InventoryAdd /></Protected>} />
              <Route path="/inventory/:id" element={<Protected><InventoryDetail /></Protected>} />
              <Route path="/log"           element={<Protected><ErrorBoundary scope="route" fallback={<RouteFallback />}><EventNew /></ErrorBoundary></Protected>} />
              <Route path="/photos"        element={<Protected><PhotoLibrary /></Protected>} />
              <Route path="/favorites"     element={<Protected><Favorites /></Protected>} />
              <Route path="/project-types" element={<Protected><ProjectTypes /></Protected>} />
              <Route path="/plants"        element={<Protected><Plants /></Protected>} />
              <Route path="/projects/:id/events/:eventId" element={<Protected><EventDetail /></Protected>} />
              <Route path="/achievements" element={<Protected><Achievements /></Protected>} />
              <Route path="*"             element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>
          <Footer />
        </div>
        {user && <BottomNav />}
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ZoneProvider>
        <AppRoutes />
      </ZoneProvider>
    </AuthProvider>
  )
}
