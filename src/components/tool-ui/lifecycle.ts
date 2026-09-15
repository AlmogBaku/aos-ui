import type { RichToolPart, RichToolPhase, RichToolState } from "./types"

const phaseLabels: Record<RichToolPhase, string> = {
  pending: "Needs response",
  submitting: "Submitting",
  answered: "Answered",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  unavailable: "Unavailable",
  expired: "Expired",
  cancelled: "Cancelled",
}

type NormalizeRichToolStateOptions = {
  interactive?: boolean
  overridePhase?: RichToolPhase
}

export function normalizeRichToolState(
  part: RichToolPart,
  { interactive = false, overridePhase }: NormalizeRichToolStateOptions = {}
): RichToolState {
  const providerResolution = part.approval?.resolution

  if (providerResolution === "expired") return createState("expired")
  if (providerResolution === "cancelled") return createState("cancelled")

  if (
    part.isError ||
    (part.status.type === "incomplete" && part.status.reason === "error") ||
    toolResultSignalsFailure(part.result)
  ) {
    return createState("failed")
  }

  if (interactive) {
    const hasProviderAnswer =
      part.result !== undefined ||
      part.approval?.approved !== undefined ||
      part.approval?.optionId !== undefined ||
      part.approval?.text !== undefined

    if (hasProviderAnswer) return createState("answered")
    if (overridePhase) return createState(overridePhase)
    if (
      part.status.type === "requires-action" ||
      part.status.type === "complete"
    ) {
      return createState("pending")
    }
  }

  if (overridePhase) return createState(overridePhase)
  if (part.status.type === "running") return createState("running")
  if (part.status.type === "requires-action") return createState("pending")
  if (part.status.type === "complete") return createState("complete")
  if (part.status.reason === "cancelled") return createState("cancelled")

  return createState("failed")
}

export function toolResultSignalsFailure(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      return toolResultSignalsFailure(JSON.parse(value) as unknown)
    } catch {
      return /^\s*(?:error|failed|failure)\b/iu.test(value)
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (
    result.isError === true ||
    result.success === false ||
    result.ok === false
  )
    return true
  const exitCode = result.exit_code ?? result.exitCode
  if (typeof exitCode === "number" && exitCode !== 0) return true
  if (
    typeof result.status === "string" &&
    /^(?:error|failed|failure)$/iu.test(result.status)
  )
    return true
  if (typeof result.error === "string" && result.error.trim()) return true
  if (result.error && typeof result.error === "object") return true
  return false
}

function createState(phase: RichToolPhase): RichToolState {
  return {
    phase,
    label: phaseLabels[phase],
    canRespond: phase === "pending",
  }
}
