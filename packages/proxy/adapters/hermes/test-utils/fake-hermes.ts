/**
 * fakeHermes — one in-memory Hermes holding one Session, for the runtime and
 * wire contracts: the socket RPCs and dashboard routes a create, a turn, a
 * read, and an MCP App's call lookup and file read reach, and the faults the
 * runtime contract drives. Pair it with the
 * real `HermesGateway` through `fakeHermesGateway`, so the gateway's own dial,
 * heal and refusal handling is what the contracts prove.
 *
 * It copies Hermes v2026.9.24 (`f97608f178d1`), its `tui_gateway` socket and
 * dashboard API, with `close_on_disconnect: false` Sessions under one profile.
 * As the release does, it stores a prompt's row at `prompt.submit` and answers
 * with its `user_row_id`, streams `message.start` with no payload, and closes a
 * turn with the `persisted_turn` receipt of the rows it stored.
 *
 * Usage:
 *
 *   const hermes = fakeHermes()
 *   const transport = fakeHermesGateway(hermes, logger)
 *   hermes.progress() // stream a reply fragment into the running turn
 */
import { posix } from "node:path"

import type { Logger } from "../../../../lifecycle"
import type { CallerError } from "../../../core/failures"
import * as ids from "../../../core/ids"
import { HermesGateway, HermesRpcRejectedError } from "../gateway"
import { HermesHttpError } from "../http"
import { FakeSocket } from "./fake-socket"
import { assistantText, userRow } from "./history-rows"
import { nativeTurn, type NativeFrame } from "./native-events"

const PROFILE = "researcher"
const PROFILE_HOME = `/home/hermes/.hermes/profiles/${PROFILE}`
/** Where the profile's Sessions run: its `terminal.cwd`. */
export const PROJECT_FOLDER = "/srv/research"
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

/**
 * `stored: false` starts Hermes with no stored Session, so its one Session is
 * a draft `session.create` hands out; by default it is already stored.
 */
export function fakeHermes({ stored = true }: { stored?: boolean } = {}) {
  const turn = nativeTurn(LIVE_ID)
  const frames: NativeFrame[] = []
  const sockets: HermesFakeSocket[] = []
  let fault: Fault = "none"
  let deleted = false
  /**
   * Whether the Session has its `sessions` row: a created draft has none until
   * its first prompt stores one (`tui_gateway/methods_session.py:394`).
   */
  let saved = stored
  /**
   * `display.tool_progress` is not "off": Hermes streams an ordinary tool
   * call only then (`tui_gateway/tool_progress.py:253` and `:319`), and its
   * thoughts either way (`tui_gateway/agent_callbacks.py:139`).
   */
  let toolProgress = true
  let running = false
  let streaming = false
  let calls = 0
  let rows: unknown[] = []
  let nextRowId = 1
  /** The rows the running turn stored, its prompt's first. */
  let turnRows: number[] = []
  let inflight: Record<string, unknown> | undefined
  /** The server request the running turn blocks on, as `server_requests` holds it. */
  let open:
    | {
        id: string
        method: string
        params: Record<string, unknown>
        settle: () => void
      }
    | undefined
  let nextRequest = 1
  /** The Session waits on a request no socket can be sent any more. */
  let lost = false
  let interrupted: (() => void) | undefined
  /** Each folder's listing: entry names to their real paths, or its refusal. */
  const folders = new Map<string, Readonly<Record<string, string>> | number>()
  /** The files a download serves the Session, by path. */
  const files = new Map<string, string>()
  /** The profile's configured MCP servers, by name (stdio, no URL). */
  const mcpServers: string[] = []
  /**
   * OAuth-authenticated MCP servers: name → { url, token }. The fake serves
   * the token from `/api/mcp/servers/{name}/token`.
   */
  const oauthMcpServers = new Map<string, { url: string; token: string }>()
  /** Every dashboard request, as Hermes received it. */
  const httpRequests: { url: URL; headers: Headers }[] = []

  const socket = () => sockets.at(-1)
  const latestSeq = () => frames.at(-1)?.seq ?? 0
  /** `_open_requests`: what a resume or a replay re-delivers. */
  const openRequests = () =>
    open ? [{ id: open.id, method: open.method, params: open.params }] : []

  /**
   * One blocking server→client request of the running turn, as `_ask` and
   * `_clarify_block` send it; settles once Hermes stops waiting on it.
   */
  function request(
    method: string,
    fields: Record<string, unknown>,
    settle: () => void = () => {}
  ) {
    startStreaming()
    const id = `srq-${String(nextRequest++).padStart(12, "0")}`
    const params = { session_id: LIVE_ID, ...fields }
    open = { id, method, params, settle }
    socket()?.deliver({ id, method, params })
  }

  /** `server_requests.cancel`: the open request ends with a `request.cancel`. */
  function cancelOpen(reason: string) {
    if (!open) return
    const { id, method, settle } = open
    open = undefined
    emit(turn.frame("request.cancel", { id, method, reason }))
    settle()
  }

  function emit(frame: NativeFrame) {
    frames.push(frame)
    const current = socket()
    if (current?.readyState === FakeSocket.OPEN) current.deliverEvent(frame)
  }

  /** Stores a row of the running turn as the release's `messages` table does. */
  function store(row: Record<string, unknown>) {
    const id = nextRowId++
    saved = true
    rows.push({
      id,
      session_id: STORED_ID,
      timestamp: Date.now() / 1000,
      ...row,
    })
    turnRows.push(id)
    return id
  }

  /** One `patch` call of its own response, streamed and stored. */
  function patchCall(
    id: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>
  ) {
    emit(turn.toolStart(id, "patch", args))
    store({
      role: "assistant",
      content: "",
      finish_reason: "tool_calls",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "patch", arguments: JSON.stringify(args) },
        },
      ],
    })
    emit(turn.toolComplete(id, "patch", result))
    store({
      role: "tool",
      tool_call_id: id,
      tool_name: "patch",
      content: JSON.stringify(result),
    })
  }

  function startStreaming() {
    if (streaming) return
    streaming = true
    emit(turn.frame("message.start"))
  }

  /** The reply's final body, stored, then the receipt and the idle frame. */
  function complete(text: string) {
    const final = store({
      role: "assistant",
      content: text,
      finish_reason: "stop",
    })
    running = false
    streaming = false
    emit(
      turn.frame("message.complete", {
        text,
        status: "complete",
        persisted_turn: {
          row_ids: turnRows,
          complete: true,
          user_row_id: turnRows[0],
          final_assistant_row_id: final,
        },
      })
    )
    emit(turn.idle())
  }

  function rpc(method: string, params: Record<string, unknown>): Reply {
    switch (method) {
      // A row's `path` is the profile's home, never where its Sessions run
      // (`tui_gateway/methods_profiles.py:275`).
      case "profiles.list":
        return { result: { profiles: [{ name: PROFILE, path: PROFILE_HOME }] } }
      // The profile's `terminal.cwd` is an existing folder, so the project
      // folder is the one `session.create` runs in
      // (`tui_gateway/methods_config.py:139`, `session_workdir.py:23`).
      case "config.get":
        return params.key === "project" && params.profile === PROFILE
          ? { result: { cwd: PROJECT_FOLDER, branch: null } }
          : { error: NATIVE_FAILURE }
      case "session.resume":
        if (deleted) return { error: SESSION_NOT_FOUND }
        // A live draft with no stored row reattaches lazy
        // (`tui_gateway/methods_session.py:628`).
        if (!saved)
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
        return {
          result: {
            session_id: LIVE_ID,
            stored_session_id: STORED_ID,
            running,
            ...(inflight ? { inflight } : {}),
            open_requests: openRequests(),
          },
        }
      case "session.events.since":
        return {
          result: {
            epoch: EPOCH,
            latest_seq: latestSeq(),
            truncated: false,
            events: frames.filter(({ seq }) => seq > Number(params.last_seen)),
            open_requests: openRequests(),
          },
        }
      case "session.active_list":
        return {
          result: {
            sessions: [
              {
                id: LIVE_ID,
                // `_session_live_status`: a pending request is `waiting`.
                status: open || lost ? "waiting" : running ? "working" : "idle",
              },
            ],
          },
        }
      case "request.answer": {
        const answered = open
        if (!answered || answered.id !== params.id)
          return { result: { status: "expired" } }
        open = undefined
        answered.settle()
        return { result: { status: "ok" } }
      }
      case "session.interrupt":
        // `_interrupt_session_turn` withdraws the open requests at once; the
        // turn ends interrupted only once its thread stops.
        cancelOpen("interrupted")
        interrupted?.()
        return { result: { status: "interrupted" } }
      case "prompt.submit": {
        running = true
        turnRows = []
        const text = typeof params.text === "string" ? params.text : ""
        const userRowId = store({ role: "user", content: text })
        return { result: { status: "streaming", user_row_id: userRowId } }
      }
      case "model.options":
        // One reasoning model, as `ModelOptionsResult` carries it
        // (`tui_gateway/contracts/config_free_tier_control.py:273`).
        return {
          result: {
            providers: [
              {
                slug: "contract",
                name: "Contract",
                models: ["contract-model"],
                capabilities: {
                  "contract-model": { fast: false, reasoning: true },
                },
              },
            ],
            model: "contract-model",
            provider: "contract",
          },
        }
      case "session.context_breakdown":
        // A Session with no agent built yet reads its usage snapshot
        // (`tui_gateway/methods_session.py:1297`).
        return {
          result: {
            categories: [],
            context_max: 200_000,
            context_percent: 1,
            context_used: 1_200,
            estimated_total: 0,
            context_estimated: false,
            context_source: "provider_usage",
            model: "contract-model",
          },
        }
      case "session.create":
        // The release answers a new draft with its live and stored ids; this
        // fake's one Session stands for it.
        saved = false
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
    const listed = saved && !deleted
    if (url.pathname === "/api/sessions")
      return json(200, {
        sessions: listed
          ? [{ id: STORED_ID, profile: PROFILE, title: "Contract Session" }]
          : [],
        total: listed ? 1 : 0,
      })
    // A listing names no Session; each entry carries the real path Hermes
    // resolved it to, and one it cannot resolve fails the whole listing
    // (`hermes_cli/web_routers/files.py:367`, `web_server_files.py:181`).
    if (url.pathname === "/api/files") {
      const folder = url.searchParams.get("path") ?? ""
      const listing = folders.get(folder) ?? 404
      if (typeof listing === "number") return json(listing, { detail: "" })
      return json(200, {
        path: folder,
        parent: folder === "/" ? null : posix.dirname(folder),
        entries: Object.entries(listing).map(([name, path]) => ({
          name,
          path,
          is_directory: false,
          size: files.get(path)?.length ?? 0,
          mtime: 0,
          mime_type: "text/plain",
        })),
        root: null,
        locked_root: null,
        can_change_path: true,
      })
    }
    // Each server as `_mcp_server_summary` reports it: one the proxy cannot
    // dial, so only its name resolves a call's server
    // (`hermes_cli/web_routers/mcp.py:94`, `web_server_mcp.py:84`).
    if (url.pathname === "/api/mcp/servers")
      return url.searchParams.get("profile") === PROFILE
        ? json(200, {
            servers: [
              ...mcpServers.map((name) => ({
                name,
                transport: "stdio",
                url: null,
                command: "synthetic-mcp",
                args: [],
                env: {},
                auth: null,
                enabled: true,
                tools: null,
              })),
              ...[...oauthMcpServers.entries()].map(([name, { url: mcpUrl }]) => ({
                name,
                transport: "http",
                url: mcpUrl,
                command: null,
                args: [],
                env: {},
                auth: "oauth",
                enabled: true,
                tools: null,
              })),
            ],
          })
        : json(404)
    // OAuth token for a named MCP server, per profile.
    const tokenMatch =
      /^\/api\/mcp\/servers\/([^/]+)\/token$/.exec(url.pathname)
    if (tokenMatch) {
      const serverName = decodeURIComponent(tokenMatch[1])
      const server = oauthMcpServers.get(serverName)
      if (!server || url.searchParams.get("profile") !== PROFILE) return json(404)
      return json(200, { access_token: server.token, token_type: "Bearer" })
    }
    if (!listed) return json(404)
    // A download resolves its path in the Session's own folder and serves
    // the file whole, as an attachment (`hermes_cli/web_routers/files.py:733`).
    if (url.pathname === "/api/fs/download") {
      const file =
        url.searchParams.get("profile") === PROFILE &&
        url.searchParams.get("session_id") === STORED_ID
          ? files.get(url.searchParams.get("path") ?? "")
          : undefined
      return file === undefined
        ? json(404)
        : new Response(file, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "accept-ranges": "bytes",
              "content-disposition": "attachment",
            },
          })
    }
    // `db.get_session` serves the whole stored row, its cost included.
    if (url.pathname === base)
      return json(200, {
        id: STORED_ID,
        profile: PROFILE,
        title: "Contract",
        estimated_cost_usd: 0.42,
      })
    // `order=latest` pages back from the newest row, each page in order
    // (`hermes_state_messages.py:1063`).
    if (url.pathname === `${base}/messages`) {
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      const end =
        url.searchParams.get("order") === "latest"
          ? rows.length - offset
          : offset + limit
      const page = rows.slice(Math.max(0, end - limit), Math.max(0, end))
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

    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      const url = new URL(String(input))
      httpRequests.push({ url, headers: new Headers(init?.headers) })
      if (fault === "down") throw new TypeError("fetch failed")
      if (fault === "refused") return json(401)
      if (fault === "native") return json(NATIVE_FAILURE_STATUS)
      return route(url)
    }) as unknown as typeof fetch,

    /** The dashboard requests Hermes received for `pathname`. */
    httpRequests: (pathname: string) =>
      httpRequests.filter(({ url }) => url.pathname === pathname),

    /**
     * What listing `folder` answers: each entry's name and the real path
     * Hermes resolved it to, or the status it refuses the listing with.
     */
    listFolder(
      folder: string,
      listing: Readonly<Record<string, string>> | number
    ) {
      folders.set(folder, listing)
    },

    /** A file a download serves the Session at `path`. */
    storeFile(path: string, body: string) {
      files.set(path, body)
    },

    /** An MCP server the profile configures (stdio, no URL). */
    addMcpServer(name: string) {
      mcpServers.push(name)
    },

    /**
     * An OAuth-authenticated HTTP MCP server the profile configures. The fake
     * serves `token` from `GET /api/mcp/servers/{name}/token`.
     */
    addOAuthMcpServer(name: string, mcpUrl: string, token: string) {
      oauthMcpServers.set(name, { url: mcpUrl, token })
    },

    /**
     * A call of the Session's, stored with no result yet: Hermes stores a
     * call's row before the tool runs (`agent/turn_tool_round.py:118`).
     */
    storeToolCall(id: string, name: string, args: Record<string, unknown>) {
      store({
        role: "assistant",
        content: "",
        finish_reason: "tool_calls",
        tool_calls: [
          {
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      })
    },

    async progress() {
      startStreaming()
      emit(turn.delta("Contract reply"))
    },

    async finish() {
      complete("Contract reply")
    },

    /** The wire contract's first model response: a thought, text, a tool. */
    async firstResponse() {
      const thought = "I should read the file."
      const text = "Reading the file."
      const args = { path: "/tmp/demo.txt" }
      const result = "alpha\nbeta\ngamma"
      startStreaming()
      emit(turn.frame("reasoning.delta", { text: thought }))
      emit(turn.delta(text))
      // The model's text beside its tool call is sealed as interim commentary.
      emit(turn.interim(text, true))
      if (toolProgress) emit(turn.toolStart("call-read", "read_file", args))
      store({
        role: "assistant",
        content: text,
        reasoning: thought,
        finish_reason: "tool_calls",
        tool_calls: [
          {
            id: "call-read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify(args) },
          },
        ],
      })
      if (toolProgress)
        emit(turn.toolComplete("call-read", "read_file", result))
      store({
        role: "tool",
        tool_call_id: "call-read",
        tool_name: "read_file",
        content: result,
      })
    },

    /**
     * A `patch` call adding `/tmp/notes.txt`, then one replacing "alpha" in
     * `/tmp/names.txt`, each with the result the release's `patch_tool`
     * returns for it (`tools/file_tools.py:1002`; the add's diff from
     * `tools/patch_parser.py:333`, the edit's from
     * `tools/file_operations.py:446`), which `tool.complete` carries parsed.
     */
    async editFile() {
      startStreaming()
      const added = "/tmp/notes.txt"
      patchCall(
        "call-write",
        {
          mode: "patch",
          patch: `*** Begin Patch\n*** Add File: ${added}\n+alpha\n*** End Patch`,
        },
        {
          success: true,
          diff: `--- /dev/null\n+++ b/${added}\n+alpha`,
          files_created: [added],
          files_modified: [added],
          resolved_path: added,
        }
      )
      const edited = "/tmp/names.txt"
      patchCall(
        "call-edit",
        {
          mode: "replace",
          path: edited,
          old_string: "alpha",
          new_string: "beta",
        },
        {
          success: true,
          diff: `--- a/${edited}\n+++ b/${edited}\n@@ -1 +1 @@\n-alpha\n+beta\n`,
          files_modified: [edited],
          resolved_path: edited,
        }
      )
    },

    /**
     * `config.set` of `verbose` to "off", which sets the Session's tool
     * progress (`tui_gateway/methods_config_set.py:214`). Hermes' "show
     * reasoning" is no such setting: it only records a display choice
     * (`:308`) that nothing streaming reads.
     */
    async quiet() {
      toolProgress = false
    },

    /** The wire contract's second model response: the final text. */
    async secondResponse(text = "The file lists three names.") {
      emit(turn.delta(text))
      complete(text)
    },

    /** The wire contract's questions, as `server_requests` asks and ends them. */
    questions: {
      ask: () =>
        new Promise<void>((settle) =>
          request(
            "clarify",
            { question: "Proceed?", choices: ["yes", "no"] },
            settle
          )
        ),
      /** The clarify wait timed out: the tool returns and the turn runs on. */
      async withdraw() {
        cancelOpen("timeout")
      },
      interrupted: () =>
        new Promise<void>((resolve) => {
          interrupted = () => {
            interrupted = undefined
            resolve()
          }
        }),
      /** The interrupted turn's thread stops: it completes interrupted. */
      async confirmInterrupt() {
        running = false
        streaming = false
        lost = false
        emit(
          turn.frame("message.complete", { text: "", status: "interrupted" })
        )
        emit(turn.idle())
      },
      held: {
        sudo: async () => {
          const command = "sudo ls /tmp/demo.txt"
          request("sudo", { command })
          return command
        },
        secret: async () => {
          const prompt = "Enter the demo token"
          request("secret", { env_var: "DEMO_TOKEN", prompt })
          return prompt
        },
        vault: async () => {
          const display = "Demo Vault"
          request("vault.unlock_prompt", {
            backend: "demo-vault",
            display_name: display,
          })
          return display
        },
      },
      /** Hermes runs a turn of its own, blocked on a request nobody holds. */
      async lose() {
        running = true
        lost = true
        startStreaming()
      },
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
