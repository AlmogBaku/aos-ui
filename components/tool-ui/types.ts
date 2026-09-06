import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react"

/**
 * The exact shape exposed for a tool-call branch by
 * `MessagePrimitive.Parts`. Keeping this alias public lets a message renderer
 * pass its enriched part straight to `RichToolRenderer`.
 */
export type RichToolPart = ToolCallMessagePartProps

/** Drop-in component type for `MessagePrimitive.Parts` tool overrides. */
export type RichToolRendererComponent = ToolCallMessagePartComponent

export type RichToolPhase =
  | "pending"
  | "submitting"
  | "answered"
  | "running"
  | "complete"
  | "failed"
  | "unavailable"
  | "expired"
  | "cancelled"

export type RichToolState = {
  phase: RichToolPhase
  label: string
  canRespond: boolean
}
