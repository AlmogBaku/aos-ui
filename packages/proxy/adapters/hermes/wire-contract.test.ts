import {
  runWireContract,
  runWireListenerContract,
  type WireRuntime,
} from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeHermesRuntime } from "./factory"
import { fakeHermes, fakeHermesGateway } from "./test-utils/fake-hermes"

function hermesRuntime(): WireRuntime {
  const hermes = fakeHermes()
  return {
    config: {
      id: "hermes-contract",
      kind: "hermes",
      baseUrl: "http://127.0.0.1:9119",
      tokenFile: "/run/secrets/hermes-token",
      sessionIdleMs: 300_000,
    },
    runtimeFactory: async (config, limits, { logger, mcpServerOverrides }) =>
      coordinatedRuntime(
        config.id,
        composeHermesRuntime({
          transport: fakeHermesGateway(hermes, logger),
          logger,
          sessionIdleMs: 300_000,
          mcpServerOverrides,
        }),
        limits,
        logger
      ),
    agentId: hermes.scope.agentId,
  }
}

runWireContract("Hermes", hermesRuntime)
runWireListenerContract("Hermes", hermesRuntime)
