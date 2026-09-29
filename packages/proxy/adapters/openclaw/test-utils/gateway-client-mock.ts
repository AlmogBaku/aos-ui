/**
 * The `@openclaw/gateway-client` module every contract over `fakeOpenClaw`
 * runs against. `vi.mock` applies per file, so each such test mocks the module
 * with this body, imported inside its factory:
 *
 *   vi.mock("@openclaw/gateway-client", async (importOriginal) =>
 *     (await import("./test-utils/gateway-client-mock")).gatewayClientMock(
 *       await importOriginal()
 *     )
 *   )
 *
 * It imports nothing from the mocked module itself, which would import the
 * mock while it is still being built.
 */
type GatewayClientModule = typeof import("@openclaw/gateway-client")

export function gatewayClientMock(
  actual: GatewayClientModule
): GatewayClientModule {
  return {
    ...actual,
    // The official client dials through the `ws` package, out of reach of the
    // contract's global WebSocket stub, so it refuses here: only the fake dials.
    GatewayClient: function GatewayClient() {
      throw new Error("The contract reached the official Gateway client")
    } as unknown as GatewayClientModule["GatewayClient"],
    // The official client marks every Gateway answer it builds; here the
    // fake's GatewayClientRequestError stands for one.
    isGatewayProtocolResponseError: ((error: unknown) =>
      error instanceof
      actual.GatewayClientRequestError) as GatewayClientModule["isGatewayProtocolResponseError"],
  }
}
