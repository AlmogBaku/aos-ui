import {
  methods,
  type AnyWireMessage,
  type WireStream,
} from "@agentclientprotocol/sdk/experimental/v2"
import pino from "pino/browser.js"

import type { LogFields, Logger } from "@aos/lifecycle"
import { AOS_META_KEY } from "@aos/protocol/acp"

/**
 * The ACP client's logging. A tab logs only warnings and errors until its URL
 * carries `?debug=acp`; from then on, for the rest of the tab, it also logs one
 * debug line per owner transition and one per wire frame. The flag is read at
 * runtime, so it works in a production build too.
 */

const DEBUG_PARAM = "debug"
const DEBUG_VALUE = "acp"
/** sessionStorage key that keeps the flag for the tab once a URL set it. */
const DEBUG_KEY = "aos-debug"

const REDACTED = "[Redacted]"

type FlagStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Whether this tab logs debug lines: `?debug=acp` now or earlier in the tab. */
export function acpDebugEnabled(search: string, storage: FlagStorage) {
  if (new URLSearchParams(search).get(DEBUG_PARAM) === DEBUG_VALUE)
    storage.setItem(DEBUG_KEY, DEBUG_VALUE)
  return storage.getItem(DEBUG_KEY) === DEBUG_VALUE
}

/**
 * A pino browser logger writing one object per line to the console, or to
 * `write` when a test captures them.
 */
export function createAcpLogger({
  debug,
  write,
}: {
  debug: boolean
  write?: (line: LogFields) => void
}): Logger {
  return pino({
    level: debug ? "debug" : "warn",
    browser: {
      asObject: true,
      formatters: { level: (label) => ({ level: label }) },
      ...(write && { write: (line: object) => write(line as LogFields) }),
    },
  })
}

/** This tab's ACP logger. */
export function tabAcpLogger() {
  return createAcpLogger({
    debug: acpDebugEnabled(
      globalThis.location.search,
      globalThis.sessionStorage
    ),
  })
}

type Json = Record<string, unknown>

const recordOf = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined

/** A payload with its `_meta.aos.token` redacted, or itself without one. */
function withoutToken(payload: unknown) {
  const meta = recordOf(recordOf(payload)?._meta)
  const aos = recordOf(meta?.[AOS_META_KEY])
  if (aos?.token === undefined) return payload
  return {
    ...recordOf(payload),
    _meta: { ...meta, [AOS_META_KEY]: { ...aos, token: REDACTED } },
  }
}

/** A JSON-RPC message with its credentials redacted. */
function redacted(message: Json): Json {
  if (message.method === methods.agent.auth.login)
    return { ...message, params: REDACTED }
  // A message carries params (a call) or a result (a reply), never both.
  const key = "params" in message ? "params" : "result"
  const body = withoutToken(message[key])
  return body === message[key] ? message : { ...message, [key]: body }
}

/**
 * One JSON-RPC message as log fields: the ids a proxy log lines up with, and
 * the message itself without its credentials.
 */
export function frameFields(direction: "in" | "out", message: unknown) {
  const frame = recordOf(message) ?? {}
  const sessionId = recordOf(frame.params)?.sessionId
  return {
    direction,
    ...(frame.id !== undefined && { requestId: frame.id }),
    ...(typeof frame.method === "string" && { method: frame.method }),
    ...(typeof sessionId === "string" && { sessionId }),
    frame: redacted(frame),
  }
}

/** `stream` with one `acp.frame` debug line per message, each way. */
export function loggedStream(stream: WireStream, logger: Logger): WireStream {
  const log = (direction: "in" | "out", frame: AnyWireMessage) => {
    for (const message of [frame].flat())
      logger.debug(frameFields(direction, message), "acp.frame")
  }
  const writer = stream.writable.getWriter()
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyWireMessage, AnyWireMessage>({
        transform(frame, controller) {
          log("in", frame)
          controller.enqueue(frame)
        },
      })
    ),
    writable: new WritableStream<AnyWireMessage>({
      write(frame) {
        log("out", frame)
        return writer.write(frame)
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  }
}
