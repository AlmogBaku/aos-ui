import { useId, type CSSProperties } from "react"

import { parseAvatar } from "@/components/agent-icons/allocation"
import { trackPairSensor } from "@/components/agent-icons/pointer-tracking"
import {
  silhouettes,
  tones,
  type SilhouetteShape,
} from "@/components/agent-icons/pool"
import { cn } from "@/lib/utils"

import styles from "./agent-tile.module.css"

export type AgentTileState = "running" | "attention"

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
  /**
   * Animates the tile: the pair blinks while the Agent runs, and the tile
   * looks around and hops while the Agent waits on the person.
   */
  state?: AgentTileState
  /** The side a waiting pair looks toward: where the conversation is. */
  lookToward?: "inline-start" | "inline-end"
  className?: string
}

/** A decorative generated Agent icon; the caller supplies the accessible name. */
export function AgentTile(props: AgentTileProps) {
  const { size = 40, state, lookToward = "inline-end", className } = props
  const side = lookToward === "inline-end" ? 1 : -1
  const hop = state === "attention" ? styles.hop : undefined
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
      <svg {...frame} className={cn(styles.tile, styles.draft, hop, className)}>
        <Outline radius={radius} dashed />
        {/* The empty outline leaves room for the pool's widest look. */}
        <Pair
          x={24}
          y={24}
          glance={2.5 * side}
          fill="currentColor"
          state={state}
        />
      </svg>
    )
  }

  const [s, t] = parseAvatar(props.avatar).pair
  const silhouette = silhouettes[s]
  const { l, c, h } = tones[t]
  const background = `oklch(${l} ${c} ${h})`
  const shapeFill = `oklch(0.93 0.012 ${h})`

  return (
    <svg {...frame} className={cn(styles.tile, hop, className)}>
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
          {...silhouette.sensor}
          glance={silhouette.sensor.glance * side}
          fill={silhouette.hollow ? shapeFill : background}
          state={state}
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

const barMotion: Record<AgentTileState, string | undefined> = {
  running: styles.blink,
  attention: styles.attentionBlink,
}

/**
 * The two-bar sensor, centred on (x, y); it tracks the pointer, except while
 * the Agent waits on the person and the pair looks `glance` toward the inline
 * end, or the inline start when negative.
 */
function Pair({
  x,
  y,
  glance,
  fill,
  state,
}: {
  x: number
  y: number
  glance: number
  fill: string
  state?: AgentTileState
}) {
  const bar = state && barMotion[state]
  return (
    <g
      transform={`translate(${x} ${y})`}
      style={{ "--glance": glance } as CSSProperties}
    >
      <g
        ref={trackPairSensor}
        className={cn(styles.sensor, state === "attention" && styles.look)}
        fill={fill}
      >
        <rect x={-6} y={-3} width={3} height={6} rx={0.5} className={bar} />
        <rect x={3} y={-3} width={3} height={6} rx={0.5} className={bar} />
      </g>
    </g>
  )
}
