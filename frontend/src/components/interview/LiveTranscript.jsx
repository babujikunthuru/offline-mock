export default function LiveTranscript({ text = '' }) {
  return <p aria-live="polite" className="text-slate-700">{text || 'Your live transcript will appear here.'}</p>
}
