import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { composeHermesRuntime } from "./factory"
import { fakeHermes, fakeHermesGateway } from "./test-utils/fake-hermes"

runServerRuntimeContract(
  "Hermes",
  () => {
    const hermes = fakeHermes()
    const { logger } = captureLogs()
    const { runtime, close } = composeHermesRuntime({
      transport: fakeHermesGateway(hermes, logger),
      logger,
      sessionIdleMs: 300_000,
    })
    return { ...hermes, runtime, close }
  },
  {
    callerErrors: ["runtime_authentication_required"],
    gaps: {
      settledTurnsFreeRecords:
        "no seam: the adapter exposes no count of its per-Session records",
    },
  }
)
