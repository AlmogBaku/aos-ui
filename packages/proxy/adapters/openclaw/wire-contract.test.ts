import { vi } from "vitest"

import { runWireContract } from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeOpenClawRuntime } from "./factory"
import { fakeOpenClaw, fakeOpenClawClient } from "./test-utils/fake-openclaw"

vi.mock("@openclaw/gateway-client", async (importOriginal) =>
  (await import("./test-utils/gateway-client-mock")).gatewayClientMock(
    await importOriginal()
  )
)

runWireContract("OpenClaw", () => {
  const openclaw = fakeOpenClaw()
  return {
    config: {
      id: "openclaw-contract",
      kind: "openclaw",
      baseUrl: "ws://127.0.0.1:18789",
      deviceIdentityFile: "/run/secrets/openclaw-device-identity",
      deviceTokenFile: "/run/secrets/openclaw-device-token",
    },
    runtimeFactory: async (config, limits, { logger }) =>
      coordinatedRuntime(
        config.id,
        // Unstarted, as the real factory leaves it: the proxy's first read
        // brings the link up.
        composeOpenClawRuntime({
          ...fakeOpenClawClient(openclaw),
          baseUrl: "ws://127.0.0.1:18789",
          logger,
        }),
        limits,
        logger
      ),
    agentId: openclaw.scope.agentId,
  }
})
