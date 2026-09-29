import {
  runWireContract,
  runWireListenerContract,
  type WireRuntime,
} from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeHermesRuntime } from "./factory"
import {
  fakeHermes,
  fakeHermesGateway,
  PROJECT_FOLDER,
} from "./test-utils/fake-hermes"

function hermesRuntime(): WireRuntime {
  // Every wire row creates its Session, so Hermes starts with none stored.
  const hermes = fakeHermes({ stored: false })
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
    // What `config.get` answers for `project`, never the profile row's `path`.
    folder: PROJECT_FOLDER,
    turn: hermes,
  }
}

runWireContract("Hermes", hermesRuntime, {
  gaps: {
    // Every clarify question takes a typed answer beside its choices
    // (`tools/clarify_tool.py:9`), so none takes its choices alone.
    choiceOnlyQuestion:
      "Hermes always offers a typed answer beside the choices",
  },
})
runWireListenerContract("Hermes", hermesRuntime)
