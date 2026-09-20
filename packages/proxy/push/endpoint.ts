import { lookup as dnsLookup } from "node:dns/promises"
import ipaddr from "ipaddr.js"

/**
 * A push endpoint the proxy refuses to call. The message names the rule, never
 * the endpoint: an endpoint is a bearer capability to wake one device.
 */
export class PushEndpointError extends Error {
  constructor(rule: string) {
    super(`Push endpoint refused: ${rule}`)
    this.name = "PushEndpointError"
  }
}

/**
 * Hostnames that name something inside the deployment rather than a service.
 * This is a courtesy check that fails a plainly local name early: what actually
 * keeps the proxy off the deployment's network is `resolvePublicAddresses`,
 * which every send waits on.
 */
const PRIVATE_SUFFIXES = [".local", ".internal", ".home.arpa"] as const

/**
 * One push service endpoint, as a URL the proxy may call. Only a public https
 * name on the default port is accepted: the proxy sends to it unattended, so it
 * must never be usable to reach the deployment's own network or to smuggle
 * credentials into a request.
 */
export function parsePushEndpoint(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PushEndpointError("not a URL")
  }
  if (url.protocol !== "https:") throw new PushEndpointError("not https")
  if (url.port !== "") throw new PushEndpointError("not the default port")
  if (url.username || url.password)
    throw new PushEndpointError("carries credentials")
  if (url.search || url.hash)
    throw new PushEndpointError("carries a query or fragment")
  const hostname = url.hostname.toLowerCase()
  if (ipaddr.isValid(hostname))
    throw new PushEndpointError("an address literal")
  if (!hostname.includes("."))
    throw new PushEndpointError("not a qualified name")
  if (
    hostname === "localhost" ||
    PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  )
    throw new PushEndpointError("a private name")
  return url
}

export type PushHostLookup = (
  hostname: string,
  options: { all: true }
) => Promise<readonly { address: string }[]>

const defaultLookup: PushHostLookup = (hostname, options) =>
  dnsLookup(hostname, options)

/**
 * Every address one push host resolves to, once they are all public unicast.
 * `unicast` is the single range that excludes everything the proxy must not be
 * talked into reaching: loopback, link-local, private, unique-local, multicast,
 * reserved, IPv4-mapped, and the carrier-grade NAT block a tailnet uses.
 */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: PushHostLookup = defaultLookup
): Promise<string[]> {
  let resolved: readonly { address: string }[]
  try {
    resolved = await lookup(hostname, { all: true })
  } catch {
    throw new PushEndpointError("does not resolve")
  }
  const addresses = resolved.map(({ address }) => address)
  if (addresses.length === 0) throw new PushEndpointError("does not resolve")
  for (const address of addresses) {
    let range: string
    try {
      range = ipaddr.process(address).range()
    } catch {
      throw new PushEndpointError("resolves to an unreadable address")
    }
    if (range !== "unicast")
      throw new PushEndpointError("resolves to a non-public address")
  }
  return addresses
}
