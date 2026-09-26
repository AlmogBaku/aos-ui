import type {
  AgentContext,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  SessionCreateResponseSchema,
  SessionModelsResponseSchema,
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
import * as ids from "../core/ids"
import type { SessionPatch, SessionScope } from "../core/runtime"
import type {
  CreateInput,
  SessionExecutionState,
} from "../core/session-coordinator"
import type { SessionRow } from "../core/session-rows"
import type { Membership } from "../core/channel"
import {
  hasSession,
  type Member,
  type MemberConnection,
  type MemberScope,
} from "../core/member"
import { redactForLog } from "../redaction"
import type { AcpConnectionContext, WorkspaceCapabilities } from "./types"
import {
  authenticationRequired,
  errorNotificationOf,
  invalidParams,
  notFound,
  publicRequestError,
} from "./validation"

/**
 * The Session half of the ACP agent: the normalized runtime reads and writes
 * the handlers need, the `_meta.aos` projections of a Session row, and the
 * per-connection registry of which Agent owns a Session and which Sessions
 * this connection has resumed.
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

function sessionInfoMeta(
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
    _meta: { [AOS_META_KEY]: { capabilities } },
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
    throw invalidParams()
  return offset
}

/** How far back history pages reach; older history reads as truncated. */
export const HISTORY_MAX_OFFSET = 100_000

/** An older page's offset: past the start replay, short of the reach. */
export function decodeHistoryCursor(cursor: string) {
  const offset = decodeCursor(cursor)
  if (offset < 1 || offset >= HISTORY_MAX_OFFSET) throw invalidParams()
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
export function createWorkspace(
  context: Pick<
    AcpConnectionContext,
    "runtimeInstance" | "sessionRows" | "principalId"
  >
) {
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
      const providerSessionId = runtime.resolveProviderSessionId(
        agentId,
        publicSessionId
      )
      if (!providerSessionId) throw notFound()
      return {
        agentId,
        providerSessionId,
        sessionId: ids.sessionId(publicSessionId),
      }
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
    /** A repeat of a client id answers the Session its first create made. */
    create: (agentId: string, input: CreateInput) =>
      call(async () => {
        const created = SessionCreateResponseSchema.parse(
          await coordinator.createSession(agentId, input, context.principalId)
        )
        return created.session.id
      }),
    session: (scope: SessionScope) =>
      call(async () =>
        context.sessionRows.rememberDetail(
          await runtime.getSession(scope.agentId, scope.providerSessionId)
        )
      ),
    history: (scope: SessionScope, limit: number, offset = 0) =>
      call(() =>
        runtime.history(scope.agentId, scope.providerSessionId, limit, offset)
      ),
    update: (scope: SessionScope, patch: SessionPatch) =>
      call(() =>
        runtime.updateSession(scope.agentId, scope.providerSessionId, patch)
      ),
    delete: (scope: SessionScope) =>
      call(() => runtime.deleteSession(scope.agentId, scope.providerSessionId)),
    models: (scope: SessionScope) =>
      call(async () =>
        SessionModelsResponseSchema.parse(
          await runtime.models(scope.agentId, scope.sessionId)
        )
      ),
    updateModel: (scope: SessionScope, patch: SessionModelUpdateRequest) =>
      call(() => runtime.updateModel(scope.agentId, scope.sessionId, patch)),
    /** Steers the Session's live turn. */
    steer: (scope: SessionScope, request: TurnSteerRequest) =>
      call(() => coordinator.steer(scope, request)),
  }
}

export type Workspace = ReturnType<typeof createWorkspace>

/**
 * Per-connection Session registry. ACP addresses a Session by its public id
 * alone, so the connection remembers the Agent each listed or created Session
 * belongs to and refuses an id it has never been told about. `connect` writes
 * the connection's member events to its client.
 */
export function createSessions(
  context: AcpConnectionContext,
  connect: (client: AgentContext) => MemberConnection
) {
  const workspace = createWorkspace(context)
  const coordinator = context.runtimeInstance.sessions
  const { runtime } = context.runtimeInstance
  const owners = new Map<string, string>()
  const memberships = new Map<string, Membership>()
  /** This connection as a channel's member, once it first joins one. */
  let member: Member | undefined

  /**
   * Who this connection acts as, and its stack: one that authenticates over
   * ACP has none until it does, and the upgrade's principal has an empty one.
   */
  function identity(): Omit<Member, "connection"> | undefined {
    return context.authentication
      ? context.authentication.member()
      : {
          principal: { id: context.principalId, role: context.role },
          middleware: [],
        }
  }

  function memberOf(client: AgentContext): Member {
    if (member) return member
    const joined = identity()
    if (!joined) throw authenticationRequired()
    member = { ...joined, connection: connect(client) }
    return member
  }

  const remember = (rows: readonly Pick<Session, "id" | "agentId">[]) => {
    for (const row of rows) owners.set(row.id, row.agentId)
  }

  /** The live status of a row, whether or not this connection resumed it. */
  function status(row: Session) {
    const providerSessionId = runtime.resolveProviderSessionId(
      row.agentId,
      row.id
    )
    return providerSessionId
      ? overlaidStatus(
          coordinator.state({
            agentId: row.agentId,
            providerSessionId,
          }),
          row.status
        )
      : row.status
  }

  return {
    workspace,
    remember,
    identity,
    status,

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

    /**
     * The Session's membership on this connection, joined on first use, again
     * once the last one detached, and anew once a fresh invitation's Session
     * exists.
     */
    join(client: AgentContext, scope: MemberScope) {
      const existing = memberships.get(scope.sessionId)
      const created = existing?.pending === true && hasSession(scope)
      if (existing && !existing.detached && !created) return existing
      if (created) existing.part()
      const log = (
        level: "info" | "error",
        event: string,
        fields: Record<string, unknown>
      ) =>
        context.logger?.[level](
          redactForLog({ event, connectionId: context.connectionId, ...fields })
        )
      const membership = context.channels.join(memberOf(client), scope, {
        coordinator,
        membershipId: `${context.connectionId}:${scope.sessionId}`,
        log,
        describe: (cause) => errorNotificationOf(runtime, cause),
        subscribeRow: (listener) => {
          const { agentId, sessionId } = scope
          const unsubscribe = context.sessionRows.subscribeRow(
            agentId,
            sessionId,
            (row) => listener(row, status(row))
          )
          // A Session this connection never listed is read once for its row.
          if (hasSession(scope) && !context.sessionRows.get(agentId, sessionId))
            void workspace.session(scope).catch((cause: unknown) =>
              log("error", "session.read.failed", {
                sessionId,
                errorCode: errorNotificationOf(runtime, cause).code,
              })
            )
          return unsubscribe
        },
      })
      memberships.set(scope.sessionId, membership)
      return membership
    },

    /**
     * The Session's membership on this connection, while it lasts and once
     * its Session exists.
     */
    membership(publicSessionId: string) {
      const membership = memberships.get(publicSessionId)
      return membership?.detached || membership?.pending
        ? undefined
        : membership
    },

    part(publicSessionId: string) {
      memberships.get(publicSessionId)?.part()
      memberships.delete(publicSessionId)
    },

    forget(scope: SessionScope) {
      memberships.get(scope.sessionId)?.part()
      memberships.delete(scope.sessionId)
      owners.delete(scope.sessionId)
      context.sessionRows.forget(scope.agentId, scope.sessionId)
    },

    close() {
      for (const membership of memberships.values()) membership.part()
      memberships.clear()
      owners.clear()
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>
