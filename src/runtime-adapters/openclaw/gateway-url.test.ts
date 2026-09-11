import { expect, it } from "vitest"
import { resolveOpenClawGatewayUrl } from "./gateway-url"

it("resolves same-origin proxy paths to the matching WebSocket scheme", () => {
  expect(resolveOpenClawGatewayUrl("/openclaw", "https://aos.example/en")).toBe(
    "wss://aos.example/openclaw"
  )
  expect(
    resolveOpenClawGatewayUrl("/openclaw", "http://127.0.0.1:3000/en")
  ).toBe("ws://127.0.0.1:3000/openclaw")
})

it("preserves explicit credential-free WebSocket URLs", () => {
  expect(
    resolveOpenClawGatewayUrl("wss://gateway.example/ws", "https://aos.example")
  ).toBe("wss://gateway.example/ws")
})
