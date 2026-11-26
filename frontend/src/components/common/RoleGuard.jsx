import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.js'

export default function RoleGuard({ role, children }) {
  const { user, token, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <main className="p-8 text-center text-slate-600" role="status">
        Checking your session…
      </main>
    )
  }

  if (!token || !user) {
    return <Navigate replace state={{ from: location }} to="/login" />
  }

  if (role && user.role !== role) {
    const home = user.role === 'admin' ? '/admin/dashboard' : user.role === 'student' ? '/student/dashboard' : '/login'
    return <Navigate replace to={home} />
  }

  return children || <Outlet />
}
