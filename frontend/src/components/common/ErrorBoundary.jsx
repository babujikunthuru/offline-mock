import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error('The application encountered an unexpected error.', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
          <section aria-labelledby="error-title" className="max-w-md rounded-card bg-white p-8 shadow-card">
            <h1 className="text-xl font-semibold text-slate-900" id="error-title">
              Something went wrong
            </h1>
            <p className="mt-2 text-slate-600">
              The page could not be displayed. Refresh the page to try again.
            </p>
            <button
              className="focus-ring mt-6 rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white hover:bg-primary-700"
              onClick={() => window.location.reload()}
              type="button"
            >
              Refresh page
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
