import { describe, expect, it, vi } from "vitest"

import { createOidcUserInfoVerifier } from "./oidc-userinfo"

const options = {
  issuer: "https://identity.example.test",
  clientId: "aos-ui",
  clientSecret: "private",
  redirectUri: "http://127.0.0.1:3000/api/aos/v1/auth/operator/callback",
}

describe("OIDC user-info boundary", () => {
  it("accepts an issuer-validated bearer identity for allowlist enforcement", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ sub: "operator@example.test", name: "Operator" }),
          { headers: { "content-type": "application/json" } }
        )
    )
    const verify = createOidcUserInfoVerifier(options, fetcher)

    await expect(
      verify(
        new Request("http://127.0.0.1:3000/api/aos/v1/auth/operator", {
          headers: { authorization: "Bearer access-token" },
        })
      )
    ).resolves.toEqual({
      subject: "operator@example.test",
      displayName: "Operator",
    })
    expect(fetcher).toHaveBeenCalledWith(
      "https://identity.example.test/userinfo",
      expect.objectContaining({
        headers: { authorization: "Bearer access-token" },
        redirect: "error",
      })
    )
  })

  it("fails closed without a valid issuer response", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }))
    const verify = createOidcUserInfoVerifier(options, fetcher)

    await expect(
      verify(new Request("http://127.0.0.1:3000/api/aos/v1/auth/operator"))
    ).resolves.toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()

    await expect(
      verify(
        new Request("http://127.0.0.1:3000/api/aos/v1/auth/operator", {
          headers: { authorization: "Bearer rejected" },
        })
      )
    ).resolves.toBeUndefined()
  })
})
