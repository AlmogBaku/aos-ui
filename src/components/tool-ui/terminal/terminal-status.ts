import type { ToolTerminalLabels } from "../locale"
import type { AosTerminal } from "../tool-artifact"

/** The terminal's state in words: running, or how it ended. */
export function terminalStatus(
  terminal: AosTerminal,
  labels: ToolTerminalLabels
): string {
  if (terminal.running) return labels.running
  if (terminal.signal) return labels.signal(terminal.signal)
  if (typeof terminal.exitCode === "number")
    return labels.exitCode(terminal.exitCode)
  return labels.finished
}
