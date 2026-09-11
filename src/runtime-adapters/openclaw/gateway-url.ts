export function resolveOpenClawGatewayUrl(baseUrl: string, pageUrl: string) {
  const gateway = new URL(baseUrl, pageUrl)
  if (gateway.protocol === "http:") gateway.protocol = "ws:"
  if (gateway.protocol === "https:") gateway.protocol = "wss:"
  return gateway.toString().replace(/\/$/, "")
}
