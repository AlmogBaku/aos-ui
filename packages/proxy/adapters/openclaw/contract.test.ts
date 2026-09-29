import { vi } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { composeOpenClawRuntime } from "./factory"
import { fakeOpenClaw, fakeOpenClawClient } from "./test-utils/fake-openclaw"

vi.mock("@openclaw/gateway-client", async (importOriginal) =>
  (await import("./test-utils/gateway-client-mock")).gatewayClientMock(
    await importOriginal()
  )
)

runServerRuntimeContract(
  "OpenClaw",
  async () => {
    const openclaw = fakeOpenClaw()
    const client = fakeOpenClawClient(openclaw)
    const { runtime, mcpToolNames, close } = composeOpenClawRuntime({
      ...client,
      baseUrl: "ws://127.0.0.1:18789",
      logger: captureLogs().logger,
    })
    // A runtime whose link is up, as it is once the proxy has read its catalog.
    await client.start()
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
