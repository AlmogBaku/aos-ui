import { describe, expect, it } from "vitest"

import { useFakeClock } from "../../../test/support/fake-clock"
import { createFilePassService, type FilePassScope } from "./file-pass"
import { createGuestInvitationService } from "./guest-invitation"

const scope: FilePassScope = {
  role: "operator",
  agentId: "agent-1",
  sessionId: "session-1",
  toolCallId: "call-1",
}

/** The pass with `claims` merged into its payload and its signature kept. */
function tampered(pass: string, claims: Record<string, unknown>) {
  const [header, payload, signature] = pass.split(".")
  const merged = {
    ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as object),
    ...claims,
  }
  return [
    header,
    Buffer.from(JSON.stringify(merged)).toString("base64url"),
    signature,
  ].join(".")
}

describe("file pass", () => {
  it.each<[string, Partial<FilePassScope>]>([
    ["another tool call", { toolCallId: "call-2" }],
    ["another Session", { sessionId: "session-2" }],
    ["another Agent", { agentId: "agent-2" }],
    ["another role", { role: "guest" }],
  ])("opens its own call and not %s", async (_, other) => {
    const passes = createFilePassService()
    const { pass } = await passes.issue(scope)

    expect(await passes.opens(pass, scope)).toBe(true)
    expect(await passes.opens(pass, { ...scope, ...other })).toBe(false)
  })

  it.each<[string, number | undefined, number]>([
    ["ten minutes", undefined, 600],
    ["no longer than an invitation ending in two minutes", 120, 120],
  ])("lasts %s", async (_, invitationLeft, lifetime) => {
    const clock = useFakeClock()
    const passes = createFilePassService()
    const now = Math.floor(Date.now() / 1_000)
    const { pass, expiresAt } = await passes.issue(
      scope,
      invitationLeft === undefined ? undefined : now + invitationLeft
    )

    expect(expiresAt).toBe(now + lifetime)
    await clock.advance((lifetime - 1) * 1_000)
    expect(await passes.opens(pass, scope)).toBe(true)
    await clock.advance(1_000)
    expect(await passes.opens(pass, scope)).toBe(false)
  })

  it.each<[string, (pass: string) => Promise<string>]>([
    [
      "a tampered pass",
      async (pass) =>
        tampered(pass, { exp: Math.floor(Date.now() / 1_000) + 3_600 }),
    ],
    [
      "a pass signed by a previous process",
      async () => (await createFilePassService().issue(scope)).pass,
    ],
    [
      "an invitation",
      async () =>
        (
          await createGuestInvitationService({
            issuer: "aos-invite",
            audience: "aos-guest",
            deploymentId: "deployment-1",
            runtimeId: "runtime-1",
            keys: [{ id: "key-1", secret: new Uint8Array(32).fill(7) }],
          }).issue({ agentId: scope.agentId, ref: scope.sessionId })
        ).token,
    ],
  ])("refuses %s", async (_, offered) => {
    const passes = createFilePassService()
    const { pass } = await passes.issue(scope)

    expect(await passes.opens(await offered(pass), scope)).toBe(false)
  })
})
