import { io } from 'socket.io-client'

let socket
let currentToken
let status = 'offline'
const statusListeners = new Set()

function setStatus(nextStatus) {
  if (status === nextStatus) return
  status = nextStatus
  statusListeners.forEach((listener) => listener(status))
}

export function getSocketStatus() {
  return status
}

export function subscribeSocketStatus(listener) {
  statusListeners.add(listener)
  listener(status)
  return () => statusListeners.delete(listener)
}

export function connectSocket(token) {
  if (!token) {
    throw new Error('A token is required to connect to the interview socket.')
  }
  if (socket && currentToken !== token) {
    disconnectSocket()
  }

  if (!socket) {
    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
    })
    currentToken = token
    socket.on('connect', () => setStatus('connected'))
    socket.on('disconnect', (reason) => {
      setStatus(reason === 'io client disconnect' || reason === 'io server disconnect' ? 'offline' : 'reconnecting')
    })
    socket.on('connect_error', () => {
      setStatus(socket.active ? 'reconnecting' : 'offline')
    })
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'))
    socket.io.on('reconnect_error', () => setStatus('reconnecting'))
  }

  if (!socket.connected && !socket.active) socket.connect()
  return socket
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket.removeAllListeners()
    socket.io.removeAllListeners()
  }
  socket = undefined
  currentToken = undefined
  setStatus('offline')
}

export { connectSocket as connect, disconnectSocket as disconnect }
