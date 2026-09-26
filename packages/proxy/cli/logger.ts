import { pino, type DestinationStream } from "pino"

import type { ProxyLogLevel } from "../config"
import { redactForLog, redactText, type CredentialValues } from "../redaction"

/**
 * The proxy's structured log: one JSON line per record at `level`, on stdout
 * unless a destination is given. Every record and the root's bindings pass
 * `redactForLog`, and every finished line loses its URL credentials and every
 * credential value the proxy has read, so the message and the error pino
 * copies into it are covered as well. pino gives a child's bindings only that
 * line pass, not `redactForLog`, so a child binds ids and never a credential.
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
  return pino(
    {
      level,
      formatters: { bindings: redactRecord, log: redactRecord },
      // An error logged as `err` is already serialized by `redactForLog`.
      serializers: { err: (error: unknown) => error },
      hooks: { streamWrite: (line) => credentials.scrub(redactText(line)) },
    },
    destination
  )
}
