import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import {
  GuestInvitationError,
  createGuestInvitationService,
  guestCapabilities,
  guestOperations,
} from "./guest-invitation"

const currentKey = new Uint8Array(32).fill(7)
const previousKey = new Uint8Array(32).fill(8)

function service(overrides?: {
  deploymentId?: string
  runtimeId?: string
  issuer?: "aos-invite"
  audience?: "aos-guest"
  keys?: readonly { id: string; secret: Uint8Array }[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}) {
  return createGuestInvitationService({
    deploymentId: overrides?.deploymentId ?? "aos-prod-il1",
    runtimeId: overrides?.runtimeId ?? "hermes-primary",
    issuer: overrides?.issuer ?? "aos-invite",
    audience: overrides?.audience ?? "aos-guest",
    keys: overrides?.keys ?? [{ id: "2026-09", secret: currentKey }],
    now: overrides?.now ?? (() => 1_700_000_000_000),
    ttlSeconds: overrides?.ttlSeconds ?? 300,
    clockSkewSeconds: overrides?.clockSkewSeconds ?? 10,
  })
}

const invitation = {
  agentId: "agent_planner",
  ref: "conversation_ref",
}

async function rogueToken(
  claims: Record<string, unknown>,
  overrides?: { key?: Uint8Array; kid?: string; typ?: string }
) {
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "HS256",
      kid: overrides?.kid ?? "2026-09",
      typ: overrides?.typ ?? "aos-guest-invitation+jwt",
    })
    .sign(overrides?.key ?? currentKey)
}

describe("guest invitation", () => {
  it("issues only the public invitation claims", async () => {
    const issued = await service().issue(invitation)

    expect(decodeProtectedHeader(issued.token)).toEqual({
      alg: "HS256",
      kid: "2026-09",
      typ: "aos-guest-invitation+jwt",
    })
    expect(decodeJwt(issued.token)).toEqual({
      v: 1,
      iss: "aos-invite",
      aud: "aos-guest",
      dep: "aos-prod-il1",
      runtime: "hermes-primary",
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      agent: "agent_planner",
      ref: "conversation_ref",
    })
    expect(issued.grant).toMatchObject({
      runtimeId: "hermes-primary",
      agentId: "agent_planner",
      sessionId: "conversation_ref",
      ref: "conversation_ref",
      operations: guestOperations,
      capabilities: guestCapabilities,
    })
  })

  it("preserves first-turn presentation and a requested shorter lifetime", async () => {
    const issued = await service({ ttlSeconds: 86_400 }).issue({
      ...invitation,
      expiresInSeconds: 3_600,
      firstTurn: {
        instruction: "Load the interview skill for Dan.",
        prefill: "Hey, Almog sent me here!",
      },
      ui: {
        lang: "he",
        name: "Almog",
        logoUrl: "https://example.test/almog.png",
        accent: "#2563eb",
        title: "Interview",
        message: "Welcome.",
      },
    })

    expect(decodeJwt(issued.token)).toEqual({
      v: 1,
      iss: "aos-invite",
      aud: "aos-guest",
      dep: "aos-prod-il1",
      runtime: "hermes-primary",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      agent: "agent_planner",
      ref: "conversation_ref",
      firstTurn: {
        instruction: "Load the interview skill for Dan.",
        prefill: "Hey, Almog sent me here!",
      },
      ui: {
        lang: "he",
        name: "Almog",
        logoUrl: "https://example.test/almog.png",
        accent: "#2563eb",
        title: "Interview",
        message: "Welcome.",
      },
    })
  })

  it("derives gateway policy and identities instead of storing them in the JWT", async () => {
    const issued = await service().issue(invitation)
    const verified = await service().verify(issued.token)

    expect(verified).toMatchObject({
      deploymentId: "aos-prod-il1",
      runtimeId: "hermes-primary",
      principalId: "guest_conversation_ref",
      invitationId: "invite_conversation_ref",
      capabilities: guestCapabilities,
    })
    expect(decodeJwt(issued.token)).toMatchObject({
      dep: "aos-prod-il1",
      runtime: "hermes-primary",
    })
    expect(decodeJwt(issued.token)).not.toHaveProperty("ops")
    expect(decodeJwt(issued.token)).not.toHaveProperty("caps")
  })

  it("binds access to the configured deployment and runtime", async () => {
    const issued = await service().issue(invitation)

    await expect(
      service({ deploymentId: "other" }).verify(issued.token)
    ).resolves.toBeUndefined()
    await expect(
      service({ runtimeId: "other" }).verify(issued.token)
    ).resolves.toBeUndefined()
    await expect(service().verify(issued.token)).resolves.toMatchObject({
      agentId: "agent_planner",
      ref: "conversation_ref",
    })
  })

  it("defaults invitation lifetime to 72 hours", async () => {
    const invitations = createGuestInvitationService({
      deploymentId: "aos-prod-il1",
      runtimeId: "hermes-primary",
      issuer: "aos-invite",
      audience: "aos-guest",
      keys: [{ id: "2026-09", secret: currentKey }],
      now: () => 1_700_000_000_000,
    })

    const issued = await invitations.issue(invitation)

    expect(decodeJwt(issued.token).exp).toBe(1_700_259_200)
  })

  it("rejects tampering, unknown keys, wrong token types, and extra claims", async () => {
    const issued = await service().issue(invitation)
    const claims = decodeJwt(issued.token)
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`

    await expect(service().verify(tampered)).resolves.toBeUndefined()
    await expect(
      service().verify(await rogueToken(claims, { kid: "retired" }))
    ).resolves.toBeUndefined()
    await expect(
      service().verify(await rogueToken(claims, { typ: "JWT" }))
    ).resolves.toBeUndefined()
    await expect(
      service().verify(await rogueToken({ ...claims, admin: true }))
    ).resolves.toBeUndefined()
  })

  it("enforces issue time, expiry, configured maximum lifetime, and clock skew", async () => {
    const issued = await service().issue(invitation)

    await expect(
      service({ now: () => 1_699_999_989_000 }).verify(issued.token)
    ).resolves.toBeUndefined()
    await expect(
      service({ now: () => 1_699_999_990_000 }).verify(issued.token)
    ).resolves.toBeDefined()
    await expect(
      service({ now: () => 1_700_000_311_000 }).verify(issued.token)
    ).resolves.toBeUndefined()
    await expect(
      service().issue({ ...invitation, expiresInSeconds: 301 })
    ).rejects.toBeInstanceOf(GuestInvitationError)
  })

  it("supports verification-only key rotation and stable token identity", async () => {
    const old = await service({
      keys: [{ id: "2026-08", secret: previousKey }],
    }).issue(invitation)
    const rotated = service({
      keys: [
        { id: "2026-09", secret: currentKey },
        { id: "2026-08", secret: previousKey },
      ],
    })

    const first = await rotated.verify(old.token)
    const second = await rotated.verify(old.token)
    expect(first?.tokenId).toBe(second?.tokenId)
    expect(
      decodeProtectedHeader((await rotated.issue(invitation)).token).kid
    ).toBe("2026-09")
  })

  it("rejects malformed requests, targets, tokens, and configuration", async () => {
    await expect(
      service().issue({ ...invitation, ref: "spaces are invalid" })
    ).rejects.toBeInstanceOf(GuestInvitationError)
    await expect(
      service().issue({ ...invitation, ui: { lang: "fr" } as never })
    ).rejects.toBeInstanceOf(GuestInvitationError)
    await expect(service().verify("not-a-jwt")).resolves.toBeUndefined()
    await expect(
      service().verify(`a.${"a".repeat(4_000)}.a`)
    ).resolves.toBeUndefined()
    expect(() => service({ issuer: "wrong" as never })).toThrow(
      GuestInvitationError
    )
    expect(() =>
      service({ audience: "https://guest.example.test/path" as never })
    ).toThrow(GuestInvitationError)
    expect(() => service({ runtimeId: "runtime\nother" })).toThrow(
      GuestInvitationError
    )
    expect(() =>
      service({ keys: [{ id: "bad", secret: new Uint8Array(31) }] })
    ).toThrow(GuestInvitationError)
  })
})
