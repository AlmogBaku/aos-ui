import type {
  AgentContext,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  SessionContextResponseSchema,
  SessionCreateResponseSchema,
  SessionModelsResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  type TurnSteerRequest,
  type Session,
  type SessionHistoryResponse,
  type SessionModelUpdateRequest,
} from "../../protocol"
import {
  AOS_META_KEY,
  type AosHistoryCursor,
  type AosSessionInfoMeta,
} from "../../protocol/acp"
import type { SessionPatch, SessionScope } from "../core/runtime"
import type { SessionExecutionState } from "../core/session-coordinator"
import type { SessionRow } from "../core/session-rows"
import { createSessionMember } from "./session-member"
import type { AcpConnectionContext, WorkspaceCapabilities } from "./types"
import { invalidRequest, notFound, publicRequestError } from "./validation"

/**
 * The Session half of the ACP agent: the normalized runtime reads and writes
 * the handlers need, the `_meta.aos` projections of a Session row, and the
 * per-connection registry of which Agent owns a Session and which Sessions
 * this connection has attached.
 */

/** A durable Session's `cwd`: AOS Sessions are not workspace-rooted. */
const SESSION_CWD = "/"

/** Mirrors the normalized status overlay: live execution outranks the row. */
export function overlaidStatus(
  state: SessionExecutionState,
  settled: Session["status"]
): Session["status"] {
  return state === "waiting-for-input"
    ? "waiting-for-input"
    : state === "running" || state === "stopping"
      ? "running"
      : state === "uncertain"
        ? "failed"
        : settled
}

export function sessionInfoMeta(
  row: SessionRow,
  status: Session["status"]
): AosSessionInfoMeta {
  return {
    agentId: row.agentId,
    status,
    archived: row.archived,
    ...(row.unread === undefined ? {} : { unread: row.unread }),
    ...(row.pinned === undefined ? {} : { pinned: row.pinned }),
  }
}

export function sessionInfoOf(
  row: SessionRow,
  status: Session["status"]
): SessionInfo {
  return {
    sessionId: row.id,
    cwd: SESSION_CWD,
    title: row.title,
    updatedAt: row.updatedAt,
    _meta: { [AOS_META_KEY]: sessionInfoMeta(row, status) },
  }
}

export function sessionInfoUpdate(
  row: SessionRow,
  status: Session["status"]
): SessionUpdate {
  return {
    sessionUpdate: "session_info_update",
    title: row.title,
    updatedAt: row.updatedAt,
    _meta: { [AOS_META_KEY]: sessionInfoMeta(row, status) },
  }
}

export function commandsUpdate(
  capabilities: WorkspaceCapabilities
): SessionUpdate {
  const { slashCommands } = capabilities.workspace
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: (slashCommands.status === "available"
      ? slashCommands.commands
      : []
    ).map(({ name, description }) => ({
      name,
      description: description ?? "",
    })),
  }
}

/** `ResumeSessionResponse._meta.aos.execution`, as the history route reports it. */
export function executionMeta(execution: {
  state: SessionExecutionState
  turnId?: string
}) {
  return {
    status: overlaidStatus(execution.state, "idle"),
    ...(execution.state === "idle" || execution.turnId === undefined
      ? {}
      : { turnId: execution.turnId }),
  }
}

/**
 * `session/list` and history pages go by offset; the cursor is that offset,
 * opaquely. Only a cursor this codec could have issued decodes, so no other
 * spelling of a number reaches a runtime.
 */
export function encodeCursor(offset: number) {
  return Buffer.from(String(offset), "utf8").toString("base64url")
}

export function decodeCursor(cursor: string | null | undefined) {
  if (cursor === undefined || cursor === null) return 0
  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"))
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    encodeCursor(offset) !== cursor
  )
    throw invalidRequest()
  return offset
}

/** How far back history pages reach; older history reads as truncated. */
export const HISTORY_MAX_OFFSET = 100_000

/** An older page's offset: past the start replay, short of the reach. */
export function decodeHistoryCursor(cursor: string) {
  const offset = decodeCursor(cursor)
  if (offset < 1 || offset >= HISTORY_MAX_OFFSET) throw invalidRequest()
  return offset
}

/**
 * `_meta.aos.history` for a page just read: a cursor to the next older page,
 * nothing once the page reached the start, or `truncated` when older history
 * exists that neither the runtime nor the reach serves.
 */
export function historyCursor(page: SessionHistoryResponse): AosHistoryCursor {
  // A runtime that cannot read further back has no page to offer beyond this.
  if (page.truncated) return { truncated: true }
  const older = page.nextOffset < page.total
  if (
    older &&
    page.nextOffset > page.offset &&
    page.nextOffset < HISTORY_MAX_OFFSET
  )
    return { nextCursor: encodeCursor(page.nextOffset) }
  return older ? { truncated: true } : {}
}

/**
 * The normalized reads and writes the handlers need, parsed with their
 * protocol schemas and with every provider or coordinator failure already
 * mapped to its JSON-RPC error. Detail reads take the provider Session id and
 * workspace reads the public one, exactly as the normalized HTTP routes do.
 */
export function createWorkspace(context: AcpConnectionContext) {
  const { runtime, sessions: coordinator } = context.runtimeInstance
  const call = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation()
    } catch (cause) {
      throw publicRequestError(runtime, cause)
    }
  }
  return {
    scope(agentId: string, publicSessionId: string): SessionScope {
      const sessionId = runtime.resolveSessionId(agentId, publicSessionId)
      if (!sessionId) throw notFound()
      return { agentId, sessionId, threadId: publicSessionId }
    },
    info: () => call(() => runtime.runtimeInfo()),
    agents: () => call(() => runtime.listAgents()),
    setVisibility: (
      agentId: string,
      visibility: "visible" | "hidden",
      revision: string
    ) =>
      call(() => runtime.updateAgentVisibility(agentId, visibility, revision)),
    list: (agentId: string | undefined, limit: number, offset: number) =>
      call(() =>
        agentId === undefined
          ? runtime.listAllSessions(limit, offset)
          : runtime.listSessions(agentId, limit, offset)
      ),
    create: (agentId: string, title: string | undefined) =>
      call(async () => {
        const created = SessionCreateResponseSchema.parse(
          await runtime.createSession(agentId, title)
        )
        return created.session.id
      }),
    /** The invited Session a guest addresses by its conversation reference. */
    invited: (
      agentId: string,
      ref: string,
      create?: { firstTurnInstruction?: string }
    ) => call(() => runtime.resolveInvitedSession(agentId, ref, create)),
    session: (scope: SessionScope) =>
      call(async () =>
        context.sessionRows.rememberDetail(
          await runtime.getSession(scope.agentId, scope.sessionId)
        )
      ),
    history: (scope: SessionScope, limit: number, offset = 0) =>
      call(() =>
        runtime.history(scope.agentId, scope.sessionId, limit, offset)
      ),
    update: (scope: SessionScope, patch: SessionPatch) =>
      call(() => runtime.updateSession(scope.agentId, scope.sessionId, patch)),
    delete: (scope: SessionScope) =>
      call(() => runtime.deleteSession(scope.agentId, scope.sessionId)),
    /** Addressed by public reference, so an invited Session needs no detail. */
    capabilities: (scope: Pick<SessionScope, "agentId" | "threadId">) =>
      call(async () =>
        SessionWorkspaceCapabilitiesResponseSchema.parse(
          await runtime.workspaceCapabilities(scope.agentId, scope.threadId)
        )
      ),
    models: (scope: SessionScope) =>
      call(async () =>
        SessionModelsResponseSchema.parse(
          await runtime.models(scope.agentId, scope.threadId)
        )
      ),
    updateModel: (scope: SessionScope, patch: SessionModelUpdateRequest) =>
      call(() => runtime.updateModel(scope.agentId, scope.threadId, patch)),
    usage: (scope: SessionScope) =>
      call(async () =>
        SessionContextResponseSchema.parse(
          await runtime.context(scope.agentId, scope.threadId)
        )
      ),
    /** Reconstructs provider-authoritative execution state before a resume. */
    discover: (scope: SessionScope) => call(() => coordinator.discover(scope)),
    steer: (scope: SessionScope, request: TurnSteerRequest) =>
      call(() => coordinator.steer(scope, request, context.principalId)),
  }
}

export type Workspace = ReturnType<typeof createWorkspace>

/**
 * Per-connection Session registry. ACP addresses a Session by its public id
 * alone, so the connection remembers the Agent each listed or created Session
 * belongs to and refuses an id it has never been told about.
 */
export function createSessions(context: AcpConnectionContext) {
  const workspace = createWorkspace(context)
  const coordinator = context.runtimeInstance.sessions
  const { runtime } = context.runtimeInstance
  const owners = new Map<string, string>()
  const members = new Map<string, ReturnType<typeof createSessionMember>>()

  const remember = (rows: readonly Session[]) => {
    for (const row of rows) owners.set(row.id, row.agentId)
  }

  return {
    workspace,
    remember,

    /** The live status of a row, whether or not this connection attached it. */
    status(row: Session) {
      const sessionId = runtime.resolveSessionId(row.agentId, row.id)
      return sessionId
        ? overlaidStatus(
            coordinator.state({ agentId: row.agentId, sessionId }),
            row.status
          )
        : row.status
    },

    owner(publicSessionId: string) {
      return owners.get(publicSessionId)
    },

    /** Trusts a client-supplied owner until the Session read confirms it. */
    adopt(publicSessionId: string, agentId: string) {
      if (!owners.has(publicSessionId)) owners.set(publicSessionId, agentId)
    },

    scope(publicSessionId: string) {
      const agentId = owners.get(publicSessionId)
      if (agentId === undefined) throw notFound()
      return workspace.scope(agentId, publicSessionId)
    },

    /** The Session's member on this connection, created on first use. */
    join(client: AgentContext, scope: SessionScope) {
      const existing = members.get(scope.threadId)
      if (existing) return existing
      const member = createSessionMember({
        context,
        scope,
        client,
        readUsage: () => workspace.usage(scope),
        readModels: () => workspace.models(scope),
      })
      members.set(scope.threadId, member)
      return member
    },

    member(publicSessionId: string) {
      return members.get(publicSessionId)
    },

    leave(publicSessionId: string) {
      members.get(publicSessionId)?.leave()
      members.delete(publicSessionId)
    },

    forget(scope: SessionScope) {
      members.get(scope.threadId)?.leave()
      members.delete(scope.threadId)
      owners.delete(scope.threadId)
      context.sessionRows.forget(scope.agentId, scope.threadId)
    },

    close() {
      for (const member of members.values()) member.leave()
      members.clear()
      owners.clear()
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>
