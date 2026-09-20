import { describe, expect, it, vi } from "vitest"

import { AosClientError, AosRemoteClient } from "./aos-client"

const AGENT_ID = "researcher"
const SESSION_ID = "opaque-session-1"

/** The normalized deployment descriptor the REST runtime route serves. */
function runtimeInfo() {
  return {
    runtime: { id: "hermes", name: "Hermes" },
    status: "ready",
    capabilities: {
      agentCatalog: { status: "available" },
      agentVisibility: { status: "available", concurrency: "revision" },
      sessionCatalog: {
        status: "available",
        scope: "workspace",
        order: "recent",
        defaultPageSize: 50,
        maxPageSize: 100,
        maxWindow: 1_000,
      },
      sessionHistory: {
        status: "available",
        order: "chronological",
        compacted: true,
        loading: "on-open",
        defaultPageSize: 200,
        maxPageSize: 500,
      },
      sessionDetail: { status: "available" },
      sessionCreation: { status: "available" },
      sessionTitle: { status: "available" },
      sessionArchival: { status: "available" },
      sessionDeletion: { status: "available" },
      sessionRun: { status: "available" },
      sessionStop: { status: "available" },
      sessionSteer: { status: "available" },
      sessionReadState: { status: "available" },
    },
  }
}

/** Serves every byte route the client still owns, and nothing else. */
function byteFetcher() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith("/runtime")) return Response.json(runtimeInfo())
    if (path.endsWith("/attachments/stage")) {
      expect(init?.method).toBe("POST")
      return Response.json({
        stageId: "stage-1",
        attachments: [
          { type: "file", filename: "brief.pdf", mimeType: "application/pdf" },
        ],
      })
    }
    if (path.includes("/artifacts/"))
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
      })
    if (path.endsWith("/audio/transcribe")) {
      expect(init?.method).toBe("POST")
      return Response.json({ transcript: "Hello" })
    }
    if (path.endsWith("/audio/speak"))
      return new Response(Uint8Array.from([1, 2]), {
        headers: { "content-type": "audio/mpeg" },
      })
    throw new Error(`Unexpected normalized request: ${path}`)
  })
}

describe("normalized AOS REST byte client", () => {
  it("reads the deployment descriptor from the same-origin runtime route", async () => {
    const fetcher = byteFetcher()
    const client = new AosRemoteClient({ fetcher })

    await expect(client.runtimeInfo()).resolves.toMatchObject({
      status: "ready",
    })

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/runtime",
    ])
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
    })
  })

  it("uses a normalized error description instead of proxy response details", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              description:
                "The service is temporarily unavailable. Please try again.",
            },
          },
          { status: 503 }
        )
      ),
    })

    await expect(client.runtimeInfo()).rejects.toMatchObject({
      name: "AosClientError",
      kind: "provider-unavailable",
      code: "temporarily_unavailable",
      message: "The service is temporarily unavailable. Please try again.",
    } satisfies Partial<AosClientError>)
  })

  it("reports an unreachable proxy separately from a proxy failure", async () => {
    const offline = new AosRemoteClient({
      fetcher: vi.fn(async () => {
        throw new Error("network down")
      }),
    })
    const invalid = new AosRemoteClient({
      fetcher: vi.fn(async () => Response.json({ status: "ready" })),
    })

    await expect(offline.runtimeInfo()).rejects.toMatchObject({
      kind: "connection-interrupted",
    })
    await expect(invalid.runtimeInfo()).rejects.toMatchObject({
      kind: "proxy-failure",
    })
  })

  it("routes Session bytes through the Agent that owns the Session", async () => {
    const fetcher = byteFetcher()
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership(SESSION_ID, AGENT_ID)

    await expect(
      client.stageAttachments(SESSION_ID, [
        {
          type: "file",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AQ==",
        },
      ])
    ).resolves.toMatchObject({ stageId: "stage-1" })
    await expect(
      client.readArtifact(SESSION_ID, "artifact-1")
    ).resolves.toBeInstanceOf(Blob)
    await expect(
      client.transcribe(SESSION_ID, new Blob(["audio"], { type: "audio/webm" }))
    ).resolves.toBe("Hello")
    await expect(client.speak(SESSION_ID, "Hello")).resolves.toBeInstanceOf(
      Blob
    )

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1/attachments/stage",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1/artifacts/artifact-1",
      "/api/aos/v1/agents/researcher/audio/transcribe",
      "/api/aos/v1/agents/researcher/audio/speak",
    ])
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      attachments: [
        {
          type: "file",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AQ==",
        },
      ],
    })
  })

  it("refuses Session bytes until ownership is known and never reassigns it", async () => {
    const fetcher = byteFetcher()
    const client = new AosRemoteClient({ fetcher })

    await expect(
      client.readArtifact(SESSION_ID, "artifact-1")
    ).rejects.toThrow()
    client.adoptSessionOwnership(SESSION_ID, AGENT_ID)
    expect(() =>
      client.adoptSessionOwnership(SESSION_ID, AGENT_ID)
    ).not.toThrow()
    expect(() => client.adoptSessionOwnership(SESSION_ID, "other")).toThrow()
    expect(() => client.adoptSessionOwnership("", AGENT_ID)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("uses an Agent directly for draft voice without requiring Session ownership", async () => {
    const fetcher = byteFetcher()
    const client = new AosRemoteClient({ fetcher })

    await expect(
      client.transcribeForAgent(
        AGENT_ID,
        new Blob(["audio"], { type: "audio/webm" })
      )
    ).resolves.toBe("Hello")
    await expect(
      client.speakForAgent(AGENT_ID, "Hello")
    ).resolves.toBeInstanceOf(Blob)

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/agents/researcher/audio/transcribe",
      "/api/aos/v1/agents/researcher/audio/speak",
    ])
  })

  it("serves an invited guest from its own base path and bearer invitation", async () => {
    const fetcher = byteFetcher()
    const client = new AosRemoteClient({
      fetcher,
      basePath: "/api/guest/v1",
      authorization: "Bearer invitation-token",
    })
    client.adoptSessionOwnership("guest_ref", AGENT_ID)

    await expect(
      client.readArtifact("guest_ref", "artifact-1")
    ).resolves.toBeInstanceOf(Blob)

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/guest/v1/agents/researcher/sessions/guest_ref/artifacts/artifact-1"
    )
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")
    ).toBe("Bearer invitation-token")
  })

  it("rejects byte requests and responses it cannot trust", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () => new Response(Uint8Array.from([1]))),
    })
    client.adoptSessionOwnership(SESSION_ID, AGENT_ID)

    await expect(client.readArtifact(SESSION_ID, "   ")).rejects.toMatchObject({
      kind: "proxy-failure",
    })
    await expect(
      client.transcribe(SESSION_ID, new Blob([], { type: "" }))
    ).rejects.toMatchObject({ kind: "proxy-failure" })
    // A blob response without a declared media type cannot be presented safely.
    await expect(
      client.readArtifact(SESSION_ID, "artifact-1")
    ).rejects.toMatchObject({ kind: "proxy-failure" })
  })

  it("separates a pruned artifact from a proxy failure and a provider outage", async () => {
    const pruned = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json(
          { error: { code: "not_found", description: "Artifact not found" } },
          { status: 404 }
        )
      ),
    })
    pruned.adoptSessionOwnership(SESSION_ID, AGENT_ID)
    const outage = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json(
          { error: { code: "temporarily_unavailable", description: "Later" } },
          { status: 503 }
        )
      ),
    })
    outage.adoptSessionOwnership(SESSION_ID, AGENT_ID)

    await expect(
      pruned.readArtifact(SESSION_ID, "artifact-1")
    ).rejects.toMatchObject({
      name: "AosClientError",
      kind: "artifact-missing",
      message: "Artifact not found",
    } satisfies Partial<AosClientError>)
    // Only the artifact read reads a 404 as bytes the provider no longer holds.
    await expect(pruned.speak(SESSION_ID, "Hello")).rejects.toMatchObject({
      kind: "proxy-failure",
    })
    await expect(
      outage.readArtifact(SESSION_ID, "artifact-1")
    ).rejects.toMatchObject({ kind: "provider-unavailable" })
  })
})

describe("this device's push subscription", () => {
  const subscription = {
    endpoint: "https://push.example/endpoint-1",
    keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  }
  const registration = {
    subscription,
    locale: "he" as const,
    categories: { input: true, failure: true, completion: false },
  }

  it("reads what the deployment offers and refuses a descriptor it cannot trust", async () => {
    const available = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json({ status: "available", publicKey: "k".repeat(87) })
      ),
    })
    const malformed = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json({ status: "available", publicKey: "too-short" })
      ),
    })

    await expect(available.pushInfo()).resolves.toEqual({
      status: "available",
      publicKey: "k".repeat(87),
    })
    await expect(malformed.pushInfo()).rejects.toMatchObject({
      kind: "proxy-failure",
    })
  })

  it("registers and retires this device on the subscriptions route", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const client = new AosRemoteClient({ fetcher })

    await expect(
      client.putPushSubscription(registration)
    ).resolves.toBeUndefined()
    await expect(
      client.deletePushSubscription(subscription.endpoint)
    ).resolves.toBeUndefined()

    expect(
      fetcher.mock.calls.map(([input, init]) => [
        String(input),
        init?.method,
        init?.body,
      ])
    ).toEqual([
      ["/api/aos/v1/push/subscriptions", "PUT", JSON.stringify(registration)],
      [
        "/api/aos/v1/push/subscriptions",
        "DELETE",
        JSON.stringify({ endpoint: subscription.endpoint }),
      ],
    ])
  })

  it("refuses an endpoint it cannot send and reports proxy failures", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () => new Response(null, { status: 500 })),
    })

    await expect(client.deletePushSubscription("")).rejects.toMatchObject({
      kind: "proxy-failure",
      message: "Invalid push subscription",
    })
    await expect(
      client.putPushSubscription(registration)
    ).rejects.toMatchObject({ kind: "proxy-failure" })
  })
})
