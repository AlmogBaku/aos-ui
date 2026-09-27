import { runServerRuntimeContract } from "../../core/runtime-contract"
import { HermesServerAdapter } from "./adapter"
import { HermesGateway } from "./gateway"
import { fakeHermes } from "./test-utils/fake-hermes"

runServerRuntimeContract(
  "Hermes",
  () => {
    const hermes = fakeHermes()
    const runtime = new HermesServerAdapter(
      new HermesGateway({
        baseUrl: "http://127.0.0.1:9119",
        credentials: async () => ({ "X-Hermes-Session-Token": "test-token" }),
        socketFactory: hermes.socketFactory,
        fetcher: hermes.fetcher,
      })
    )
    return { ...hermes, runtime, close: () => runtime.close() }
  },
  {
    callerErrors: ["runtime_authentication_required"],
    gaps: {
      settledTurnsFreeRecords:
        "no seam: the adapter exposes no count of its per-Session records",
    },
  }
)
