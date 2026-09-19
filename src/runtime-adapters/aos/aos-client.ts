import type { z } from "zod"

import {
  ErrorResponseSchema,
  RuntimeInfoSchema,
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionContextResponseSchema,
  SessionModelsResponseSchema,
  SessionSpeechRequestSchema,
  SessionTranscriptionRequestSchema,
  SessionTranscriptionResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "@aos/protocol"

import type { AosStagedAttachment } from "./aos-attachment-adapter"

/**
 * The normalized proxy's REST surface, which carries bytes and deployment
 * metadata only: attachments, artifacts, speech, transcription, and the runtime
 * descriptor. Every conversation, Session, and Agent concern travels over ACP.
 */

type Schema<T> = Pick<z.ZodType<T>, "safeParse">

export type AosWorkspaceCapabilities = z.infer<
  typeof SessionWorkspaceCapabilitiesResponseSchema
>
export type AosModelChoices = z.infer<typeof SessionModelsResponseSchema>
export type AosContext = z.infer<typeof SessionContextResponseSchema>

export type AosClientFailure =
  | "connection-interrupted"
  | "provider-unavailable"
  | "proxy-failure"
  /** The provider no longer holds the bytes a published receipt points at. */
  | "artifact-missing"

export class AosClientError extends Error {
  constructor(
    readonly kind: AosClientFailure,
    message = "AOS proxy request failed",
    readonly code?: string
  ) {
    super(message)
    this.name = "AosClientError"
  }
}

export type AosRemoteClientOptions = {
  fetcher?: typeof fetch
  basePath?: string
  authorization?: string
}

async function normalizedError(response: Response) {
  const parsed = ErrorResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  )
  return parsed.success ? parsed.data.error : undefined
}

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return `data:${blob.type};base64,${btoa(binary)}`
}

export class AosRemoteClient {
  readonly #fetch: typeof fetch
  readonly #basePath: string
  readonly #authorization?: string
  readonly #sessionOwners = new Map<string, string>()

  constructor(options: AosRemoteClientOptions = {}) {
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#basePath = options.basePath ?? "/api/aos/v1"
    this.#authorization = options.authorization
  }

  async #read<T>(
    path: string,
    schema: Schema<T>,
    init?: RequestInit
  ): Promise<T> {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set("accept", "application/json")
      if (this.#authorization) headers.set("authorization", this.#authorization)
      response = await this.#fetch(`${this.#basePath}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      })
    } catch {
      throw new AosClientError("connection-interrupted")
    }
    if (!response.ok) {
      const error = await normalizedError(response)
      throw new AosClientError(
        response.status === 503 ? "provider-unavailable" : "proxy-failure",
        error?.description,
        error?.code
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success)
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    return parsed.data
  }

  runtimeInfo(signal?: AbortSignal) {
    return this.#read("/runtime", RuntimeInfoSchema, { signal })
  }

  /** REST authorizes byte routes per Agent, so every Session names its owner. */
  adoptSessionOwnership(threadId: string, agentId: string) {
    if (!threadId || !agentId)
      throw new Error("Invalid Session ownership metadata")
    const current = this.#sessionOwners.get(threadId)
    if (current && current !== agentId)
      throw new Error("Conflicting Session ownership metadata")
    this.#sessionOwners.set(threadId, agentId)
  }

  async stageAttachments(
    threadId: string,
    attachments: readonly AosStagedAttachment[]
  ) {
    const request = SessionAttachmentStageRequestSchema.safeParse({
      attachments: attachments.map(({ dataUrl, filename, mimeType, type }) =>
        type === "image"
          ? { type, dataUrl, ...(filename ? { filename } : {}) }
          : {
              type,
              dataUrl,
              ...(filename ? { filename } : {}),
              ...(mimeType ? { mimeType } : {}),
            }
      ),
    })
    if (!request.success)
      throw new AosClientError(
        "proxy-failure",
        "Invalid attachment staging request"
      )
    return this.#read(
      this.#sessionPath(threadId, "/attachments/stage"),
      SessionAttachmentStageResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      }
    )
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
    signal?: AbortSignal
  ) {
    if (!artifactId.trim() || artifactId.length > 512)
      throw new AosClientError("proxy-failure", "Invalid artifact reference")
    return this.#readBlob(
      this.#sessionPath(
        threadId,
        `/artifacts/${encodeURIComponent(artifactId)}`
      ),
      { signal },
      // A published artifact the provider has since pruned is gone for good.
      "artifact-missing"
    )
  }

  async transcribe(threadId: string, audio: Blob, signal?: AbortSignal) {
    return this.transcribeForAgent(this.#owner(threadId), audio, signal)
  }

  async transcribeForAgent(agentId: string, audio: Blob, signal?: AbortSignal) {
    if (!audio.size || !audio.type)
      throw new AosClientError("proxy-failure", "Invalid audio recording")
    const request = SessionTranscriptionRequestSchema.safeParse({
      dataUrl: await dataUrl(audio),
      mimeType: audio.type,
    })
    if (!request.success)
      throw new AosClientError("proxy-failure", "Invalid audio recording")
    const path = `/agents/${encodeURIComponent(agentId)}/audio/transcribe`
    const response = await this.#read(
      path,
      SessionTranscriptionResponseSchema,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      }
    )
    return response.transcript
  }

  async speak(threadId: string, text: string, signal?: AbortSignal) {
    return this.speakForAgent(this.#owner(threadId), text, signal)
  }

  async speakForAgent(agentId: string, text: string, signal?: AbortSignal) {
    const request = SessionSpeechRequestSchema.safeParse({ text })
    if (!request.success)
      throw new AosClientError("proxy-failure", "Invalid speech input")
    const path = `/agents/${encodeURIComponent(agentId)}/audio/speak`
    return this.#readBlob(path, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
    })
  }

  #sessionPath(threadId: string, suffix: string) {
    const agentId = this.#owner(threadId)
    return `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}${suffix}`
  }

  async #readBlob(
    path: string,
    init?: RequestInit,
    /** How this route reads an absent resource; 503 always stays an outage. */
    notFound: AosClientFailure = "proxy-failure"
  ) {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set("accept", "application/octet-stream")
      if (this.#authorization) headers.set("authorization", this.#authorization)
      response = await this.#fetch(`${this.#basePath}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      })
    } catch {
      throw new AosClientError("connection-interrupted")
    }
    if (!response.ok) {
      const error = await normalizedError(response)
      throw new AosClientError(
        response.status === 503
          ? "provider-unavailable"
          : response.status === 404
            ? notFound
            : "proxy-failure",
        error?.description
      )
    }
    const contentType = response.headers.get("content-type")
    if (!contentType || /[\r\n]/u.test(contentType))
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    try {
      return await response.blob()
    } catch {
      throw new AosClientError("proxy-failure", "Invalid AOS proxy response")
    }
  }

  #owner(threadId: string) {
    const owner = this.#sessionOwners.get(threadId)
    if (!owner) throw new Error("Session ownership is unknown")
    return owner
  }
}
