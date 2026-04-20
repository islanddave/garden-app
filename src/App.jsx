import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
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
import { P } from './lib/constants.js'

function Protected({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  return user ? children : <Navigate to="/login" replace />
}

function AppRoutes() {
  const { user } = useAuth()

  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/"             element={<Home />} />
        <Route path="/garden/:slug" element={<ProjectPublic />} />
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
        <Route path="/projects"
          element={<Protected><ProjectList /></Protected>}
        />
        <Route path="/projects/new"
          element={<Protected><ProjectNew /></Protected>}
        />
        <Route path="/projects/:id"
          element={<Protected><ProjectDetail /></Protected>}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
