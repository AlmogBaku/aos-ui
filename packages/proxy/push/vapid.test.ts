import { generateKeyPairSync, type JsonWebKey } from "node:crypto"
import { describe, expect, it } from "vitest"

import { deriveVapidPublicKey } from "./vapid"

/** The P-256 scalar and the uncompressed point of one generated pair. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const { d } = privateKey.export({ format: "jwk" }) as JsonWebKey
  const { x, y } = publicKey.export({ format: "jwk" }) as JsonWebKey
  return {
    privateKey: new Uint8Array(Buffer.from(d ?? "", "base64url")),
    publicKey: Buffer.concat([
      Uint8Array.of(4),
      Buffer.from(x ?? "", "base64url"),
      Buffer.from(y ?? "", "base64url"),
    ]).toString("base64url"),
  }
}

describe("VAPID key derivation", () => {
  it("derives the application server key of a generated private key", () => {
    const pair = keyPair()

    const derived = deriveVapidPublicKey(pair.privateKey)

    expect(derived).toBe(pair.publicKey)
    expect(derived).toHaveLength(87)
  })

  it("refuses a scalar that is not a P-256 private key", () => {
    expect(() => deriveVapidPublicKey(new Uint8Array(32))).toThrow()
  })
})
