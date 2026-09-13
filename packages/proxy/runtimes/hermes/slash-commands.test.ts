import { expect, it, vi } from "vitest"
import { EventType } from "@ag-ui/core"
import { HermesServerAdapter, type HermesRpcTransport } from "./adapter"
import { HermesRunEngine, type HermesRunNative } from "./run"
import { HermesRpcError } from "./transport"

it("projects native slash catalog names in order without duplicate or malformed entries", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "session.resume") return { session_id: "live", running: false }
    if (method === "commands.catalog") return { pairs: [["/help", "Help"], ["/skill", "Skill"], ["/help", "Duplicate"], ["/bad name", "Invalid"]] }
    throw new Error("unexpected RPC")
  })
  const adapter = new HermesServerAdapter({ request, http: async () => ({ id: "stored", profile: "writer", title: "Work" }) })
  await expect(adapter.slashCommands("writer", "hermes:writer:stored")).resolves.toEqual({ commands: [{ name: "help", description: "Help" }, { name: "skill", description: "Skill" }] })
  expect(request).toHaveBeenCalledWith("commands.catalog", { session_id: "live", profile: "writer" }, expect.any(Number))
})

it("routes an exact native command to slash.exec and exposes synchronous text", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
    if (method === "slash.exec") return { output: "<script>text only</script>" }
    throw new Error("unexpected RPC")
  })
  const adapter = new HermesServerAdapter({ request })
  await expect(adapter.submit("live", { text: "/help details", runId: "run" })).resolves.toEqual({ acknowledgement: "accepted", completion: { output: "<script>text only</script>" } })
  expect(request).toHaveBeenCalledWith("slash.exec", { command: "help details", session_id: "live" }, expect.any(Number))
  expect(request.mock.calls.some(([method]) => method === "prompt.submit")).toBe(false)
})

it.each(["/unknown", "/Help", " /help", "/helpful", "normal text"])("sends unmatched text normally: %s", async (text) => {
  const request = vi.fn(async (method: string) => method === "commands.catalog" ? { pairs: [["/help", "Help"]] } : { status: "streaming" })
  const adapter = new HermesServerAdapter({ request })
  await adapter.submit("live", { text, runId: "run" })
  expect(request).toHaveBeenCalledWith("prompt.submit", { session_id: "live", text })
  expect(request.mock.calls.some(([method]) => method === "slash.exec")).toBe(false)
})

it.each([-32601, 4018])("uses command.dispatch only after explicit native unsupported code %s", async (code) => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs: [["/skill", "Skill"]] }
    if (method === "slash.exec") throw new HermesRpcError(code)
    if (method === "command.dispatch") return { type: "skill", name: "skill", message: "Expanded skill" }
    return { status: "streaming" }
  })
  const adapter = new HermesServerAdapter({ request })
  await expect(adapter.submit("live", { text: "/skill arguments", runId: "run" })).resolves.toEqual({ acknowledgement: "accepted" })
  expect(request).toHaveBeenCalledWith("command.dispatch", { session_id: "live", name: "skill", arg: "arguments" }, expect.any(Number))
  expect(request).toHaveBeenCalledWith("prompt.submit", { session_id: "live", text: "Expanded skill" })
})

it.each([new HermesRpcError(5030), new Error("uncertain connection")])("never retries execution failure through another dispatch or chat", async (failure) => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
    throw failure
  })
  await expect(new HermesServerAdapter({ request }).submit("live", { text: "/help", runId: "run" })).rejects.toThrow()
  expect(request.mock.calls.map(([method]) => method)).toEqual(["commands.catalog", "slash.exec"])
})

it("follows native aliases and completes outputless synchronous commands", async () => {
  const request = vi.fn(async (method: string, params: Readonly<Record<string, unknown>>) => {
    if (method === "commands.catalog") return { pairs: [["/help", "Help"]] }
    if (params.command === "help info") return { type: "alias", target: "/status more" }
    return { type: "exec" }
  })
  await expect(new HermesServerAdapter({ request }).submit("live", { text: "/help info", runId: "run" })).resolves.toEqual({ acknowledgement: "accepted", completion: { output: "" } })
  expect(request).toHaveBeenCalledWith("slash.exec", { session_id: "live", command: "status more info" }, expect.any(Number))
})

it("keeps command-looking attachment turns and failed discovery on the normal chat path", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "commands.catalog") throw new Error("discovery unavailable")
    return { status: "streaming" }
  })
  const adapter = new HermesServerAdapter({ request })
  await adapter.submit("live", { text: "/help", runId: "one", allowSlashCommands: false })
  await adapter.submit("live", { text: "/help", runId: "two" })
  expect(request.mock.calls.map(([method]) => method)).toEqual(["prompt.submit", "commands.catalog", "prompt.submit"])
})

it("finishes a synchronous command run without waiting for native conversational events", async () => {
  const native: HermesRunNative = {
    resume: async () => ({ liveSessionId: "live" }),
    observe: async () => () => {},
    recover: async () => ({ epoch: "epoch", lastSeen: 0, events: [] }),
    status: async () => "idle",
    interrupt: async () => {},
    submit: async () => ({ acknowledgement: "accepted", completion: { output: "Help output" } }),
  }
  const engine = new HermesRunEngine(native)
  const handle = await engine.start({ agentId: "writer", sessionId: "stored", threadId: "thread" }, { threadId: "thread", runId: "run", state: {}, messages: [{ id: "user", role: "user", content: "/help" }], tools: [], context: [], forwardedProps: {} })
  const events = []
  for await (const event of handle.events) events.push(event)
  expect(events.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED])
  expect(events[2]).toMatchObject({ delta: "Help output" })
  expect(events[4]).toMatchObject({ threadId: "thread", runId: "run" })
})
