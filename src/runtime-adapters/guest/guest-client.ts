import { z } from "zod"

import type {
  GuestBootstrap,
  GuestContentPart,
  GuestHistory,
} from "@shared/guest"
import { captureInviteToken } from "@/lib/invite-fragment"

export { captureInviteToken } from "@/lib/invite-fragment"

const capabilitiesSchema = z
  .object({
    attachments: z.boolean(),
    edit: z.boolean(),
    regenerate: z.boolean(),
    branches: z.boolean(),
    questions: z.boolean(),
    transcription: z.boolean(),
    speech: z.boolean(),
  })
  .strict()
const uiSchema = z
  .object({
    lang: z.enum(["en", "he"]).optional(),
    name: z.string().min(1).optional(),
    logoUrl: z.string().min(1).optional(),
    accent: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .strict()
  .optional()
const bootstrapBaseSchema = z.object({
  conversation: z.string().min(1),
  expiresAt: z.number().int().positive(),
  ui: uiSchema,
  capabilities: capabilitiesSchema,
})
const bootstrapSchema = z.discriminatedUnion("state", [
  bootstrapBaseSchema
    .extend({
      state: z.literal("new"),
      prefill: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
  bootstrapBaseSchema.extend({ state: z.literal("existing") }).strict(),
])
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.enum(["image", "file"]),
      url: z.string().startsWith("data:"),
      filename: z.string().optional(),
      mime: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("display"),
      display: z
        .object({
          id: z.string().min(1).max(256),
          kind: z.enum(["chart", "map", "stats", "plan"]),
          payload: z
            .object({
              args: z.record(z.string(), z.json()),
              result: z.json().optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact"),
      artifact: z
        .object({
          id: z.string().min(1).max(256),
          filename: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(255).optional(),
          sizeBytes: z.number().int().nonnegative().optional(),
          source: z.discriminatedUnion("type", [
            z
              .object({
                type: z.literal("provider"),
                reference: z.string().min(1).max(256),
              })
              .strict(),
            z
              .object({
                type: z.literal("inline"),
                encoding: z.literal("base64"),
                data: z.string().min(1),
              })
              .strict(),
          ]),
        })
        .strict(),
    })
    .strict(),
])
const historySchema = z
  .object({
    messages: z.array(
      z
        .object({
          id: z.string().min(1),
          role: z.enum(["user", "assistant"]),
          content: z.array(contentSchema),
          parentId: z.string().min(1).optional(),
        })
        .strict()
    ),
    pendingQuestions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            questions: z
              .array(
                z
                  .object({
                    header: z.string().min(1).max(256),
                    question: z
                      .string()
                      .min(1)
                      .max(8 * 1024),
                    options: z
                      .array(
                        z
                          .object({
                            label: z.string().min(1).max(1024),
                            description: z.string().max(4 * 1024),
                          })
                          .strict()
                      )
                      .max(32),
                    multiple: z.boolean().optional(),
                    custom: z.boolean().optional(),
                  })
                  .strict()
              )
              .min(1)
              .max(16),
          })
          .strict()
      )
      .max(32)
      .default([]),
    running: z.boolean(),
    branches: z
      .record(z.string().min(1), z.array(z.string().min(1)))
      .optional(),
  })
  .strict()

export function parseGuestBootstrap(value: unknown): GuestBootstrap {
  const result = bootstrapSchema.safeParse(value)
  if (!result.success) throw new Error("Invalid guest bootstrap")
  return result.data
}

export async function loadGuestBootstrap(
  fetcher: typeof fetch = fetch,
  token = captureInviteToken()
) {
  const response = await fetcher(
    token ? "/api/guest/redeem" : "/api/guest/bootstrap",
    token
      ? {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }
      : { credentials: "same-origin" }
  )
  return parseGuestBootstrap(await readJson(response))
}

type GuestState = GuestHistory & {
  loading: boolean
  revoked: boolean
  error?: string
  revision: number
}

function isRevocationError(code: string) {
  return (
    code === "invalid-invite" ||
    code.includes("expired") ||
    code.includes("mismatch") ||
    code.includes("conversation-changed")
  )
}

const EMPTY_STATE: GuestState = {
  messages: [],
  pendingQuestions: [],
  running: false,
  loading: true,
  revoked: false,
  revision: 0,
}

async function readJson(response: Response): Promise<unknown> {
  const value = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code =
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : `http_${response.status}`
    throw new Error(code)
  }
  return value
}

export class GuestClient {
  readonly #listeners = new Set<() => void>()
  readonly #fetcher: typeof fetch
  #state = EMPTY_STATE
  #streamAbort?: AbortController

  constructor(
    readonly bootstrap: GuestBootstrap,
    options: { fetcher?: typeof fetch } = {}
  ) {
    const fetcher = options.fetcher ?? fetch
    this.#fetcher = (input, init) => fetcher(input, init)
    if (this.#isExpired()) this.#revoke("expired")
  }

  getSnapshot = () => this.#state
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(next: Omit<GuestState, "revision">) {
    this.#state = { ...next, revision: this.#state.revision + 1 }
    for (const listener of this.#listeners) listener()
  }

  #revoke(error: string) {
    this.#streamAbort?.abort()
    this.#emit({
      ...this.#state,
      running: false,
      loading: false,
      revoked: true,
      error,
    })
  }

  #isExpired() {
    return this.bootstrap.expiresAt * 1_000 <= Date.now()
  }

  async #request(path: string, init: RequestInit = {}) {
    if (this.#state.revoked || this.#isExpired()) {
      this.#revoke("expired")
      throw new Error("expired")
    }
    const headers = new Headers(init.headers)
    headers.set("X-AOS-Conversation", this.bootstrap.conversation)
    const response = await this.#fetcher(path, {
      ...init,
      headers,
      credentials: "same-origin",
    })
    if (!response.ok) {
      let code = `http_${response.status}`
      try {
        const value = (await response.json()) as { error?: unknown }
        if (value.error) code = String(value.error)
      } catch {
        // Status remains an inspectable fallback.
      }
      const revoke =
        response.status === 401 ||
        response.status === 403 ||
        isRevocationError(code)
      if (revoke) {
        this.#revoke(code)
      } else {
        this.#emit({ ...this.#state, loading: false, error: code })
      }
      throw new Error(code)
    }
    return response
  }

  async loadHistory() {
    const parsed = historySchema.safeParse(
      await readJson(await this.#request("/api/guest/history"))
    )
    if (!parsed.success) throw new Error("Invalid guest history")
    this.#emit({ ...parsed.data, loading: false, revoked: false })
  }

  async #mutateAndRefresh(path: string, body: unknown) {
    try {
      await this.#json(path, body)
    } catch (reason) {
      if (reason instanceof Error && reason.message === "uncertain") {
        await this.loadHistory().catch(() => undefined)
        this.#emit({ ...this.#state, revoked: false, error: "uncertain" })
      }
      throw reason
    }
    await this.loadHistory().catch(() => undefined)
  }
  send(content: GuestContentPart[]) {
    return this.#mutateAndRefresh("/api/guest/send", { content })
  }
  stop() {
    return this.#json("/api/guest/stop", {})
  }
  edit(messageId: string, content: GuestContentPart[]) {
    return this.#mutateAndRefresh("/api/guest/edit", { messageId, content })
  }
  regenerate(messageId: string) {
    return this.#mutateAndRefresh("/api/guest/regenerate", { messageId })
  }
  async replyToQuestion(questionId: string, answers: string[][]) {
    await this.#json("/api/guest/question/reply", { questionId, answers })
    await this.loadHistory().catch(() => undefined)
  }
  async rejectQuestion(questionId: string) {
    await this.#json("/api/guest/question/reject", { questionId })
    await this.loadHistory().catch(() => undefined)
  }
  transcribe(recording: Blob, signal: AbortSignal) {
    return this.#request("/api/guest/transcribe", {
      method: "POST",
      body: recording,
      signal,
      headers: { "Content-Type": recording.type || "application/octet-stream" },
    }).then(async (response) => {
      const value = (await response.json()) as { text?: unknown }
      if (typeof value.text !== "string")
        throw new Error("Invalid transcription")
      return value.text
    })
  }
  speech(text: string, signal: AbortSignal) {
    return this.#request("/api/guest/speech", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((response) => response.blob())
  }
  artifact(id: string, signal: AbortSignal) {
    return this.#request(`/api/guest/artifact?id=${encodeURIComponent(id)}`, {
      signal,
      headers: { Accept: "application/octet-stream" },
    }).then((response) => response.blob())
  }

  async #json(path: string, body: unknown) {
    await this.#request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  connect() {
    this.#streamAbort?.abort()
    const abort = new AbortController()
    this.#streamAbort = abort
    void this.#eventLoop(abort.signal)
    return () => abort.abort()
  }

  async #eventLoop(signal: AbortSignal) {
    let retryDelay = 250
    while (!signal.aborted && !this.#state.revoked) {
      try {
        await this.#readEvents(signal)
        retryDelay = 250
      } catch (reason) {
        if (!signal.aborted && !this.#state.revoked)
          this.#emit({
            ...this.#state,
            error: reason instanceof Error ? reason.message : String(reason),
          })
      }
      if (signal.aborted || this.#state.revoked) break
      this.#emit({ ...this.#state, error: "reconnecting" })
      await waitForRetry(signal, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 5_000)
    }
  }

  async #readEvents(signal: AbortSignal) {
    const response = await this.#request(
      `/api/guest/events?conversation=${encodeURIComponent(this.bootstrap.conversation)}`,
      { signal, headers: { Accept: "text/event-stream" } }
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Guest event stream unavailable")
    const decoder = new TextDecoder()
    let buffer = ""
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split("\n\n")
      buffer = events.pop() ?? ""
      for (const event of events) this.#receiveEvent(event)
    }
  }

  #receiveEvent(block: string) {
    let event = "message"
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return
    const value: unknown = JSON.parse(data.join("\n"))
    if (event === "snapshot") {
      const parsed = historySchema.safeParse(value)
      if (parsed.success)
        this.#emit({ ...parsed.data, loading: false, revoked: false })
    } else if (event === "error") {
      const code =
        value && typeof value === "object" && "error" in value
          ? String(value.error)
          : "stream_error"
      if (isRevocationError(code)) this.#revoke(code)
      else this.#emit({ ...this.#state, error: code })
    }
  }
}

function waitForRetry(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, milliseconds)
    function done() {
      window.clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}
