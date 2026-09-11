import {
  createMessageQueue,
  SimpleImageAttachmentAdapter,
  type AppendMessage,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
  type RemoteThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { z } from "zod"
import {
  parseArtifactDescriptor,
  type ArtifactMessage,
} from "@/artifacts/artifacts"
import type {
  ArtifactAdapter,
  ArtifactResolveOptions,
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"
import type { Locale } from "@/lib/i18n/config"
import type {
  OpenClawApproval,
  OpenClawAttachment,
  OpenClawClient,
  OpenClawSession,
} from "./openclaw-client"

/** Only an explicit canonical receipt authorizes an inspector artifact. */
export function projectOpenClawArtifacts(
  messages: readonly ArtifactMessage[]
): readonly ArtifactMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message
    const artifacts = message.content.flatMap((part) => {
      const tool = z
        .object({ type: z.literal("tool-call"), result: z.unknown() })
        .passthrough()
        .safeParse(part)
      if (!tool.success) return []
      const receipt = z
        .object({
          ok: z.literal(true),
          type: z.literal("aos.artifact"),
          artifact: z.unknown(),
        })
        .safeParse(tool.data.result)
      if (!receipt.success) return []
      const artifact = parseArtifactDescriptor(receipt.data.artifact)
      return artifact?.source.type === "provider"
        ? [{ type: "data", name: "aos.artifact", data: artifact }]
        : []
    })
    return artifacts.length
      ? { ...message, content: [...message.content, ...artifacts] }
      : message
  })
}

export function createOpenClawWorkspace(
  client: OpenClawClient
): WorkspaceAdapter {
  const metadata = (ids: readonly string[]) =>
    client
      .getSnapshot()
      .sessions.filter((session) => ids.includes(session.threadId))
      .map(({ threadId, agentId, updatedAt, status }) => ({
        threadId,
        agentId,
        updatedAt,
        status,
      }))
  return {
    async listAgents() {
      await client.start()
      return client.getSnapshot().agents
    },
    async refreshAgents() {
      await client.start()
      await client.refresh()
      return client.getSnapshot().agents
    },
    async getSessionMetadata(ids) {
      await client.start()
      return metadata(ids)
    },
    async createSession(agentId, options) {
      await client.start()
      return client.createSession(agentId, options?.title)
    },
    subscribeAgentCatalog: client.subscribeCatalog,
    subscribeSessionMetadata: (ids, listener) =>
      client.subscribe(() => listener(metadata(ids))),
    subscribeActivity: client.subscribeActivity,
  }
}

export function createOpenClawInteractions(
  client: OpenClawClient
): RuntimeInteractionAdapter {
  const cache = new Map<
    string,
    { revision: number; request: RuntimeQuestionRequest | undefined }
  >()
  return {
    getPending(threadId) {
      const revision = client.getSnapshot().revision
      const prior = cache.get(threadId)
      if (prior?.revision === revision) return prior.request
      const request = client.pendingQuestions(threadId)[0]
      cache.set(threadId, { revision, request })
      return request
    },
    subscribe: (_threadId, listener) => client.subscribe(listener),
    respond: (request, response) =>
      client.answerQuestion(
        request.sessionId,
        request.requestId,
        response.answers
      ),
    reject: (request) =>
      client.answerQuestion(request.sessionId, request.requestId, null),
  }
}

const labels = {
  en: {
    "allow-once": "Allow once",
    "allow-always": "Always allow",
    deny: "Deny",
  },
  he: {
    "allow-once": "אישור פעם אחת",
    "allow-always": "אישור תמיד",
    deny: "דחייה",
  },
}
export function projectOpenClawApprovals(
  messages: readonly ThreadMessageLike[],
  approvals: OpenClawApproval[],
  locale: Locale
): readonly ThreadMessageLike[] {
  return [
    ...messages,
    ...approvals.map((approval): ThreadMessageLike => ({
      id: `openclaw-approval:${approval.id}`,
      role: "assistant",
      status: { type: "requires-action", reason: "tool-calls" },
      content: [
        {
          type: "tool-call",
          toolName: "request_permission",
          toolCallId: `openclaw-approval:${approval.id}`,
          args: { command: approval.request.command },
          argsText: JSON.stringify({ command: approval.request.command }),
          approval: {
            id: approval.id,
            prompt: approval.request.command,
            options: (
              approval.request.allowedDecisions ?? ["allow-once", "deny"]
            ).map((id) => ({
              id,
              kind: id === "deny" ? "reject-once" : id,
              label: labels[locale][id],
            })),
          },
        },
      ],
    })),
  ]
}

export class OpenClawAttachmentAdapter implements AttachmentAdapter {
  readonly accept = "*"
  private readonly bytes = new SimpleImageAttachmentAdapter()
  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      ...(await this.bytes.add({ file })),
      type: file.type.startsWith("image/") ? "image" : "file",
    }
  }
  remove: AttachmentAdapter["remove"] = async () => {}
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const result = await this.bytes.send(attachment)
    const part = result.content[0]
    if (part?.type !== "image") throw new Error("Unable to read attachment")
    return {
      ...result,
      content:
        attachment.type === "image"
          ? [{ ...part, filename: attachment.name }]
          : [
              {
                type: "file",
                data: part.image,
                mimeType: attachment.file.type || "application/octet-stream",
                filename: attachment.name,
              },
            ],
    }
  }
}

export function submitOpenClawMessage(
  client: OpenClawClient,
  threadId: string,
  message: AppendMessage
) {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const attachments: OpenClawAttachment[] = (message.attachments ?? []).flatMap(
    (attachment) =>
      attachment.content.map((part) => {
        const value =
          part.type === "image"
            ? part.image
            : part.type === "file"
              ? part.data
              : undefined
        if (typeof value !== "string")
          throw new Error("OpenClaw requires inline attachment bytes")
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(value)
        if (!match) throw new Error("OpenClaw requires base64 attachment bytes")
        return {
          mimeType: match[1],
          content: match[2]!,
          fileName: attachment.name,
        }
      })
  )
  return client.submit(threadId, text, attachments)
}

export function createOpenClawQueue(
  client: OpenClawClient,
  threadId: string,
  onError?: (error: Error) => void
) {
  let wasBusy = true
  let uncertain = false
  const controller = createMessageQueue({
    run(message) {
      void submitOpenClawMessage(client, threadId, message).catch(
        (reason: unknown) => {
          uncertain = true
          controller.notifyCancelled()
          controller.notifyBusy()
          onError?.(
            reason instanceof Error ? reason : new Error(String(reason))
          )
        }
      )
    },
  })
  controller.notifyBusy()
  return {
    controller,
    sync() {
      const session = client.session(threadId)
      const safelyIdle =
        !uncertain &&
        client.getSnapshot().connection === "ready" &&
        session?.status === "idle" &&
        !session.running &&
        !session.loading &&
        !client.pendingApprovals(threadId).length &&
        !client.pendingQuestions(threadId).length
      if (!safelyIdle) {
        if (!wasBusy) controller.notifyBusy()
        wasBusy = true
      } else if (wasBusy) {
        wasBusy = false
        controller.notifyIdle()
      }
    },
  }
}

function metadata(session: OpenClawSession) {
  return {
    remoteId: session.threadId,
    externalId: session.threadId,
    title: session.title,
    status: session.archived ? ("archived" as const) : ("regular" as const),
    lastMessageAt: new Date(session.updatedAt),
    custom: { agentId: session.agentId, status: session.status },
  }
}
export class OpenClawThreadListAdapter implements RemoteThreadListAdapter {
  constructor(readonly client: OpenClawClient) {}
  async list() {
    await this.client.start()
    return { threads: this.client.getSnapshot().sessions.map(metadata) }
  }
  async fetch(id: string) {
    await this.client.start()
    const session = this.client.session(id)
    if (!session) throw new Error("Unknown OpenClaw Session")
    return metadata(session)
  }
  async initialize(id: string) {
    await this.fetch(id)
    return { remoteId: id, externalId: id }
  }
  async rename(id: string, title: string) {
    await this.patch(id, { label: title })
  }
  async archive(id: string) {
    await this.patch(id, { archived: true })
  }
  async unarchive(id: string) {
    await this.patch(id, { archived: false })
  }
  private async patch(
    id: string,
    values: { label?: string; archived?: boolean }
  ) {
    const session = this.client.session(id)
    if (!session) throw new Error("Unknown OpenClaw Session")
    await this.client.request("sessions.patch", {
      key: id,
      agentId: session.agentId,
      ...values,
    })
    await this.client.refresh()
  }
  async delete(id: string) {
    const session = this.client.session(id)
    if (!session) throw new Error("Unknown OpenClaw Session")
    await this.client.request("sessions.delete", {
      key: id,
      agentId: session.agentId,
    })
    await this.client.refresh()
  }
  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  }
}

export class OpenClawArtifactAdapter implements ArtifactAdapter {
  constructor(readonly client: OpenClawClient) {}
  async resolve(input: ArtifactResolveOptions): Promise<Blob> {
    input.signal.throwIfAborted()
    if (this.client.session(input.threadId)?.agentId !== input.agentId)
      throw new Error("OpenClaw artifact ownership mismatch")
    if (input.artifact.source.type !== "provider")
      throw new Error("OpenClaw requires a native artifact reference")
    const result = z
      .object({
        artifact: z
          .object({
            id: z.string(),
            sessionKey: z.string().optional(),
            mimeType: z.string().optional(),
          })
          .passthrough(),
        encoding: z.literal("base64").optional(),
        data: z.string().optional(),
      })
      .passthrough()
      .parse(
        await this.client.request("artifacts.download", {
          agentId: input.agentId,
          sessionKey: input.threadId,
          artifactId: input.artifact.source.reference,
        })
      )
    input.signal.throwIfAborted()
    if (
      result.artifact.id !== input.artifact.source.reference ||
      (result.artifact.sessionKey &&
        result.artifact.sessionKey !== input.threadId)
    )
      throw new Error("OpenClaw artifact ownership mismatch")
    if (result.encoding !== "base64" || !result.data)
      throw new Error("OpenClaw artifact download bytes are unavailable")
    return new Blob(
      [Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0))],
      {
        type:
          result.artifact.mimeType ??
          input.artifact.mimeType ??
          "application/octet-stream",
      }
    )
  }
}
