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
import * as ids from "../core/ids"
import type { SessionScope } from "../core/runtime"
import type { SessionExecutionState } from "../core/session-coordinator"
import type { SessionRow } from "../core/session-rows"
import type { Membership } from "../core/channel"
import {
  hasSession,
  type Member,
  type MemberConnection,
  type MemberScope,
} from "../core/member"
import { redactForLog } from "../redaction"
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

/** A Session row's `_meta.aos`, on a listed row and on its update alike. */
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
 * Per-connection Session registry. ACP addresses a Session by its public id
 * alone, so the connection remembers the Agent each listed or created Session
 * belongs to and refuses an id it has never been told about. `connect` writes
 * the connection's member events to its client.
 */
export function createSessions(
  context: AcpConnectionContext,
  connect: (client: AgentContext) => MemberConnection
) {
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

  /** Reads the Session's row, which reaches each of its members as it changes. */
  async function readRow(scope: SessionScope) {
    context.sessionRows.rememberDetail(
      await runtime.getSession(scope.agentId, scope.providerSessionId)
    )
  }

  return {
    remember,
    identity,
    status,
    readRow,

    owner(publicSessionId: string) {
      return owners.get(publicSessionId)
    },

    /** Trusts a client-supplied owner until the Session read confirms it. */
    adopt(publicSessionId: string, agentId: string) {
      if (!owners.has(publicSessionId)) owners.set(publicSessionId, agentId)
    },

    scope(publicSessionId: string): SessionScope {
      const agentId = owners.get(publicSessionId)
      const providerSessionId =
        agentId === undefined
          ? undefined
          : runtime.resolveProviderSessionId(agentId, publicSessionId)
      if (agentId === undefined || !providerSessionId) throw notFound()
      return {
        agentId,
        providerSessionId,
        sessionId: ids.sessionId(publicSessionId),
      }
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
            void readRow(scope).catch((cause: unknown) =>
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
