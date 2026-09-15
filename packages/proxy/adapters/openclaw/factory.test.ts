import { createHash, generateKeyPairSync } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { RuntimeLimits } from "../../config"
import type { OpenClawClientOptions } from "./client"
import { createOpenClawRuntime } from "./factory"

const temporaryDirectories: string[] = []
const limits: RuntimeLimits = {
  activeExecutions: 4,
  guestActiveExecutions: 2,
  operatorEventPeers: 4,
  subscriberEvents: 20,
  subscriberBytes: 4096,
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function credentials(deviceIdOverride?: string) {
  const directory = await mkdtemp(join(tmpdir(), "aos-openclaw-factory-"))
  temporaryDirectories.push(directory)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" })
  const deviceId = createHash("sha256")
    .update(publicKeyDer.subarray(publicKeyDer.byteLength - 32))
    .digest("hex")
  const identityFile = join(directory, "identity.json")
  const tokenFile = join(directory, "token")
  await writeFile(
    identityFile,
    JSON.stringify({
      deviceId: deviceIdOverride ?? deviceId,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    }),
    { mode: 0o600 }
  )
  await writeFile(tokenFile, "device-token\n", { mode: 0o600 })
  await Promise.all([chmod(identityFile, 0o600), chmod(tokenFile, 0o600)])
  return { identityFile, tokenFile }
}

describe("OpenClaw runtime factory", () => {
  it("loads server credentials and owns one configured official client", async () => {
    const files = await credentials()
    let options: OpenClawClientOptions | undefined
    const client = {
      start: vi.fn(async () => undefined),
      stopAndWait: vi.fn(async () => undefined),
      request: vi.fn(),
      negotiatedPolicy: vi.fn(() => ({ maxPayload: 1024 })),
    }
    const instance = await createOpenClawRuntime(
      {
        kind: "openclaw",
        id: "openclaw-local",
        baseUrl: "ws://127.0.0.1:18789",
        deviceIdentityFile: files.identityFile,
        deviceTokenFile: files.tokenFile,
      },
      limits,
      {
        clientFactory: (input) => {
          options = input
          return client
        },
      }
    )

    expect(instance.id).toBe("openclaw-local")
    expect(options).toMatchObject({
      url: "ws://127.0.0.1:18789",
      role: "operator",
      scopes: [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
      ],
      credentials: {
        deviceIdentity: {
          deviceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        deviceToken: "device-token",
      },
    })
    expect(options?.caps).toEqual(
      expect.arrayContaining([
        "approvals",
        "session-scoped-events",
        "tool-events",
      ])
    )
    expect(options?.onEvent).toEqual(expect.any(Function))
    expect(options?.onGap).toEqual(expect.any(Function))
    expect(options?.onClose).toEqual(expect.any(Function))

    await Promise.all([instance.close(), instance.close()])
    expect(client.stopAndWait).toHaveBeenCalledTimes(1)
  })

  it("rejects an invalid pre-provisioned device identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-openclaw-factory-"))
    temporaryDirectories.push(directory)
    const identityFile = join(directory, "identity.json")
    const tokenFile = join(directory, "token")
    await writeFile(identityFile, '{"deviceId":"device-a"}', { mode: 0o600 })
    await writeFile(tokenFile, "device-token", { mode: 0o600 })

    await expect(
      createOpenClawRuntime(
        {
          kind: "openclaw",
          id: "openclaw-local",
          baseUrl: "ws://127.0.0.1:18789",
          deviceIdentityFile: identityFile,
          deviceTokenFile: tokenFile,
        },
        limits
      )
    ).rejects.toThrow("Invalid OpenClaw device identity")
  })

  it("rejects device identity metadata that does not match its key", async () => {
    const files = await credentials("0".repeat(64))

    await expect(
      createOpenClawRuntime(
        {
          kind: "openclaw",
          id: "openclaw-local",
          baseUrl: "ws://127.0.0.1:18789",
          deviceIdentityFile: files.identityFile,
          deviceTokenFile: files.tokenFile,
        },
        limits
      )
    ).rejects.toThrow("Invalid OpenClaw device identity")
  })
})
