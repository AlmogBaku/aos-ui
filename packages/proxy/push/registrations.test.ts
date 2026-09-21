// @vitest-environment node

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PushRegistration } from "../../protocol/push"
import {
  openPushRegistrations,
  PushRegistrationLimitError,
  PUSH_REGISTRATIONS_FILE,
} from "./registrations"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

async function stateDir() {
  const directory = await mkdtemp(join(tmpdir(), "aos-push-state-"))
  directories.push(directory)
  return directory
}

const NOW = 1_700_000_000_000

function registration(suffix: string): PushRegistration {
  return {
    subscription: {
      endpoint: `https://push.example.test/${suffix}`,
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    },
    locale: "en",
    categories: { input: true, failure: true, completion: false },
  }
}

describe("push registration file", () => {
  it("keeps one device per endpoint across a reopen", async () => {
    const directory = await stateDir()
    const registrations = await openPushRegistrations({
      stateDir: directory,
      now: () => NOW,
    })

    await registrations.put("operator", registration("device-1"))
    await registrations.put("operator", registration("device-2"))
    expect(registrations.list("operator")).toEqual([
      { ...registration("device-1"), createdAt: new Date(NOW).toISOString() },
      { ...registration("device-2"), createdAt: new Date(NOW).toISOString() },
    ])

    const replacement = {
      ...registration("device-1"),
      locale: "he" as const,
      categories: { input: false, failure: true, completion: true },
    }
    await registrations.put("operator", replacement)
    expect(registrations.list("operator")).toHaveLength(2)

    await registrations.remove(
      "operator",
      registration("device-2").subscription.endpoint
    )

    const reopened = await openPushRegistrations({ stateDir: directory })
    expect(reopened.list("operator")).toEqual([
      { ...replacement, createdAt: new Date(NOW).toISOString() },
    ])
  })

  it("keeps the devices in an owner-only file and leaves nothing beside it", async () => {
    const directory = await stateDir()
    const registrations = await openPushRegistrations({ stateDir: directory })

    await registrations.put("operator", registration("device-1"))

    const details = await stat(join(directory, PUSH_REGISTRATIONS_FILE))
    expect(details.mode & 0o077).toBe(0)
    expect(await readdir(directory)).toEqual([PUSH_REGISTRATIONS_FILE])
  })

  it("refuses the device past the limit instead of evicting one", async () => {
    const directory = await stateDir()
    const registrations = await openPushRegistrations({
      stateDir: directory,
      maxPerPrincipal: 2,
    })
    await registrations.put("operator", registration("device-1"))
    await registrations.put("operator", registration("device-2"))

    await expect(
      registrations.put("operator", registration("device-3"))
    ).rejects.toThrow(PushRegistrationLimitError)

    expect(registrations.list("operator")).toHaveLength(2)
    // A device already registered still refreshes past the limit.
    await expect(
      registrations.put("operator", registration("device-1"))
    ).resolves.toBeUndefined()
  })

  it("starts empty and reports a file it cannot read, without its contents", async () => {
    const directory = await stateDir()
    await writeFile(
      join(directory, PUSH_REGISTRATIONS_FILE),
      '{"version":1,"principals":{"operator":[{"subscription":{"endpoint":"https://push.example.test/leak"}}]}}'
    )
    const logger = { info: vi.fn(), error: vi.fn() }

    const registrations = await openPushRegistrations({
      stateDir: directory,
      logger,
    })

    expect(registrations.list("operator")).toEqual([])
    expect(logger.error).toHaveBeenCalledWith({
      event: "push.registrations.invalid",
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "push.example"
    )
  })

  it("refuses to open a state directory that is not there", async () => {
    const directory = await stateDir()

    await expect(
      openPushRegistrations({ stateDir: join(directory, "missing") })
    ).rejects.toThrow("Push state directory")
  })

  it("lands both of two concurrent registrations", async () => {
    const directory = await stateDir()
    const registrations = await openPushRegistrations({ stateDir: directory })

    await Promise.all([
      registrations.put("operator", registration("device-1")),
      registrations.put("operator", registration("device-2")),
    ])

    const stored = JSON.parse(
      await readFile(join(directory, PUSH_REGISTRATIONS_FILE), "utf8")
    ) as { principals: Record<string, unknown[]> }
    expect(stored.principals["operator"]).toHaveLength(2)
  })

  it("keeps one principal's devices out of another's", async () => {
    const directory = await stateDir()
    const registrations = await openPushRegistrations({ stateDir: directory })

    await registrations.put("operator", registration("device-1"))
    await registrations.put("guest-7", registration("device-2"))

    expect(registrations.list("operator")).toHaveLength(1)
    expect(registrations.list("guest-7")).toHaveLength(1)
    expect(registrations.list("nobody")).toEqual([])
    await registrations.remove(
      "nobody",
      registration("device-1").subscription.endpoint
    )
    expect(registrations.list("operator")).toHaveLength(1)
  })
})
