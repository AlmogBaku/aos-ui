import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import {
  GuestInvitationError,
  createGuestInvitationServiceForTest,
  guestOperations,
  type GuestOperation,
} from "./guest-invitation"

const currentKey = new Uint8Array(32).fill(7)
const previousKey = new Uint8Array(32).fill(8)

function service(overrides?: {
  deploymentId?: string
  issuer?: string
  audience?: string
  keys?: readonly { id: string; secret: Uint8Array }[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}) {
  let sequence = 0
  return createGuestInvitationServiceForTest(
    {
      deploymentId: overrides?.deploymentId ?? "aos-prod-il1",
      issuer: overrides?.issuer ?? "https://aos.example.test",
      audience: overrides?.audience ?? "aos-guest-listener",
      keys: overrides?.keys ?? [{ id: "2026-09", secret: currentKey }],
      now: overrides?.now ?? (() => 1_700_000_000_000),
      ttlSeconds: overrides?.ttlSeconds ?? 300,
      clockSkewSeconds: overrides?.clockSkewSeconds ?? 10,
    },
    (size) => new Uint8Array(size).fill(++sequence)
  )
}

const invitation = {
  principalId: "guest_4Ez4k6W5",
  invitationId: "invite_Q9mZ2",
  agentId: "agent_planner",
  sessionId: "session_launch",
  operations: ["messages:create", "messages:read"] as const,
  capabilities: ["message-text", "custom-ui"] as const,
}

function target(operation: GuestOperation = "messages:read") {
  return {
    agentId: "agent_planner",
    sessionId: "session_launch",
    operation,
  }
}

async function rogueToken(
  claims: Record<string, unknown>,
  overrides?: { key?: Uint8Array; alg?: "HS256"; kid?: string; typ?: string }
) {
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: overrides?.alg ?? "HS256",
      kid: overrides?.kid ?? "2026-09",
      typ: overrides?.typ ?? "aos-guest-invitation+jwt",
    })
    .sign(overrides?.key ?? currentKey)
}

describe("guest invitation", () => {
  it("issues canonical, short-lived claims and verifies an exact authorization", async () => {
    const invitations = service()

    const issued = await invitations.issue({
      ...invitation,
      operations: ["messages:read", "messages:create"],
      capabilities: ["custom-ui", "message-text"],
    })

    expect(decodeProtectedHeader(issued.token)).toEqual({
      alg: "HS256",
      kid: "2026-09",
      typ: "aos-guest-invitation+jwt",
    })
    expect(decodeJwt(issued.token)).toEqual({
      aud: "aos-guest-listener",
      agent: "agent_planner",
      caps: ["custom-ui", "message-text"],
      dep: "aos-prod-il1",
      exp: 1_700_000_300,
      iat: 1_700_000_000,
      inv: "invite_Q9mZ2",
      iss: "https://aos.example.test",
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      lane: "guest",
      nbf: 1_700_000_000,
      ops: ["messages:create", "messages:read"],
      session: "session_launch",
      sub: "guest_4Ez4k6W5",
      v: 1,
    })
    expect(issued.grant).toEqual({
      version: 1,
      lane: "guest",
      issuer: "https://aos.example.test",
      audience: "aos-guest-listener",
      deploymentId: "aos-prod-il1",
      principalId: "guest_4Ez4k6W5",
      invitationId: "invite_Q9mZ2",
      agentId: "agent_planner",
      sessionId: "session_launch",
      operations: ["messages:create", "messages:read"],
      capabilities: ["custom-ui", "message-text"],
      tokenId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      issuedAt: 1_700_000_000,
      notBefore: 1_700_000_000,
      expiresAt: 1_700_000_300,
    })
    await expect(invitations.verify(issued.token, target())).resolves.toEqual({
      version: 1,
      lane: "guest",
      issuer: "https://aos.example.test",
      audience: "aos-guest-listener",
      deploymentId: "aos-prod-il1",
      principalId: "guest_4Ez4k6W5",
      invitationId: "invite_Q9mZ2",
      agentId: "agent_planner",
      sessionId: "session_launch",
      operation: "messages:read",
      capabilities: ["custom-ui", "message-text"],
      tokenId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      issuedAt: 1_700_000_000,
      notBefore: 1_700_000_000,
      expiresAt: 1_700_000_300,
    })
  })

  it("rejects tampering, alg confusion, unknown keys, and the wrong token type", async () => {
    const invitations = service()
    const issued = await invitations.issue(invitation)
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`
    const [header, payload] = issued.token.split(".")
    const unsecured = `${Buffer.from(
      JSON.stringify({
        alg: "none",
        kid: "2026-09",
        typ: "aos-guest-invitation+jwt",
      })
    ).toString("base64url")}.${payload}.`

    await expect(
      invitations.verify(tampered, target())
    ).resolves.toBeUndefined()
    await expect(
      invitations.verify(unsecured, target())
    ).resolves.toBeUndefined()
    await expect(
      invitations.verify(
        await rogueToken(decodeJwt(issued.token), { kid: "retired" }),
        target()
      )
    ).resolves.toBeUndefined()
    await expect(
      invitations.verify(`${header}.${payload}.bad`, target())
    ).resolves.toBeUndefined()
    await expect(
      invitations.verify(
        await rogueToken(decodeJwt(issued.token), { typ: "JWT" }),
        target()
      )
    ).resolves.toBeUndefined()
  })

  it("binds issuer, audience, deployment, lane, and version", async () => {
    const issued = await service().issue(invitation)
    const claims = decodeJwt(issued.token)
    const mutations = [
      { ...claims, iss: "https://attacker.example" },
      { ...claims, aud: "operator-listener" },
      { ...claims, dep: "aos-prod-us1" },
      { ...claims, lane: "operator" },
      { ...claims, v: 2 },
    ]

    for (const mutated of mutations) {
      await expect(
        service().verify(await rogueToken(mutated), target())
      ).resolves.toBeUndefined()
    }
  })

  it("enforces not-before, expiry, and only the configured clock skew", async () => {
    const issued = await service().issue(invitation)

    await expect(
      service({ now: () => 1_699_999_989_000 }).verify(issued.token, target())
    ).resolves.toBeUndefined()
    await expect(
      service({ now: () => 1_699_999_990_000 }).verify(issued.token, target())
    ).resolves.toMatchObject({
      operation: "messages:read",
      tokenId: issued.grant.tokenId,
    })
    await expect(
      service({ now: () => 1_700_000_311_000 }).verify(issued.token, target())
    ).resolves.toBeUndefined()
  })

  it("rejects wildcard, duplicate, unknown, and empty authorization scope", async () => {
    const invalidInputs = [
      { ...invitation, operations: [] },
      { ...invitation, operations: ["*"] },
      { ...invitation, operations: ["messages:read", "messages:read"] },
      { ...invitation, capabilities: [] },
      { ...invitation, capabilities: ["operator"] },
    ]

    for (const input of invalidInputs) {
      await expect(service().issue(input as never)).rejects.toBeInstanceOf(
        GuestInvitationError
      )
    }
  })

  it("rejects non-canonical or expanded signed claims", async () => {
    const issued = await service().issue(invitation)
    const claims = decodeJwt(issued.token)
    const mutations = [
      { ...claims, ops: ["messages:read", "*"] },
      { ...claims, ops: ["messages:read", "messages:create"] },
      { ...claims, caps: ["message-text", "message-text"] },
      { ...claims, operator: true },
    ]

    for (const mutated of mutations) {
      await expect(
        service().verify(await rogueToken(mutated), target())
      ).resolves.toBeUndefined()
    }
  })

  it("cannot issue or verify an operator identity or malformed invitation identity", async () => {
    await expect(
      service().issue({ ...invitation, principalId: "operator_root" })
    ).rejects.toBeInstanceOf(GuestInvitationError)
    await expect(
      service().issue({ ...invitation, invitationId: "operator_grant" })
    ).rejects.toBeInstanceOf(GuestInvitationError)

    const issued = await service().issue(invitation)
    await expect(
      service().verify(
        await rogueToken({ ...decodeJwt(issued.token), sub: "operator_root" }),
        target()
      )
    ).resolves.toBeUndefined()
  })

  it("rejects a valid signature over a non-canonical claim encoding", async () => {
    const issued = await service().issue(invitation)
    const reversedClaims = Object.fromEntries(
      Object.entries(decodeJwt(issued.token)).reverse()
    )

    await expect(
      service().verify(await rogueToken(reversedClaims), target())
    ).resolves.toBeUndefined()
  })

  it("binds use to the requested Agent and optional Session", async () => {
    const issued = await service().issue(invitation)

    await expect(
      service().verify(issued.token, {
        ...target(),
        agentId: "agent_other",
      })
    ).resolves.toBeUndefined()
    await expect(
      service().verify(issued.token, {
        agentId: "agent_planner",
        sessionId: "session_other",
        operation: "messages:read",
      })
    ).resolves.toBeUndefined()
    await expect(
      service().verify(issued.token, target())
    ).resolves.toMatchObject({ operation: "messages:read" })
  })

  it("requires one exact requested operation and returns only that bound operation", async () => {
    const issued = await service().issue({
      ...invitation,
      operations: guestOperations,
    })

    for (const operation of guestOperations) {
      const verified = await service().verify(issued.token, target(operation))
      expect(verified?.operation).toBe(operation)
      expect(verified).not.toHaveProperty("operations")
    }
    await expect(
      service().verify(issued.token, {
        agentId: "agent_planner",
        sessionId: "session_launch",
      } as never)
    ).resolves.toBeUndefined()
    await expect(
      service().verify(issued.token, {
        ...target(),
        operation: "operator:admin",
      } as never)
    ).resolves.toBeUndefined()
  })

  it("rejects an exact operation that the invitation did not grant", async () => {
    const issued = await service().issue(invitation)

    await expect(
      service().verify(issued.token, target("artifacts:read"))
    ).resolves.toBeUndefined()
  })

  it("supports explicit verification-only key rotation and issues with the first key", async () => {
    const old = await service({
      keys: [{ id: "2026-08", secret: previousKey }],
    }).issue(invitation)
    const rotated = service({
      keys: [
        { id: "2026-09", secret: currentKey },
        { id: "2026-08", secret: previousKey },
      ],
    })

    await expect(rotated.verify(old.token, target())).resolves.toMatchObject({
      operation: "messages:read",
      tokenId: old.grant.tokenId,
    })
    expect(
      decodeProtectedHeader((await rotated.issue(invitation)).token).kid
    ).toBe("2026-09")
  })

  it("returns the same token identity on stateless repeated verification", async () => {
    const issued = await service().issue(invitation)

    const first = await service().verify(issued.token, target())
    const retry = await service().verify(issued.token, target())

    expect(first).toEqual(retry)
    expect(first?.tokenId).toBe(issued.grant.tokenId)
  })

  it("rejects oversized tokens and malformed claim or target identifiers", async () => {
    await expect(
      service().verify(`a.${"a".repeat(4_097)}.a`, target())
    ).resolves.toBeUndefined()
    await expect(
      service().verify("not-a-jwt", target())
    ).resolves.toBeUndefined()
    await expect(
      service().issue({ ...invitation, agentId: `agent_${"é".repeat(200)}` })
    ).rejects.toBeInstanceOf(GuestInvitationError)
    const issued = await service().issue(invitation)
    await expect(
      service().verify(issued.token, { ...target(), agentId: "agent\nother" })
    ).resolves.toBeUndefined()
  })

  it("rejects unsafe key, lifetime, issuer, audience, and deployment configuration", () => {
    const invalid = [
      { keys: [{ id: "2026-09", secret: new Uint8Array(31) }] },
      { ttlSeconds: 3_601 },
      { clockSkewSeconds: 61 },
      { issuer: "not a URL" },
      { audience: "guest audience" },
      { deploymentId: "production\nother" },
    ]

    for (const overrides of invalid) {
      expect(() => service(overrides as never)).toThrow(GuestInvitationError)
    }
  })
})
