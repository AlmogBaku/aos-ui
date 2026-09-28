import { runWireContract } from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeOpenCodeRuntime } from "./factory"
import { fakeOpenCode, fakeOpenCodeClient } from "./test-utils/fake-opencode"

runWireContract("OpenCode", () => {
  const opencode = fakeOpenCode()
  return {
    config: {
      id: "opencode-contract",
      kind: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspaces/contract",
      username: "operator",
      passwordFile: "/run/secrets/opencode-password",
    },
    runtimeFactory: async (config, limits, { logger, mcpServerOverrides }) =>
      coordinatedRuntime(
        config.id,
        composeOpenCodeRuntime({
          client: fakeOpenCodeClient(opencode),
          logger,
          mcpServerOverrides,
        }),
        limits,
        logger
      ),
    agentId: opencode.scope.agentId,
  }
})
