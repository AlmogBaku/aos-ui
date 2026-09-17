import { expect, it, vi } from "vitest"
import { EventType } from "@ag-ui/core"
import { HermesServerAdapter } from "./adapter"
import { nativeSlashCommands } from "./slash-commands"
import { HermesRunEngine, type HermesRunNative } from "./run"
import { HermesRpcError } from "./transport"
import { rpcRouter } from "./test-utils/rpc-router"

const scope = {
  agentId: "writer",
  sessionId: "stored",
  threadId: "stored",
}

it("projects native slash catalog names in order without duplicate or malformed entries", async () => {
  const router = rpcRouter({
    "session.resume": async () => ({ session_id: "live", running: false }),
    "commands.catalog": async () => ({
      pairs: [
        ["/help", "Help"],
        ["/skill", "Skill"],
        ["/help", "Duplicate"],
        ["/bad name", "Invalid"],
      ],
    }),
  })
  const adapter = new HermesServerAdapter({
    ...router,
    http: async () => ({ id: "stored", profile: "writer", title: "Work" }),
  })
  await expect(adapter.slashCommands("writer", "stored")).resolves.toEqual([
    { name: "help", description: "Help" },
    { name: "skill", description: "Skill" },
  ])
  const catalogCall = router.calls("commands.catalog")[0]
  expect(catalogCall?.params).toEqual({ session_id: "live", profile: "writer" })
  expect(catalogCall?.maxResponseBytes).toEqual(expect.any(Number))
})

it("includes skill commands that follow the first 256 catalog entries", async () => {
  const pairs = [
    ...Array.from({ length: 256 }, (_, index) => [
      `/native-${index}`,
      `Native ${index}`,
    ]),
    ["/writing-plans", "Write an implementation plan"],
  ]
  const transport = {
    request: vi.fn(async () => ({ pairs })),
  }

  await expect(nativeSlashCommands(transport, {})).resolves.toContainEqual({
    name: "writing-plans",
    description: "Write an implementation plan",
  })
})

it("keeps the capability response usable when the native catalog is unavailable", async () => {
  const adapter = new HermesServerAdapter({
    request: vi.fn(async () => {
      throw new Error("catalog offline")
    }),
  })

  await expect(
    adapter.workspaceCapabilities("writer", "stored")
  ).resolves.toMatchObject({
    workspace: {
      slashCommands: {
        status: "unavailable",
        reason: "command-catalog-unavailable",
      },
      models: { status: "available" },
    },
  })
})

it("rejects a malformed catalog instead of treating it as an authoritative miss", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { commands: [] }
    throw new Error("unexpected RPC")
  })

  await expect(
    new HermesServerAdapter({ request }).submit("live", {
      scope,
      text: "/help",
      runId: "run",
    })
  ).resolves.toEqual({ acknowledgement: "rejected" })
  expect(request).toHaveBeenCalledOnce()
})

it("routes an exact native command to slash.exec and exposes synchronous text", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
    if (method === "slash.exec") return { output: "<script>text only</script>" }
    throw new Error("unexpected RPC")
  })
  const adapter = new HermesServerAdapter({ request })
  await expect(
    adapter.submit("live", {
      scope,
      text: "/help details",
      runId: "run",
    })
  ).resolves.toEqual({
    acknowledgement: "accepted",
    completion: { output: "<script>text only</script>" },
  })
  expect(request).toHaveBeenCalledWith(
    "slash.exec",
    { command: "help details", session_id: "live" },
    expect.any(Number)
  )
  expect(
    request.mock.calls.some(([method]) => method === "prompt.submit")
  ).toBe(false)
})

it("preserves native prefill results for commands such as undo", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs: [["/undo", "Undo"]] }
    if (method === "slash.exec")
      return {
        type: "prefill",
        message: "Earlier question",
        notice: "Undid 1 turn.",
      }
    throw new Error("unexpected RPC")
  })

  await expect(
    new HermesServerAdapter({ request }).submit("live", {
      scope,
      text: "/undo",
      runId: "run",
    })
  ).resolves.toEqual({
    acknowledgement: "accepted",
    completion: {
      output: "Undid 1 turn.",
      composerPrefill: "Earlier question",
    },
  })
})

it("recognizes typed commands from the full native catalog", async () => {
  const pairs = Array.from({ length: 257 }, (_, index) => [
    `/command-${index}`,
    `Command ${index}`,
  ])
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs }
    if (method === "slash.exec") return { output: "Last command" }
    throw new Error("unexpected RPC")
  })

  await expect(
    new HermesServerAdapter({ request }).submit("live", {
      scope,
      text: "/command-256",
      runId: "run",
    })
  ).resolves.toEqual({
    acknowledgement: "accepted",
    completion: { output: "Last command" },
  })
  expect(
    request.mock.calls.some(([method]) => method === "prompt.submit")
  ).toBe(false)
})

it.each([
  ["/q now", "quit now"],
  ["/Help", "help"],
])(
  "routes Hermes canonical aliases and case-folded commands: %s",
  async (text, command) => {
    const request = vi.fn(async (method: string) => {
      if (method === "commands.catalog")
        return {
          pairs: [
            ["/help", "Help"],
            ["/quit", "Quit"],
          ],
          canon: {
            "/help": "/help",
            "/quit": "/quit",
            "/q": "/quit",
          },
        }
      if (method === "slash.exec") return { output: "Done" }
      throw new Error("unexpected RPC")
    })

    await new HermesServerAdapter({ request }).submit("live", {
      scope,
      text,
      runId: "run",
    })

    expect(request).toHaveBeenCalledWith(
      "slash.exec",
      { command, session_id: "live" },
      expect.any(Number)
    )
    expect(
      request.mock.calls.some(([method]) => method === "prompt.submit")
    ).toBe(false)
  }
)

it("keeps commands whose native descriptions exceed the public limit", async () => {
  const commands = await nativeSlashCommands(
    {
      request: async () => ({ pairs: [["/long", "x".repeat(5_000)]] }),
    },
    { session_id: "live", profile: "writer" }
  )

  expect(commands).toEqual([{ name: "long", description: "x".repeat(4_096) }])
})

it.each(["/unknown", "/constructor", " /help", "/helpful", "normal text"])(
  "sends unmatched text normally: %s",
  async (text) => {
    const request = vi.fn(async (method: string) =>
      method === "commands.catalog"
        ? { pairs: [["/help", "Help"]], canon: { "/help": "/help" } }
        : { status: "streaming" }
    )
    const adapter = new HermesServerAdapter({ request })
    await adapter.submit("live", { scope, text, runId: "run" })
    expect(request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "live",
      text,
    })
    expect(request.mock.calls.some(([method]) => method === "slash.exec")).toBe(
      false
    )
  }
)

it.each([-32601, 4018])(
  "uses command.dispatch only after explicit native unsupported code %s",
  async (code) => {
    const request = vi.fn(async (method: string) => {
      if (method === "commands.catalog") return { pairs: [["/skill", "Skill"]] }
      if (method === "slash.exec") throw new HermesRpcError(code)
      if (method === "command.dispatch")
        return { type: "skill", name: "skill", message: "Expanded skill" }
      return { status: "streaming" }
    })
    const adapter = new HermesServerAdapter({ request })
    await expect(
      adapter.submit("live", {
        scope,
        text: "/skill arguments",
        runId: "run",
      })
    ).resolves.toEqual({ acknowledgement: "accepted" })
    expect(request).toHaveBeenCalledWith(
      "command.dispatch",
      { session_id: "live", name: "skill", arg: "arguments" },
      expect.any(Number)
    )
    expect(request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "live",
      text: "Expanded skill",
    })
  }
)

it.each([
  [new HermesRpcError(5030), "rejected"],
  [new Error("uncertain connection"), "throws"],
] as const)(
  "never retries execution failure through another dispatch or chat: %s",
  async (failure, outcome) => {
    const request = vi.fn(async (method: string) => {
      if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
      throw failure
    })
    const submission = new HermesServerAdapter({ request }).submit("live", {
      scope,
      text: "/help",
      runId: "run",
    })
    if (outcome === "rejected")
      await expect(submission).resolves.toEqual({ acknowledgement: "rejected" })
    else await expect(submission).rejects.toThrow()
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "commands.catalog",
      "slash.exec",
    ])
  }
)

it("follows native aliases and completes outputless synchronous commands", async () => {
  const request = vi.fn(
    async (method: string, params: Readonly<Record<string, unknown>>) => {
      if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
      if (params.command === "help info")
        return { type: "alias", target: "/status more" }
      return { type: "exec" }
    }
  )
  await expect(
    new HermesServerAdapter({ request }).submit("live", {
      scope,
      text: "/help info",
      runId: "run",
    })
  ).resolves.toEqual({
    acknowledgement: "accepted",
    completion: { output: "" },
  })
  expect(request).toHaveBeenCalledWith(
    "slash.exec",
    { session_id: "live", command: "status more info" },
    expect.any(Number)
  )
})

it("rejects recognized commands with attachments and sends unknown ones normally", async () => {
  const request = vi.fn(async (method: string) =>
    method === "commands.catalog"
      ? { pairs: [["/help", "Help"]] }
      : { status: "streaming" }
  )
  const adapter = new HermesServerAdapter({ request })
  await expect(
    adapter.submit("live", {
      scope: { ...scope, hasAttachments: true },
      text: "/help",
      runId: "one",
    })
  ).resolves.toEqual({
    acknowledgement: "rejected",
    rejection: "command-with-attachments",
  })
  await adapter.submit("live", {
    scope: { ...scope, hasAttachments: true },
    text: "/unknown",
    runId: "two",
  })
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "commands.catalog",
    "commands.catalog",
    "prompt.submit",
  ])
})

it("finishes a synchronous command run without waiting for native conversational events", async () => {
  const native: HermesRunNative = {
    resume: async () => ({ liveSessionId: "live" }),
    observe: async () => () => {},
    recover: async () => ({ epoch: "epoch", lastSeen: 0, events: [] }),
    status: async () => "idle",
    interrupt: async () => {},
    submit: async () => ({
      acknowledgement: "accepted",
      completion: { output: "Help output" },
    }),
  }
  const engine = new HermesRunEngine(native)
  const handle = await engine.start(
    { agentId: "writer", sessionId: "stored", threadId: "thread" },
    {
      threadId: "thread",
      runId: "run",
      state: {},
      messages: [{ id: "user", role: "user", content: "/help" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }
  )
  const events = []
  for await (const event of handle.events) events.push(event)
  expect(events.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ])
  expect(events[2]).toMatchObject({ delta: "Help output" })
  expect(events[4]).toMatchObject({ threadId: "thread", runId: "run" })
})
