import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ZoneProvider } from './context/ZoneContext.jsx'
import Nav from './components/Nav.jsx'
import Home from './pages/Home.jsx'
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
import EventNew from './pages/EventNew.jsx'
import { P } from './lib/constants.js'

// ---- Protected route wrapper ----
// Render nothing while loading to prevent flash-of-unauth content with stale/expired tokens.
// Only after getSession() resolves do we know the true auth state.
function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  return user ? children : <Navigate to="/login" replace />
}

// ---- Routes (inside AuthProvider so useAuth is available) ----
function AppRoutes() {
  const { user } = useAuth()

  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        {/* ---- Public ---- */}
        <Route path="/"             element={<Home />} />
        <Route path="/garden/:slug" element={<ProjectPublic />} />

        {/* ---- Auth ---- */}
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/login"
          element={user ? <Navigate to="/dashboard" replace /> : <Login />}
        />
        <Route path="/dashboard"
          element={<Protected><Dashboard /></Protected>}
        />
        <Route path="/locations"
          element={<Protected><Locations /></Protected>}
        />
        <Route path="/tasks"
          element={<Protected><Tasks /></Protected>}
        />
        <Route path="/zone"
          element={<Protected><ZonePicker /></Protected>}
        />
        <Route path="/projects"
          element={<Protected><ProjectList /></Protected>}
        />
        <Route path="/projects/new"
          element={<Protected><ProjectNew /></Protected>}
        />
        <Route path="/projects/:id"
          element={<Protected><ProjectDetail /></Protected>}
        />
        <Route path="/inventory"
          element={<Protected><Inventory /></Protected>}
        />
        <Route path="/log"
          element={<Protected><EventNew /></Protected>}
        />

        {/* ---- Catch-all ---- */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

// ---- Root ----
export default function App() {
  return (
    <AuthProvider>
      <ZoneProvider>
        <AppRoutes />
      </ZoneProvider>
    </AuthProvider>
  )
}
