import styles from "./status-dots.module.css"

/** Every Agent or Session status a navigation row can indicate. */
export type RowStatus =
  | "idle"
  | "active"
  | "running"
  | "attention"
  | "unknown"
  | "waiting-for-input"
  | "failed"

/**
 * Row dots are decorative: the hover title repeats what the row's accessible
 * name already states, so assistive technology never reads them twice.
 */
export function StatusDot({
  status,
  label,
}: {
  status: RowStatus | undefined
  label: string
}) {
  if (!status || status === "idle") return null

  return (
    <span
      className={styles.statusDot}
      data-status={status}
      title={label}
      aria-hidden="true"
    />
  )
}

export function UnreadDot({ label }: { label: string }) {
  return <span className={styles.unreadDot} title={label} aria-hidden="true" />
}

function needsOperator(status: RowStatus | undefined) {
  return (
    status === "waiting-for-input" ||
    status === "attention" ||
    status === "failed"
  )
}

/**
 * A row shows one dot. A state that needs the operator (waiting for input,
 * attention, failed) outranks unread; unread outranks a run that is merely in
 * progress. The row's accessible name still states every state in full.
 */
export function RowIndicators({
  status,
  statusLabel,
  unread,
  unreadLabel,
}: {
  status: RowStatus | undefined
  statusLabel: string
  unread: boolean | undefined
  unreadLabel: string
}) {
  const showStatus = Boolean(status && status !== "idle")
  if (!showStatus && !unread) return null

  return (
    <span className={styles.indicators}>
      {unread && !needsOperator(status) ? (
        <UnreadDot label={unreadLabel} />
      ) : (
        <StatusDot status={status} label={statusLabel} />
      )}
    </span>
  )
}
