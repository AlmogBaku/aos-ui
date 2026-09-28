/**
 * fakeHermes — one in-memory Hermes holding one Session, for the runtime and
 * wire contracts: the socket RPCs and dashboard routes a create, a turn and a
 * read reach, and the faults the runtime contract drives. Pair it with the
 * real `HermesGateway` through `fakeHermesGateway`, so the gateway's own dial,
 * heal and refusal handling is what the contracts prove.
 *
 * It copies Hermes v2026.9.21 (`d337b736aa1e`), its `tui_gateway` socket and
 * dashboard API, with `close_on_disconnect: false` Sessions under one profile.
 *
 * Usage:
 *
 *   const hermes = fakeHermes()
 *   const transport = fakeHermesGateway(hermes, logger)
 *   hermes.progress() // stream a reply fragment into the running turn
 */
import type { Logger } from "../../../../lifecycle"
import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import { HermesGateway, HermesRpcRejectedError } from "../gateway"
import { HermesHttpError } from "../http"
import { FakeSocket } from "./fake-socket"
import { assistantText, userRow } from "./history-rows"
import { nativeTurn, type NativeFrame } from "./native-events"

const PROFILE = "researcher"
const STORED_ID = "stored-1"
const LIVE_ID = "live-1"
const EPOCH = "e1"
const AUTH_CLOSE_CODE = 4401
const LOST_CLOSE_CODE = 1006
/** Hermes answers a resume of a Session it holds no record of with this. */
const SESSION_NOT_FOUND = { code: 4007, message: "session not found" }
const NATIVE_FAILURE = { code: -32000, message: "contract native failure" }
const NATIVE_FAILURE_STATUS = 500
/** Frames that keep a socket alive rather than asking Hermes anything. */
const TRANSPORT_METHODS = new Set(["client.capabilities", "gateway.ping"])
/** The scaffold Hermes writes into a redirect's `api_content`. */
const REDIRECT_SCAFFOLD = "[Context from the interrupted assistant response]"

type Fault = "none" | "native" | "refused" | "down"
type Reply = { result: unknown } | { error: { code: number; message: string } }

/** A socket that answers every request frame the way Hermes would. */
class HermesFakeSocket extends FakeSocket {
  constructor(
    private readonly answer: (
      method: string,
      params: Record<string, unknown>
    ) => Reply
  ) {
    super()
    this.autoReply = false
  }

  override send(value: string) {
    super.send(value)
    const frame = JSON.parse(value) as {
      id?: string
      method?: string
      params?: Record<string, unknown>
    }
    if (frame.id === undefined || frame.method === undefined) return
    const id = frame.id
    const reply = this.answer(frame.method, frame.params ?? {})
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.OPEN) return
      if ("error" in reply) this.replyError(id, reply.error)
      else this.reply(id, reply.result)
    })
  }
}

function json(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** The real gateway over `hermes`, as every contract dials it. */
export function fakeHermesGateway(hermes: FakeHermes, log: Logger) {
  return new HermesGateway({
    baseUrl: "http://127.0.0.1:9119",
    credentials: async () => ({ "X-Hermes-Session-Token": "test-token" }),
    log,
    socketFactory: hermes.socketFactory,
    fetcher: hermes.fetcher,
  })
}

export type FakeHermes = ReturnType<typeof fakeHermes>

export function fakeHermes() {
  const turn = nativeTurn(LIVE_ID)
  const frames: NativeFrame[] = []
  const sockets: HermesFakeSocket[] = []
  let fault: Fault = "none"
  let deleted = false
  let running = false
  let replyId: string | undefined
  let replies = 0
  let calls = 0
  let rows: unknown[] = []
  let inflight: Record<string, unknown> | undefined

  const socket = () => sockets.at(-1)
  const latestSeq = () => frames.at(-1)?.seq ?? 0

  function emit(frame: NativeFrame) {
    frames.push(frame)
    const current = socket()
    if (current?.readyState === FakeSocket.OPEN) current.deliverEvent(frame)
  }

  function rpc(method: string, params: Record<string, unknown>): Reply {
    switch (method) {
      case "profiles.list":
        return { result: { profiles: [{ name: PROFILE }] } }
      case "session.resume":
        if (deleted) return { error: SESSION_NOT_FOUND }
        return {
          result: {
            session_id: LIVE_ID,
            stored_session_id: STORED_ID,
            running,
            ...(inflight ? { inflight } : {}),
          },
        }
      case "session.events.since":
        return {
          result: {
            epoch: EPOCH,
            latest_seq: latestSeq(),
            truncated: false,
            events: frames.filter(({ seq }) => seq > Number(params.last_seen)),
          },
        }
      case "session.active_list":
        return {
          result: {
            sessions: [{ id: LIVE_ID, status: running ? "working" : "idle" }],
          },
        }
      case "prompt.submit":
        running = true
        return { result: { status: "streaming" } }
      case "session.create":
        // The release answers a new draft with its live and stored ids; this
        // fake's one Session stands for it.
        return {
          result: {
            session_id: LIVE_ID,
            stored_session_id: STORED_ID,
            message_count: 0,
            messages: [],
            info: {
              model: "contract-model",
              lazy: true,
              profile_name: PROFILE,
            },
          },
        }
      case "session.close":
        return { result: {} }
      default:
        return { error: { code: -32601, message: "method not found" } }
    }
  }

  function answer(method: string, params: Record<string, unknown>): Reply {
    if (TRANSPORT_METHODS.has(method))
      return { result: method === "gateway.ping" ? { ok: true } : {} }
    calls += 1
    return fault === "native" ? { error: NATIVE_FAILURE } : rpc(method, params)
  }

  function route(url: URL) {
    const base = `/api/sessions/${encodeURIComponent(STORED_ID)}`
    if (url.pathname === "/api/sessions")
      return json(200, {
        sessions: deleted
          ? []
          : [{ id: STORED_ID, profile: PROFILE, title: "Contract Session" }],
        total: deleted ? 0 : 1,
      })
    if (deleted) return json(404)
    if (url.pathname === base)
      return json(200, { id: STORED_ID, profile: PROFILE, title: "Contract" })
    if (url.pathname === `${base}/messages`) {
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      const page = rows.slice(offset, offset + limit)
      return json(200, {
        session_id: STORED_ID,
        messages: page,
        pagination: {
          limit,
          offset,
          returned: page.length,
          total: rows.length,
        },
      })
    }
    return json(404)
  }

  return {
    scope: {
      agentId: PROFILE,
      providerSessionId: ids.providerSessionId(STORED_ID),
      sessionId: ids.sessionId(STORED_ID),
    },

    socketFactory: () => {
      calls += 1
      const dialed = new HermesFakeSocket(answer)
      sockets.push(dialed)
      queueMicrotask(() => {
        if (fault === "down") return dialed.close(LOST_CLOSE_CODE)
        dialed.open()
        if (fault === "refused") dialed.close(AUTH_CLOSE_CODE)
        else dialed.deliverReady()
      })
      return dialed
    },

    fetcher: (async (input: string | URL | Request) => {
      calls += 1
      if (fault === "down") throw new TypeError("fetch failed")
      if (fault === "refused") return json(401)
      if (fault === "native") return json(NATIVE_FAILURE_STATUS)
      return route(new URL(String(input)))
    }) as unknown as typeof fetch,

    async progress() {
      if (replyId === undefined) {
        replies += 1
        replyId = `assistant-${replies}`
        emit(turn.messageStart(replyId))
      }
      emit(turn.delta("Contract reply"))
    },

    async finish() {
      running = false
      emit(turn.complete(replyId ?? `assistant-${replies}`, "Contract reply"))
      emit(turn.idle())
      replyId = undefined
    },

    deleteSession() {
      deleted = true
    },

    failNative() {
      fault = "native"
      return (error: unknown) =>
        (error instanceof HermesRpcRejectedError &&
          error.code === NATIVE_FAILURE.code) ||
        (error instanceof HermesHttpError &&
          error.status === NATIVE_FAILURE_STATUS)
    },

    refuseAsCaller(kind: CallerError) {
      if (kind !== "runtime_authentication_required")
        throw new Error(`Hermes refuses a read only for its credential`)
      fault = "refused"
      socket()?.close(AUTH_CLOSE_CODE)
    },

    nativeCalls: () => calls,

    async dropLink() {
      fault = "down"
      socket()?.close(LOST_CLOSE_CODE)
    },

    async restoreLink() {
      fault = "none"
    },

    /** A redirect correction, then a prompt whose turn Hermes failed. */
    seedTypedMessages() {
      rows = [
        userRow("user-1", "Summarize the notes"),
        assistantText("assistant-1", "Reading the"),
        userRow("user-2", "Only the first page", {
          apiContent: `${REDIRECT_SCAFFOLD}\nReading the\n\nOnly the first page`,
        }),
        assistantText("assistant-2", "The first page covers the plan."),
        userRow("user-3", "Now the second page"),
      ]
      inflight = {
        user: "Now the second page",
        assistant: "",
        streaming: false,
        status: "error",
        error: "provider overloaded",
        error_surface: { layer: "provider", code: "overloaded" },
      }
    },
  }
}
