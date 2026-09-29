/**
 * The wire contract every runtime meets: what a plain ACP v2 client reads
 * from the proxy over its WebSocket, proven over each adapter's own native
 * fake. An adapter's `wire-contract.test.ts` calls `runWireContract` with the
 * runtime it composes; the real proxy is built around it by
 * `createConfiguredProxy`, and the SDK's own client reaches its ACP services
 * through `acpBridge`, the calls the network listener makes. A row the runtime
 * cannot express is named in `gaps` with its reason and listed as skipped.
 *
 * The client is plain: it sends no `_meta` of its own, registers no `_aos/*`
 * handler, and reads standard fields only. Only its Session setup names the
 * Agent in `_meta.aos.agentId`. A case that tests an extra on purpose uses an
 * extras client, and a case no runtime changes runs in
 * `runWireListenerContract`, over one runtime.
 *
 * Test-only: the architecture guard keeps production code from importing it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  client,
  methods,
  RequestError,
  SessionConfigOption,
  SessionUpdate,
  type AnyWireMessage,
  type ContentBlock,
} from "@agentclientprotocol/sdk/experimental/v2"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  acpBridge,
  type BridgedAcpService,
} from "../../../test/support/acp-bridge-socket"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import {
  AOS_ACP_GUEST_PATH,
  AOS_ACP_OPERATOR_PATH,
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
} from "../../protocol/acp"
import type { RuntimeFactory } from "../adapters/create-runtime"
import { createConfiguredProxy } from "../composition"
import { stubUnreachableTransports, until } from "../core/runtime-contract"
import { CredentialValues } from "../redaction"

/** The contract's rows, each named for the rule it protects. */
export type WireContractRow =
  | "promptAnswerCarriesMessageId"
  | "onlyAdvertisedContentIn"
  | "promptAnsweredAtStorage"
  | "sameIdsLiveAndAfterReload"
  | "historyAndLiveJoinedById"
  | "oneTurnThroughQuestion"
  | "stopMidStreamAndInQuestion"
  | "withdrawnQuestion"
  | "heldAndLostQuestions"
  | "questionsDuringOwnTurn"
  | "reloadMidTurn"
  | "catchUpWithStandardUpdates"
  | "questionsOnlyToCapableClients"
  | "failedSendEndsWait"
  | "choiceOnlyQuestion"
  | "diffAddedWithGitPatchOrNone"
  | "costInUsageUpdate"
  | "unsavedSessionUndated"
  | "thoughtLevelDefault"
  | "everyThoughtAndCallLive"
  | "quietStreamPassedThrough"

/**
 * The native side of the turn a row prompted, played and stored as the
 * runtime's release does. Every turn the rows play has these two model
 * responses. A Session that played one has cost 0.42 USD, where the runtime
 * reports cost.
 */
export type WireTurn = Readonly<{
  /**
   * The thought "I should read the file.", the text "Reading the file." and
   * a `read_file` call on `/tmp/demo.txt` that completes, all stored.
   */
  firstResponse(): Promise<void>
  /** The text "The file lists three names." or `text`, stored; the turn ends. */
  secondResponse(text?: string): Promise<void>
  /**
   * In place of the first response: a call that creates `/tmp/notes.txt`
   * holding "alpha", then one that changes the line "alpha" of the existing
   * `/tmp/names.txt` to "beta" and reports the edit's patch, each completed
   * and stored. Absent when its row is a gap.
   */
  editFile?(): Promise<void>
  /**
   * The runtime's own setting for a quieter live stream: from here on it
   * streams no `read_file` call of the first response, yet still stores it.
   * Absent when its row is a gap.
   */
  quiet?(): Promise<void>
  /** Absent only when every row that asks a question is a gap. */
  questions?: WireQuestions
}>

/** The questions a running turn asks, and its Stop, as the release has them. */
export type WireQuestions = Readonly<{
  /**
   * Asks "Proceed?" with the choices "yes" and "no", taking no other answer
   * where the runtime can ask so, inside the running turn; settles once the
   * runtime holds an answer or stopped waiting for one.
   */
  ask(): Promise<void>
  /** The runtime withdraws the open question; its turn runs on. */
  withdraw(): Promise<void>
  /** Settles at the next interrupt the runtime receives. */
  interrupted(): Promise<void>
  /** The runtime confirms the interrupt: its turn ends interrupted. */
  confirmInterrupt(): Promise<void>
  /**
   * Each asks one prompt the proxy holds back, and resolves with a value the
   * prompt carries that must never reach a client.
   */
  held: Readonly<Record<string, () => Promise<string>>>
  /**
   * The Session already waits on a question no proxy can present again, as
   * after a proxy restart.
   */
  lose(): Promise<void>
}>

/** The runtime one adapter's fake stands behind. */
export type WireRuntime = Readonly<{
  /** The deployment's `runtime` block; its secret files are never read. */
  config: Readonly<Record<string, unknown>>
  /** Builds the real adapter over the fake, as `createRuntimeInstance` would. */
  runtimeFactory: RuntimeFactory
  /** An Agent the fake holds. */
  agentId: string
  /** Absent only when every row that plays a turn is a gap. */
  turn?: WireTurn
}>

export type WireContractOptions = {
  /** Rows skipped, each with why the runtime cannot express it. */
  gaps?: Partial<Record<WireContractRow, string>>
}

const OPERATOR_ORIGIN = "https://aos.example.test"
const GUEST_ORIGIN = "https://guest.example.test"

type Clock = ReturnType<typeof useFakeClock>
type Proxy = Awaited<ReturnType<typeof createConfiguredProxy>>
/** The bounds one subscriber's stream and replay keep. */
type SubscriberLimits = { subscriberEvents: number; subscriberBytes: number }

const SUBSCRIBER_LIMITS: SubscriberLimits = {
  subscriberEvents: 512,
  subscriberBytes: 2_097_152,
}

/** What one case holds: the proxy, the Agent, and whatever it opened. */
type WireHarness = Readonly<{
  proxy: Proxy
  agentId: string
  turn: WireTurn
  clock: Clock
  /** Connects a client to `service`, closed with the case. */
  connect(
    service: BridgedAcpService,
    origin: string,
    path: string,
    options?: ClientOptions
  ): ReturnType<typeof connectClient>
}>

type ClientOptions = {
  /** Whether the client declares it answers form elicitations; it does. */
  elicits?: boolean
}

/**
 * The real proxy over `runtime`, an operator and a guest listener, with its
 * invitation key written to a private directory as a deployment keeps it.
 * Awaited directly, not on the fake clock: composing reads that key from
 * disk, and real I/O takes no fixed count of clock steps.
 */
async function composeProxy(runtime: WireRuntime, limits: SubscriberLimits) {
  const directory = await mkdtemp(join(tmpdir(), "aos-wire-contract-"))
  const invitationKey = join(directory, "invitation-key")
  await writeFile(
    invitationKey,
    `${Buffer.alloc(32, 7).toString("base64url")}\n`,
    { mode: 0o600 }
  )
  const release = () => rm(directory, { recursive: true })
  try {
    const proxy = await createConfiguredProxy(
      {
        version: 1,
        deploymentId: "wire-contract",
        listen: { host: "127.0.0.1", port: 4100 },
        publicOrigin: OPERATOR_ORIGIN,
        runtime: runtime.config,
        limits: {
          activeExecutions: 256,
          guestActiveExecutions: 32,
          operatorEventPeers: 256,
          ...limits,
        },
        guest: {
          listen: { host: "127.0.0.1", port: 4101 },
          publicOrigin: GUEST_ORIGIN,
          invitations: {
            keys: [{ id: "guest-current", secretFile: invitationKey }],
            clockSkewSeconds: 0,
          },
        },
        shutdownGraceMs: 5_000,
      },
      {
        runtimeFactory: runtime.runtimeFactory,
        logger: captureLogs().logger,
        credentials: new CredentialValues(),
      }
    )
    return { proxy, release }
  } catch (error) {
    await release()
    throw error
  }
}

/** The SDK's own client on `service`, over the WebSocket stream it builds. */
function connectClient(
  service: BridgedAcpService,
  origin: string,
  path: string,
  { elicits = true }: ClientOptions = {}
) {
  const bridge = acpBridge(service)
  const updates: SessionUpdate[] = []
  const timeline: TimelineEntry[] = []
  const updateWaiters = new Set<(update: SessionUpdate) => void>()
  const askWaiters = new Set<(ask: WireAsk) => void>()
  /** Holds one request open until the case answers it or the proxy withdraws it. */
  function hold<T>(signal: AbortSignal, params: unknown, reply: T) {
    timeline.push("asked")
    return new Promise<T>((resolve, reject) => {
      const ask: WireAsk = {
        params,
        withdrawn: new Promise((settle) =>
          signal.addEventListener("abort", () => settle(), { once: true })
        ),
        answer: () => resolve(reply),
        fail: () => reject(RequestError.internalError()),
      }
      signal.addEventListener("abort", () => reject(new Error("withdrawn")), {
        once: true,
      })
      for (const settle of askWaiters) settle(ask)
    })
  }
  const app = client({ name: "wire-contract" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      timeline.push(params.update)
      for (const settle of updateWaiters) settle(params.update)
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
      hold(signal, params, {
        outcome: {
          outcome: "selected" as const,
          optionId: params.options[0]!.optionId,
        },
      })
    )
    .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
      hold(signal, params, {
        action: "accept" as const,
        content: { q0: "yes" },
      })
    )
  const connection = app.connect(
    createWebSocketStream<AnyWireMessage>(
      `wss://${new URL(origin).host}${path}`,
      {
        WebSocket: bridge.WebSocket,
        headers: { Origin: origin },
      }
    )
  )
  /** Settles with the next update `matches` accepts. */
  const next = <T extends SessionUpdate>(
    matches: (update: SessionUpdate) => update is T
  ) =>
    new Promise<T>((resolve) => {
      const settle = (update: SessionUpdate) => {
        if (!matches(update)) return
        updateWaiters.delete(settle)
        resolve(update)
      }
      updateWaiters.add(settle)
    })
  /** Settles at the next update that says a turn is in `state`. */
  const nextState = async (state: string) => {
    await next(
      (update): update is SessionUpdate =>
        SessionUpdate.isStateUpdate(update) && update.state === state
    )
  }
  return {
    connection,
    bridge,
    /** Every `session/update` this client read, in order. */
    updates,
    /** Every update, request and marked answer this client read, in order. */
    timeline,
    /** Marks the answer to a request, where the client read it. */
    answered: () => {
      timeline.push("answer")
    },
    next,
    nextState,
    /** Settles at the next update that says a turn went idle. */
    nextIdle: () => nextState("idle"),
    /** Settles at the next question or permission request. */
    nextAsked: () =>
      new Promise<WireAsk>((resolve) => {
        const settle = (ask: WireAsk) => {
          askWaiters.delete(settle)
          resolve(ask)
        }
        askWaiters.add(settle)
      }),
    cancel: (sessionId: string) =>
      connection.agent.notify(methods.agent.session.cancel, { sessionId }),
    initialize: () =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "wire-contract", version: "1.0.0" },
        capabilities: elicits ? { elicitation: { form: {} } } : {},
      }),
  }
}

/**
 * One thing a client read: an update, a request the proxy `asked` it, or the
 * `answer` to a request the case marked.
 */
type TimelineEntry = SessionUpdate | "asked" | "answer"

/** One request the proxy sent this client, held open until answered. */
type WireAsk = Readonly<{
  /** The request's params, as the client read them. */
  params: unknown
  /** Settles once the proxy withdraws the request with `$/cancel_request`. */
  withdrawn: Promise<void>
  /** Answers "yes", or allows with the first option offered. */
  answer(): void
  /** Answers with an error, as a client that could not show it does. */
  fail(): void
}>

type WireClient = ReturnType<typeof connectClient>

/** A Session on `agentId`, created as the plain client's one setup step. */
async function newSession({ connection }: WireClient, agentId: string) {
  const { sessionId } = await connection.agent.request(
    methods.agent.session.new,
    { cwd: "/", _meta: { [AOS_META_KEY]: { agentId } } }
  )
  return sessionId
}

/** `sessionId` joined on a fresh connection, its history read from the start. */
function resumeFromStart(
  { connection }: WireClient,
  sessionId: string,
  agentId: string
) {
  return connection.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/",
    replayFrom: { type: "start" },
    _meta: { [AOS_META_KEY]: { agentId } },
  })
}

/** Prompts `text` and plays the turn's two responses until it goes idle. */
async function playTurn(
  clock: Clock,
  plain: WireClient,
  sessionId: string,
  turn: WireTurn,
  text: string
) {
  const idle = plain.nextIdle()
  await until(clock, prompt(plain, sessionId, text))
  await until(clock, turn.firstResponse())
  await until(clock, turn.secondResponse())
  await until(clock, idle)
}

function prompt({ connection }: WireClient, sessionId: string, text: string) {
  return connection.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
  })
}

/** A plain operator client, and one new Session it made on the Agent. */
async function operatorSession({
  proxy,
  agentId,
  clock,
  connect,
}: WireHarness) {
  const plain = connect(
    proxy.acpService,
    OPERATOR_ORIGIN,
    AOS_ACP_OPERATOR_PATH
  )
  await until(clock, plain.initialize())
  const sessionId = await until(clock, newSession(plain, agentId))
  return { plain, sessionId }
}

/**
 * The runtime asks its question; resolves once `plain` holds it, with what
 * settles once the runtime holds an answer.
 */
async function askQuestion(
  clock: Clock,
  plain: WireClient,
  questions: WireQuestions
) {
  const asked = plain.nextAsked()
  const settled = questions.ask()
  return { ask: await until(clock, asked), settled }
}

/**
 * Stops the running turn, and returns the state `plain` read once the runtime
 * was interrupted and once it confirmed.
 */
async function stopTurn(
  clock: Clock,
  plain: WireClient,
  sessionId: string,
  questions: WireQuestions
) {
  const interrupted = questions.interrupted()
  const idle = plain.nextIdle()
  await until(clock, plain.cancel(sessionId))
  await until(clock, interrupted)
  const beforeConfirmation = states(plain.updates).at(-1)
  await until(clock, questions.confirmInterrupt())
  await until(clock, idle)
  return { beforeConfirmation, after: states(plain.updates).at(-1) }
}

/** A content block as the text a reader shows, or its type. */
function blockText(block: ContentBlock) {
  return block.type === "text" ? block.text : block.type
}

/**
 * The Agent's side as a plain reader sees it in standard fields: each message
 * in order with its kind and text, and each tool call's final status. An
 * `agent_message` or `agent_thought` replaces its message's content; a chunk
 * extends it.
 */
function agentSide(updates: readonly SessionUpdate[]) {
  const messages = new Map<string, { kind: string; text: string }>()
  const calls: Record<string, string> = {}
  for (const update of updates) {
    if (
      SessionUpdate.isAgentMessage(update) ||
      SessionUpdate.isAgentThought(update)
    ) {
      const kind = update.sessionUpdate
      const text = (update.content ?? []).map(blockText).join("")
      const message = messages.get(update.messageId)
      if (message) Object.assign(message, { kind, text })
      else messages.set(update.messageId, { kind, text })
    }
    if (
      SessionUpdate.isAgentMessageChunk(update) ||
      SessionUpdate.isAgentThoughtChunk(update)
    ) {
      const id = update.messageId ?? "(no id)"
      const message = messages.get(id) ?? {
        kind: update.sessionUpdate.replace(/_chunk$/u, ""),
        text: "",
      }
      message.text += blockText(update.content)
      messages.set(id, message)
    }
    if (SessionUpdate.isToolCallUpdate(update) && update.status)
      calls[update.toolCallId] = update.status
  }
  return {
    messages: [...messages].map(([id, message]) => ({ id, ...message })),
    calls,
  }
}

/**
 * Each user message a plain reader holds, by id and text: a `user_message`
 * replaces the message its id names.
 */
function userSide(updates: readonly SessionUpdate[]) {
  const messages = new Map<string, string>()
  for (const update of updates)
    if (SessionUpdate.isUserMessage(update))
      messages.set(
        update.messageId,
        (update.content ?? []).map(blockText).join("")
      )
  return [...messages].map(([id, text]) => ({ id, text }))
}

/**
 * Each tool call a plain reader holds, by id: its last status and its
 * content, which `tool_call_update` replaces and a content chunk extends.
 */
function toolCalls(updates: readonly SessionUpdate[]) {
  const calls: Record<string, { status?: string; content: unknown[] }> = {}
  for (const update of updates) {
    if (
      !SessionUpdate.isToolCallUpdate(update) &&
      !SessionUpdate.isToolCallContentChunk(update)
    )
      continue
    const call = (calls[update.toolCallId] ??= { content: [] })
    if (SessionUpdate.isToolCallContentChunk(update)) {
      call.content.push(update.content)
      continue
    }
    if (update.status) call.status = update.status
    if (update.content) call.content = [...update.content]
  }
  return calls
}

/**
 * The order a reader read a reload in: the conversation, each state, each
 * request and the answer, a run of conversation read as one step.
 */
function reloadOrder(timeline: readonly TimelineEntry[]) {
  const order: string[] = []
  for (const entry of timeline) {
    const step =
      typeof entry === "string"
        ? entry
        : SessionUpdate.isStateUpdate(entry)
          ? `state:${entry.state}`
          : SessionUpdate.isUserMessage(entry) ||
              SessionUpdate.isAgentMessageChunk(entry) ||
              SessionUpdate.isAgentThoughtChunk(entry) ||
              SessionUpdate.isToolCallUpdate(entry) ||
              SessionUpdate.isToolCallContentChunk(entry)
            ? "conversation"
            : undefined
    if (step !== undefined && order.at(-1) !== step) order.push(step)
  }
  return order
}

/** Each turn state a plain reader read, an idle one with its stop reason. */
function states(updates: readonly SessionUpdate[]) {
  return updates.flatMap((update) =>
    SessionUpdate.isStateUpdate(update)
      ? [update.state === "idle" ? `idle:${update.stopReason}` : update.state]
      : []
  )
}

/** What every turn the rows play reads as, ids aside. */
const PLAYED_TURN = [
  { kind: "agent_thought", text: "I should read the file." },
  { kind: "agent_message", text: "Reading the file." },
  { kind: "agent_message", text: "The file lists three names." },
]

/** One model response longer than the bound the catch-up row sets. */
const LONG_RESPONSE = "The file lists three names. ".repeat(64).trim()

/** Bounds one `LONG_RESPONSE` delta overflows, stream and replay alike. */
const TIGHT_LIMITS: SubscriberLimits = {
  subscriberEvents: 512,
  subscriberBytes: 1_024,
}

/** The AOS-only methods a client read that name a view to rebuild. */
function rebuildNotices(client: WireClient) {
  return client.bridge.sockets().flatMap(({ frames }) =>
    frames.flatMap((raw) => {
      const { method } = JSON.parse(raw) as { method?: string }
      return method === "_aos/session_invalidated" ||
        method === "_aos/steer_accepted"
        ? [method]
        : []
    })
  )
}

/** The values each field of an elicitation's form takes, when it limits them. */
function formChoices(params: unknown) {
  type Field = { enum?: string[]; oneOf?: Array<{ const: string }> }
  const { requestedSchema } = params as {
    requestedSchema?: { properties?: Record<string, Field> }
  }
  return Object.values(requestedSchema?.properties ?? {}).map(
    (field) => field.enum ?? field.oneOf?.map(({ const: value }) => value)
  )
}

/** Each diff a reader holds, in call order, with its patch where it has one. */
function fileDiffs(updates: readonly SessionUpdate[]) {
  return Object.values(toolCalls(updates)).flatMap(({ content }) =>
    content.flatMap((block) =>
      (block as { type?: string }).type === "diff"
        ? [block as { changes: unknown[]; patch?: unknown }]
        : []
    )
  )
}

/** A patch `git apply` takes: its file headers, then a hunk. */
const GIT_PATCH = {
  format: "git_patch",
  text: expect.stringMatching(
    /^(?:diff --git .+\n)?--- (?:a\/|\/dev\/null).*\n\+\+\+ (?:b\/|\/dev\/null).*\n@@ /u
  ),
}

/** A fake with no turn driver fails the row that plays one, never skips it. */
const NO_TURN: WireTurn = {
  firstResponse: () =>
    Promise.reject(new Error("this fake plays no turn; name the row a gap")),
  secondResponse: () =>
    Promise.reject(new Error("this fake plays no turn; name the row a gap")),
}

/** A fake that asks nothing fails the row that asks, never skips it. */
function questionsOf(turn: WireTurn): WireQuestions {
  if (turn.questions) return turn.questions
  const none = () =>
    Promise.reject(new Error("this fake asks no question; name the row a gap"))
  return {
    ask: none,
    withdraw: none,
    interrupted: none,
    confirmInterrupt: none,
    held: {},
    lose: none,
  }
}

/** One case over a freshly composed proxy, closing all it opened. */
function wireCase(
  createRuntime: () => WireRuntime,
  body: (harness: WireHarness) => Promise<void>,
  limits = SUBSCRIBER_LIMITS
) {
  return async () => {
    const clock = useFakeClock()
    const runtime = createRuntime()
    const { proxy, release } = await composeProxy(runtime, limits)
    const clients: WireClient[] = []
    try {
      await body({
        proxy,
        agentId: runtime.agentId,
        turn: runtime.turn ?? NO_TURN,
        clock,
        connect(service, origin, path, options) {
          const opened = connectClient(service, origin, path, options)
          clients.push(opened)
          return opened
        },
      })
    } finally {
      for (const { connection } of clients) connection.close()
      await until(clock, proxy.runtimeInstance.close())
      await release()
    }
  }
}

function withTransportsStubbed(describeBody: () => void) {
  return () => {
    beforeEach(stubUnreachableTransports)
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    describeBody()
  }
}

export function runWireContract(
  name: string,
  createRuntime: () => WireRuntime,
  { gaps = {} }: WireContractOptions = {}
) {
  function row(
    id: WireContractRow,
    title: string,
    body: (harness: WireHarness) => Promise<void>,
    limits?: SubscriberLimits
  ) {
    if (gaps[id] !== undefined) it.skip(`${title} (gap: ${gaps[id]})`)
    else it(title, wireCase(createRuntime, body, limits))
  }

  describe(
    `${name} ACP wire contract`,
    withTransportsStubbed(() => {
      row(
        "promptAnswerCarriesMessageId",
        "answers a prompt with a message id the SDK's own client reads",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))

          const answer = await until(
            clock,
            prompt(plain, sessionId, "list the files")
          )

          expect(answer.messageId).toEqual(expect.any(String))
        }
      )

      row(
        "onlyAdvertisedContentIn",
        "takes a resource link in a prompt, and an image or embedded context exactly where it advertises one",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          const { capabilities } = await until(clock, plain.initialize())
          const advertised = capabilities?.session?.prompt ?? {}
          const blocks = {
            resourceLink: {
              type: "resource_link",
              uri: "file:///tmp/demo.txt",
              name: "demo.txt",
            },
            image: {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
            },
            embeddedContext: {
              type: "resource",
              resource: { uri: "file:///tmp/demo.txt", text: "alpha" },
            },
          } satisfies Record<string, ContentBlock>
          const read: Record<string, unknown> = {}
          for (const [kind, block] of Object.entries(blocks)) {
            // Each on its own Session, so one taken leaves the next unbusied.
            const sessionId = await until(clock, newSession(plain, agentId))
            read[kind] = await until(
              clock,
              plain.connection.agent.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: "text", text: "list the files" }, block],
              })
            ).then(
              ({ messageId }) => typeof messageId === "string",
              (error: { code?: unknown }) => error.code
            )
          }

          // No runtime port takes an image or embedded context in a prompt,
          // so neither is advertised and each is refused.
          const invalidParams = RequestError.invalidParams().code
          expect(read).toEqual({
            resourceLink: true,
            image: invalidParams,
            embeddedContext: invalidParams,
          })
          expect(advertised).not.toHaveProperty("image")
          expect(advertised).not.toHaveProperty("embeddedContext")
        }
      )

      row(
        "promptAnsweredAtStorage",
        "answers a prompt once stored, under the id it was stored as, and refuses one while its turn runs",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))
          const answer = await until(
            clock,
            prompt(plain, sessionId, "list the files")
          )
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          await expect(
            until(clock, prompt(plain, sessionId, "and their sizes"))
          ).rejects.toMatchObject({ code: AOS_JSONRPC_ERRORS.turnInProgress })
          const stored = [{ id: answer.messageId, text: "list the files" }]
          expect(userSide(reader.updates)).toEqual(stored)
          expect(userSide(plain.updates)).toEqual(stored)
        }
      )

      row(
        "sameIdsLiveAndAfterReload",
        "gives each thought and model response its own id, the same after a reload",
        async ({ proxy, agentId, turn, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))
          await playTurn(clock, plain, sessionId, turn, "list the files")
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          const live = agentSide(plain.updates)
          expect(
            live.messages.map(({ kind, text }) => ({ kind, text }))
          ).toEqual(PLAYED_TURN)
          expect(new Set(live.messages.map(({ id }) => id)).size).toBe(
            PLAYED_TURN.length
          )
          expect(Object.values(live.calls)).toEqual(["completed"])
          expect(agentSide(reader.updates)).toEqual(live)
        }
      )

      row(
        "historyAndLiveJoinedById",
        "shows a turn stored just before a resume exactly once beside the live one",
        async ({ proxy, agentId, turn, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))
          await playTurn(clock, plain, sessionId, turn, "list the files")
          // The next turn starts 3 s after the first was stored, inside the
          // window a join by time would mistake for the live turn's own.
          await clock.advance(3_000)
          const idle = plain.nextIdle()
          await until(clock, prompt(plain, sessionId, "and their sizes"))
          await until(clock, turn.firstResponse())
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))
          await until(clock, turn.secondResponse())
          await until(clock, idle)

          const live = agentSide(plain.updates)
          expect(
            live.messages.map(({ kind, text }) => ({ kind, text }))
          ).toEqual([...PLAYED_TURN, ...PLAYED_TURN])
          expect(agentSide(reader.updates)).toEqual(live)
        }
      )

      row(
        "oneTurnThroughQuestion",
        "keeps one turn through a question it asks",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const { plain, sessionId } = await operatorSession(harness)
          const from = plain.updates.length
          const idle = plain.nextIdle()
          await until(clock, prompt(plain, sessionId, "list the files"))
          await until(clock, turn.firstResponse())
          const { ask, settled } = await askQuestion(
            clock,
            plain,
            questionsOf(turn)
          )
          ask.answer()
          await until(clock, settled)
          await until(clock, turn.secondResponse())
          await until(clock, idle)
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          expect(states(plain.updates.slice(from))).toEqual([
            "running",
            "requires_action",
            "running",
            "idle:end_turn",
          ])
          // One turn numbers its responses as one, the same after a reload.
          expect(agentSide(reader.updates)).toEqual(agentSide(plain.updates))
        }
      )

      row(
        "stopMidStreamAndInQuestion",
        "stops a turn mid-stream and during a question once the runtime confirms, then takes the next prompt",
        async (harness) => {
          const { clock, turn } = harness
          const questions = questionsOf(turn)
          const { plain, sessionId } = await operatorSession(harness)
          await until(clock, prompt(plain, sessionId, "list the files"))
          await until(clock, turn.firstResponse())
          const midStream = await stopTurn(clock, plain, sessionId, questions)
          await until(clock, prompt(plain, sessionId, "and their sizes"))
          await askQuestion(clock, plain, questions)
          const inQuestion = await stopTurn(clock, plain, sessionId, questions)

          await expect(
            until(clock, prompt(plain, sessionId, "list the files"))
          ).resolves.toMatchObject({ messageId: expect.any(String) })
          // Stop in a question runs the turn on until the runtime confirms.
          const stopped = {
            beforeConfirmation: "running",
            after: "idle:cancelled",
          }
          expect(midStream).toEqual(stopped)
          expect(inQuestion).toEqual(stopped)
        }
      )

      row(
        "withdrawnQuestion",
        "withdraws a question the runtime stopped waiting on, and runs on",
        async (harness) => {
          const { clock, turn } = harness
          const questions = questionsOf(turn)
          const { plain, sessionId } = await operatorSession(harness)
          const from = plain.updates.length
          await until(clock, prompt(plain, sessionId, "list the files"))
          const { ask, settled } = await askQuestion(clock, plain, questions)
          const running = plain.nextState("running")
          await until(clock, questions.withdraw())
          await until(clock, settled)
          await until(clock, ask.withdrawn)
          await until(clock, running)

          expect(states(plain.updates.slice(from))).toEqual([
            "running",
            "requires_action",
            "running",
          ])
        }
      )

      row(
        "heldAndLostQuestions",
        "reports a question it holds back or lost as waiting, and sends none of its fields",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const questions = questionsOf(turn)
          const { plain, sessionId } = await operatorSession(harness)
          const held: Record<string, string | undefined> = {}
          for (const [name, ask] of Object.entries(questions.held)) {
            await until(clock, prompt(plain, sessionId, "list the files"))
            const waiting = plain.nextState("requires_action")
            const value = await until(clock, ask())
            await until(clock, waiting)
            held[name] = JSON.stringify(plain.updates).includes(value)
              ? "sent"
              : states(plain.updates).at(-1)
            await stopTurn(clock, plain, sessionId, questions)
          }
          const lost = plain.nextState("requires_action")
          await until(clock, questions.lose())
          await until(clock, lost)
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))
          held.lost = states(reader.updates).at(-1)

          expect(Object.keys(held)).not.toHaveLength(0)
          expect(held).toEqual(
            Object.fromEntries(
              Object.keys(held).map((name) => [name, "requires_action"])
            )
          )
        }
      )

      row(
        "questionsDuringOwnTurn",
        "asks a question live during a turn it prompted",
        async (harness) => {
          const { clock, turn } = harness
          const { plain, sessionId } = await operatorSession(harness)
          await until(clock, prompt(plain, sessionId, "list the files"))

          await expect(
            askQuestion(clock, plain, questionsOf(turn))
          ).resolves.toBeTypeOf("object")
        }
      )

      row(
        "reloadMidTurn",
        "rebuilds a turn waiting on a question from history, then its state and question, then answers",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const { plain, sessionId } = await operatorSession(harness)
          await until(clock, prompt(plain, sessionId, "list the files"))
          await until(clock, turn.firstResponse())
          await askQuestion(clock, plain, questionsOf(turn))
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          const asked = reader.nextAsked()
          await until(
            clock,
            resumeFromStart(reader, sessionId, agentId).then(reader.answered)
          )
          await until(clock, asked)

          expect(reloadOrder(reader.timeline)).toEqual([
            "conversation",
            "state:requires_action",
            "asked",
            "answer",
          ])
          expect(userSide(reader.updates)).toEqual(userSide(plain.updates))
          expect(agentSide(reader.updates)).toEqual(agentSide(plain.updates))
          const calls = toolCalls(reader.updates)
          expect(Object.values(calls)).toMatchObject([
            { status: "completed", content: [expect.anything()] },
          ])
          expect(calls).toEqual(toolCalls(plain.updates))
        }
      )

      row(
        "catchUpWithStandardUpdates",
        "rebuilds a view that fell behind or lost its place from history in standard updates, then states the turn",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const { plain, sessionId } = await operatorSession(harness)
          const idle = plain.nextIdle()
          await until(clock, prompt(plain, sessionId, "list the files"))
          await until(clock, turn.firstResponse())
          // One delta past the bound overflows the live stream and the replay.
          await until(clock, turn.secondResponse(LONG_RESPONSE))
          await until(clock, idle)
          // A cursor the replay no longer holds.
          const stale = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, stale.initialize())
          const resumed = await until(
            clock,
            stale.connection.agent.request(methods.agent.session.resume, {
              sessionId,
              cwd: "/",
              _meta: { [AOS_META_KEY]: { agentId, after: 1 } },
            })
          )
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          const stored = agentSide(reader.updates)
          expect(stored.messages.map(({ text }) => text)).toContain(
            LONG_RESPONSE
          )
          expect(agentSide(plain.updates)).toEqual(stored)
          expect(agentSide(stale.updates)).toEqual(stored)
          expect(userSide(stale.updates)).toEqual(userSide(reader.updates))
          for (const client of [plain, stale]) {
            expect(states(client.updates).at(-1)).toMatch(/^idle/u)
            expect(states(client.updates).join()).not.toContain(
              AOS_STOP_REASONS.uncertain
            )
            expect(rebuildNotices(client)).toEqual([])
          }
          expect(resumed._meta?.[AOS_META_KEY]).not.toHaveProperty("resync")
        },
        TIGHT_LIMITS
      )

      row(
        "questionsOnlyToCapableClients",
        "asks a question only of a client that declared it answers one, and shows the rest the wait",
        async ({ proxy, agentId, clock, turn, connect }) => {
          const bare = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH,
            { elicits: false }
          )
          await until(clock, bare.initialize())
          const sessionId = await until(clock, newSession(bare, agentId))
          await until(clock, prompt(bare, sessionId, "list the files"))
          const waiting = bare.nextState("requires_action")
          await until(clock, Promise.race([waiting, questionsOf(turn).ask()]))
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          const asked = reader.nextAsked()
          await until(clock, resumeFromStart(reader, sessionId, agentId))
          await until(clock, asked)

          expect(states(bare.updates).at(-1)).toBe("requires_action")
          expect(bare.timeline).not.toContain("asked")
        }
      )

      row(
        "failedSendEndsWait",
        "ends the wait on a question the client answered with an error, and runs on",
        async (harness) => {
          const { clock, turn } = harness
          const { plain, sessionId } = await operatorSession(harness)
          const from = plain.updates.length
          await until(clock, prompt(plain, sessionId, "list the files"))
          const { ask, settled } = await askQuestion(
            clock,
            plain,
            questionsOf(turn)
          )
          const running = plain.nextState("running")
          ask.fail()
          await until(clock, settled)
          await until(clock, running)

          expect(states(plain.updates.slice(from))).toEqual([
            "running",
            "requires_action",
            "running",
          ])
        }
      )

      row(
        "choiceOnlyQuestion",
        "asks a question that takes only its choices as a list of those choices",
        async (harness) => {
          const { clock, turn } = harness
          const { plain, sessionId } = await operatorSession(harness)
          await until(clock, prompt(plain, sessionId, "list the files"))
          const { ask } = await askQuestion(clock, plain, questionsOf(turn))

          expect(formChoices(ask.params)).toEqual([["yes", "no"]])
        }
      )

      row(
        "diffAddedWithGitPatchOrNone",
        "reports a created file as added with a git patch or none, and an edit's git patch, the same after a reload",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const editFile =
            turn.editFile ??
            (() =>
              Promise.reject(
                new Error("this fake edits no file; name the row a gap")
              ))
          const { plain, sessionId } = await operatorSession(harness)
          const idle = plain.nextIdle()
          await until(clock, prompt(plain, sessionId, "write the notes"))
          await until(clock, editFile())
          await until(clock, turn.secondResponse())
          await until(clock, idle)
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          for (const client of [plain, reader]) {
            const [added, edited, ...rest] = fileDiffs(client.updates)
            expect(rest).toEqual([])
            expect(added?.changes).toEqual([
              { operation: "add", path: "/tmp/notes.txt" },
            ])
            if (added?.patch != null) expect(added.patch).toEqual(GIT_PATCH)
            expect(edited).toMatchObject({
              changes: [{ operation: "modify", path: "/tmp/names.txt" }],
              patch: GIT_PATCH,
            })
          }
        }
      )

      row(
        "costInUsageUpdate",
        "reports the Session's cost in its usage update",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const { plain, sessionId } = await operatorSession(harness)
          await playTurn(clock, plain, sessionId, turn, "list the files")
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          const usage = reader.next(SessionUpdate.isUsageUpdate)
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          await expect(until(clock, usage)).resolves.toMatchObject({
            cost: { amount: 0.42, currency: "USD" },
          })
        }
      )

      row(
        "unsavedSessionUndated",
        "gives a Session its runtime has not stored no title and no date",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))
          // A member joining the Session reads its row.
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          const info = reader.next(SessionUpdate.isSessionInfoUpdate)
          await until(clock, resumeFromStart(reader, sessionId, agentId))
          await until(clock, info)
          const listed = await until(
            clock,
            plain.connection.agent.request(methods.agent.session.list, {
              _meta: { [AOS_META_KEY]: { agentId } },
            })
          )

          const read = [
            ...[plain, reader].flatMap((client) =>
              client.updates.filter(SessionUpdate.isSessionInfoUpdate)
            ),
            ...listed.sessions.filter((row) => row.sessionId === sessionId),
          ].map(({ title, updatedAt }) => ({ title, updatedAt }))
          for (const row of read)
            expect(row).toEqual({ title: undefined, updatedAt: undefined })
        }
      )

      row(
        "thoughtLevelDefault",
        "offers a thought level whose current value is one of its choices, and takes that choice",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const configured = plain.next(SessionUpdate.isConfigOptionUpdate)
          const sessionId = await until(clock, newSession(plain, agentId))
          const { configOptions } = await until(clock, configured)
          const selects = configOptions.filter(SessionConfigOption.isSelect)
          const thought = selects.find(
            ({ category }) => category === "thought_level"
          )
          if (thought) {
            const { configId, currentValue: value } = thought
            await expect(
              until(
                clock,
                plain.connection.agent.request(
                  methods.agent.session.setConfigOption,
                  { sessionId, configId, type: "id", value }
                )
              )
            ).resolves.toMatchObject({
              configOptions: expect.arrayContaining([
                expect.objectContaining({ configId, currentValue: value }),
              ]),
            })
          }

          expect(selects.map(({ category }) => category)).toContain(
            "thought_level"
          )
          for (const option of selects) {
            // A select lists its values flat or in groups.
            const entries: ReadonlyArray<{
              value?: string
              options?: ReadonlyArray<{ value: string }>
            }> = option.options
            const values = entries.flatMap(
              (entry) => entry.options?.map(({ value }) => value) ?? entry.value
            )
            expect(values).toContain(option.currentValue)
          }
        }
      )

      row(
        "everyThoughtAndCallLive",
        "streams every thought and tool call of a response while its turn runs",
        async (harness) => {
          const { clock, turn } = harness
          const { plain, sessionId } = await operatorSession(harness)
          const idle = plain.nextIdle()
          const called = plain.next(
            (update): update is SessionUpdate =>
              SessionUpdate.isToolCallUpdate(update) &&
              update.status === "completed"
          )
          await until(clock, prompt(plain, sessionId, "list the files"))
          await until(clock, turn.firstResponse())
          await until(clock, called)

          const live = agentSide(plain.updates)
          expect(
            live.messages.map(({ kind, text }) => ({ kind, text }))
          ).toEqual(PLAYED_TURN.slice(0, 2))
          expect(Object.values(live.calls)).toEqual(["completed"])
          await until(clock, turn.secondResponse())
          await until(clock, idle)
        }
      )

      row(
        "quietStreamPassedThrough",
        "streams only what the runtime streams, filling in nothing it stored",
        async (harness) => {
          const { proxy, agentId, clock, turn, connect } = harness
          const quiet =
            turn.quiet ??
            (() =>
              Promise.reject(
                new Error("this fake has no quieter stream; name the row a gap")
              ))
          const { plain, sessionId } = await operatorSession(harness)
          await until(clock, quiet())
          await playTurn(clock, plain, sessionId, turn, "list the files")
          const reader = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, reader.initialize())
          await until(clock, resumeFromStart(reader, sessionId, agentId))

          const live = agentSide(plain.updates)
          expect(
            live.messages.map(({ kind, text }) => ({ kind, text }))
          ).toEqual(PLAYED_TURN)
          expect(live.calls).toEqual({})
          // The runtime stored the call it did not stream, so a reload has it.
          expect(Object.values(agentSide(reader.updates).calls)).toEqual([
            "completed",
          ])
        }
      )
    })
  )
}

/**
 * A socket on `service` that writes raw text frames and reads each frame the
 * server sends as JSON, for a case about framing the SDK's client never sends.
 */
async function rawSocket(
  service: BridgedAcpService,
  origin: string,
  path: string
) {
  const bridge = acpBridge(service)
  const socket = new bridge.WebSocket(
    `wss://${new URL(origin).host}${path}`,
    undefined,
    { headers: { Origin: origin } }
  ) as unknown as EventTarget & { send(data: string): void }
  const read: unknown[] = []
  const waiters = new Set<() => void>()
  let closeCode: number | undefined
  const wake = () => {
    for (const settle of [...waiters]) settle()
  }
  socket.addEventListener("message", (event) => {
    read.push(JSON.parse((event as MessageEvent<string>).data))
    wake()
  })
  socket.addEventListener("close", (event) => {
    closeCode = (event as CloseEvent).code
    wake()
  })
  await new Promise((resolve) =>
    socket.addEventListener("open", resolve, { once: true })
  )
  let taken = 0
  return {
    send: (frame: string) => socket.send(frame),
    /** Settles with the next frame read, or the close code if none comes. */
    next: () =>
      new Promise<unknown>((resolve) => {
        const settle = () => {
          if (taken < read.length) {
            waiters.delete(settle)
            resolve(read[taken++])
          } else if (closeCode !== undefined) {
            waiters.delete(settle)
            resolve({ closed: closeCode })
          }
        }
        waiters.add(settle)
        settle()
      }),
  }
}

/** A raw `initialize` asking for `protocolVersion`. */
function rawInitialize(protocolVersion: unknown, id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: methods.agent.initialize,
    params: {
      protocolVersion,
      info: { name: "wire-contract", version: "1.0.0" },
    },
  }
}

/** The cases no runtime changes, run once over one runtime's fake. */
export function runWireListenerContract(
  name: string,
  createRuntime: () => WireRuntime
) {
  describe(
    `${name} ACP listener wire contract`,
    withTransportsStubbed(() => {
      it(
        "answers version 2 to an initialize asking for any version, alone or as a batch's only entry",
        wireCase(createRuntime, async ({ proxy, clock }) => {
          const answers: unknown[] = []
          for (const version of [1, 3])
            for (const batched of [false, true]) {
              const raw = await until(
                clock,
                rawSocket(
                  proxy.acpService,
                  OPERATOR_ORIGIN,
                  AOS_ACP_OPERATOR_PATH
                )
              )
              const frame = rawInitialize(version)
              raw.send(JSON.stringify(batched ? [frame] : frame))
              const answer = await until(clock, raw.next())
              answers.push(batched ? (answer as unknown[])[0] : answer)
            }

          expect(answers).toEqual(
            Array.from({ length: 4 }, () =>
              expect.objectContaining({
                id: 1,
                result: expect.objectContaining({ protocolVersion: 2 }),
              })
            )
          )
        })
      )

      it(
        "answers each malformed frame with the SDK's own error",
        wireCase(createRuntime, async ({ proxy, clock }) => {
          const open = () =>
            until(
              clock,
              rawSocket(
                proxy.acpService,
                OPERATOR_ORIGIN,
                AOS_ACP_OPERATOR_PATH
              )
            )
          const answers: unknown[] = []
          for (const frame of [
            "{not json",
            JSON.stringify({ ...rawInitialize(2), params: null }),
            JSON.stringify({ ...rawInitialize(2), params: [] }),
            JSON.stringify([{ ...rawInitialize(2), params: null }]),
          ]) {
            const raw = await open()
            raw.send(frame)
            answers.push(await until(clock, raw.next()))
          }
          const raw = await open()
          raw.send(JSON.stringify(rawInitialize(2)))
          await until(clock, raw.next())
          raw.send(
            JSON.stringify([
              7,
              {
                jsonrpc: "2.0",
                id: 2,
                method: methods.agent.session.list,
                params: {},
              },
            ])
          )
          answers.push(await until(clock, raw.next()))

          const error = (id: number | null, code: number) =>
            expect.objectContaining({
              id,
              error: expect.objectContaining({ code }),
            })
          expect(answers).toEqual([
            error(null, -32700),
            error(1, -32602),
            error(1, -32602),
            [error(1, -32602)],
            [
              error(null, -32600),
              expect.objectContaining({ id: 2, result: expect.anything() }),
            ],
          ])
        })
      )

      it(
        "refuses an initialize batched with other entries",
        wireCase(createRuntime, async ({ proxy, clock }) => {
          const raw = await until(
            clock,
            rawSocket(proxy.acpService, OPERATOR_ORIGIN, AOS_ACP_OPERATOR_PATH)
          )
          raw.send(
            JSON.stringify([
              rawInitialize(1),
              {
                jsonrpc: "2.0",
                id: 2,
                method: methods.agent.session.list,
                params: {},
              },
            ])
          )

          // The SDK refuses it by closing the socket, answering nothing.
          expect(await until(clock, raw.next())).toEqual({ closed: 1002 })
        })
      )

      it(
        "admits a guest on its own listener once it logs in with an invite",
        wireCase(createRuntime, async ({ proxy, agentId, clock, connect }) => {
          const guest = proxy.guest!
          const extras = connect(
            guest.acpService,
            GUEST_ORIGIN,
            AOS_ACP_GUEST_PATH
          )
          const { token } = await guest.invitations.issue({
            agentId,
            ref: "wire-contract",
          })
          await until(clock, extras.initialize())

          await expect(
            until(
              clock,
              extras.connection.agent.request(methods.agent.auth.login, {
                methodId: AOS_AUTH_METHOD_INVITE,
                _meta: { [AOS_META_KEY]: { token } },
              })
            )
          ).resolves.toBeTypeOf("object")
        })
      )
    })
  )
}
