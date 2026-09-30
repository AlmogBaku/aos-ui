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
import {
  PushInfoSchema,
  PushUnregistrationSchema,
  type PushRegistration,
} from "@aos/protocol/push"
import {
  CallToolResultSchema,
  McpAppFilesSchema,
  McpAppResourceReadRequestSchema,
  McpAppToolCallRequestSchema,
  McpAppViewSchema,
  ReadResourceResultSchema,
  type McpAppFiles,
  type McpAppResourceReadRequest,
  type McpAppToolCallRequest,
} from "@aos/protocol/mcp-apps"

import type { AosStagedAttachment } from "./aos-attachment-adapter"

/**
 * The normalized proxy's REST surface, which carries bytes and deployment
 * metadata only: attachments, artifacts, MCP App views, speech, transcription,
 * and the runtime descriptor. Every conversation, Session, and Agent concern travels over ACP.
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

/** What an MCP App view is opened for: a tool call, or a published Artifact. */
export type McpAppSubject = { toolCallId: string } | { artifactId: string }

export class AosClientError extends Error {
  constructor(
    readonly kind: AosClientFailure,
    message = "AOS proxy request failed",
    readonly code?: string,
    /** The proxy's HTTP status, when it answered. */
    readonly status?: number
  ) {
    super(message)
    this.name = "AosClientError"
  }
}

export type AosRemoteClientOptions = {
  fetcher?: typeof fetch
  basePath?: string
  authorization?: string
  /** What a relative base path resolves against; the page's own by default. */
  origin?: string
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
  readonly #origin?: string
  readonly #sessionOwners = new Map<string, string>()

  constructor(options: AosRemoteClientOptions = {}) {
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#basePath = options.basePath ?? "/api/aos/v1"
    this.#authorization = options.authorization
    this.#origin = options.origin ?? globalThis.location?.origin
  }

  async #read<T>(
    path: string,
    schema: Schema<T>,
    init?: RequestInit,
    /** How this route reads an absent resource; 503 always stays an outage. */
    notFound: AosClientFailure = "proxy-failure"
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
        response.status === 503
          ? "provider-unavailable"
          : response.status === 404
            ? notFound
            : "proxy-failure",
        error?.description,
        error?.code,
        response.status
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

  /** What this deployment offers for alerts while no tab is open. */
  pushInfo(signal?: AbortSignal) {
    return this.#read("/push", PushInfoSchema, { signal })
  }

  /** Registering the same endpoint again is how a preference change travels. */
  async putPushSubscription(registration: PushRegistration) {
    await this.#write("/push/subscriptions", "PUT", registration)
  }

  async deletePushSubscription(endpoint: string) {
    const request = PushUnregistrationSchema.safeParse({ endpoint })
    if (!request.success || !endpoint.trim())
      throw new AosClientError("proxy-failure", "Invalid push subscription")
    await this.#write("/push/subscriptions", "DELETE", request.data)
  }

  /** REST authorizes byte routes per Agent, so every Session names its owner. */
  adoptSessionOwnership(sessionId: string, agentId: string) {
    if (!sessionId || !agentId)
      throw new Error("Invalid Session ownership metadata")
    const current = this.#sessionOwners.get(sessionId)
    if (current && current !== agentId)
      throw new Error("Conflicting Session ownership metadata")
    this.#sessionOwners.set(sessionId, agentId)
  }

  async stageAttachments(
    sessionId: string,
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
      this.#sessionPath(sessionId, "/attachments/stage"),
      SessionAttachmentStageResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      }
    )
  }

  async readArtifact(
    sessionId: string,
    artifactId: string,
    signal?: AbortSignal
  ) {
    if (!artifactId.trim() || artifactId.length > 512)
      throw new AosClientError("proxy-failure", "Invalid artifact reference")
    return this.#readBlob(
      this.#sessionPath(
        sessionId,
        `/artifacts/${encodeURIComponent(artifactId)}`
      ),
      { signal },
      // A published artifact the provider has since pruned is gone for good.
      "artifact-missing"
    )
  }

  /**
   * The App view a flagged tool call renders, or the viewer a published
   * Artifact opens in; the proxy resolves its resource. A published Artifact
   * the provider has since pruned reads as `artifact-missing`, as its bytes do.
   */
  async openMcpApp(
    sessionId: string,
    subject: McpAppSubject,
    signal?: AbortSignal
  ) {
    const view = await this.#read(
      this.#mcpAppPath(sessionId, subject),
      McpAppViewSchema,
      { signal },
      "artifactId" in subject ? "artifact-missing" : "proxy-failure"
    )
    return view.files
      ? { ...view, files: this.#absoluteFiles(view.files) }
      : view
  }

  /** Fresh addresses, each under a new pass, for the files a view reads. */
  async renewMcpAppFiles(sessionId: string, subject: McpAppSubject) {
    return this.#absoluteFiles(
      await this.#read(
        this.#mcpAppPath(sessionId, subject, "/files"),
        McpAppFilesSchema,
        { method: "POST" }
      )
    )
  }

  /** A view fetches from its own opaque origin, so each address is absolute. */
  #absoluteFiles(files: McpAppFiles): McpAppFiles {
    const base = new URL(this.#basePath, this.#origin)
    return {
      ...files,
      addresses: Object.fromEntries(
        Object.entries(files.addresses).map(([name, address]) => [
          name,
          new URL(address, base).href,
        ])
      ),
    }
  }

  /** A tool call the App view makes, answered by the proxy's MCP server. */
  async callMcpAppTool(
    sessionId: string,
    toolCallId: string,
    request: McpAppToolCallRequest
  ) {
    return this.#postMcpApp(
      sessionId,
      { toolCallId },
      "/tools/call",
      McpAppToolCallRequestSchema.safeParse(request),
      CallToolResultSchema
    )
  }

  /** A resource read the App view makes, answered by the proxy's MCP server. */
  async readMcpAppResource(
    sessionId: string,
    subject: McpAppSubject,
    request: McpAppResourceReadRequest
  ) {
    return this.#postMcpApp(
      sessionId,
      subject,
      "/resources/read",
      McpAppResourceReadRequestSchema.safeParse(request),
      ReadResourceResultSchema
    )
  }

  async transcribe(sessionId: string, audio: Blob, signal?: AbortSignal) {
    return this.transcribeForAgent(this.#owner(sessionId), audio, signal)
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

  async speak(sessionId: string, text: string, signal?: AbortSignal) {
    return this.speakForAgent(this.#owner(sessionId), text, signal)
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

  /** A route that answers with no content; only its failure kind matters. */
  async #write(path: string, method: string, body: unknown) {
    let response: Response
    try {
      const headers = new Headers({ "content-type": "application/json" })
      if (this.#authorization) headers.set("authorization", this.#authorization)
      response = await this.#fetch(`${this.#basePath}${path}`, {
        method,
        credentials: "same-origin",
        headers,
        body: JSON.stringify(body),
      })
    } catch {
      throw new AosClientError("connection-interrupted")
    }
    if (!response.ok) {
      const error = await normalizedError(response)
      throw new AosClientError(
        response.status === 503 ? "provider-unavailable" : "proxy-failure",
        error?.description,
        error?.code,
        response.status
      )
    }
  }

  #mcpAppPath(sessionId: string, subject: McpAppSubject, suffix = "") {
    const [collection, id] =
      "toolCallId" in subject
        ? ["tool-calls", subject.toolCallId]
        : ["artifacts", subject.artifactId]
    if (!id.trim() || id.length > 512)
      throw new AosClientError("proxy-failure", "Invalid MCP App reference")
    return this.#sessionPath(
      sessionId,
      `/${collection}/${encodeURIComponent(id)}/app${suffix}`
    )
  }

  async #postMcpApp<T>(
    sessionId: string,
    subject: McpAppSubject,
    suffix: string,
    request: { success: true; data: unknown } | { success: false },
    schema: Schema<T>
  ) {
    if (!request.success)
      throw new AosClientError("proxy-failure", "Invalid MCP App request")
    return this.#read(this.#mcpAppPath(sessionId, subject, suffix), schema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
    })
  }

  #sessionPath(sessionId: string, suffix: string) {
    const agentId = this.#owner(sessionId)
    return `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
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
        error?.description,
        error?.code,
        response.status
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

  #owner(sessionId: string) {
    const owner = this.#sessionOwners.get(sessionId)
    if (!owner) throw new Error("Session ownership is unknown")
    return owner
  }
}
