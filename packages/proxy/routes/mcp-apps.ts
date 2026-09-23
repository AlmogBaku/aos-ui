import {
  CallToolResultSchema,
  McpAppResourceReadRequestSchema,
  McpAppToolCallRequestSchema,
  McpAppViewSchema,
  ReadResourceResultSchema,
} from "../../protocol/mcp-apps"
import type { ProxyAppOptions } from "../app"
import type { ServerRuntime, SessionScope } from "../core/runtime"
import { McpAppResourceError } from "../mcp-apps/client"
import { McpAppNotFoundError, McpAppRefusedError } from "../mcp-apps/fallback"
import { redactForLog } from "../redaction"
import { boundedJson, errorResponse } from "./http"
import type { ProxyRouteApp } from "./types"

/**
 * MCP App views, keyed by the tool call that opened them. The browser names no
 * server, tool, or resource URI to open a view; a view's own requests reach
 * only the server its tool call came from.
 */

export const MCP_APP_PATH = "/tool-calls/:toolCallId/app"
const MAX_REQUEST_BYTES = 256 * 1024
const RATE_WINDOW_MS = 1_000
const RATE_MAX_PER_WINDOW = 10
const RATE_MAX_TRACKED = 4_096

export type McpAppOperation = "open" | "tools/call" | "resources/read"

export type McpAppOutcome =
  | { ok: true; body: unknown }
  | {
      ok: false
      reason:
        | "not_found"
        | "forbidden"
        | "invalid_request"
        | "rate_limited"
        | "temporarily_unavailable"
      status: 400 | 403 | 404 | 429 | 503
    }

const failure = {
  not_found: { ok: false, reason: "not_found", status: 404 },
  forbidden: { ok: false, reason: "forbidden", status: 403 },
  invalid_request: { ok: false, reason: "invalid_request", status: 400 },
  rate_limited: { ok: false, reason: "rate_limited", status: 429 },
  unavailable: { ok: false, reason: "temporarily_unavailable", status: 503 },
} as const satisfies Record<string, McpAppOutcome>

/** A fixed window per view, so one chatty view cannot flood its server. */
export function createMcpAppRateLimit(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return (key: string) => {
    const at = now()
    const current = windows.get(key)
    if (!current || at - current.start >= RATE_WINDOW_MS) {
      if (windows.size >= RATE_MAX_TRACKED) windows.clear()
      windows.set(key, { start: at, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= RATE_MAX_PER_WINDOW
  }
}

/**
 * One MCP App request, lane-neutral. The caller has already authorized the
 * Session and resolved `scope`; this reads the body, applies the view's rate
 * limit, and maps every failure to an answer that never names a native detail.
 */
export async function handleMcpAppRequest(input: {
  runtime: ServerRuntime
  scope: SessionScope
  toolCallId: string
  operation: McpAppOperation
  request: Request
  allow: (key: string) => boolean
}): Promise<McpAppOutcome> {
  const { runtime, scope, toolCallId, operation, request } = input
  const apps = runtime.mcpApps
  if (!apps) return failure.not_found
  if (
    !input.allow(`${scope.agentId}\u0000${scope.threadId}\u0000${toolCallId}`)
  )
    return failure.rate_limited
  try {
    if (operation === "open")
      return {
        ok: true,
        body: McpAppViewSchema.parse(
          await apps.open(scope, toolCallId, request.signal)
        ),
      }
    const json = await boundedJson(request, MAX_REQUEST_BYTES)
    if (operation === "tools/call") {
      const body = McpAppToolCallRequestSchema.safeParse(json)
      if (!body.success) return failure.invalid_request
      return {
        ok: true,
        body: CallToolResultSchema.parse(
          await apps.callTool(
            scope,
            toolCallId,
            body.data.name,
            body.data.arguments
          )
        ),
      }
    }
    const body = McpAppResourceReadRequestSchema.safeParse(json)
    if (!body.success) return failure.invalid_request
    return {
      ok: true,
      body: ReadResourceResultSchema.parse(
        await apps.readResource(scope, toolCallId, body.data.uri)
      ),
    }
  } catch (error) {
    if (
      error instanceof McpAppNotFoundError ||
      error instanceof McpAppResourceError ||
      runtime.publicError(error)?.code === "not_found"
    )
      return failure.not_found
    if (error instanceof McpAppRefusedError) return failure.forbidden
    return failure.unavailable
  }
}

/** The three identifiers every MCP App route carries in its path. */
export function mcpAppParams(params: Record<string, string | undefined>) {
  const { agentId, sessionId, toolCallId } = params
  return agentId && sessionId && toolCallId
    ? { agentId, sessionId, toolCallId }
    : undefined
}

export function registerMcpAppRoutes(
  app: ProxyRouteApp,
  options: ProxyAppOptions,
  requireRuntime: (request: Request) => Promise<ServerRuntime>,
  requireScopedSession: (
    runtime: ServerRuntime,
    agentId: string,
    sessionId: string
  ) => Promise<string>
) {
  const base = `/api/aos/v1/agents/:agentId/sessions/:sessionId${MCP_APP_PATH}`
  const allow = createMcpAppRateLimit(options.clock)
  const routes: Array<[method: "get" | "post", path: string, McpAppOperation]> =
    [
      ["get", base, "open"],
      ["post", `${base}/tools/call`, "tools/call"],
      ["post", `${base}/resources/read`, "resources/read"],
    ]
  for (const [method, path, operation] of routes)
    app[method](path, async (context) => {
      const runtime = await requireRuntime(context.req.raw)
      if (
        method === "post" &&
        context.req.header("origin") !== options.publicOrigin
      )
        return errorResponse("forbidden", 403)
      const params = mcpAppParams(context.req.param())
      if (!params) return errorResponse("not_found", 404)
      const { agentId, sessionId: threadId, toolCallId } = params
      const sessionId = await requireScopedSession(runtime, agentId, threadId)
      options.logger.info(
        redactForLog({
          event: "mcp_app.request",
          requestId: context.get("requestId"),
          operation,
          agentId,
          sessionId: threadId,
          toolCallId,
        })
      )
      const outcome = await handleMcpAppRequest({
        runtime,
        scope: { agentId, sessionId, threadId },
        toolCallId,
        operation,
        request: context.req.raw,
        allow,
      })
      if (outcome.ok) return context.json(outcome.body)
      return errorResponse(
        outcome.reason === "rate_limited"
          ? "temporarily_unavailable"
          : outcome.reason,
        outcome.status
      )
    })
}
