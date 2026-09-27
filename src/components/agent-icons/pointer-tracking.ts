// Shifts every mounted pair sensor slightly toward the pointer. One shared
// passive `pointermove` listener feeds at most one animation frame at a time,
// and only on fine pointers without a reduced-motion preference.

const sensors = new Set<SVGGElement>()
let pointerX = 0
let pointerY = 0
let queued = false

function canTrack() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

function update() {
  queued = false
  for (const sensor of sensors) {
    const box = (sensor.ownerSVGElement ?? sensor).getBoundingClientRect()
    const dx = pointerX - (box.left + box.width / 2)
    const dy = pointerY - (box.top + box.height / 2)
    const distance = Math.hypot(dx, dy) || 1
    const pull = Math.min(1, distance / 240)
    sensor.style.transform = `translate(${(dx / distance) * pull * 1.4}px, ${(dy / distance) * pull}px)`
  }
}

function onPointerMove(event: PointerEvent) {
  pointerX = event.clientX
  pointerY = event.clientY
  if (queued) return
  queued = true
  requestAnimationFrame(update)
}

/**
 * A React 19 callback ref for a tile's pair sensor: subscribes the element and
 * returns its cleanup. The listener goes away with the last sensor.
 */
export function trackPairSensor(
  sensor: SVGGElement | null
): (() => void) | undefined {
  if (!sensor || !canTrack()) return undefined
  if (sensors.size === 0) {
    window.addEventListener("pointermove", onPointerMove, { passive: true })
  }
  sensors.add(sensor)
  return () => {
    sensors.delete(sensor)
    if (sensors.size === 0) {
      window.removeEventListener("pointermove", onPointerMove)
    }
  }
}
