import { useCallback, useMemo, useState } from 'react'
import { ToastContext } from '../../context/ToastContext.js'

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback((message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((current) => [...current, { id, message, type }])
    window.setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-atomic="false" aria-live="polite" className="fixed right-4 top-4 z-50 grid gap-2">
        {toasts.map((toast) => (
          <div
            className={`flex min-w-64 items-center justify-between gap-4 rounded-lg border bg-white px-4 py-3 text-sm shadow-card ${
              toast.type === 'error'
                ? 'border-danger-200 text-danger-700'
                : toast.type === 'success'
                  ? 'border-success-200 text-success-700'
                  : 'border-slate-200 text-slate-700'
            }`}
            key={toast.id}
            role="status"
          >
            <span>{toast.message}</span>
            <button
              aria-label="Dismiss notification"
              className="focus-ring rounded px-1 text-lg leading-none text-slate-500 hover:text-slate-900"
              onClick={() => dismiss(toast.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
