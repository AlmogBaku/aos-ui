import { describe, expect, it } from "vitest"

import { type OperatorAuthenticator, OperatorAuthError } from "../operator-auth"
import { createOperatorSessionAuthenticator } from "./operator-session-auth"
import { createOperatorSessionCookieForTest } from "./session-cookie"

const key = new Uint8Array(32).fill(7)

function cookies() {
  let sequence = 0
  return createOperatorSessionCookieForTest(
    {
      deploymentId: "aos-prod-il1",
      keys: [{ id: "2026-09", secret: key }],
      now: () => 1_700_000_000_000,
    },
    (size) => new Uint8Array(size).fill(++sequence)
  )
}

function request(cookie?: string): Request {
  return new Request("https://aos.example.test/api/aos/v1/auth/operator", {
    headers: cookie ? { cookie } : undefined,
  })
}

describe("sealed operator session authenticator", () => {
  it("implements the existing OperatorAuthenticator boundary from a sealed principal session", async () => {
    const sessionCookies = cookies()
    const issued = await sessionCookies.issue({
      principalId: "aos_principal_4Ez4k6W5",
    })
    const authenticator: OperatorAuthenticator =
      createOperatorSessionAuthenticator(sessionCookies)

    await expect(
      authenticator.state(request(issued.cookie.split(";", 1)[0]))
    ).resolves.toEqual({
      status: "authenticated",
      operator: { id: "aos_principal_4Ez4k6W5" },
    })
    await expect(
      authenticator.require(request(issued.cookie.split(";", 1)[0]))
    ).resolves.toEqual({
      status: "authenticated",
      operator: { id: "aos_principal_4Ez4k6W5" },
    })
  })

  it("returns the normalized opaque session without requiring a raw IdP subject", async () => {
    const sessionCookies = cookies()
    const issued = await sessionCookies.issue({
      principalId: "aos_principal_4Ez4k6W5",
    })
    const authenticator = createOperatorSessionAuthenticator(sessionCookies)
    const header = issued.cookie.split(";", 1)[0]

    await expect(authenticator.session(request(header))).resolves.toEqual(
      issued.session
    )
    expect(issued.cookie).not.toContain("operator@example.test")
  })

  it("fails closed for missing or tampered cookies", async () => {
    const sessionCookies = cookies()
    const authenticator = createOperatorSessionAuthenticator(sessionCookies)
    const issued = await sessionCookies.issue({
      principalId: "aos_principal_4Ez4k6W5",
    })
    const header = issued.cookie.split(";", 1)[0]
    const tampered = `${header.slice(0, -1)}${header.endsWith("A") ? "B" : "A"}`

    await expect(authenticator.state(request())).resolves.toEqual({
      status: "unauthenticated",
    })
    await expect(authenticator.state(request(tampered))).resolves.toEqual({
      status: "unauthenticated",
    })
    await expect(authenticator.require(request())).rejects.toBeInstanceOf(
      OperatorAuthError
    )
  })
})
