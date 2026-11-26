import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axiosClient, { AUTH_TOKEN_KEY } from '../api/axiosClient.js'
import { connectSocket, disconnectSocket } from '../api/socketClient.js'
import { useToast } from './ToastContext.js'
import { AuthContext } from './AuthContext.js'

function getStoredToken() {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(AUTH_TOKEN_KEY)
}

export function AuthProvider({ children }) {
  const { showToast } = useToast()
  const [token, setToken] = useState(getStoredToken)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(() => Boolean(getStoredToken()))
  const authRequestId = useRef(0)

  const clearAuth = useCallback(() => {
    authRequestId.current += 1
    window.localStorage.removeItem(AUTH_TOKEN_KEY)
    setToken(null)
    setUser(null)
    disconnectSocket()
  }, [])

  const loadProfile = useCallback(async () => {
    const response = await axiosClient.get('/auth/me')
    const refreshedUser = response?.user || response
    if (!refreshedUser?.role) {
      throw new Error('The server returned an invalid user profile.')
    }
    return refreshedUser
  }, [])

  const refresh = useCallback(async () => {
    const requestId = ++authRequestId.current
    const storedToken = getStoredToken()
    if (!storedToken) {
      setToken(null)
      setUser(null)
      setLoading(false)
      return null
    }

    setToken(storedToken)
    setLoading(true)
    try {
      const refreshedUser = await loadProfile()
      if (requestId !== authRequestId.current) return null
      setUser(refreshedUser)
      connectSocket(storedToken)
      return refreshedUser
    } catch (error) {
      if (requestId !== authRequestId.current) return null
      if (error.status !== 401) {
        setUser(null)
        showToast(`Unable to refresh your session: ${error.message}`, 'error')
      }
      return null
    } finally {
      if (requestId === authRequestId.current) setLoading(false)
    }
  }, [loadProfile, showToast])

  const establishSession = useCallback((response) => {
    const nextToken = response?.token
    const nextUser = response?.user
    if (!nextToken || !nextUser?.role) {
      throw new Error('The server returned an invalid authentication response.')
    }

    authRequestId.current += 1
    window.localStorage.setItem(AUTH_TOKEN_KEY, nextToken)
    setToken(nextToken)
    setUser(nextUser)
    connectSocket(nextToken)
    return nextUser
  }, [])

  const login = useCallback(async (credentials) => {
    const response = await axiosClient.post('/auth/login', credentials)
    return establishSession(response)
  }, [establishSession])

  const register = useCallback(async (details) => {
    const response = await axiosClient.post('/auth/register', details)
    return establishSession(response)
  }, [establishSession])

  const logout = useCallback(() => {
    clearAuth()
  }, [clearAuth])

  useEffect(() => {
    const handleUnauthorized = () => clearAuth()
    window.addEventListener('talkready:unauthorized', handleUnauthorized)
    let active = true
    const requestId = ++authRequestId.current
    const storedToken = getStoredToken()
    if (storedToken) {
      loadProfile()
        .then((profile) => {
          if (active && requestId === authRequestId.current) {
            setUser(profile)
            connectSocket(storedToken)
          }
        })
        .catch((error) => {
          if (active && requestId === authRequestId.current && error.status !== 401) {
            showToast(`Unable to refresh your session: ${error.message}`, 'error')
          }
        })
        .finally(() => {
          if (active && requestId === authRequestId.current) setLoading(false)
        })
    }
    return () => {
      active = false
      window.removeEventListener('talkready:unauthorized', handleUnauthorized)
    }
  }, [clearAuth, loadProfile, showToast])

  const value = useMemo(() => ({
    user,
    token,
    role: user?.role || null,
    loading,
    login,
    register,
    logout,
    refresh,
  }), [user, token, loading, login, register, logout, refresh])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
