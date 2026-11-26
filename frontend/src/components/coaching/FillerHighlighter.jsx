export default function FillerHighlighter({ text = '' }) {
  return <p className="whitespace-pre-wrap text-slate-700">{text || 'No transcript to review yet.'}</p>
}
