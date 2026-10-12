import { badgeCount, type AttentionLevel } from "@/lib/attention-level"
import { cn } from "@/lib/utils"

import styles from "./attention-badge.module.css"
import { StatusDot } from "./status-dots"

/**
 * The count an Agent tile or the bell carries on its top inline-end corner, in
 * the color of its most urgent state. With nothing counted, a running level
 * shows the breathing running dot instead. Decorative: the control's name
 * states every count in full.
 */
export function AttentionBadge({
  level,
  runningLabel,
  className,
}: {
  level: AttentionLevel | undefined
  runningLabel: string
  className?: string
}) {
  if (level?.count)
    return (
      <span
        className={cn(styles.badge, className)}
        data-top={level.top}
        aria-hidden="true"
      >
        {badgeCount(level.count)}
      </span>
    )
  if (level?.top !== "running") return null
  return (
    <span className={cn(styles.dot, className)}>
      <StatusDot status="running" label={runningLabel} />
    </span>
  )
}
