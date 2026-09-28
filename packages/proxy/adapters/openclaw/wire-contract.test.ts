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

/**
 * OpenClaw's push names no assistant message: an agent event carries its run
 * and sequence alone (`AgentEventSchema`, and each `ChatEventSchema` state, in
 * `@openclaw/gateway-protocol` 2026.9.4), and only a stored transcript row has
 * an id (`readSessionMessageIdentity` in `@openclaw/gateway-client`). The
 * adapter names its live messages itself, so a reload cannot give them back.
 */
const LIVE_IDS_ADAPTER_MADE =
  "OpenClaw's push names no assistant message, so live ids are the adapter's and history's are the transcript's"

runWireContract(
  "OpenClaw",
  () => {
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
  },
  {
    gaps: {
      sameIdsLiveAndAfterReload: LIVE_IDS_ADAPTER_MADE,
      historyAndLiveJoinedById: LIVE_IDS_ADAPTER_MADE,
    },
  }
)
