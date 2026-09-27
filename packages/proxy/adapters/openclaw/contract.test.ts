import { vi } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { OpenClawClient } from "./client"
import { composeOpenClawRuntime } from "./factory"
import { fakeOpenClaw } from "./test-utils/fake-openclaw"

vi.mock("@openclaw/gateway-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openclaw/gateway-client")>()
  return {
    ...actual,
    // The official client dials through the `ws` package, out of reach of the
    // contract's global WebSocket stub, so it refuses here: only the fake dials.
    GatewayClient: function GatewayClient() {
      throw new Error(
        "The runtime contract reached the official Gateway client"
      )
    },
    // The official client marks every Gateway answer it builds; here the
    // fake's GatewayClientRequestError stands for one.
    isGatewayProtocolResponseError: (error: unknown) =>
      error instanceof actual.GatewayClientRequestError,
  }
})

runServerRuntimeContract(
  "OpenClaw",
  async () => {
    const openclaw = fakeOpenClaw()
    let client: OpenClawClient | undefined
    const { runtime, mcpToolNames, close } = composeOpenClawRuntime({
      baseUrl: "ws://127.0.0.1:18789",
      credentials: async () => ({
        deviceIdentity: {
          deviceId: "device-test",
          privateKeyPem: "test-private-key",
          publicKeyPem: "test-public-key",
        },
        deviceToken: "test-token",
        signDevicePayload: () => "test-signature",
        publicKeyRawBase64UrlFromPem: () => "test-public-key-raw",
      }),
      logger: captureLogs().logger,
      clientFactory: (options) =>
        (client = new OpenClawClient({
          ...options,
          createGatewayClient: openclaw.createGatewayClient,
        })),
    })
    // A runtime whose link is up, as it is once the proxy has read its catalog.
    await client!.start()
    return {
      ...openclaw,
      runtime,
      records: () => mcpToolNames.size,
      close,
    }
  },
  {
    callerErrors: ["runtime_authentication_required"],
    gaps: {
      typedMessageFields:
        "capability: OpenClaw history carries no correction or turn error code",
    },
  }
)
