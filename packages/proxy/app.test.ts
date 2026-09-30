import { describe, expect, it, vi } from "vitest"

import { captureLogs } from "../../test/support/log-capture"
import type { McpAppFiles, McpAppView } from "../protocol/mcp-apps"
import { createProxyApp, type ProxyAppOptions } from "./app"
import {
  HermesAuthenticationError,
  HermesHttpError,
} from "./adapters/hermes/gateway"
import {
  HermesServerAdapter,
  HermesSessionNotFoundError,
  type HermesRpcTransport,
} from "./adapters/hermes/adapter"
import { HermesTurnPublicError } from "./adapters/hermes/run-failures"
import { createFilePassService, type FilePassScope } from "./auth/file-pass"
import { createAppFileCalls } from "./core/app-files"
import { AttachmentStageRegistry } from "./core/attachment-stages"
import {
  ServerSessionNotFoundError,
  type McpToolCall,
  type RuntimeInstance,
  type ServerFileReader,
  type ServerMcpApps,
  type SessionScope,
} from "./core/runtime"
import { SessionCoordinator } from "./core/session-coordinator"
import { McpAppNotFoundError } from "./mcp-apps/fallback"
import { appFileSettings, type AppFileOptions } from "./routes/app-files"

const origin = "http://127.0.0.1:3000"

/** Idle health readings, for an app whose liveness no case reads. */
const health = () => ({
  links: [],
  gauges: {
    sockets: 0,
    memberships: 0,
    executions: 0,
    uncertain: 0,
    deadlinesFired: 0,
    journalBytes: 0,
  },
})

function session(agentId = "researcher", id = "stored") {
  return {
    id,
    agentId,
    title: "Owned",
    archived: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle" as const,
  }
}

function nativeProfile() {
  return {
    name: "researcher",
    display_name: "Researcher",
    ui_meta: { "hermes-bots": { hidden: false } },
    ui_meta_revisions: { "hermes-bots": 1 },
  }
}

function runtimeInstance(runtime: HermesServerAdapter): RuntimeInstance {
  const sessions = new SessionCoordinator({
    engine: runtime.turns,
    readings: runtime,
    maxActiveExecutions: 8,
    maxSubscriberEvents: 32,
    maxSubscriberBytes: 256 * 1024,
    logger: captureLogs().logger,
  })
  return {
    id: "hermes-main",
    runtime,
    sessions,
    close: vi.fn(async () => {
      sessions.close()
      await runtime.close()
    }),
  }
}

function app(
  runtime: HermesServerAdapter,
  options: Partial<ProxyAppOptions> = {}
) {
  return createProxyApp({
    publicOrigin: origin,
    runtimeInstance: runtimeInstance(runtime),
    logger: captureLogs().logger,
    health,
    ...options,
  })
}

const stagedDataUrl = "data:text/plain;base64,bm90ZXM="

const stageRequest = {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    attachments: [
      {
        type: "file",
        filename: "notes.txt",
        mimeType: "text/plain",
        dataUrl: stagedDataUrl,
      },
    ],
  }),
}

describe("AOS V1 proxy", () => {
  it("serves runtime discovery without application authentication", async () => {
    const request = vi.fn(async (method: string) =>
      method === "profiles.list" ? { profiles: [nativeProfile()] } : undefined
    )

    const response = await app(new HermesServerAdapter({ request })).request(
      `${origin}/api/aos/v1/runtime`
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      runtime: { id: "hermes" },
      status: "ready",
    })
  })

  it("stages operator attachments for the ACP listener to consume", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockResolvedValue(session())
    const cleanup = vi.fn(async () => undefined)
    vi.spyOn(runtime, "stageAttachments").mockResolvedValue({
      public: [{ type: "file", filename: "notes.txt", mimeType: "text/plain" }],
      appendTo: (text) => `${text}\n\n[attachment]`,
      cleanup,
    })

    // Room for exactly one batch's bytes, so a second one is over the cap.
    const proxy = app(runtime, {
      attachmentStages: new AttachmentStageRegistry(
        256,
        300_000,
        stagedDataUrl.length
      ),
    })
    const path = `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`

    const response = await proxy.request(path, stageRequest)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      stageId: expect.any(String),
      attachments: [
        { type: "file", filename: "notes.txt", mimeType: "text/plain" },
      ],
    })
    expect(cleanup).not.toHaveBeenCalled()

    expect((await proxy.request(path, stageRequest)).status).toBe(503)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("requires the exact configured origin for state changes", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "stageAttachments")

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      {
        ...stageRequest,
        headers: {
          origin: "https://attacker.example.test",
          "content-type": "application/json",
        },
      }
    )

    expect(response.status).toBe(403)
    expect(runtime.stageAttachments).not.toHaveBeenCalled()
  })

  it("does not expose invitation signing when the guest surface is disabled", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    const proxy = app(runtime)

    const response = await proxy.request(
      `${origin}/api/aos/v1/guest-invitations`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ agentId: "researcher", ref: "guest-ref" }),
      }
    )

    expect(response.status).toBe(404)
  })

  it("serves no browser wire beside runtime discovery and content", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    const proxy = app(runtime)
    const session = `${origin}/api/aos/v1/agents/researcher/sessions/stored`

    // Sessions, history, models, context, visibility, runs, and the
    // invalidation socket all travel over ACP now.
    for (const path of [
      `${origin}/api/aos/v1/agents`,
      `${origin}/api/aos/v1/sessions`,
      `${origin}/api/aos/v1/events`,
      session,
      `${session}/history`,
      `${session}/runs`,
      `${session}/runs/stop`,
      `${session}/runs/steer`,
      `${session}/workspace/capabilities`,
      `${session}/workspace/models`,
      `${session}/workspace/context`,
      `${session}/workspace/todos`,
      `${session}/interactions/pending`,
      `${session}/audio`,
    ])
      expect((await proxy.request(path)).status, path).toBe(404)
  })

  it("reports rejected credentials and keeps an unreachable provider discoverable", async () => {
    const failing = (error: Error) =>
      app(
        new HermesServerAdapter({
          request: vi.fn(async () => {
            throw error
          }),
        })
      ).request(`${origin}/api/aos/v1/runtime`)

    const rejected = await failing(new HermesAuthenticationError())
    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "runtime_authentication_required",
        description: expect.any(String),
      },
    })

    // Runtime discovery is how the browser learns a runtime is unreachable, so
    // it answers with unavailable state rather than an error.
    const unreachable = await failing(new HermesHttpError(503))
    expect(unreachable.status).toBe(200)
    await expect(unreachable.json()).resolves.toMatchObject({
      status: "unavailable",
    })
  })

  it("maps a provider failure on the content routes to a friendly error", async () => {
    const transport: HermesRpcTransport = {
      request: vi.fn(async () => {
        throw new HermesHttpError(503)
      }),
    }

    const path = `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`
    const response = await app(new HermesServerAdapter(transport)).request(
      path,
      stageRequest
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        code: "temporarily_unavailable",
        description: expect.any(String),
      },
    })

    // A write that may have landed is no caller error: the route answers it
    // 503, under the code that says to reconcile first.
    const uncertain = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(uncertain, "getSession").mockRejectedValue(
      new HermesTurnPublicError("AOS_STOP_UNCERTAIN", "Stop was not confirmed.")
    )
    const reconcile = await app(uncertain).request(path, stageRequest)
    expect(reconcile.status).toBe(503)
    expect(await reconcile.json()).toMatchObject({
      error: { code: "uncertain_mutation" },
    })
  })

  it("maps an owned Session miss to a friendly not-found response", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockRejectedValue(
      new HermesSessionNotFoundError()
    )

    const response = await app(runtime).request(
      `${origin}/api/aos/v1/agents/researcher/sessions/stored/attachments/stage`,
      stageRequest
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "not_found", description: expect.any(String) },
    })
  })

  it("keeps liveness independent from provider readiness", async () => {
    const runtime = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new Error("offline")
      }),
    })
    const proxy = app(runtime)

    expect((await proxy.request(`${origin}/api/aos/v1/healthz`)).status).toBe(
      200
    )
    expect((await proxy.request(`${origin}/api/aos/v1/readyz`)).status).toBe(
      503
    )
  })

  it("logs the request path without its query on a completed and a failed request", async () => {
    const runtime = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new HermesHttpError(503)
      }),
    })
    const logs = captureLogs()
    const proxy = createProxyApp({
      publicOrigin: origin,
      runtimeInstance: runtimeInstance(runtime),
      logger: logs.logger,
      health,
    })

    // An artifact read is a REST route that reaches the provider, so an outage
    // there is the failure a log line has to name its path for.
    const path = "/api/aos/v1/agents/researcher/sessions/stored/artifacts/art-1"
    expect((await proxy.request(`${origin}${path}?token=secret`)).status).toBe(
      503
    )

    expect(logs.records()).toContainEqual({
      level: "error",
      message: "request.failed",
      fields: expect.objectContaining({
        code: "temporarily_unavailable",
        path,
      }),
    })
    expect(logs.records()).toContainEqual({
      level: "info",
      message: "request.completed",
      fields: expect.objectContaining({ method: "GET", status: 503, path }),
    })
  })

  it("opens an MCP App view only from the Session that holds its call", async () => {
    const runtime = new HermesServerAdapter({ request: vi.fn() })
    vi.spyOn(runtime, "getSession").mockImplementation(async (agentId, id) =>
      session(agentId, id)
    )
    // A call the runtime finds only in the Session that made it.
    const owned = (sessionId: string, toolCallId: string) => {
      if (sessionId !== "stored" || toolCallId !== "call-1")
        throw new McpAppNotFoundError()
    }
    const mcpApps: ServerMcpApps = {
      describe: vi.fn(async () => true),
      open: vi.fn(async (scope, toolCallId) => {
        owned(scope.providerSessionId, toolCallId)
        return { html: "<p>view</p>" }
      }),
      callTool: vi.fn(async (scope, toolCallId) => {
        owned(scope.providerSessionId, toolCallId)
        return { content: [] }
      }),
      readResource: vi.fn(async () => ({ contents: [] })),
    }
    Object.defineProperty(runtime, "mcpApps", { value: mcpApps })
    const proxy = app(runtime)
    const view = (sessionId: string) =>
      `${origin}/api/aos/v1/agents/researcher/sessions/${sessionId}/tool-calls/call-1/app`

    expect((await proxy.request(view("stored"))).status).toBe(200)
    expect((await proxy.request(view("other"))).status).toBe(404)
    const call = await proxy.request(`${view("other")}/tools/call`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "refresh", arguments: {} }),
    })
    expect(call.status).toBe(404)
    expect(await call.json()).toMatchObject({ error: { code: "not_found" } })
  })
})

const REPORT = "/srv/agent/report.pdf"
/** The operator listener's own headers on every answer. */
const LISTENER_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}
/** The policy the file route sets on every answer but a PDF's. */
const SANDBOX = "default-src 'none'; frame-ancestors 'none'; sandbox"
/** Every refusal's answer, whatever refused it. */
const REFUSAL = {
  headers: { ...LISTENER_HEADERS, "content-security-policy": SANDBOX },
  body: "",
}

/** The stored call most cases read: `aos-ui`'s `present_artifact` of REPORT. */
const reportCall: McpToolCall = {
  server: "aos-ui",
  tool: "present_artifact",
  input: { path: REPORT, title: "Q3" },
}

/** One call's MCP App path on the operator listener. */
function appPath(sessionId = "stored", toolCallId = "call-1") {
  return `/api/aos/v1/agents/researcher/sessions/${sessionId}/tool-calls/${toolCallId}/app`
}

/** An answer as a client can tell it apart, its request id aside. */
async function observed(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(
      [...response.headers].filter(([name]) => name !== "x-request-id")
    ),
    body: await response.text(),
  }
}

/** The pass an offered address carries. */
function passOf(address: string) {
  return new URL(address, origin).searchParams.get("pass") ?? ""
}

/**
 * An operator app serving files under the default settings, over a runtime
 * whose Session `stored` holds `call-1` as `call` describes it: `null` is a
 * call no server matches, and a `null` reader a runtime that reads no files.
 * Its view gets the call's own input unless `viewInput` differs.
 */
function fileProxy(
  setup: {
    call?: McpToolCall | null
    viewInput?: Record<string, unknown>
    reader?: ServerFileReader | null
    files?: Partial<AppFileOptions>
    clock?: () => number
  } = {}
) {
  const runtime = new HermesServerAdapter({ request: vi.fn() })
  const getSession = vi
    .spyOn(runtime, "getSession")
    .mockImplementation(async (agentId, id) => session(agentId, id))
  vi.spyOn(runtime, "agentFolder").mockResolvedValue("/srv/agent")
  const call = setup.call === undefined ? reportCall : setup.call
  const toolCall = vi.fn<NonNullable<ServerMcpApps["toolCall"]>>(
    async (scope, toolCallId) =>
      scope.providerSessionId === "stored" && toolCallId === "call-1"
        ? (call ?? undefined)
        : undefined
  )
  const open = vi.fn<ServerMcpApps["open"]>(async () => ({
    html: "<p>view</p>",
    toolInput: setup.viewInput ?? (call ?? reportCall).input,
  }))
  const mcpApps: ServerMcpApps = {
    describe: vi.fn(async () => true),
    open,
    toolCall,
    callTool: vi.fn(async () => ({ content: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
  }
  Object.defineProperty(runtime, "mcpApps", { value: mcpApps })
  const read = vi.fn<ServerFileReader["read"]>(
    async () =>
      new Response("%PDF-1", {
        headers: { "content-type": "application/pdf", "content-length": "6" },
      })
  )
  Object.defineProperty(runtime, "readFile", {
    value: setup.reader === null ? undefined : (setup.reader ?? { read }),
  })
  const logs = captureLogs()
  const files: AppFileOptions = {
    ...appFileSettings(undefined),
    passes: createFilePassService(),
    calls: createAppFileCalls(),
    logger: logs.logger,
    ...setup.files,
  }
  const proxy = app(runtime, {
    files,
    logger: logs.logger,
    ...(setup.clock ? { clock: setup.clock } : {}),
  })
  return { proxy, getSession, toolCall, open, read, files, logs }
}

/** Opens `call-1`'s view in `sessionId`, as the workspace does. */
async function openView(proxy: ReturnType<typeof app>, sessionId = "stored") {
  const response = await proxy.request(`${origin}${appPath(sessionId)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as McpAppView
}

describe("MCP App files", () => {
  const offer = {
    addresses: {
      path: expect.stringMatching(
        /^\/api\/aos\/v1\/agents\/researcher\/sessions\/stored\/tool-calls\/call-1\/app\/files\/path\?pass=[\w.-]+$/u
      ),
    },
    expiresAt: expect.any(String),
  }
  const chart: McpToolCall = {
    server: "aos-ui",
    tool: "render_chart",
    input: { series: [1, 2] },
  }
  const pass: FilePassScope = {
    role: "operator",
    agentId: "researcher",
    sessionId: "stored",
    toolCallId: "call-1",
  }

  it.each<
    [string, Parameters<typeof fileProxy>[0], McpAppFiles | undefined, number]
  >([
    [
      "a call from a server named aos_ui",
      { call: { ...reportCall, server: "aos_ui" } },
      offer,
      200,
    ],
    ["a call that names no file", { call: chart }, undefined, 404],
    [
      "a call that names no file, though its view's copy does",
      { call: chart, viewInput: reportCall.input },
      { addresses: {} },
      404,
    ],
    [
      "a call from a server outside servers",
      { call: { ...reportCall, server: "search" } },
      { addresses: {} },
      404,
    ],
    [
      "a native tool named present_artifact",
      { call: null },
      { addresses: {} },
      404,
    ],
    [
      "a call on a runtime without readFile",
      { reader: null },
      { addresses: {} },
      404,
    ],
  ])("gives %s only the files it may read", async (_, setup, files, status) => {
    const { proxy } = fileProxy(setup)

    expect((await openView(proxy)).files).toEqual(files)
    expect(
      (await proxy.request(`${origin}${appPath()}/files/path`)).status
    ).toBe(status)
  })

  it("refuses every argument and Session it may not serve with one empty 404, before any read", async () => {
    const input = {
      path: REPORT,
      outside: "/srv/other/report.pdf",
      nested: { path: REPORT },
      home: "~/report.pdf",
      doubled: "/srv/agent//report.pdf",
      dotted: "/srv/agent/./report.pdf",
      parent: "/srv/agent/../agent/report.pdf",
      nul: "/srv/agent/report.pdf\u0000.txt",
    }
    const { proxy, getSession, read } = fileProxy({
      call: { ...reportCall, input },
    })
    const file = async (argument: string) =>
      observed(await proxy.request(`${origin}${appPath()}/files/${argument}`))

    // The folders refuse this one; every other refusal answers alike.
    const refusal = await file("outside")
    expect(refusal).toEqual({ status: 404, ...REFUSAL })
    for (const argument of [
      "missing",
      "nested",
      "__proto__",
      "constructor",
      "home",
      "doubled",
      "dotted",
      "parent",
      "nul",
    ])
      expect(await file(argument), argument).toEqual(refusal)
    getSession.mockRejectedValueOnce(new ServerSessionNotFoundError())
    expect(await file("path"), "a Session gone").toEqual(refusal)
    expect(read).not.toHaveBeenCalled()
  })

  it.each<[string, ServerFileReader["read"], number]>([
    [
      "a missing file",
      async () => new Response(`no file at ${REPORT}`, { status: 404 }),
      404,
    ],
    [
      "a runtime refusal",
      async () => new Response(`${REPORT} is outside`, { status: 403 }),
      404,
    ],
    [
      "a runtime that does not answer",
      async () => {
        throw new Error(`timed out on ${REPORT}`)
      },
      503,
    ],
    [
      "a runtime's 401",
      async () => new Response(`no login for ${REPORT}`, { status: 401 }),
      503,
    ],
    [
      "a runtime's 500",
      async () => new Response(`crashed on ${REPORT}`, { status: 500 }),
      503,
    ],
    [
      "a range past the file's end",
      async () =>
        new Response(`past the end of ${REPORT}`, {
          status: 416,
          headers: { "content-length": "37" },
        }),
      416,
    ],
  ])("answers %s with an empty %i", async (_, read, status) => {
    const { proxy } = fileProxy({ reader: { read } })

    expect(
      await observed(await proxy.request(`${origin}${appPath()}/files/path`))
    ).toEqual({ status, ...REFUSAL })
  })

  it("passes on only the runtime headers a file needs, and lets only a view that sent a pass read the answer", async () => {
    const { proxy, read } = fileProxy({
      call: {
        ...reportCall,
        input: { path: REPORT, notes: "/srv/agent/notes.txt" },
      },
    })
    read.mockImplementation(
      async (_scope, path) =>
        new Response("body", {
          headers: {
            "content-type": path.endsWith(".pdf")
              ? "application/pdf"
              : "text/plain",
            "content-length": "4",
            "accept-ranges": "bytes",
            "access-control-allow-credentials": "true",
            "cache-control": "max-age=3600",
            "content-encoding": "gzip",
            "set-cookie": "native=synthetic",
            "x-native-path": path,
          },
        })
    )
    const { files } = await openView(proxy)
    const passed = { "accept-ranges": "bytes", "content-length": "4" }

    // A browser renders no sandboxed PDF, so a PDF keeps the listener's policy.
    expect(
      await observed(await proxy.request(`${origin}${files?.addresses.path}`))
    ).toEqual({
      status: 200,
      headers: {
        ...LISTENER_HEADERS,
        ...passed,
        "access-control-allow-origin": "null",
        "content-disposition": "inline; filename*=UTF-8''report.pdf",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "content-type": "application/pdf",
      },
      body: "body",
    })
    expect(
      await observed(await proxy.request(`${origin}${appPath()}/files/notes`))
    ).toEqual({
      status: 200,
      headers: {
        ...LISTENER_HEADERS,
        ...passed,
        "content-disposition": "inline; filename*=UTF-8''notes.txt",
        "content-security-policy": SANDBOX,
        "content-type": "text/plain",
      },
      body: "body",
    })
  })

  it.each([
    [
      "page.html",
      "text/html; charset=utf-8",
      "text/plain; charset=utf-8",
      "page.html",
    ],
    ["image.svg", "image/svg+xml", "application/octet-stream", "image.svg"],
    ["feed.xml", "application/xml", "application/octet-stream", "feed.xml"],
    ["report.pdf", "application/pdf", "application/pdf", "report.pdf"],
    ["photo.png", "IMAGE/PNG", "image/png", "photo.png"],
    [
      'notes "v2"; (final).txt',
      "text/plain",
      "text/plain",
      "notes%20%22v2%22%3B%20%28final%29.txt",
    ],
  ])(
    "serves %s, reported as %s, as %s",
    async (name, reported, served, filename) => {
      const { proxy, read } = fileProxy({
        call: { ...reportCall, input: { path: `/srv/agent/${name}` } },
      })
      read.mockResolvedValue(
        new Response("x", { headers: { "content-type": reported } })
      )

      const response = await proxy.request(`${origin}${appPath()}/files/path`)

      expect(response.headers.get("content-type")).toBe(served)
      expect(response.headers.get("content-disposition")).toBe(
        `inline; filename*=UTF-8''${filename}`
      )
    }
  )

  it("streams one byte range and stops the read once the client leaves", async () => {
    const { proxy, read } = fileProxy()
    const url = `${origin}${appPath()}/files/path`
    read.mockResolvedValueOnce(
      new Response("PD", {
        status: 206,
        headers: {
          "content-type": "application/pdf",
          "content-range": "bytes 1-2/6",
          "content-length": "2",
        },
      })
    )

    const ranged = await proxy.request(url, { headers: { range: "bytes=1-2" } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe("bytes 1-2/6")
    expect(await ranged.text()).toBe("PD")
    expect(read.mock.lastCall?.[2]).toMatchObject({ range: "bytes=1-2" })
    // Several ranges are more than a runtime reads, so the file is read whole.
    await proxy.request(url, { headers: { range: "bytes=0-1,4-5" } })
    expect(read.mock.lastCall?.[2]).not.toHaveProperty("range")

    const cancelled = vi.fn()
    const first = new TextEncoder().encode("%PDF-")
    read.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(first),
            cancel: cancelled,
          }),
          { headers: { "content-type": "application/pdf" } }
        )
    )
    const client = new AbortController()
    const streamed = await proxy.request(url, { signal: client.signal })
    const body = streamed.body!.getReader()
    // The first bytes arrive while the runtime still holds the file open.
    expect((await body.read()).value).toEqual(first)
    const signal = read.mock.lastCall![2].signal
    expect(signal.aborted).toBe(false)
    client.abort()
    expect(signal.aborted).toBe(true)
    await body.cancel()
    expect(cancelled).toHaveBeenCalled()

    // A HEAD answer drops the body, so its read stops at once.
    const dropped = vi.fn()
    read.mockImplementationOnce(
      async () =>
        new Response(new ReadableStream({ cancel: dropped }), {
          headers: { "content-type": "application/pdf" },
        })
    )
    expect((await proxy.request(url, { method: "HEAD" })).status).toBe(200)
    expect(dropped).toHaveBeenCalled()
  })

  it("renews a call's addresses only for the configured origin and a call the Session holds", async () => {
    const { proxy } = fileProxy()
    const renew = (from: string, path = appPath()) =>
      proxy.request(`${origin}${path}/files`, {
        method: "POST",
        headers: { origin: from },
      })

    expect((await renew("https://attacker.example.test")).status).toBe(403)
    expect((await renew(origin, appPath("stored", "call-2"))).status).toBe(404)
    const renewed = await renew(origin)
    expect(renewed.status).toBe(200)
    const files = (await renewed.json()) as McpAppFiles
    expect(files).toEqual(offer)
    expect(
      (await proxy.request(`${origin}${files.addresses.path}`)).status
    ).toBe(200)
  })

  it("limits file reads and renewals apart from the view's own requests", async () => {
    // One instant, so every request falls in one window.
    const { proxy } = fileProxy({
      files: { ratePerSecond: 11 },
      clock: () => Date.UTC(2026, 0, 1),
    })
    const file = () => proxy.request(`${origin}${appPath()}/files/path`)

    for (let count = 0; count < 10; count += 1)
      expect((await file()).status).toBe(200)
    const renewal = await proxy.request(`${origin}${appPath()}/files`, {
      method: "POST",
      headers: { origin },
    })
    expect(renewal.status).toBe(200)
    // Eleven file requests spent none of the view's own ten.
    expect((await proxy.request(`${origin}${appPath()}`)).status).toBe(200)
    expect((await file()).status).toBe(429)
  })

  it("keeps a call's paths and passes out of its view, its refusals, and the log", async () => {
    const { proxy, toolCall, open, read, logs } = fileProxy()
    // Two Sessions whose calls share one id, each naming its own file.
    const paths: Record<string, string> = {
      stored: REPORT,
      other: "/srv/agent/other.pdf",
    }
    const input = (scope: SessionScope) => ({
      path: paths[scope.providerSessionId],
      title: "Q3",
    })
    toolCall.mockImplementation(async (scope) => ({
      ...reportCall,
      input: input(scope),
    }))
    // A runtime's own copy of the call may spell a path its own way.
    open.mockImplementation(async (scope) => ({
      html: "<p>view</p>",
      toolInput: { ...input(scope), path: `file://${input(scope).path}` },
    }))

    const stored = await openView(proxy, "stored")
    const other = await openView(proxy, "other")
    expect(stored.toolInput).toEqual({ title: "Q3" })
    await proxy.request(`${origin}${stored.files?.addresses.path}`)
    expect(read.mock.lastCall?.[1]).toBe(REPORT)
    await proxy.request(`${origin}${other.files?.addresses.path}`)
    expect(read.mock.lastCall?.[1]).toBe(paths.other)

    // One Session's pass opens no other Session's call.
    const storedPass = passOf(stored.files?.addresses.path ?? "")
    expect(
      (
        await proxy.request(
          `${origin}${appPath("other")}/files/path?pass=${storedPass}`
        )
      ).status
    ).toBe(401)
    // Neither a refusal nor an outage names a path, in its answer or the log.
    const refused = await proxy.request(
      `${origin}${appPath()}/files/title?pass=${storedPass}`
    )
    expect(await refused.text()).toBe("")
    read.mockRejectedValueOnce(new Error(`cannot read ${REPORT}`))
    const failed = await proxy.request(
      `${origin}${stored.files?.addresses.path}`
    )
    expect(await failed.text()).toBe("")
    expect(logs.records().map(({ message }) => message)).toEqual(
      expect.arrayContaining(["app_file.refused", "app_file.unavailable"])
    )
    const logged = JSON.stringify(logs.records())
    for (const secret of [
      "/srv/agent",
      storedPass,
      passOf(other.files?.addresses.path ?? ""),
    ])
      expect(logged).not.toContain(secret)
  })

  it.each<[string, (files: AppFileOptions, sent: string) => Promise<string>]>([
    [
      "tampered",
      async (_, sent) =>
        `${sent.slice(0, sent.lastIndexOf(".") + 1)}${"A".repeat(43)}`,
    ],
    [
      "expired",
      async (files) =>
        (await files.passes.issue(pass, Math.floor(Date.now() / 1_000) - 1))
          .pass,
    ],
    ["foreign", async () => (await createFilePassService().issue(pass)).pass],
    [
      "another call's",
      async (files) =>
        (await files.passes.issue({ ...pass, toolCallId: "call-2" })).pass,
    ],
    [
      "a guest's",
      async (files) =>
        (await files.passes.issue({ ...pass, role: "guest" })).pass,
    ],
  ])("refuses a %s pass with an empty 401", async (_, forge) => {
    const { proxy, read, files } = fileProxy()
    const view = await openView(proxy)
    const forged = await forge(files, passOf(view.files?.addresses.path ?? ""))

    const response = await proxy.request(
      `${origin}${appPath()}/files/path?pass=${forged}`
    )

    expect(await observed(response)).toEqual({
      status: 401,
      headers: {
        ...REFUSAL.headers,
        "access-control-allow-origin": "null",
      },
      body: "",
    })
    expect(read).not.toHaveBeenCalled()
  })
})
