import {
  SessionHistoryResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import {
  CallToolResultSchema,
  type CallToolResult,
} from "../../protocol/mcp-apps"
import { isAosToolName } from "../core/aos-tool-names"
import { TurnEventKind, type TurnEvent } from "../core/events"
import type {
  ServerMcpApps,
  ServerTurnEngine,
  ServerTurnHandle,
  ServerRuntime,
  SessionScope,
} from "../core/runtime"
import { MAX_MCP_APP_HTML_BYTES } from "./client"

/** How long a tool call waits to learn whether it opens a view. */
const DESCRIBE_TIMEOUT_MS = 1_500

/**
 * Only an MCP tool can declare a view: another server's reads
 * `mcp__<server>__<tool>`, an `aos-ui` tool reads under its bare name, and a
 * native tool is neither.
 */
function mayDeclareView(toolName: string) {
  return toolName.startsWith("mcp__") || isAosToolName(toolName)
}

async function describeWithin(
  apps: ServerMcpApps,
  scope: SessionScope,
  call: { toolCallId: string; toolName: string; result?: unknown }
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DESCRIBE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      apps.describe(scope, call).catch(() => false),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A streamed result as the view reads it: the MCP result, or its text. */
function liveResult(content: string): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(parseJson(content))
  return parsed.success
    ? parsed.data
    : { content: [{ type: "text", text: content }] }
}

/**
 * Flags a call the moment it starts, from its tool's name alone, so the
 * browser draws the view while the call runs; a call the start could not
 * flag still counts once its result names a view (native first). A flagged
 * call's name, arguments, and result also reach `observe`, for a host that
 * otherwise opens only calls the runtime has stored.
 */
async function* annotatedEvents(
  events: AsyncIterable<TurnEvent>,
  apps: ServerMcpApps,
  scope: SessionScope
): AsyncIterable<TurnEvent> {
  const names = new Map<string, string>()
  const flagged = new Set<string>()
  const args = new Map<string, string>()
  for await (const event of events) {
    if (event.kind === TurnEventKind.ToolCallStarted) {
      const { toolCallId, name: toolName } = event
      if (toolName === undefined) {
        yield event
        continue
      }
      names.set(toolCallId, toolName)
      const app =
        event.app ||
        (mayDeclareView(toolName) &&
          (await describeWithin(apps, scope, { toolCallId, toolName })))
      if (!app) {
        yield event
        continue
      }
      flagged.add(toolCallId)
      args.set(toolCallId, "")
      apps.observe?.(scope, { toolCallId, toolName })
      yield { ...event, app: true }
      continue
    }
    if (
      event.kind === TurnEventKind.ToolCallInputChunk &&
      args.has(event.toolCallId)
    )
      args.set(event.toolCallId, args.get(event.toolCallId)! + event.delta)
    if (
      event.kind === TurnEventKind.ToolCallInputEnded &&
      args.has(event.toolCallId)
    ) {
      const input = record(parseJson(args.get(event.toolCallId)!))
      args.delete(event.toolCallId)
      apps.observe?.(scope, {
        toolCallId: event.toolCallId,
        toolName: names.get(event.toolCallId)!,
        ...(input ? { input } : {}),
      })
    }
    if (event.kind !== TurnEventKind.ToolCallFinished) {
      yield event
      continue
    }
    const toolName = names.get(event.toolCallId)
    const app =
      event.app ||
      flagged.has(event.toolCallId) ||
      (toolName !== undefined &&
        mayDeclareView(toolName) &&
        (await describeWithin(apps, scope, {
          toolCallId: event.toolCallId,
          toolName,
          result: parseJson(event.output),
        })))
    if (app && toolName !== undefined)
      apps.observe?.(scope, {
        toolCallId: event.toolCallId,
        toolName,
        result: liveResult(event.output),
      })
    yield app ? { ...event, app: true } : event
  }
}

function annotatedHandle(
  handle: ServerTurnHandle,
  apps: ServerMcpApps,
  scope: SessionScope
): ServerTurnHandle {
  const events = annotatedEvents(handle.events, apps, scope)
  return new Proxy(handle, {
    get(target, property) {
      if (property === "events") return events
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function annotatedTurns(
  turns: ServerTurnEngine,
  apps: ServerMcpApps
): ServerTurnEngine {
  return {
    start: async (scope, input, attachments) =>
      annotatedHandle(
        await turns.start(scope, input, attachments),
        apps,
        scope
      ),
    recover: async (scope, request) =>
      annotatedHandle(await turns.recover(scope, request), apps, scope),
    ...(turns.discover
      ? {
          discover: async (scope: SessionScope, turnId: string) => {
            const found = await turns.discover!(scope, turnId)
            return (
              found && {
                ...found,
                handle: annotatedHandle(found.handle, apps, scope),
              }
            )
          },
        }
      : {}),
    // A watch only signals; the turn it reports is read through `discover`.
    ...(turns.watch ? { watch: turns.watch.bind(turns) } : {}),
  }
}

async function annotatedHistory(
  history: SessionHistoryResponse,
  apps: ServerMcpApps,
  scope: SessionScope
): Promise<SessionHistoryResponse> {
  const messages = await Promise.all(
    history.messages.map(async (message) => {
      if (message.role === "activity") return message
      const content = await Promise.all(
        message.content.map(async (part) =>
          part.type === "tool-call" &&
          !part.app &&
          mayDeclareView(part.toolName) &&
          (await describeWithin(apps, scope, part))
            ? { ...part, app: true as const }
            : part
        )
      )
      return { ...message, content }
    })
  )
  return { ...history, messages }
}

/**
 * Adds MCP Apps to one server runtime without touching the adapter: a tool
 * call whose tool declares a view carries the `app` flag from its start, live
 * and in history, and the Session's capabilities advertise the view API. A
 * runtime without `mcpApps` is returned as it is.
 */
export function withMcpApps<Runtime extends ServerRuntime>(
  native: Runtime
): Runtime {
  const apps = native.mcpApps
  if (!apps) return native
  const turns = annotatedTurns(native.turns, apps)

  const overrides: Pick<
    ServerRuntime,
    "turns" | "history" | "workspaceCapabilities"
  > = {
    turns,
    async history(agentId, runtimeSessionId, limit, offset) {
      const history = SessionHistoryResponseSchema.parse(
        await native.history(agentId, runtimeSessionId, limit, offset)
      )
      return annotatedHistory(history, apps, {
        agentId,
        sessionId: runtimeSessionId,
        threadId: history.sessionId,
      })
    },
    async workspaceCapabilities(agentId, publicSessionId) {
      const value = await native.workspaceCapabilities(agentId, publicSessionId)
      const parsed = SessionWorkspaceCapabilitiesResponseSchema.safeParse(value)
      if (!parsed.success) return value
      return {
        ...parsed.data,
        content: {
          ...parsed.data.content,
          mcpApps: {
            status: "available",
            scope: "session",
            maxBytes: MAX_MCP_APP_HTML_BYTES,
          },
        },
      }
    },
  }

  return new Proxy(native, {
    get(target, property) {
      if (Object.hasOwn(overrides, property))
        return overrides[property as keyof typeof overrides]
      // Adapters keep their state in `#private` fields, so a delegated method
      // has to stay bound to the native instance rather than to this Proxy.
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
