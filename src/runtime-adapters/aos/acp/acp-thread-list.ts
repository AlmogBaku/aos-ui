import type { RemoteThreadListAdapter } from "@assistant-ui/react"
import type { SessionInfo } from "@agentclientprotocol/sdk/experimental/v2"

import { AOS_META_KEY, AosSessionInfoMetaSchema } from "@aos/protocol/acp"
import type { AosDraftRegistry } from "../aos-drafts"
import type { AcpConnection } from "./types"

/**
 * Assistant UI's remote thread list over one ACP connection. ACP owns the
 * Session catalog; `_meta.aos` carries the owning Agent and the archived flag.
 * History belongs to the Session projector, so this adapter exposes no
 * `historyFor`. Assistant UI has no pin, so that write travels on the workspace
 * channel instead of here.
 */

type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["list"]>
>["threads"][number]
type TitleStream = Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
type TitleChunk =
  TitleStream extends ReadableStream<infer Chunk> ? Chunk : never

/** Exactly what the thread list reads from the connection. */
export type AcpThreadListConnection = Pick<
  AcpConnection,
  "listSessions" | "updateSession" | "deleteSession"
> & {
  newSession(
    meta: Parameters<AcpConnection["newSession"]>[0]
  ): Promise<{ sessionId: string }>
}

export type AcpThreadListOptions = {
  connection: AcpThreadListConnection
  /** Associates Assistant UI's optimistic local id with the chosen Agent. */
  drafts: AosDraftRegistry
  /** The title tracked from `session_info_update`, for `generateTitle`. */
  titleFor: (remoteId: string) => string | undefined
  /** Resolves Agents for Sessions this adapter has not listed itself. */
  agentIdFor?: (remoteId: string) => string | undefined
  /** The Agent whose History further pages read; absent, every Agent's. */
  agentScope?: () => string | undefined
}

export type AcpThreadListAdapter = RemoteThreadListAdapter & {
  agentFor(remoteId: string): string | undefined
  historyFor?: never
}

/** Rejects a Session the proxy did not describe rather than guessing at it. */
function metadataOf(info: SessionInfo) {
  const meta = AosSessionInfoMetaSchema.parse(info._meta?.[AOS_META_KEY])
  const metadata: RemoteThreadMetadata = {
    status: meta.archived ? "archived" : "regular",
    remoteId: info.sessionId,
    title: info.title ?? undefined,
    lastMessageAt: info.updatedAt ? new Date(info.updatedAt) : undefined,
  }
  return { metadata, agentId: meta.agentId }
}

/** `session/list` meta for one Agent's catalog, or every Agent's. */
function listMeta(agentId: string | undefined) {
  return agentId === undefined ? {} : { agentId }
}

function titleStream(title: string | undefined): TitleStream {
  return new ReadableStream<TitleChunk>({
    start(controller) {
      if (title) {
        controller.enqueue({
          type: "part-start",
          path: [0],
          part: { type: "text" },
        })
        controller.enqueue({ type: "text-delta", path: [0], textDelta: title })
        controller.enqueue({ type: "part-finish", path: [0] })
      }
      controller.close()
    },
  })
}

export function createAcpThreadListAdapter({
  connection,
  drafts,
  titleFor,
  agentIdFor,
  agentScope,
}: AcpThreadListOptions): AcpThreadListAdapter {
  const listed = new Map<string, RemoteThreadMetadata>()
  const agents = new Map<string, string>()
  const initializations = new Map<string, Promise<{ remoteId: string }>>()

  function remember({
    metadata,
    agentId,
  }: {
    metadata: RemoteThreadMetadata
    agentId: string
  }) {
    listed.set(metadata.remoteId, metadata)
    agents.set(metadata.remoteId, agentId)
    return metadata
  }

  // A page that lists nothing, or a cursor that does not advance, cannot
  // reach another Session.
  function advances(
    page: { sessions: readonly unknown[]; nextCursor?: string },
    cursor: string | undefined
  ) {
    return (
      page.sessions.length > 0 &&
      page.nextCursor !== undefined &&
      page.nextCursor !== cursor
    )
  }

  function revise(remoteId: string, change: Partial<RemoteThreadMetadata>) {
    const metadata = listed.get(remoteId)
    if (metadata) listed.set(remoteId, { ...metadata, ...change })
  }

  async function create(threadId: string, agentId: string) {
    const existing = initializations.get(threadId)
    if (existing) return existing
    const initialization = connection
      .newSession({ agentId })
      .then(({ sessionId }) => {
        agents.set(sessionId, agentId)
        return { remoteId: sessionId }
      })
      .finally(() => initializations.delete(threadId))
    initializations.set(threadId, initialization)
    return initialization
  }

  return {
    /**
     * Pages the selected Agent's own catalog, so the cursor, and with it
     * History's "Load more", ends where that Agent's Sessions do. Page one of
     * every Agent still comes with the first page: other Agents' status and
     * Open sessions read it.
     */
    async list({ after } = {}) {
      const agentId = agentScope?.()
      const [first, everyAgent] = await Promise.all([
        connection.listSessions(listMeta(agentId), after),
        agentId === undefined || after !== undefined
          ? undefined
          : connection.listSessions({}),
      ])
      // Page one of every Agent can already hold this Agent's next page, and a
      // later page that lists nothing new would stop History reading at its
      // end, so a later read continues until it reaches an unlisted Session.
      let page = first
      let cursor = after
      const read = new Set([after])
      while (
        after !== undefined &&
        page.sessions.every((info) => listed.has(info.sessionId)) &&
        advances(page, cursor) &&
        !read.has(page.nextCursor)
      ) {
        cursor = page.nextCursor
        read.add(cursor)
        page = await connection.listSessions(listMeta(agentId), cursor)
      }
      const sessions = new Map(
        [...page.sessions, ...(everyAgent?.sessions ?? [])].map((info) => [
          info.sessionId,
          info,
        ])
      )
      const threads = [...sessions.values()].map((info) =>
        remember(metadataOf(info))
      )
      return {
        threads,
        ...(advances(page, cursor) ? { nextCursor: page.nextCursor } : {}),
      }
    },

    /**
     * Resolves a Session this adapter has not listed, which is how Assistant UI
     * opens one named before any page was read — a reloaded deep link. The
     * catalog is the only authority for it and has no single-Session read, so
     * the owning Agent's pages, or the selected Agent's, are read until it
     * appears.
     */
    async fetch(threadId: string) {
      const metadata = listed.get(threadId)
      if (metadata) return metadata
      const agentId = agentIdFor?.(threadId) ?? agentScope?.()
      let cursor: string | undefined
      for (;;) {
        const page = await connection.listSessions(listMeta(agentId), cursor)
        for (const info of page.sessions) remember(metadataOf(info))
        const found = listed.get(threadId)
        if (found) return found
        // A cursor the provider does not advance cannot reach another page.
        if (page.nextCursor === undefined || page.nextCursor === cursor)
          throw new Error("Unknown AOS Session")
        cursor = page.nextCursor
      }
    },

    async initialize(threadId: string) {
      const draftAgentId = drafts.agentFor(threadId)
      if (draftAgentId) return create(threadId, draftAgentId)
      if (listed.has(threadId)) return { remoteId: threadId }
      throw new Error("An AOS Session needs an owning Agent")
    },

    agentFor(remoteId: string) {
      return agents.get(remoteId) ?? agentIdFor?.(remoteId)
    },

    async rename(remoteId: string, title: string) {
      await connection.updateSession({ sessionId: remoteId, title })
      revise(remoteId, { title })
    },

    async archive(remoteId: string) {
      await connection.updateSession({ sessionId: remoteId, archived: true })
      revise(remoteId, { status: "archived" })
    },

    async unarchive(remoteId: string) {
      await connection.updateSession({ sessionId: remoteId, archived: false })
      revise(remoteId, { status: "regular" })
    },

    async delete(remoteId: string) {
      await connection.deleteSession(remoteId)
      listed.delete(remoteId)
      agents.delete(remoteId)
    },

    /**
     * The provider owns Session titles: this streams the title the connection
     * has already seen, and a later `session_info_update` retries once the
     * runtime persists one.
     */
    async generateTitle(remoteId: string) {
      const title = titleFor(remoteId)?.trim()
      return titleStream(title && title !== remoteId ? title : undefined)
    },
  }
}
