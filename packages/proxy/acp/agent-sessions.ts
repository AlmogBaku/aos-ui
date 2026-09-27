import type {
  AgentContext,
  SessionInfo,
} from "@agentclientprotocol/sdk/experimental/v2"

import { type Session, type SessionHistoryResponse } from "../../protocol"
import {
  AOS_META_KEY,
  type AosHistoryCursor,
  type AosSessionInfoMeta,
} from "../../protocol/acp"
import type { SessionRow } from "../core/session-rows"
import {
  HISTORY_MAX_OFFSET,
  hasOlderPage,
  type Membership,
} from "../core/channel"
import {
  hasSession,
  showWorkspace,
  type Member,
  type MemberConnection,
  type MemberScope,
  type WorkspaceEvent,
} from "../core/member"
import type { AcpConnectionContext } from "./types"
import {
  authenticationRequired,
  errorNotificationOf,
  invalidParams,
  notFound,
} from "./validation"

/**
 * The Session half of the ACP agent: the `_meta.aos` projections of a Session
 * row, and the per-connection registry of which Agent owns a Session and
 * which Sessions this connection has joined.
 */

/** A durable Session's `cwd`: AOS Sessions are not workspace-rooted. */
const SESSION_CWD = "/"

/** A Session row's `_meta.aos`, on a listed row and on its update alike. */
export function sessionInfoMeta(row: SessionRow): AosSessionInfoMeta {
  return {
    agentId: row.agentId,
    status: row.status,
    archived: row.archived,
    ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
    ...(row.unread === undefined ? {} : { unread: row.unread }),
    ...(row.pinned === undefined ? {} : { pinned: row.pinned }),
  }
}

export function sessionInfoOf(row: SessionRow): SessionInfo {
  return {
    sessionId: row.id,
    cwd: SESSION_CWD,
    title: row.title,
    updatedAt: row.updatedAt,
    _meta: { [AOS_META_KEY]: sessionInfoMeta(row) },
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
  if (hasOlderPage(page)) return { nextCursor: encodeCursor(page.nextOffset) }
  return page.nextOffset < page.total ? { truncated: true } : {}
}

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
  const { catalog } = context
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

  return {
    remember,
    identity,

    owner(publicSessionId: string) {
      return owners.get(publicSessionId)
    },

    /** Trusts a client-supplied owner until the Session read confirms it. */
    adopt(publicSessionId: string, agentId: string) {
      if (!owners.has(publicSessionId)) owners.set(publicSessionId, agentId)
    },

    scope(publicSessionId: string) {
      const agentId = owners.get(publicSessionId)
      const scope =
        agentId === undefined
          ? undefined
          : catalog.scope(agentId, publicSessionId)
      if (!scope) throw notFound()
      return scope
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
      const logger = context.logger.child({ sessionId: scope.sessionId })
      const membership = context.channels.join(memberOf(client), scope, {
        membershipId: `${context.connectionId}:${scope.sessionId}`,
        logger,
        describe: (cause) => errorNotificationOf(context.publicError, cause),
        subscribeRow: (listener) =>
          catalog.subscribe(scope, listener, (cause) => {
            const { code } = errorNotificationOf(context.publicError, cause)
            logger.error({ errorCode: code }, "session.read.failed")
          }),
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

    forget(publicSessionId: string) {
      memberships.get(publicSessionId)?.part()
      memberships.delete(publicSessionId)
      owners.delete(publicSessionId)
    },

    /**
     * Shows this connection one workspace event through its stack, once it
     * acts as someone. A connection that cannot be written to has closed.
     */
    show(client: AgentContext, event: WorkspaceEvent) {
      if (!identity()) return
      showWorkspace(memberOf(client), event).catch((err: unknown) =>
        context.logger.warn({ err }, "session.workspace.show_failed")
      )
    },

    close() {
      for (const membership of memberships.values()) membership.part()
      memberships.clear()
      owners.clear()
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>
