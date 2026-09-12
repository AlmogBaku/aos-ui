import { describe, expect, it } from "vitest"

import {
  OperatorSessionCookieError,
  createOperatorSessionCookie,
} from "./session-cookie"

const currentKey = new Uint8Array(32).fill(7)
const previousKey = new Uint8Array(32).fill(8)

function harness(overrides?: {
  deploymentId?: string
  keys?: readonly { id: string; secret: Uint8Array }[]
  now?: () => number
  ttlSeconds?: number
  clockSkewSeconds?: number
}) {
  let sequence = 0
  return createOperatorSessionCookie({
    deploymentId: overrides?.deploymentId ?? "aos-prod-il1",
    keys: overrides?.keys ?? [{ id: "2026-09", secret: currentKey }],
    now: overrides?.now ?? (() => 1_700_000_000_000),
    ttlSeconds: overrides?.ttlSeconds ?? 900,
    clockSkewSeconds: overrides?.clockSkewSeconds ?? 10,
    randomBytes(size) {
      sequence += 1
      return new Uint8Array(size).fill(sequence)
    },
  })
}

function cookieHeader(cookie: string) {
  return cookie.slice(0, cookie.indexOf(";"))
}

describe("operator session cookie", () => {
  it("issues an opaque authenticated __Host- cookie and returns its normalized session", () => {
    const cookies = harness()

    const issued = cookies.issue({ principalId: "aos_principal_4Ez4k6W5" })

    expect(issued.cookie).toMatch(
      /^__Host-aos-session=v1\.2026-09\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}; Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Lax$/u
    )
    expect(issued.cookie).not.toContain("aos_principal_4Ez4k6W5")
    expect(issued.session).toEqual({
      principalId: "aos_principal_4Ez4k6W5",
      sessionId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_900,
    })
    expect(cookies.verify(cookieHeader(issued.cookie))).toEqual(issued.session)
  })

  it("rejects tampering, malformed values, truncation, and duplicate session cookies", () => {
    const cookies = harness()
    const issued = cookies.issue({ principalId: "aos_principal_4Ez4k6W5" })
    const header = cookieHeader(issued.cookie)
    const tampered = `${header.slice(0, -1)}${header.endsWith("A") ? "B" : "A"}`

    expect(cookies.verify(tampered)).toBeUndefined()
    expect(
      cookies.verify("__Host-aos-session=v1.bad.bad.bad.bad")
    ).toBeUndefined()
    expect(cookies.verify(header.slice(0, -3))).toBeUndefined()
    expect(cookies.verify(`${header}; ${header}`)).toBeUndefined()
    expect(
      cookies.verify(`__Host-aos-session=${"a".repeat(8_193)}`)
    ).toBeUndefined()
  })

  it("rejects cookies issued for another deployment, key, or version", () => {
    const issued = harness().issue({ principalId: "aos_principal_4Ez4k6W5" })
    const header = cookieHeader(issued.cookie)

    expect(
      harness({ deploymentId: "aos-prod-us1" }).verify(header)
    ).toBeUndefined()
    expect(
      harness({ keys: [{ id: "2026-09", secret: previousKey }] }).verify(header)
    ).toBeUndefined()
    expect(harness().verify(header.replace("v1.", "v2."))).toBeUndefined()
  })

  it("enforces expiry and future issue time with only its configured skew", () => {
    const issued = harness({ now: () => 1_700_000_000_000 }).issue({
      principalId: "aos_principal_4Ez4k6W5",
    })
    const header = cookieHeader(issued.cookie)

    expect(
      harness({ now: () => 1_700_000_911_000 }).verify(header)
    ).toBeUndefined()
    expect(
      harness({ now: () => 1_699_999_989_000 }).verify(header)
    ).toBeUndefined()
    expect(harness({ now: () => 1_699_999_990_000 }).verify(header)).toEqual(
      issued.session
    )
  })

  it("accepts the previous key during an explicit key rotation", () => {
    const old = harness({
      keys: [{ id: "2026-08", secret: previousKey }],
    }).issue({ principalId: "aos_principal_4Ez4k6W5" })
    const rotated = harness({
      keys: [
        { id: "2026-09", secret: currentKey },
        { id: "2026-08", secret: previousKey },
      ],
    })

    expect(rotated.verify(cookieHeader(old.cookie))).toEqual(old.session)
    expect(rotated.issue({ principalId: "aos_principal_new" }).cookie).toMatch(
      /^__Host-aos-session=v1\.2026-09\./u
    )
  })

  it("returns a strict deletion cookie with the same __Host- attributes", () => {
    expect(harness().clear()).toBe(
      "__Host-aos-session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
    )
  })

  it("rejects unsafe key and deployment configuration", () => {
    expect(() =>
      harness({ keys: [{ id: "2026-09", secret: new Uint8Array(31) }] })
    ).toThrow(OperatorSessionCookieError)
    expect(() => harness({ deploymentId: "production\nother" })).toThrow(
      OperatorSessionCookieError
    )
  })

  it("does not issue a cookie from an invalid future clock", () => {
    const cookies = harness({ now: () => 4_102_444_801_000 })

    expect(() =>
      cookies.issue({ principalId: "aos_principal_4Ez4k6W5" })
    ).toThrow(OperatorSessionCookieError)
  })
})
