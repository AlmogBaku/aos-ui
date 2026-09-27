import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { composeHermesRuntime } from "./factory"
import { HermesGateway } from "./gateway"
import { fakeHermes } from "./test-utils/fake-hermes"

runServerRuntimeContract(
  "Hermes",
  () => {
    const hermes = fakeHermes()
    const { logger } = captureLogs()
    const { runtime, close } = composeHermesRuntime({
      transport: new HermesGateway({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({ "X-Hermes-Session-Token": "test-token" }),
        log: logger,
        socketFactory: hermes.socketFactory,
        fetcher: hermes.fetcher,
      }),
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
