import { createECDH } from "node:crypto"

/**
 * The uncompressed P-256 point belonging to one VAPID private scalar, base64url
 * as the browser's `applicationServerKey` and `GET /push` carry it. Deriving it
 * keeps the private key file the only VAPID material an operator configures,
 * so the two halves can never disagree.
 */
export function deriveVapidPublicKey(privateKey: Uint8Array): string {
  const curve = createECDH("prime256v1")
  curve.setPrivateKey(privateKey)
  return curve.getPublicKey().toString("base64url")
}
