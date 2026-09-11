import { afterEach, expect, it, vi } from "vitest"
import { OpenClawClient } from "./openclaw-client"
import { MockGateway } from "./mock-gateway"
import {
  createOpenClawInteractions,
  createOpenClawWorkspace,
  OpenClawArtifactAdapter,
  projectOpenClawApprovals,
  createOpenClawQueue,
  projectOpenClawArtifacts,
  OpenClawThreadListAdapter,
} from "./openclaw-adapters"

const clients: OpenClawClient[] = []
async function setup() {
  const gateway = new MockGateway()
  gateway.responses.set("artifacts.download", {
    artifact: {
      id: "file-1",
      sessionKey: "agent:alice:main",
      mimeType: "text/plain",
    },
    encoding: "base64",
    data: btoa("hello"),
  })
  const client = new OpenClawClient({
    gatewayUrl: "ws://localhost:18789",
    createSocket: gateway.createSocket,
    deviceAuth: {
      loadIdentity: async () => null,
      tokenStore: { load: () => null, store: () => {}, clear: () => {} },
    },
  })
  clients.push(client)
  await client.start()
  return { client, gateway }
}
afterEach(() => clients.splice(0).forEach((client) => client.stop()))
it("exposes shared ownership metadata and leaves unsupported operations absent", async () => {
  const { client } = await setup()
  const workspace = createOpenClawWorkspace(client)
  expect(await workspace.getSessionMetadata(["agent:bob:main"])).toEqual([
    {
      agentId: "bob",
      threadId: "agent:bob:main",
      updatedAt: "1970-01-01T00:00:01.000Z",
      status: "idle",
    },
  ])
  expect(workspace.subscribeTodos).toBeUndefined()
  expect(workspace.updateAgentVisibility).toBeUndefined()
  expect(workspace.updateAgent).toBeUndefined()
})
it("holds stable pending-question snapshots until the native request changes", async () => {
  const { client, gateway } = await setup()
  const interactions = createOpenClawInteractions(client)
  gateway.event("question.requested", {
    id: "q",
    sessionKey: "agent:alice:main",
    status: "pending",
    expiresAtMs: 9999999999999,
    questions: [
      {
        questionId: "name",
        header: "Name",
        question: "Which name?",
        options: [],
      },
    ],
  })
  expect(interactions.getPending("agent:alice:main")).toBe(
    interactions.getPending("agent:alice:main")
  )
  expect(interactions.getPending("agent:alice:main")?.requestId).toBe("q")
})
it("resolves artifact bytes only within the selected Agent and Session", async () => {
  const { client, gateway } = await setup()
  const adapter = new OpenClawArtifactAdapter(client)
  const options = {
    agentId: "alice",
    threadId: "agent:alice:main",
    signal: new AbortController().signal,
    artifact: {
      id: "file-1",
      filename: "hello.txt",
      source: { type: "provider" as const, reference: "file-1" },
    },
  }
  expect((await adapter.resolve(options)).size).toBe(5)
  expect(gateway.requests.at(-1)?.params).toEqual({
    agentId: "alice",
    sessionKey: "agent:alice:main",
    artifactId: "file-1",
  })
  await expect(adapter.resolve({ ...options, agentId: "bob" })).rejects.toThrow(
    /ownership/
  )
  gateway.responses.set("artifacts.download", {
    artifact: { id: "file-1", sessionKey: "agent:bob:main" },
    encoding: "base64",
    data: btoa("secret"),
  })
  await expect(adapter.resolve(options)).rejects.toThrow(/ownership/)
})
it("renders only native approval choices with localized labels", () => {
  const messages = projectOpenClawApprovals(
    [],
    [
      {
        id: "a",
        createdAtMs: 0,
        expiresAtMs: 9999999999999,
        request: {
          sessionKey: "agent:alice:main",
          command: "pwd",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    ],
    "he"
  )
  expect(messages[0]?.status).toEqual({
    type: "requires-action",
    reason: "tool-calls",
  })
  expect(messages[0]?.content).toMatchObject([
    {
      type: "tool-call",
      approval: {
        id: "a",
        options: [
          { id: "allow-once", label: "אישור פעם אחת" },
          { id: "deny", label: "דחייה" },
        ],
      },
    },
  ])
})
it("parks a queued prompt until active native work completes", async () => {
  const { client, gateway } = await setup()
  const queue = createOpenClawQueue(client, "agent:alice:main")
  queue.sync()
  await client.submit("agent:alice:main", "Running")
  queue.sync()
  queue.controller.adapter.enqueue({
    role: "user",
    content: [{ type: "text", text: "Queued" }],
    attachments: [],
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    createdAt: new Date(0),
    runConfig: undefined,
  })
  expect(client.session("agent:alice:main")?.running).toBe(true)
  expect(gateway.requests.filter((r) => r.method === "chat.send")).toHaveLength(
    1
  )
  gateway.event("chat", {
    sessionKey: "agent:alice:main",
    runId: "run-1",
    seq: 1,
    state: "final",
    message: { role: "assistant", content: "Done" },
  })
  gateway.responses.set("chat.send", { runId: "run-2", status: "started" })
  queue.sync()
  await vi.waitFor(() =>
    expect(
      gateway.requests.filter((r) => r.method === "chat.send")
    ).toHaveLength(2)
  )
  expect(
    gateway.requests.filter((r) => r.method === "chat.send")[1]?.params.message
  ).toBe("Queued")
})
it("projects canonical artifact receipts without granting local file paths authority", () => {
  const base = {
    id: "message",
    role: "assistant",
    content: [
      {
        type: "tool-call",
        result: {
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "file-1",
            filename: "report.txt",
            source: { type: "provider", reference: "native-id" },
          },
        },
      },
    ],
  }
  expect(projectOpenClawArtifacts([base])[0]?.content).toMatchObject([
    {},
    {
      type: "data",
      name: "aos.artifact",
      data: { id: "file-1", source: { reference: "native-id" } },
    },
  ])
  const pathReceipt = {
    ...base,
    content: [
      {
        type: "tool-call",
        result: {
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "file",
            filename: "report.txt",
            path: "reports/report.txt",
          },
        },
      },
    ],
  }
  expect(projectOpenClawArtifacts([pathReceipt])[0]?.content).toHaveLength(1)
})
it("uses native Session patch semantics for rename, archive, and unarchive", async () => {
  const { client, gateway } = await setup()
  // A new connection refreshes advertised methods.
  gateway.responses.set("sessions.patch", { ok: true })
  client.stop()
  await client.start()
  const adapter = new OpenClawThreadListAdapter(client)
  await adapter.rename("agent:alice:main", "New title")
  await adapter.archive("agent:alice:main")
  await adapter.unarchive("agent:alice:main")
  expect(
    gateway.requests
      .filter((request) => request.method === "sessions.patch")
      .map((request) => request.params)
  ).toEqual([
    { key: "agent:alice:main", agentId: "alice", label: "New title" },
    { key: "agent:alice:main", agentId: "alice", archived: true },
    { key: "agent:alice:main", agentId: "alice", archived: false },
  ])
})
