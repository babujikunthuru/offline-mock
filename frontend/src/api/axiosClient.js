import axios from 'axios'

export const AUTH_TOKEN_KEY = 'token'

const axiosClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
})

axiosClient.interceptors.request.use((config) => {
  const token = typeof window === 'undefined' ? null : window.localStorage.getItem(AUTH_TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

function normalizeError(response, fallbackMessage) {
  const status = response?.status
  const backendError = response?.data?.error
  const error = new Error(
    backendError?.message || response?.statusText || fallbackMessage || 'The request could not be completed.',
  )

  error.code = backendError?.code || (status ? `HTTP_${status}` : 'NETWORK_ERROR')
  error.status = status
  return error
}

axiosClient.interceptors.response.use(
  (response) => {
    const payload = response.data
    if (payload?.success === false) {
      return Promise.reject(normalizeError(response))
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
      return payload.data
    }
    return payload
  },
  (requestError) => {
    const error = normalizeError(requestError.response, requestError.message)
    if (error.status === 401 && typeof window !== 'undefined') {
      window.localStorage.removeItem(AUTH_TOKEN_KEY)
      window.dispatchEvent(new CustomEvent('talkready:unauthorized'))
      if (!['/login', '/register'].includes(window.location.pathname)) {
        window.location.assign('/login')
      }
    }
    return Promise.reject(error)
  },
)

export default axiosClient
