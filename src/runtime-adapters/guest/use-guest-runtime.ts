"use client"

import {
  createMessageQueue,
  fromThreadMessageLike,
  useExternalStoreRuntime,
  type AppendMessage,
  type CompleteAttachment,
  type PendingAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { useEffect, useMemo, useSyncExternalStore } from "react"

import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import type { GuestContentPart, GuestMessage } from "@shared/guest"
import { GuestClient } from "./guest-client"
import { GuestArtifactAdapter } from "./guest-artifacts"

const COMPLETE = { type: "complete", reason: "unknown" } as const
const DISPLAY_TOOL_NAMES = {
  chart: "render_chart",
  map: "render_map",
  stats: "render_stats",
  plan: "present_plan",
} as const

function attachmentMime(file: File) {
  if (file.type) return file.type
  const extension = file.name.split(".").pop()?.toLowerCase()
  const known: Record<string, string> = {
    md: "text/markdown",
    json: "application/json",
    txt: "text/plain",
    csv: "text/csv",
    pdf: "application/pdf",
  }
  return (extension && known[extension]) || "application/octet-stream"
}

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result)
      const comma = value.indexOf(",")
      resolve(
        comma < 0 ? value : `data:${mime};base64,${value.slice(comma + 1)}`
      )
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read attachment"))
    reader.readAsDataURL(file)
  })
}

function guestPart(part: AppendMessage["content"][number]): GuestContentPart[] {
  if (part.type === "text") return [{ type: "text", text: part.text }]
  if (part.type === "image")
    return [
      {
        type: "image",
        url: part.image,
        filename: part.filename,
        mime: /^data:([^;,]+);base64,/.exec(part.image)?.[1],
      },
    ]
  if (part.type === "file")
    return [
      {
        type: "file",
        url: part.data,
        filename: part.filename,
        mime: part.mimeType,
      },
    ]
  return []
}

function contentParts(message: AppendMessage): GuestContentPart[] {
  return [
    ...message.content,
    ...(message.attachments ?? []).flatMap(({ content }) => content),
  ].flatMap(guestPart)
}

function toThreadMessage(message: GuestMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content.map((part) => {
      if (part.type === "text") return part
      if (part.type === "image")
        return {
          type: "image" as const,
          image: part.url,
          filename: part.filename,
        }
      if (part.type === "file") {
        return {
          type: "file" as const,
          data: part.url,
          filename: part.filename ?? "attachment",
          mimeType: part.mime ?? "application/octet-stream",
        }
      }
      if (part.type === "artifact") {
        return {
          type: "data" as const,
          name: "aos.artifact",
          data: part.artifact,
        }
      }
      const { id, kind, payload } = part.display
      return {
        type: "tool-call" as const,
        toolCallId: id,
        toolName: DISPLAY_TOOL_NAMES[kind],
        args: payload.args,
        ...(payload.result === undefined ? {} : { result: payload.result }),
      }
    }),
  }
}

export function useGuestRuntime(client: GuestClient) {
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot
  )
  const blocked = snapshot.running || snapshot.pendingQuestions.length > 0
  const queue = useMemo(() => {
    const controller = createMessageQueue({
      run(message) {
        void client
          .send(contentParts(message))
          .catch(() => controller.notifyCancelled())
      },
      cancel: () => void client.stop(),
    })
    return controller
  }, [client])
  const media = useMemo(() => new VoiceMediaController(), [])
  const artifacts = useMemo(() => new GuestArtifactAdapter(client), [client])
  const adapters = useMemo(() => {
    const voice = media.createAdapters(client.bootstrap.conversation, {
      transcribe: (blob, signal) => client.transcribe(blob, signal),
      synthesize: (text, signal) => client.speech(text, signal),
      projectText: (text) => text,
    })
    return {
      ...(client.bootstrap.capabilities.attachments
        ? {
            attachments: {
              accept: "image/*,.pdf,.txt,.md,.csv,.json",
              async add({ file }: { file: File }): Promise<PendingAttachment> {
                return {
                  id: crypto.randomUUID(),
                  type: file.type.startsWith("image/") ? "image" : "file",
                  name: file.name,
                  contentType: file.type,
                  file,
                  status: { type: "requires-action", reason: "composer-send" },
                }
              },
              async remove() {},
              async send(
                attachment: PendingAttachment
              ): Promise<CompleteAttachment> {
                const mime = attachmentMime(attachment.file)
                const url = await dataUrl(attachment.file, mime)
                return {
                  ...attachment,
                  status: { type: "complete" },
                  content:
                    attachment.type === "image"
                      ? [
                          {
                            type: "image",
                            image: url,
                            filename: attachment.name,
                          },
                        ]
                      : [
                          {
                            type: "file",
                            data: url,
                            filename: attachment.name,
                            mimeType: mime,
                          },
                        ],
                }
              },
            },
          }
        : {}),
      ...(client.bootstrap.capabilities.transcription
        ? { dictation: voice.dictation }
        : {}),
      ...(client.bootstrap.capabilities.speech ? { speech: voice.speech } : {}),
    }
  }, [client, media])

  useEffect(() => {
    let active = true
    let disconnect: () => void = () => undefined
    media.setScope(client.bootstrap.conversation)
    media.setAvailability(client.bootstrap.conversation, {
      transcription: client.bootstrap.capabilities.transcription
        ? "ready"
        : "unavailable",
      speech: client.bootstrap.capabilities.speech ? "ready" : "unavailable",
    })
    void client
      .loadHistory()
      .catch(() => undefined)
      .then(() => {
        if (active) disconnect = client.connect()
      })
    return () => {
      active = false
      disconnect()
      queue.clear()
      media.dispose()
    }
  }, [client, media, queue])

  useEffect(() => {
    media.setSafelyIdle(!blocked && !snapshot.loading && !snapshot.revoked)
    if (blocked) queue.notifyBusy()
    else if (!snapshot.error) queue.notifyIdle()
  }, [
    media,
    queue,
    snapshot.error,
    snapshot.loading,
    snapshot.revoked,
    snapshot.revision,
    blocked,
  ])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: snapshot.messages.map(toThreadMessage),
    convertMessage: (message, index) =>
      fromThreadMessageLike(
        message,
        message.id ?? `guest-message-${index}`,
        COMPLETE
      ),
    // A pending native question blocks sends through the queue/composer, but
    // is not an active model run; completed history must remain fully rendered.
    isRunning: snapshot.running,
    isLoading: snapshot.loading,
    isDisabled: snapshot.revoked,
    adapters,
    queue: queue.adapter,
    onNew: (message) => client.send(contentParts(message)),
    onCancel: () => client.stop(),
    onRefetchThread: () => client.loadHistory(),
    ...(client.bootstrap.capabilities.edit
      ? {
          onEdit: (message: AppendMessage) =>
            client.edit(message.parentId!, contentParts(message)),
        }
      : {}),
    ...(client.bootstrap.capabilities.regenerate
      ? {
          onReload: (parentId: string | null) =>
            client.regenerate(parentId ?? ""),
        }
      : {}),
  })
  return {
    runtime,
    media,
    artifacts,
    artifactMessages: snapshot.messages.map((message) => {
      const converted = toThreadMessage(message)
      return {
        id: message.id,
        role: message.role,
        content:
          typeof converted.content === "string"
            ? [{ type: "text" as const, text: converted.content }]
            : converted.content,
      }
    }),
    snapshot,
  }
}
