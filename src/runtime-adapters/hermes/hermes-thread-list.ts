import type { RemoteThreadListAdapter } from "@assistant-ui/react"

import type { HermesNativeClient, HermesSession } from "./hermes-native-client"

function metadata(session: HermesSession) {
  return {
    remoteId: session.threadId,
    externalId: session.threadId,
    status: "regular" as const,
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

  async rename() {
    throw new Error("Hermes Session renaming is unavailable in AOS")
  }

  async archive() {
    throw new Error("Hermes Session archiving is unavailable in AOS")
  }

  async unarchive() {
    throw new Error("Hermes Session unarchiving is unavailable in AOS")
  }

  async delete() {
    throw new Error("Hermes Session deletion is unavailable in AOS")
  }

  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }
}
