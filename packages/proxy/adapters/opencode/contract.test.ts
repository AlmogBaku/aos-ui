import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { createOpenCodeClient } from "./client"
import { composeOpenCodeRuntime } from "./factory"
import { fakeOpenCode } from "./test-utils/fake-opencode"

runServerRuntimeContract(
  "OpenCode",
  () => {
    const opencode = fakeOpenCode()
    const { runtime, engine, close } = composeOpenCodeRuntime({
      client: createOpenCodeClient({
        baseUrl: "http://127.0.0.1:4096",
        directory: "/workspaces/contract",
        username: "operator",
        password: async () => "test-password",
        fetcher: opencode.fetcher,
      }),
      logger: captureLogs().logger,
    })
    return {
      ...opencode,
      runtime,
      records: () => engine!.retainedRecords,
      close,
    }
  },
  {
    callerErrors: [
      "runtime_authentication_required",
      "invalid_request",
      "revision_conflict",
    ],
    gaps: {
      typedMessageFields:
        "capability: OpenCode history carries no correction or turn error code",
    },
  }
)
