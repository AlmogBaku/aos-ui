import type { InspectionEvent } from "xstate"

export type LogFields = Record<string, unknown>

type LogFn = (fields: LogFields, message: string) => void

/** The structured logger lifecycle code writes to; a pino logger satisfies it. */
export type Logger = {
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  child(bindings: LogFields): Logger
}

/**
 * An XState `inspect` observer writing one debug line per transition taken:
 * the actor, the event type and the state reached, never context or payloads.
 */
export function inspectToLogger(logger: Logger) {
  return (inspection: InspectionEvent) => {
    if (inspection.type !== "@xstate.microstep") return
    if (inspection._transitions.length === 0) return
    logger.debug(
      {
        actor: inspection.actorRef.sessionId,
        event: inspection.event.type,
        state: (inspection.snapshot as { value?: unknown }).value,
      },
      "xstate.transition"
    )
  }
}
