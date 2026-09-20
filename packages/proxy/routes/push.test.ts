// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PushRegistration } from "../../protocol/push"
import { createProxyApp } from "../app"
import type { RuntimeInstance } from "../core/runtime"
import { openPushRegistrations } from "../push/registrations"

const ORIGIN = "https://aos.example.test"
const PUBLIC_KEY = "A".repeat(87)
const ENDPOINT = "https://push.example/subscription-id"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

const runtimeInstance = {
  id: "test-runtime",
  runtime: {
    publicError: () => undefined,
    runtimeInfo: async () => ({ status: "ready" }),
  },
  sessions: {},
  close: async () => undefined,
} as unknown as RuntimeInstance

function registration(endpoint = ENDPOINT): PushRegistration {
  return {
    subscription: {
      endpoint,
      keys: { p256dh: "B".repeat(87), auth: "C".repeat(22) },
    },
    locale: "en",
    categories: { input: true, failure: true, completion: false },
  }
}

async function harness(options: { push?: boolean; maxDevices?: number } = {}) {
  const logger = { info: vi.fn(), error: vi.fn() }
  const directory = await mkdtemp(join(tmpdir(), "aos-push-routes-"))
  directories.push(directory)
  const registrations = await openPushRegistrations({
    stateDir: directory,
    ...(options.maxDevices === undefined
      ? {}
      : { maxPerPrincipal: options.maxDevices }),
  })
  const app = createProxyApp({
    publicOrigin: ORIGIN,
    runtimeInstance,
    logger,
    ...(options.push === false
      ? {}
      : { push: { publicKey: PUBLIC_KEY, registrations } }),
  })
  return {
    app,
    logger,
    registrations,
    info: () => app.request(`${ORIGIN}/api/aos/v1/push`),
    put: (body: unknown, origin = ORIGIN) =>
      app.request(`${ORIGIN}/api/aos/v1/push/subscriptions`, {
        method: "PUT",
        headers: { origin, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    remove: (body: unknown, origin = ORIGIN) =>
      app.request(`${ORIGIN}/api/aos/v1/push/subscriptions`, {
        method: "DELETE",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  }
}

describe("push routes", () => {
  it("publishes the application server key and nothing else", async () => {
    const test = await harness()

    const response = await test.info()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: "available",
      publicKey: PUBLIC_KEY,
    })
  })

  it("reports a deployment without push and refuses its writes", async () => {
    const test = await harness({ push: false })

    const info = await test.info()

    expect(info.status).toBe(200)
    await expect(info.json()).resolves.toEqual({ status: "not-configured" })
    expect((await test.put(registration())).status).toBe(404)
    expect((await test.remove({ endpoint: ENDPOINT })).status).toBe(404)
  })

  it("registers a device from the trusted origin only", async () => {
    const test = await harness()

    expect(
      (await test.put(registration(), "https://attacker.example.test")).status
    ).toBe(403)
    expect(test.registrations.list("operator")).toEqual([])

    expect((await test.put(registration())).status).toBe(204)

    expect(test.registrations.list("operator")).toEqual([
      { ...registration(), createdAt: expect.any(String) },
    ])
  })

  it.each([
    ["a plain HTTP endpoint", registration("http://push.example/x")],
    ["an address literal", registration("https://127.0.0.1/x")],
    ["an unqualified name", registration("https://localhost/x")],
    [
      "no subscription keys",
      { ...registration(), subscription: { endpoint: ENDPOINT } },
    ],
    ["an unknown field", { ...registration(), title: "leak" }],
    ["an unknown locale", { ...registration(), locale: "fr" }],
  ])("refuses a registration with %s", async (_label, body) => {
    const test = await harness()

    expect((await test.put(body)).status).toBe(400)
    expect(test.registrations.list("operator")).toEqual([])
  })

  it("refuses a body past the bound without reading it", async () => {
    const test = await harness()

    const response = await test.put(
      JSON.stringify({ ...registration(), padding: "p".repeat(17 * 1024) })
    )

    expect(response.status).toBe(400)
    expect(test.registrations.list("operator")).toEqual([])
  })

  it("refuses one device past the deployment's limit", async () => {
    const test = await harness({ maxDevices: 2 })
    expect(
      (await test.put(registration("https://push.example/one"))).status
    ).toBe(204)
    expect(
      (await test.put(registration("https://push.example/two"))).status
    ).toBe(204)

    const response = await test.put(registration("https://push.example/three"))

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe(
      "registration_limit_exceeded"
    )
    expect(test.registrations.list("operator")).toHaveLength(2)
  })

  it("unregisters a device from the trusted origin only", async () => {
    const test = await harness()
    await test.put(registration())

    expect(
      (
        await test.remove(
          { endpoint: ENDPOINT },
          "https://attacker.example.test"
        )
      ).status
    ).toBe(403)
    expect(test.registrations.list("operator")).toHaveLength(1)

    expect((await test.remove({ endpoint: ENDPOINT })).status).toBe(204)

    expect(test.registrations.list("operator")).toEqual([])
    // An unregistration names one endpoint and nothing else.
    expect((await test.remove({})).status).toBe(400)
    expect((await test.remove({ endpoint: ENDPOINT, all: true })).status).toBe(
      400
    )
  })

  it("never writes a device endpoint to the log", async () => {
    const test = await harness()

    await test.put(registration())
    await test.remove({ endpoint: ENDPOINT })

    const logged = JSON.stringify([
      ...test.logger.info.mock.calls,
      ...test.logger.error.mock.calls,
    ])
    expect(logged).toContain("/api/aos/v1/push/subscriptions")
    expect(logged).not.toContain("push.example")
    expect(logged).not.toContain("p256dh")
  })
})
