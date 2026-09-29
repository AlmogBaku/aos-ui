/**
 * fakeOpenClaw — one in-memory OpenClaw Gateway holding one Agent and one
 * Session, for the runtime and wire contracts: the calls a create, a turn and
 * a read reach, the events a run streams, and the faults the runtime contract
 * drives. It stands in for the official Gateway client under the real
 * `OpenClawClient`, built by `fakeOpenClawClient`, so the client's own link,
 * deadlines and error mapping are what the contracts prove.
 *
 * It copies the OpenClaw v2026.9.4 Gateway protocol
 * (`@openclaw/gateway-protocol` 2026.9.4), for an operator device holding the
 * admin scope.
 *
 * Usage:
 *
 *   const openclaw = fakeOpenClaw()
 *   const client = fakeOpenClawClient(openclaw)
 *   composeOpenClawRuntime({ ...client, baseUrl, logger })
 *   await client.start()
 *   openclaw.progress() // stream a reply fragment into the running turn
 *
 * The official client marks every Gateway answer it builds, so a test over
 * this fake mocks `@openclaw/gateway-client` with `gatewayClientMock`.
 */
import { GatewayClientRequestError } from "@openclaw/gateway-client"
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol"

import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import {
  OpenClawClient,
  type OpenClawClientOptions,
  type OpenClawGatewayClient,
  type OpenClawGatewayClientOptions,
  type OpenClawRequestOptions,
} from "../client"

const AGENT_ID = "research"
/** The folder `agents.list` names for the Agent, as the release resolves it. */
export const AGENT_WORKSPACE = "/srv/openclaw/research"
const SESSION_KEY = "agent:research:main"
const LOST_CLOSE_CODE = 1006

type Fault = "none" | "native" | "refused" | "down"

/** One dialed official client: its options, and whether it is up. */
type Connection = {
  readonly options: OpenClawGatewayClientOptions
  up: boolean
  stopped: boolean
}

/**
 * The real client over `openclaw`, as every contract composes it: synthetic
 * device credentials, a client factory, and the start that brings its link up
 * as the proxy's first catalog read does.
 */
export function fakeOpenClawClient(openclaw: FakeOpenClaw) {
  let client: OpenClawClient | undefined
  return {
    credentials: async () => ({
      deviceIdentity: {
        deviceId: "device-test",
        privateKeyPem: "test-private-key",
        publicKeyPem: "test-public-key",
      },
      deviceToken: "test-token",
      signDevicePayload: () => "test-signature",
      publicKeyRawBase64UrlFromPem: () => "test-public-key-raw",
    }),
    clientFactory: (options: OpenClawClientOptions) =>
      (client = new OpenClawClient({
        ...options,
        createGatewayClient: openclaw.createGatewayClient,
      })),
    start: () => client!.start(),
  }
}

export type FakeOpenClaw = ReturnType<typeof fakeOpenClaw>

export function fakeOpenClaw() {
  let connection: Connection | undefined
  let fault: Fault = "none"
  let failure: Error | undefined
  let deleted = false
  let calls = 0
  let seq = 0
  let run: { id: string; seq: number } | undefined
  /** The rows the Session stored, as `chat.history` reads them back. */
  const transcript: Record<string, unknown>[] = []
  /** The approval the running turn blocks on, and what settles its wait. */
  let open:
    { approval: Record<string, unknown>; settle: () => void } | undefined
  let nextApproval = 1
  let interrupted: (() => void) | undefined

  function hello(dialed: Connection) {
    if (dialed.stopped || dialed.up || connection !== dialed) return
    if (fault === "down") return
    if (fault === "refused") {
      dialed.options.onConnectError?.(
        new GatewayClientRequestError({
          details: { code: "AUTH_UNAUTHORIZED" },
        })
      )
      return
    }
    dialed.up = true
    dialed.options.onHelloOk?.({ protocol: PROTOCOL_VERSION } as never)
  }

  /** Ends the live connection the way a dropped socket does. */
  function drop() {
    const dropped = connection
    if (!dropped?.up) return
    dropped.up = false
    dropped.options.onClose?.(LOST_CLOSE_CODE, "lost", {
      phase: "post-hello",
    } as never)
  }

  function emit(event: string, payload: Record<string, unknown>) {
    if (!run || !connection?.up) return
    seq += 1
    connection.options.onEvent?.({
      type: "event",
      event,
      seq,
      payload: {
        runId: run.id,
        sessionKey: SESSION_KEY,
        agentId: AGENT_ID,
        ...payload,
      },
    })
  }

  function agentEvent(stream: string, data: Record<string, unknown>) {
    if (!run) return
    emit("agent", { seq: run.seq++, stream, ts: 1_000 + seq, data })
  }

  /**
   * A `session.approval` transition, as the release pushes it to a Session's
   * audience: its payload names the Session and the approval, no run.
   */
  function emitApproval(
    phase: "pending" | "terminal",
    approval: Record<string, unknown>
  ) {
    if (!connection?.up) return
    seq += 1
    connection.options.onEvent?.({
      type: "event",
      event: "session.approval",
      seq,
      payload: {
        sessionKey: SESSION_KEY,
        ...(phase === "pending" ? { sourceSessionKey: SESSION_KEY } : {}),
        updatedAtMs: Date.now(),
        phase,
        approval,
      },
    })
  }

  /** The open approval ends as `terminal` records it; the run goes on. */
  function endApproval(terminal: Record<string, unknown>) {
    if (!open) return undefined
    const { approval, settle } = open
    open = undefined
    // A terminal snapshot drops the pending projection's `sourceSessionKey`.
    const common: Record<string, unknown> = { ...approval }
    delete common.sourceSessionKey
    delete common.status
    const ended = {
      ...common,
      resolvedAtMs: Date.now(),
      source: { agentId: AGENT_ID, sessionKey: SESSION_KEY },
      ...terminal,
    }
    emitApproval("terminal", ended)
    settle()
    return ended
  }

  /** The run ends; its last model response is stored as a transcript row. */
  function complete(text: string) {
    agentEvent("lifecycle", { phase: "end" })
    emit("chat", { seq: 0, state: "final" })
    transcript.push({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      __openclaw: {
        id: `msg-${transcript.length + 1}`,
        seq: transcript.length + 1,
      },
    })
    run = undefined
  }

  function answer(
    method: string,
    params: Record<string, unknown>,
    options: OpenClawRequestOptions | undefined
  ): unknown {
    switch (method) {
      case "agents.list":
        return {
          defaultId: AGENT_ID,
          mainKey: "main",
          scope: "global",
          agents: [
            {
              id: AGENT_ID,
              name: "Research",
              kind: "agent",
              workspace: AGENT_WORKSPACE,
            },
          ],
        }
      case "sessions.list":
        return {
          sessions: deleted
            ? []
            : [
                {
                  key: SESSION_KEY,
                  agentId: AGENT_ID,
                  // `SessionRowSchema` carries the usage the gateway recorded.
                  totalTokens: 1_200,
                  contextTokens: 200_000,
                  estimatedCostUsd: 0.42,
                  toolOverrides: { mcpServers: { "aos-ui": true } },
                },
              ],
        }
      case "sessions.create":
        // The release answers a new Session with its key; this fake's one
        // Session stands for it.
        return { ok: true, key: SESSION_KEY, sessionId: "transcript-a" }
      case "sessions.messages.subscribe":
        return { key: params.key }
      case "sessions.messages.unsubscribe":
        return {}
      case "tools.effective":
        return { agentId: AGENT_ID, profile: "default", groups: [] }
      case "chat.history":
        return {
          sessionKey: SESSION_KEY,
          sessionId: "transcript-a",
          messages: transcript,
          sessionInfo: {
            hasActiveRun: run !== undefined,
            activeRunIds: run ? [run.id] : [],
          },
        }
      case "chat.send": {
        // The release answers a send once, as it starts the run, and pushes
        // the prompt's row once it stored it.
        const id = String(params.idempotencyKey)
        options?.onSent?.()
        run = { id, seq: 0 }
        const row = {
          role: "user",
          content: [{ type: "text", text: String(params.message) }],
          timestamp: Date.now(),
          __openclaw: {
            id: `msg-${transcript.length + 1}`,
            seq: transcript.length + 1,
            idempotencyKey: id,
          },
        }
        transcript.push(row)
        queueMicrotask(() =>
          emit("session.message", {
            message: row,
            messageId: row.__openclaw.id,
            messageSeq: row.__openclaw.seq,
          })
        )
        return { runId: id, status: "started" }
      }
      case "approval.get":
        if (!open || open.approval.id !== params.id)
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unknown approval",
          })
        return { approval: open.approval }
      case "approval.resolve": {
        // A deny ends the approval denied, the only terminal carrying it.
        const approval = endApproval({
          status: params.decision === "deny" ? "denied" : "allowed",
          decision: params.decision,
          reason: "user",
        })
        if (!approval)
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unknown approval",
          })
        return { applied: true, approval }
      }
      case "sessions.abort": {
        // An abort cancels the run's open approval at once; the run ends
        // aborted only once its loop stops.
        const aborted = run?.id
        endApproval({ status: "cancelled", reason: "run-aborted" })
        interrupted?.()
        return aborted
          ? { ok: true, status: "aborted", abortedRunId: aborted }
          : { ok: true, status: "no-active-run", abortedRunId: null }
      }
      default:
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: `unknown method ${method}`,
        })
    }
  }

  return {
    scope: {
      agentId: AGENT_ID,
      providerSessionId: ids.providerSessionId(SESSION_KEY),
      sessionId: ids.sessionId("contract-session"),
    },

    createGatewayClient(
      options: OpenClawGatewayClientOptions
    ): OpenClawGatewayClient {
      const dialed: Connection = { options, up: false, stopped: false }
      connection = dialed
      return {
        start() {
          calls += 1
          queueMicrotask(() => hello(dialed))
        },
        async stopAndWait() {
          dialed.stopped = true
          dialed.up = false
        },
        async request<T>(
          method: string,
          params?: unknown,
          options?: OpenClawRequestOptions
        ) {
          calls += 1
          if (!dialed.up) throw new Error("gateway not connected")
          if (fault === "native") throw failure
          return (await answer(
            method,
            (params ?? {}) as Record<string, unknown>,
            options
          )) as T
        },
      }
    },

    async progress() {
      agentEvent("assistant", { delta: "Contract reply" })
    },

    async finish() {
      agentEvent("lifecycle", { phase: "end" })
      emit("chat", {
        seq: 0,
        state: "final",
        message: { content: [{ type: "text", text: "Contract reply" }] },
      })
      run = undefined
    },

    /** The wire contract's turn, as a run of the release streams it. */
    turn: {
      async firstResponse() {
        const call = { toolCallId: "call-read", name: "read_file" }
        agentEvent("thinking", { delta: "I should read the file." })
        agentEvent("assistant", { delta: "Reading the file." })
        agentEvent("tool", {
          ...call,
          phase: "start",
          args: { path: "/tmp/demo.txt" },
        })
        agentEvent("tool", {
          ...call,
          phase: "result",
          result: "alpha\nbeta\ngamma",
          isError: false,
        })
      },
      async secondResponse(text = "The file lists three names.") {
        agentEvent("assistant", { delta: text })
        complete(text)
      },
      /**
       * The release has no Session-scoped push for a question (no
       * `question.*` event reaches `sessions.messages.subscribe`), so the
       * run's in-turn prompt is a plugin approval.
       */
      questions: {
        ask: () =>
          new Promise<void>((settle) => {
            const now = Date.now()
            const id = `approval-${nextApproval++}`
            const approval = {
              id,
              urlPath: `/approvals/${id}`,
              createdAtMs: now,
              expiresAtMs: now + 600_000,
              presentation: {
                kind: "plugin",
                title: "Proceed?",
                description: "Proceed? yes / no",
                severity: "info",
                agentId: AGENT_ID,
                allowedDecisions: ["allow-once", "deny"],
              },
              status: "pending",
              sourceSessionKey: SESSION_KEY,
            }
            open = { approval, settle }
            emitApproval("pending", approval)
          }),
        /** The approval timed out: it failed closed and the run goes on. */
        async withdraw() {
          endApproval({ status: "expired", reason: "timeout" })
        },
        interrupted: () =>
          new Promise<void>((resolve) => {
            interrupted = () => {
              interrupted = undefined
              resolve()
            }
          }),
        /** The aborted run's loop stops: it ends aborted. */
        async confirmInterrupt() {
          emit("chat", { seq: 0, state: "aborted" })
          run = undefined
        },
        held: {},
        lose: () =>
          Promise.reject(new Error("OpenClaw replays every pending approval")),
      },
    },

    deleteSession() {
      deleted = true
    },

    failNative() {
      fault = "native"
      const native = new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "contract native failure",
      })
      failure = native
      return (error: unknown) => error === native
    },

    refuseAsCaller(kind: CallerError) {
      if (kind !== "runtime_authentication_required")
        throw new Error("OpenClaw refuses a read only for its device")
      fault = "refused"
      drop()
    },

    nativeCalls: () => calls,

    async dropLink() {
      fault = "down"
      drop()
    },

    /** The Gateway is back: a dial still waiting on its hello gets one. */
    async restoreLink() {
      fault = "none"
      if (connection) hello(connection)
    },
  }
}
