/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
        },
        success: {
          50: '#ecfdf5',
          200: '#a7f3d0',
          500: '#10b981',
          700: '#047857',
        },
        warning: {
          50: '#fffbeb',
          200: '#fde68a',
          500: '#f59e0b',
          700: '#b45309',
        },
        danger: {
          50: '#fef2f2',
          200: '#fecaca',
          500: '#ef4444',
          700: '#b91c1c',
        },
      },
      borderRadius: {
        card: '1rem',
      },
      boxShadow: {
        card: '0 12px 32px -16px rgb(15 23 42 / 0.18)',
        focus: '0 0 0 3px rgb(59 130 246 / 0.35)',
      },
    },
  },
  plugins: [],
}
