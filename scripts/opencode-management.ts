import { createServer } from "node:http"
import { z } from "zod"
import { updateManagedAgentVisibility } from "../.opencode/lib/agent-visibility"
import {
  hasManagedAgentMetadata,
  isCatalogAgent,
  isManagedAgentId,
} from "../lib/runtime-adapters/opencode/agent-catalog"

const visibilitySchema = z.enum(["visible", "hidden"])
const requestSchema = z.strictObject({
  visibility: visibilitySchema,
  expectedVisibility: visibilitySchema,
})
const providerAgentSchema = z.object({
  name: z.string(),
  mode: z.enum(["primary", "all", "subagent"]),
  native: z.boolean().nullish(),
  hidden: z.boolean().nullish(),
  options: z.record(z.string(), z.unknown()),
})
export type ManagementProvider = {
  agents(): Promise<z.infer<typeof providerAgentSchema>[]>
  isActive(): Promise<boolean>
  reload(): Promise<void>
}
const MAX_BODY_BYTES = 512

export function createManagementProvider(
  baseUrl: string,
  directory: string
): ManagementProvider {
  async function request(path: string, method = "GET") {
    const url = new URL(path, baseUrl)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error("Provider request failed")
    return response.json() as Promise<unknown>
  }
  return {
    agents: async () =>
      z.array(providerAgentSchema).parse(await request("/agent")),
    async isActive() {
      const [statuses, questions, permissions] = await Promise.all([
        request("/session/status"),
        request("/question"),
        request("/permission"),
      ])
      const parsed = z
        .record(
          z.string(),
          z.object({ type: z.enum(["idle", "busy", "retry"]) })
        )
        .parse(statuses)
      return (
        Object.values(parsed).some((status) => status.type !== "idle") ||
        z.array(z.unknown()).parse(questions).length > 0 ||
        z.array(z.unknown()).parse(permissions).length > 0
      )
    },
    async reload() {
      if ((await request("/instance/dispose", "POST")) !== true)
        throw new Error("Provider reload failed")
    },
  }
}

export function createManagementHandler({
  worktree,
  origins,
  provider,
}: {
  worktree: string
  origins: readonly string[]
  provider: ManagementProvider
}) {
  let inFlight = false
  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get("origin")
    const allowed = origin !== null && origins.includes(origin)
    const headers = new Headers({ "cache-control": "no-store", vary: "Origin" })
    if (allowed) headers.set("access-control-allow-origin", origin)
    const error = (
      status: number,
      code: string,
      message: string,
      retryable = false
    ) => Response.json({ code, message, retryable }, { status, headers })
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({ status: "ok" }, { headers })
    if (!allowed)
      return error(403, "origin-rejected", "Management origin is not allowed.")
    const match = /^\/agents\/([a-z][a-z0-9-]*)\/visibility$/.exec(url.pathname)
    if (!match || url.search || !isManagedAgentId(match[1]))
      return error(404, "not-found", "Management operation is unavailable.")
    if (request.method === "OPTIONS") {
      if (
        request.headers.get("access-control-request-method") !== "PATCH" ||
        (request.headers.get("access-control-request-headers") ?? "")
          .split(",")
          .some((header) => header.trim().toLowerCase() !== "content-type")
      )
        return error(
          403,
          "preflight-rejected",
          "Management preflight is not allowed."
        )
      headers.set("access-control-allow-methods", "PATCH")
      headers.set("access-control-allow-headers", "content-type")
      return new Response(null, { status: 204, headers })
    }
    if (request.method !== "PATCH")
      return error(405, "method-rejected", "Only PATCH is supported.")
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      return error(415, "content-type-rejected", "Use application/json.")
    let body: z.infer<typeof requestSchema>
    try {
      const reader = request.body?.getReader()
      if (!reader)
        return error(400, "invalid-body", "Invalid visibility request.")
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BODY_BYTES) {
            await reader.cancel()
            return error(
              413,
              "body-too-large",
              "Visibility request is too large."
            )
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8"))
      )
    } catch {
      return error(400, "invalid-body", "Invalid visibility request.")
    }
    if (inFlight)
      return error(
        409,
        "update-in-progress",
        "Another visibility update is in progress. Try again.",
        true
      )
    inFlight = true
    try {
      const agentId = match[1]
      const agent = (await provider.agents()).find(
        (candidate) => candidate.name === agentId
      )
      if (
        !agent ||
        !isCatalogAgent(agent) ||
        !hasManagedAgentMetadata(agent.options)
      )
        return error(403, "read-only", "This Agent is managed by its provider.")
      if (
        (agent.hidden === true ? "hidden" : "visible") !==
        body.expectedVisibility
      )
        return error(
          409,
          "stale-visibility",
          "Agent visibility changed. Refresh and try again.",
          true
        )
      if (await provider.isActive())
        return error(
          409,
          "provider-active",
          "Wait for active Sessions to finish before changing Agent visibility.",
          true
        )
      try {
        await updateManagedAgentVisibility(worktree, agentId, body.visibility)
      } catch {
        return error(
          409,
          "unsafe-definition",
          "The managed Agent definition is unavailable, unsafe, or changed. Refresh and try again.",
          true
        )
      }
      // Always reload even when the file already matches: an earlier request may
      // have persisted but deferred its reload because a Session became active.
      if (await provider.isActive())
        return error(
          409,
          "pending-reload",
          "Visibility was saved. Wait for active Sessions to finish, then try again to apply it.",
          true
        )
      await provider.reload()
      const confirmed = (await provider.agents()).find(
        (candidate) => candidate.name === agentId
      )
      if (
        !confirmed ||
        !isCatalogAgent(confirmed) ||
        (confirmed.hidden === true ? "hidden" : "visible") !== body.visibility
      )
        return error(
          502,
          "readback-failed",
          "OpenCode did not confirm the saved Agent visibility. Refresh and try again.",
          true
        )
      return Response.json(
        { agentId, visibility: body.visibility },
        { headers }
      )
    } catch {
      return error(
        502,
        "provider-unavailable",
        "OpenCode could not confirm this visibility change. Refresh and try again.",
        true
      )
    } finally {
      inFlight = false
    }
  }
}

export async function startManagementServer(options: {
  host: string
  port: number
  worktree: string
  origins: readonly string[]
  provider: ManagementProvider
}) {
  const handle = createManagementHandler(options)
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of incoming) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          outgoing.writeHead(413).end()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value)
      const response = await handle(
        new Request(`http://management.local${incoming.url}`, {
          method: incoming.method,
          headers,
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? {}
            : { body: Buffer.concat(chunks).toString("utf8") }),
        })
      )
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(await response.text())
    } catch {
      outgoing.writeHead(400).end()
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Management listener did not bind a TCP address")
  return {
    address,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  }
}
