import { runWireContract } from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeOpenCodeRuntime } from "./factory"
import { fakeOpenCode, fakeOpenCodeClient } from "./test-utils/fake-opencode"

runWireContract(
  "OpenCode",
  () => {
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
      turn: opencode.turn,
    }
  },
  {
    gaps: {
      // Every question and permission carries a presentable form, so the
      // adapter holds none back, and OpenCode lists each pending one
      // (`GET /api/session/{sessionID}/question` and `…/permission`), so a
      // restarted proxy presents it again rather than losing it.
      heldAndLostQuestions:
        "OpenCode holds no question back and lists every pending one",
      // OpenCode reports edits as `patch` parts and `session.diff` events
      // (`SnapshotFileDiff`), which the adapter does not map yet.
      diffAddedWithGitPatchOrNone: "the adapter maps no OpenCode file change",
      // `Session.cost` exists, but the pinned SDK reads no context window, so
      // the adapter reports no usage to carry it (`opencode/adapter.ts:466`).
      costInUsageUpdate: "the adapter reads no OpenCode usage to carry a cost",
      // `Session.title` and `Session.time` are required: OpenCode stores and
      // titles a Session as it creates it.
      unsavedSessionUndated: "OpenCode stores every Session at creation",
      // `ProviderConfig` model `variants` are not mapped to efforts yet
      // (`opencode/adapter.ts:454`), so no thought level is offered.
      thoughtLevelDefault: "the adapter offers no OpenCode thought level",
    },
  }
)
