import { pino, type DestinationStream } from "pino"

import type { ProxyLogLevel } from "../config"
import { redactForLog, redactText, type CredentialValues } from "../redaction"

/**
 * The proxy's structured log: one JSON line per record at `level`, on stdout
 * unless a destination is given. Every record and every logger's bindings, a
 * child's included, pass `redactForLog`, and every finished line loses its URL
 * credentials and every credential value the proxy has read, so the message
 * and the error pino copies into it are covered as well.
 */
export function createProxyLogger({
  level,
  credentials,
  destination,
}: {
  level: ProxyLogLevel
  credentials: CredentialValues
  destination?: DestinationStream
}) {
  const redactRecord = (record: object) =>
    redactForLog(record) as Record<string, unknown>
  const logger = pino(
    {
      level,
      formatters: { bindings: redactRecord, log: redactRecord },
      // An error logged as `err` is already serialized by `redactForLog`.
      serializers: { err: (error: unknown) => error },
      hooks: { streamWrite: (line) => credentials.scrub(redactText(line)) },
    },
    destination
  )
  // pino runs `formatters.bindings` on the root's bindings alone, so a child's
  // pass here; every descendant inherits this `child` from the root.
  const child = logger.child
  logger.child = function (this: typeof logger, bindings, options) {
    return child.call(this, redactRecord(bindings), options)
  } as typeof child
  return logger
}
