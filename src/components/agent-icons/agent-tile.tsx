import { useId } from "react"

import { parseAvatar } from "@/components/agent-icons/allocation"
import { trackPairSensor } from "@/components/agent-icons/pointer-tracking"
import {
  silhouettes,
  tones,
  type SilhouetteShape,
} from "@/components/agent-icons/pool"
import { cn } from "@/lib/utils"

import styles from "./agent-tile.module.css"

export type AgentTileProps = (
  | {
      /** A resolved token from `resolveAgentIcons`, for example `ring/blue`. */
      avatar: string
      variant?: never
    }
  | { variant: "draft" | "hidden"; avatar?: never }
) & {
  /** Rendered size in CSS pixels. */
  size?: number
  /** Blinks the pair sensor while the Agent runs. */
  running?: boolean
  className?: string
}

/** A decorative generated Agent icon; the caller supplies the accessible name. */
export function AgentTile(props: AgentTileProps) {
  const { size = 40, running = false, className } = props
  const clipId = useId()
  // Keeps the corner radius visually steady across sizes, in view box units.
  const radius = ((size >= 40 ? 8 : 6) * 48) / size
  const frame = {
    width: size,
    height: size,
    viewBox: "0 0 48 48",
    "aria-hidden": true,
  } as const

  if (props.variant === "hidden") {
    return (
      <svg {...frame} className={cn(styles.tile, styles.hidden, className)}>
        <Outline radius={radius} />
      </svg>
    )
  }

  if (props.variant) {
    return (
      <svg {...frame} className={cn(styles.tile, styles.draft, className)}>
        <Outline radius={radius} dashed />
        <Pair x={24} y={24} fill="currentColor" running={running} />
      </svg>
    )
  }

  const [s, t] = parseAvatar(props.avatar).pair
  const silhouette = silhouettes[s]
  const { l, c, h } = tones[t]
  const background = `oklch(${l} ${c} ${h})`
  const shapeFill = `oklch(0.93 0.012 ${h})`

  return (
    <svg {...frame} className={cn(styles.tile, className)}>
      <defs>
        <clipPath id={clipId}>
          <rect width={48} height={48} rx={radius} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width={48} height={48} fill={background} />
        <g fill={shapeFill}>
          {silhouette.shapes.map((shape, index) => (
            <Shape key={index} shape={shape} />
          ))}
        </g>
        <Pair
          x={silhouette.sensor.x}
          y={silhouette.sensor.y}
          fill={silhouette.hollow ? shapeFill : background}
          running={running}
        />
      </g>
    </svg>
  )
}

function Outline({ radius, dashed }: { radius: number; dashed?: boolean }) {
  return (
    <rect
      x={1}
      y={1}
      width={46}
      height={46}
      rx={radius}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeDasharray={dashed ? "4 3" : undefined}
    />
  )
}

function Shape({ shape }: { shape: SilhouetteShape }) {
  switch (shape.kind) {
    case "rect":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={1.5}
        />
      )
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} />
    case "path":
      return (
        <path d={shape.d} fillRule={shape.evenOdd ? "evenodd" : undefined} />
      )
  }
}

/** The two-bar sensor, centred on (x, y); it tracks the pointer. */
function Pair({
  x,
  y,
  fill,
  running,
}: {
  x: number
  y: number
  fill: string
  running: boolean
}) {
  const bar = running ? styles.blink : undefined
  return (
    <g transform={`translate(${x} ${y})`}>
      <g ref={trackPairSensor} className={styles.sensor} fill={fill}>
        <rect x={-6} y={-3} width={3} height={6} rx={0.5} className={bar} />
        <rect x={3} y={-3} width={3} height={6} rx={0.5} className={bar} />
      </g>
    </g>
  )
}
