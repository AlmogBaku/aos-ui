// @vitest-environment node

import { generateKeyPairSync, randomBytes, type JsonWebKey } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { PushMessage } from "../../protocol/push"
import {
  createPushSender,
  topicFor,
  type PushFetch,
  type PushSenderOptions,
  type PushTarget,
} from "./sender"
import { deriveVapidPublicKey } from "./vapid"

/** The P-256 scalar of a freshly generated pair; no key is ever committed. */
function privateScalar() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const { d } = privateKey.export({ format: "jwk" }) as JsonWebKey
  return new Uint8Array(Buffer.from(d ?? "", "base64url"))
}

let vapid: PushSenderOptions["vapid"]
let target: PushTarget

beforeAll(() => {
  const serverKey = privateScalar()
  vapid = {
    subject: "mailto:ops@example.test",
    publicKey: deriveVapidPublicKey(serverKey),
    privateKey: serverKey,
  }
  target = {
    subscription: {
      endpoint: "https://push.example/subscription-id",
      keys: {
        p256dh: deriveVapidPublicKey(privateScalar()),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  }
})

const MESSAGE: PushMessage = {
  v: 1,
  category: "input",
  count: 1,
  agentId: "researcher",
  sessionId: "session-1",
  occurredAt: "2026-09-20T10:00:00.000Z",
  locale: "en",
}

const publicLookup = vi.fn(async () => [{ address: "8.8.8.8" }])

function sender(post: PushFetch) {
  return createPushSender({ vapid, fetch: post, lookup: publicLookup })
}

function accepting(status: number) {
  return vi.fn<PushFetch>(async () => ({ ok: status < 300, status }))
}

describe("push sender", () => {
  it("reports an accepted message as sent, with the options a push service reads", async () => {
    const post = accepting(201)

    await expect(sender(post).send(target, MESSAGE, "high")).resolves.toEqual({
      result: "sent",
    })

    expect(post).toHaveBeenCalledOnce()
    const [endpoint, init] = post.mock.calls[0]!
    expect(endpoint).toBe(target.subscription.endpoint)
    expect(init.method).toBe("post")
    expect(init.redirect).toBe("error")
    expect(init.headers).toMatchObject({
      ttl: "3600",
      urgency: "high",
      topic: topicFor("input"),
      "content-encoding": "aes128gcm",
    })
    // The vendor pads every message to one size, so nothing about the
    // notification leaks through its length.
    expect(init.body.byteLength).toBe(4_096)
  })

  it("reports an unsubscribed device as gone and any other status as failed", async () => {
    await expect(
      sender(accepting(404)).send(target, MESSAGE, "high")
    ).resolves.toEqual({ result: "gone", status: 404 })
    await expect(
      sender(accepting(410)).send(target, MESSAGE, "high")
    ).resolves.toEqual({ result: "gone", status: 410 })
    await expect(
      sender(accepting(500)).send(target, MESSAGE, "normal")
    ).resolves.toEqual({ result: "failed", status: 500 })
  })

  it("reports a transport that throws as failed, without rethrowing", async () => {
    const post = vi.fn<PushFetch>(async () => {
      throw new Error(`redirected to ${target.subscription.endpoint}`)
    })

    await expect(sender(post).send(target, MESSAGE, "high")).resolves.toEqual({
      result: "failed",
    })
  })

  it("never posts to an endpoint that resolves inside the deployment", async () => {
    const post = accepting(201)
    const privateSender = createPushSender({
      vapid,
      fetch: post,
      lookup: vi.fn(async () => [{ address: "10.0.0.5" }]),
    })

    await expect(privateSender.send(target, MESSAGE, "high")).resolves.toEqual({
      result: "failed",
    })
    expect(post).not.toHaveBeenCalled()
  })

  it("never posts to an endpoint that is not a public https URL", async () => {
    const post = accepting(201)

    await expect(
      sender(post).send(
        {
          subscription: {
            ...target.subscription,
            endpoint: "http://push.example/x",
          },
        },
        MESSAGE,
        "high"
      )
    ).resolves.toEqual({ result: "failed" })
    expect(post).not.toHaveBeenCalled()
  })

  it("derives one stable opaque topic per category", () => {
    expect(topicFor("input")).toMatch(/^[0-9a-f]{32}$/u)
    expect(topicFor("input")).toBe(topicFor("input"))
    expect(topicFor("input")).not.toBe(topicFor("completion"))
    expect(topicFor("failure")).not.toBe(topicFor("completion"))
  })
})
