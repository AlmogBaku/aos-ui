import {
  ExportedMessageRepository,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"

import {
  SESSION_CATALOG_MAX_WINDOW,
  type Session,
} from "../../../packages/protocol"
import type { AosRemoteClient } from "./aos-client"

const PAGE_SIZE = 50
type RemoteThreadMetadata = Awaited<
  ReturnType<RemoteThreadListAdapter["list"]>
>["threads"][number]

function metadata(session: Session): RemoteThreadMetadata {
  return {
    remoteId: session.id,
    externalId: session.id,
    status: session.archived ? "archived" : "regular",
    title: session.title,
    lastMessageAt: new Date(session.updatedAt),
    custom: { agentId: session.agentId, status: session.status },
  }
}

function cursorOffset(cursor: string | undefined) {
  if (cursor === undefined) return 0
  const match = /^aos-session-offset:([1-9]\d*)$/u.exec(cursor)
  if (!match) throw new Error("Invalid AOS Session cursor")
  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset))
    throw new Error("Invalid AOS Session cursor")
  return offset
}

class AosThreadHistoryAdapter implements ThreadHistoryAdapter {
  constructor(
    private readonly client: AosRemoteClient,
    private readonly threadId: string
  ) {}

  async load() {
    const history = await this.client.loadHistory(this.threadId)
    const repository = ExportedMessageRepository.fromArray(
      history.messages.map((message): ThreadMessageLike => ({
        ...message,
        createdAt: new Date(message.createdAt),
      }))
    )
    return {
      ...repository,
      headId: repository.messages.at(-1)?.message.id ?? null,
    }
  }

  async append() {
    // The normalized AG-UI run endpoint owns durable writes.
  }
}

/** Public assistant-ui adapters over the normalized AOS REST surface. */
export class AosThreadListAdapter implements RemoteThreadListAdapter {
  readonly #histories = new Map<string, ThreadHistoryAdapter>()

  constructor(readonly client: AosRemoteClient) {}

  async list({ after }: { after?: string } = {}) {
    const offset = cursorOffset(after)
    const page = await this.client.listSessionCatalog(PAGE_SIZE, offset)
    const sessions = [...page.sessions].sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.id.localeCompare(right.id)
    )
    const nextOffset = page.offset + page.sessions.length
    const hasMore =
      nextOffset < page.total && nextOffset < SESSION_CATALOG_MAX_WINDOW
    return {
      threads: sessions.map(metadata),
      ...(hasMore
        ? {
            nextCursor: `aos-session-offset:${nextOffset}`,
          }
        : {}),
    }
  }

  async fetch(threadId: string) {
    return metadata(await this.client.getSession(threadId))
  }

  async initialize(threadId: string) {
    const session = await this.fetch(threadId)
    return { remoteId: session.remoteId, externalId: session.externalId }
  }

  rename(threadId: string, title: string) {
    return this.client.renameSession(threadId, title)
  }

  archive(threadId: string) {
    return this.client.archiveSession(threadId)
  }

  unarchive(threadId: string) {
    return this.client.unarchiveSession(threadId)
  }

  delete(threadId: string) {
    return this.client.deleteSession(threadId)
  }

  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }

  historyFor(threadId: string): ThreadHistoryAdapter {
    let history = this.#histories.get(threadId)
    if (!history) {
      history = new AosThreadHistoryAdapter(this.client, threadId)
      this.#histories.set(threadId, history)
    }
    return history
  }
}
