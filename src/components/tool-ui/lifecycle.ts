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
    (part.status.type === "incomplete" && part.status.reason === "error")
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

function createState(phase: RichToolPhase): RichToolState {
  return {
    phase,
    label: phaseLabels[phase],
    canRespond: phase === "pending",
  }
}
