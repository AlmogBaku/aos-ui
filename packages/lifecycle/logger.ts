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
