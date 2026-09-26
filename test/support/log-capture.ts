import type { LogFields, Logger, OwnerKind } from "../../packages/lifecycle"

/** One line a captured logger wrote, its bindings merged into its fields. */
export type LogRecord = {
  level: Exclude<keyof Logger, "child">
  message: string
  fields: LogFields
}

export type LogCapture = ReturnType<typeof captureLogs>

/** A lifecycle Logger that keeps every line it and its children write. */
export function captureLogs() {
  const lines: LogRecord[] = []
  const loggerWith = (bindings: LogFields): Logger => {
    const at =
      (level: LogRecord["level"]) => (fields: LogFields, message: string) => {
        lines.push({ level, message, fields: { ...bindings, ...fields } })
      }
    return {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (more) => loggerWith({ ...bindings, ...more }),
    }
  }
  return {
    logger: loggerWith({}),
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
