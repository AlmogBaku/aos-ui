import type { OpencodeClient } from "@assistant-ui/react-opencode"

const REQUEST_OPTIONS = { throwOnError: true } as const

/**
 * Small authoritative cache shared by the workspace adapter and the official
 * Assistant UI OpenCode runtime. It keeps Agent ownership provider-owned while
 * ensuring every send (including retry) names that owner explicitly.
 */
export class OpenCodeSessionOwnership {
  readonly #agentIds = new Map<string, string>()
  #reloadBarrierActive = false
  #reloadQueue = Promise.resolve()

  remember(threadId: string, agentId: string) {
    this.#agentIds.set(threadId, agentId)
  }

  forget(threadId: string) {
    this.#agentIds.delete(threadId)
  }

  reconcile(
    entries: readonly (readonly [threadId: string, agentId: string])[]
  ) {
    this.#agentIds.clear()
    for (const [threadId, agentId] of entries) {
      this.#agentIds.set(threadId, agentId)
    }
  }

  assertSendAvailable() {
    if (this.#reloadBarrierActive) {
      throw new Error(
        "OpenCode is reloading Agent configuration; retry this message in a moment"
      )
    }
  }

  /**
   * Serializes directory-instance reloads and blocks only sends made through
   * AOS's scoped client. Other OpenCode clients are deliberately outside
   * this local guarantee.
   */
  async withReloadBarrier<T>(operation: () => Promise<T>): Promise<T> {
    let releaseQueue!: () => void
    const predecessor = this.#reloadQueue
    this.#reloadQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    await predecessor
    this.#reloadBarrierActive = true
    try {
      return await operation()
    } finally {
      this.#reloadBarrierActive = false
      releaseQueue()
    }
  }

  async resolve(client: OpencodeClient, threadId: string) {
    const agentId = await this.find(client, threadId)
    if (!agentId) {
      throw new Error(
        `OpenCode did not confirm Agent ownership for Session ${threadId}`
      )
    }
    return agentId
  }

  async find(client: OpencodeClient, threadId: string) {
    const remembered = this.#agentIds.get(threadId)
    if (remembered) return remembered

    const response = await client.session.get(
      { sessionID: threadId },
      REQUEST_OPTIONS
    )
    const agentId = response.data?.agent
    if (!agentId) return undefined

    this.remember(threadId, agentId)
    return agentId
  }
}

type PromptParameters = Parameters<OpencodeClient["session"]["prompt"]>[0]
type PromptOptions = Parameters<OpencodeClient["session"]["prompt"]>[1]
type PromptAsyncParameters = Parameters<
  OpencodeClient["session"]["promptAsync"]
>[0]
type AbortParameters = Parameters<OpencodeClient["session"]["abort"]>[0]
type RevertParameters = Parameters<OpencodeClient["session"]["revert"]>[0]

type OpenCodeMessageWithParts = {
  info?: { id?: string; role?: string }
  parts?: readonly unknown[]
}
type ReplayablePromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string; filename?: string }

function bindSessionMethod(
  target: OpencodeClient["session"],
  property: PropertyKey
) {
  const value = Reflect.get(target, property, target)
  return typeof value === "function" ? value.bind(target) : value
}

/**
 * OpenCode's reload fallback reverts the originating user message. A revert
 * alone is an undo operation, so recover only prompt input parts accepted by
 * the public prompt endpoint and send them after that undo completes.
 */
function replayablePromptParts(
  messages: readonly OpenCodeMessageWithParts[],
  messageId: string
) {
  const message = messages.find(
    (candidate) =>
      candidate.info?.id === messageId && candidate.info.role === "user"
  )
  if (!message?.parts?.length) return undefined

  const parts: ReplayablePromptPart[] = []
  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue
    const value = part as Record<string, unknown>
    if (value.type === "text" && typeof value.text === "string") {
      parts.push({ type: "text", text: value.text })
      continue
    }
    if (
      value.type === "file" &&
      typeof value.mime === "string" &&
      typeof value.url === "string"
    ) {
      parts.push({
        type: "file",
        mime: value.mime,
        url: value.url,
        ...(typeof value.filename === "string" && { filename: value.filename }),
      })
    }
  }

  return parts.length > 0 ? parts : undefined
}

/**
 * The official adapter remains responsible for controllers, streams, and
 * message state. This proxy injects provider-authoritative ownership into its
 * prompt calls, and completes its reload fallback: OpenCode's `revert` is an
 * undo, so replay the reverted user prompt when the adapter takes that path.
 */
export function createAgentScopedOpenCodeClient({
  client,
  ownership,
}: {
  client: OpencodeClient
  ownership: OpenCodeSessionOwnership
}): OpencodeClient {
  const session = new Proxy(client.session, {
    get(target, property) {
      if (property === "revert") {
        const abort = bindSessionMethod(target, "abort") as (
          parameters: AbortParameters,
          options?: PromptOptions
        ) => Promise<unknown>
        const revert = bindSessionMethod(target, property) as (
          parameters: RevertParameters,
          options?: PromptOptions
        ) => Promise<unknown>
        const messages = bindSessionMethod(target, "messages") as (
          parameters: { sessionID: string },
          options?: PromptOptions
        ) => Promise<{ data?: readonly OpenCodeMessageWithParts[] }>
        const promptAsync = bindSessionMethod(target, "promptAsync") as (
          parameters: PromptAsyncParameters,
          options?: PromptOptions
        ) => Promise<unknown>

        return async (
          parameters: RevertParameters,
          options?: PromptOptions
        ) => {
          ownership.assertSendAvailable()
          let parts: ReturnType<typeof replayablePromptParts>
          if (parameters.messageID) {
            try {
              const response = await messages(
                { sessionID: parameters.sessionID },
                REQUEST_OPTIONS
              )
              parts = replayablePromptParts(
                response.data ?? [],
                parameters.messageID
              )
            } catch {
              // Preserve normal OpenCode revert behavior if history cannot be
              // read. Any subsequent provider failure remains visible through
              // the official adapter's standard error path.
            }
          }

          // Establish that a replay can be issued before stopping the current
          // run or applying OpenCode's destructive undo. OpenCode rejects a
          // revert while the Session is busy, and abort is a no-op once idle.
          // If ownership cannot be resolved, leave the existing run intact and
          // let the adapter expose the failure.
          const agentId = parts
            ? await ownership.resolve(client, parameters.sessionID)
            : undefined
          ownership.assertSendAvailable()
          await abort({ sessionID: parameters.sessionID }, options)
          await revert(parameters, options)
          if (!parts || !agentId) return

          await promptAsync(
            {
              sessionID: parameters.sessionID,
              parts: parts as PromptAsyncParameters["parts"],
              agent: agentId,
            },
            options
          )
        }
      }

      if (property !== "prompt" && property !== "promptAsync") {
        return bindSessionMethod(target, property)
      }

      const send = bindSessionMethod(target, property) as (
        parameters: PromptParameters,
        options?: PromptOptions
      ) => unknown
      return async (parameters: PromptParameters, options?: PromptOptions) => {
        ownership.assertSendAvailable()
        const agentId = await ownership.resolve(client, parameters.sessionID)
        ownership.assertSendAvailable()
        return send({ ...parameters, agent: agentId }, options)
      }
    },
  })

  return new Proxy(client, {
    get(target, property) {
      if (property === "session") return session
      return Reflect.get(target, property, target)
    },
  }) as OpencodeClient
}
