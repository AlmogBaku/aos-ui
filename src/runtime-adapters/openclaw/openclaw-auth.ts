import {
  gatewayOriginScope,
  type GatewayBrowserDeviceIdentity,
} from "@openclaw/gateway-client/browser"
import { z } from "zod"

const identitySchema = z.object({
  privateKey: z.string(),
  publicKey: z.string(),
  deviceId: z.string(),
})
const tokenSchema = z.object({ token: z.string(), scopes: z.array(z.string()) })
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
const decode = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0)
  )

/** Private device material is browser-owned and never enters public runtime config. */
export function createOpenClawDeviceAuth(
  gatewayUrl: string,
  storage: Storage = localStorage
) {
  const scope = `aos.openclaw.${gatewayOriginScope(gatewayUrl)}`
  let identityPromise: Promise<GatewayBrowserDeviceIdentity> | undefined
  async function loadIdentity(): Promise<GatewayBrowserDeviceIdentity> {
    const stored = storage.getItem(`${scope}.identity`)
    let identity = stored ? identitySchema.parse(JSON.parse(stored)) : undefined
    if (!identity) {
      const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])
      const publicKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", keys.publicKey)
      )
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", publicKey)
      )
      identity = {
        deviceId: Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join(""),
        publicKey: encode(publicKey),
        privateKey: encode(
          new Uint8Array(
            await crypto.subtle.exportKey("pkcs8", keys.privateKey)
          )
        ),
      }
      storage.setItem(`${scope}.identity`, JSON.stringify(identity))
    }
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      decode(identity.privateKey),
      { name: "Ed25519" },
      false,
      ["sign"]
    )
    return {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      sign: async (payload) =>
        encode(
          new Uint8Array(
            await crypto.subtle.sign(
              "Ed25519",
              privateKey,
              new TextEncoder().encode(payload)
            )
          )
        ),
    }
  }
  const tokenKey = (value: {
    clientId: string
    deviceId: string
    role: string
  }) => `${scope}.token.${value.clientId}.${value.deviceId}.${value.role}`
  return {
    loadIdentity: () => (identityPromise ??= loadIdentity()),
    tokenStore: {
      load: (value: { clientId: string; deviceId: string; role: string }) => {
        const stored = storage.getItem(tokenKey(value))
        return stored ? tokenSchema.parse(JSON.parse(stored)) : null
      },
      store: (value: {
        clientId: string
        deviceId: string
        role: string
        token: string
        scopes: string[]
      }) =>
        storage.setItem(
          tokenKey(value),
          JSON.stringify({ token: value.token, scopes: value.scopes })
        ),
      clear: (value: { clientId: string; deviceId: string; role: string }) =>
        storage.removeItem(tokenKey(value)),
    },
  }
}
