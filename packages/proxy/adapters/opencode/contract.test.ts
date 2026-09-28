import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { composeOpenCodeRuntime } from "./factory"
import { fakeOpenCode, fakeOpenCodeClient } from "./test-utils/fake-opencode"

runServerRuntimeContract(
  "OpenCode",
  () => {
    const opencode = fakeOpenCode()
    const { runtime, engine, close } = composeOpenCodeRuntime({
      client: fakeOpenCodeClient(opencode),
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
