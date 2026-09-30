import type { ServerFileReader } from "../../core/runtime"
import {
  OpenClawArtifactUnavailableError,
  OpenClawArtifactUnreadableError,
} from "./artifacts"
import type { OpenClawGatewayClient } from "./client"
import { OpenClawNativePayloadError } from "./native-schemas"

/**
 * The files an MCP App's call names, read through the gateway's assistant
 * media route (`src/gateway/control-ui.ts:524`) under the Control UI's base
 * path. The gateway holds the Session's roots and sandbox and answers 404 for
 * any file it will not serve (`:708`), so the reader resolves no real path.
 */

/** The route under the base path (`src/gateway/control-ui-resource-routes.ts:7`). */
const MEDIA_ROUTE = "/__openclaw__/assistant-media"

/** Segments of unreserved characters, none of them dots alone. */
const BASE_PATH = /^(?:\/(?!\.+(?:\/|$))[A-Za-z0-9._~-]+)*$/u

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The Control UI base path in a `config.get` answer, normalized as OpenClaw
 * does (`src/gateway/control-ui-shared.ts:6`). Nothing else in the answer is
 * read: the rest may hold secrets.
 */
function basePath(answer: unknown) {
  const value =
    record(record(record(record(answer)?.config)?.gateway)?.controlUi)
      ?.basePath ?? ""
  if (typeof value !== "string") throw new OpenClawNativePayloadError()
  const trimmed = value.trim()
  const rooted = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const path = rooted.endsWith("/") ? rooted.slice(0, -1) : rooted
  if (!BASE_PATH.test(path)) throw new OpenClawNativePayloadError()
  return path
}

export function createOpenClawFileReader(input: {
  client: Pick<OpenClawGatewayClient, "request">
  start(): Promise<void>
  /** The gateway's HTTP origin. */
  origin: string
  /** Read afresh for each file. */
  deviceToken(): Promise<string>
  fetch: typeof fetch
}): ServerFileReader {
  return {
    async read(scope, path, { range, signal }) {
      // The gateway trims a source (`src/gateway/control-ui.ts:246`), so it
      // would read a path other than the one core judged.
      if (path !== path.trim()) throw new OpenClawArtifactUnreadableError()
      await input.start()
      const base = basePath(
        await input.client.request("config.get", {}, { signal })
      )
      const query = new URLSearchParams({
        source: path,
        sessionKey: scope.providerSessionId,
        agentId: scope.agentId,
      })
      const url = new URL(`${base}${MEDIA_ROUTE}?${query}`, input.origin)
      // `BASE_PATH` already keeps both; this holds if it ever loosens.
      if (
        url.origin !== input.origin ||
        url.pathname !== `${base}${MEDIA_ROUTE}`
      )
        throw new OpenClawNativePayloadError()
      try {
        return await input.fetch(url, {
          headers: {
            authorization: `Bearer ${await input.deviceToken()}`,
            "accept-encoding": "identity",
            // An Accept that takes HTML gets the Control UI page for a path
            // the gateway does not route (`src/gateway/control-ui-http-utils.ts:14`).
            accept: "application/octet-stream",
            ...(range ? { range } : {}),
          },
          // A redirect would carry the token onward.
          redirect: "error",
          signal,
        })
      } catch {
        // Never the cause: fetch's error for a bad header quotes the token.
        throw new OpenClawArtifactUnavailableError()
      }
    },
  }
}
