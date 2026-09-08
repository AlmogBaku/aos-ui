import type { OpencodeClient } from "@assistant-ui/react-opencode"

const REQUEST_OPTIONS = { throwOnError: true } as const

function toMetadata(session: {
  id: string
  title: string
  time: { archived?: number | null }
}) {
  return {
    status:
      typeof session.time.archived === "number"
        ? ("archived" as const)
        : ("regular" as const),
    remoteId: session.id,
    externalId: session.id,
    title: session.title,
  }
}

export function createAosOpenCodeThreadListAdapter(client: OpencodeClient) {
  return {
    async list() {
      const response = await client.experimental.session.list(
        { roots: true, archived: true },
        REQUEST_OPTIONS
      )
      return {
        threads: (response.data ?? [])
          .filter((session) => !session.parentID)
          .map(toMetadata),
      }
    },
    async rename(remoteId: string, newTitle: string) {
      await client.session.update(
        { sessionID: remoteId, title: newTitle },
        REQUEST_OPTIONS
      )
    },
    async archive(remoteId: string) {
      await client.session.update(
        { sessionID: remoteId, time: { archived: Date.now() } },
        REQUEST_OPTIONS
      )
    },
    async unarchive(remoteId: string) {
      await client.session.update(
        { sessionID: remoteId, time: { archived: null as never } as never },
        REQUEST_OPTIONS
      )
    },
    async delete(remoteId: string) {
      await client.session.delete({ sessionID: remoteId }, REQUEST_OPTIONS)
    },
    async initialize() {
      const response = await client.session.create({}, REQUEST_OPTIONS)
      if (!response.data?.id)
        throw new Error("Failed to create OpenCode Session")
      return { remoteId: response.data.id, externalId: response.data.id }
    },
    async generateTitle(remoteId: string) {
      await client.session.summarize({ sessionID: remoteId }, REQUEST_OPTIONS)
      return new ReadableStream({
        start(controller) {
          controller.close()
        },
      }) as never
    },
    async fetch(threadId: string) {
      const response = await client.session.get(
        { sessionID: threadId },
        REQUEST_OPTIONS
      )
      if (!response.data?.id) throw new Error("OpenCode Session not found")
      return toMetadata(response.data)
    },
  }
}
