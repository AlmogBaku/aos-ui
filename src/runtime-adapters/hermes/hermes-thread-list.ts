import type { RemoteThreadListAdapter } from "@assistant-ui/react"

import type { HermesNativeClient, HermesSession } from "./hermes-native-client"

function metadata(session: HermesSession) {
  return {
    remoteId: session.threadId,
    externalId: session.threadId,
    status: session.archived ? ("archived" as const) : ("regular" as const),
    title: session.title,
    lastMessageAt: new Date(session.updatedAt),
    custom: { agentId: session.agentId, status: session.status },
  }
}

export class HermesThreadListAdapter implements RemoteThreadListAdapter {
  constructor(readonly client: HermesNativeClient) {}

  async list() {
    await this.client.start()
    return { threads: this.client.getSnapshot().sessions.map(metadata) }
  }

  async fetch(threadId: string) {
    await this.client.start()
    const session = this.client.session(threadId)
    if (!session) throw new Error(`Hermes Session not found: ${threadId}`)
    return metadata(session)
  }

  async initialize(threadId: string) {
    await this.fetch(threadId)
    return { remoteId: threadId, externalId: threadId }
  }

  async rename(threadId: string, title: string) {
    await this.client.renameSession(threadId, title)
  }

  async archive(threadId: string) {
    await this.client.archiveSession(threadId)
  }

  async unarchive(threadId: string) {
    await this.client.unarchiveSession(threadId)
  }

  async delete(threadId: string) {
    await this.client.deleteSession(threadId)
  }

  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }
}
