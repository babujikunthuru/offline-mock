export default function AudioVisualizer() {
  return (
    <div aria-label="Audio visualizer" className="flex h-12 items-center justify-center gap-1">
      {[16, 28, 20, 36, 24, 32, 18].map((height, index) => (
        <span
          aria-hidden="true"
          className="w-1 rounded-full bg-primary-500"
          key={index}
          style={{ height }}
        />
      ))}
    </div>
  )
}
