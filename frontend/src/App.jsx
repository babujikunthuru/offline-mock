import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Navbar from './components/common/Navbar.jsx'
import RoleGuard from './components/common/RoleGuard.jsx'
import { useAuth } from './context/AuthContext.js'
import Login from './pages/auth/Login.jsx'
import Register from './pages/auth/Register.jsx'
import AdminContent from './pages/admin/AdminContent.jsx'
import AdminDashboard from './pages/admin/AdminDashboard.jsx'
import AdminRubric from './pages/admin/AdminRubric.jsx'
import InterviewSetup from './pages/student/InterviewSetup.jsx'
import LiveInterview from './pages/student/LiveInterview.jsx'
import NotesLibrary from './pages/student/NotesLibrary.jsx'
import SessionReport from './pages/student/SessionReport.jsx'
import Settings from './pages/student/Settings.jsx'
import SkillDrills from './pages/student/SkillDrills.jsx'
import StudentDashboard from './pages/student/StudentDashboard.jsx'

function HomeRedirect() {
  const { user, loading } = useAuth()
  if (loading) {
    return <main className="p-8 text-center text-slate-600" role="status">Loading your workspace…</main>
  }
  if (user?.role === 'student') return <Navigate replace to="/student/dashboard" />
  if (user?.role === 'admin') return <Navigate replace to="/admin/dashboard" />
  return <Navigate replace to="/login" />
}

function AuthenticatedLayout() {
  return (
    <>
      <Navbar />
      <Outlet />
    </>
  )
}

function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-6 py-20 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-primary-700">404</p>
      <h1 className="mt-3 text-3xl font-bold text-slate-900">Page not found</h1>
      <p className="mt-3 text-slate-600">The page you requested does not exist.</p>
      <Link className="focus-ring mt-6 inline-flex rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white" to="/">
        Go to home
      </Link>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<HomeRedirect />} path="/" />
      <Route element={<Login />} path="/login" />
      <Route element={<Register />} path="/register" />

      <Route element={<RoleGuard role="student" />}>
        <Route element={<AuthenticatedLayout />}>
          <Route element={<StudentDashboard />} path="/student/dashboard" />
          <Route element={<NotesLibrary />} path="/student/notes" />
          <Route element={<InterviewSetup />} path="/student/setup" />
          <Route element={<LiveInterview />} path="/student/interview" />
          <Route element={<SessionReport />} path="/student/report/:id" />
          <Route element={<SkillDrills />} path="/student/drills" />
          <Route element={<Settings />} path="/student/settings" />
        </Route>
      </Route>

      <Route element={<RoleGuard role="admin" />}>
        <Route element={<AuthenticatedLayout />}>
          <Route element={<AdminDashboard />} path="/admin/dashboard" />
          <Route element={<AdminContent />} path="/admin/content" />
          <Route element={<AdminRubric />} path="/admin/rubric" />
        </Route>
      </Route>

      <Route element={<NotFound />} path="*" />
    </Routes>
  )
}
