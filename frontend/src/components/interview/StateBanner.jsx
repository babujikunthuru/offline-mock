export default function StateBanner({ state = 'Ready' }) {
  return <div className="rounded-lg bg-primary-50 px-4 py-3 text-sm font-medium text-primary-800">{state}</div>
}
