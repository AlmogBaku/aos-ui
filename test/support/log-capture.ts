import { pino } from "pino"

import type { LogFields, Logger, OwnerKind } from "../../packages/lifecycle"

/** One line a captured logger wrote, its bindings merged into its fields. */
export type LogRecord = {
  level: Exclude<keyof Logger, "child">
  message: string
  fields: LogFields
}

export type LogCapture = ReturnType<typeof captureLogs>

/** A pino logger at `debug` that keeps every line it and its children write. */
export function captureLogs() {
  const lines: LogRecord[] = []
  const logger: Logger = pino(
    {
      level: "debug",
      base: undefined,
      timestamp: false,
      formatters: { level: (label) => ({ level: label }) },
    },
    {
      write(line: string) {
        const { level, msg, ...fields } = JSON.parse(line) as LogFields & {
          level: LogRecord["level"]
          msg: string
        }
        lines.push({ level, message: msg, fields })
      },
    }
  )
  return {
    logger,
    /** Every line at every level, in the order written. */
    records: (): readonly LogRecord[] => [...lines],
    /** The (from, to) states one kind of owner entered, or one Session's. */
    transitions: ({
      owner,
      sessionId,
    }: {
      owner: OwnerKind
      sessionId?: string
    }) =>
      lines.flatMap(({ message, fields: { from, to, sessionId: session } }) =>
        message.startsWith(`${owner}.`) &&
        typeof from === "string" &&
        typeof to === "string" &&
        (sessionId === undefined || session === sessionId)
          ? [[from, to] as const]
          : []
      ),
  }
}
