import {
  CallToolResultSchema,
  McpAppViewSchema,
  ReadResourceResultSchema,
} from "../../../protocol/mcp-apps"
import type { ServerMcpApps, SessionScope } from "../../core/runtime"
import {
  OpenClawClientRequestError,
  type OpenClawGatewayClient,
} from "./client"
import { OpenClawNativePayloadError } from "./native-schemas"
import { OpenClawWorkspaceOwnershipError } from "./workspace"

/** OpenClaw's own cap on one MCP App's HTML resource. */
export const OPENCLAW_MCP_APP_MAX_BYTES = 2 * 1024 * 1024

/** OpenClaw mints `mcp-app-<uuid>` view ids of at most 128 characters. */
const VIEW_ID = /^mcp-app-[A-Za-z0-9-]{1,120}$/u

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The view a tool result opened: OpenClaw attaches
 * `details.mcpAppPreview.mcpApp` to an MCP tool result whose tool declares a
 * UI resource, while `mcp.apps.enabled` is on.
 */
export function mcpAppViewId(result: unknown) {
  const descriptor = record(
    record(record(record(result)?.details)?.mcpAppPreview)?.mcpApp
  )
  const viewId = descriptor?.viewId
  return typeof viewId === "string" && VIEW_ID.test(viewId) ? viewId : undefined
}

export type OpenClawMcpAppAuthority = Readonly<{
  getSession(agentId: string, sessionKey: string): Promise<unknown>
  /** The view this Session's own stored `toolCallId` result opened. */
  mcpAppViewId(
    agentId: string,
    sessionKey: string,
    toolCallId: string
  ): Promise<string | undefined>
}>

/**
 * MCP Apps over OpenClaw's native `mcp.app.*` RPCs. The view id always comes
 * from this Session's own history, never from the browser; a view the gateway
 * no longer holds (expired, or `mcp.apps` turned off) reads as not found.
 */
export function createOpenClawMcpApps(input: {
  client: Pick<OpenClawGatewayClient, "request">
  authority: OpenClawMcpAppAuthority
  start(): Promise<void>
}): ServerMcpApps {
  const viewParams = async (scope: SessionScope, toolCallId: string) => {
    await input.start()
    await input.authority.getSession(scope.agentId, scope.sessionId)
    const viewId = await input.authority.mcpAppViewId(
      scope.agentId,
      scope.sessionId,
      toolCallId
    )
    if (!viewId) throw new OpenClawWorkspaceOwnershipError()
    return { sessionKey: scope.sessionId, agentId: scope.agentId, viewId }
  }
  const request = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => {
    try {
      return await input.client.request<unknown>(
        method,
        params,
        signal ? { signal } : undefined
      )
    } catch (error) {
      if (
        error instanceof OpenClawClientRequestError &&
        error.kind === "rejected"
      )
        throw new OpenClawWorkspaceOwnershipError()
      throw error
    }
  }
  const parsed = <T>(
    schema: {
      safeParse(value: unknown): { success: true; data: T } | { success: false }
    },
    value: unknown
  ) => {
    const result = schema.safeParse(value)
    if (!result.success) throw new OpenClawNativePayloadError()
    return result.data
  }
  return {
    async describe(scope, call) {
      if (call.result !== undefined)
        return mcpAppViewId(call.result) !== undefined
      try {
        await viewParams(scope, call.toolCallId)
        return true
      } catch (error) {
        if (error instanceof OpenClawWorkspaceOwnershipError) return false
        throw error
      }
    },
    async open(scope, toolCallId, signal) {
      const view = record(
        await request(
          "mcp.app.view",
          await viewParams(scope, toolCallId),
          signal
        )
      )
      // `permissions` and `prefersBorder` are not part of the native view.
      return parsed(McpAppViewSchema, {
        html: view?.html,
        ...(view?.csp === undefined ? {} : { csp: view.csp }),
        ...(record(view?.toolInput) ? { toolInput: view?.toolInput } : {}),
        ...(view?.toolResult === undefined
          ? {}
          : { toolResult: view.toolResult }),
      })
    },
    async callTool(scope, toolCallId, name, args) {
      return parsed(
        CallToolResultSchema,
        await request("mcp.app.callTool", {
          ...(await viewParams(scope, toolCallId)),
          toolName: name,
          arguments: args,
        })
      )
    },
    async readResource(scope, toolCallId, uri) {
      return parsed(
        ReadResourceResultSchema,
        await request("mcp.app.readResource", {
          ...(await viewParams(scope, toolCallId)),
          uri,
        })
      )
    },
  }
}
