import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import axiosClient from '../../api/axiosClient.js'
import { getSocketStatus, subscribeSocketStatus } from '../../api/socketClient.js'
import { useAuth } from '../../context/AuthContext.js'

const navigation = {
  student: [
    { label: 'Dashboard', to: '/student/dashboard' },
    { label: 'Notes', to: '/student/notes' },
    { label: 'Practice', to: '/student/setup' },
    { label: 'Skill drills', to: '/student/drills' },
    { label: 'Settings', to: '/student/settings' },
  ],
  admin: [
    { label: 'Dashboard', to: '/admin/dashboard' },
    { label: 'Content', to: '/admin/content' },
    { label: 'Rubric', to: '/admin/rubric' },
  ],
}

export default function Navbar() {
  const { user, role, logout } = useAuth()
  const navigate = useNavigate()
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine)
  const [backendOnline, setBackendOnline] = useState(null)
  const [socketStatus, setSocketStatus] = useState(getSocketStatus)

  useEffect(() => {
    const markOnline = () => setBrowserOnline(true)
    const markOffline = () => setBrowserOnline(false)
    window.addEventListener('online', markOnline)
    window.addEventListener('offline', markOffline)
    return () => {
      window.removeEventListener('online', markOnline)
      window.removeEventListener('offline', markOffline)
    }
  }, [])

  useEffect(() => subscribeSocketStatus(setSocketStatus), [])

  useEffect(() => {
    let active = true
    const checkBackend = () => {
      axiosClient.get('/health', { timeout: 5000 })
        .then(() => {
          if (active) setBackendOnline(true)
        })
        .catch(() => {
          if (active) setBackendOnline(false)
        })
    }

    checkBackend()
    const intervalId = window.setInterval(checkBackend, 15000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [])

  const signOut = () => {
    logout()
    navigate('/login', { replace: true })
  }

  let connectionLabel = 'Online'
  let indicatorColor = 'bg-success-500'
  if (!browserOnline) {
    connectionLabel = 'Browser offline'
    indicatorColor = 'bg-danger-500'
  } else if (backendOnline === false) {
    connectionLabel = 'Backend offline'
    indicatorColor = 'bg-danger-500'
  } else if (backendOnline === null) {
    connectionLabel = 'Checking backend…'
    indicatorColor = 'bg-warning-500'
  } else if (socketStatus === 'reconnecting') {
    connectionLabel = 'Reconnecting…'
    indicatorColor = 'bg-warning-500'
  } else if (socketStatus !== 'connected') {
    connectionLabel = 'Socket offline'
    indicatorColor = 'bg-warning-500'
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <Link className="font-semibold text-primary-700" to="/">
          TalkReady
        </Link>
        <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-2">
          {(navigation[role] || []).map((item) => (
            <NavLink
              className={({ isActive }) => `focus-ring rounded-lg px-3 py-2 text-sm font-medium ${
                isActive ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
              key={item.to}
              to={item.to}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <span
            aria-live="polite"
            className="inline-flex items-center gap-2 text-sm text-slate-600"
            title={`Browser: ${browserOnline ? 'online' : 'offline'}; backend: ${
              backendOnline === null ? 'checking' : backendOnline ? 'online' : 'offline'
            }; socket: ${socketStatus}`}
          >
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${indicatorColor}`} />
            {connectionLabel}
          </span>
          <span className="hidden text-sm text-slate-600 sm:inline">{user?.name || user?.email}</span>
          <button
            className="focus-ring rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={signOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
