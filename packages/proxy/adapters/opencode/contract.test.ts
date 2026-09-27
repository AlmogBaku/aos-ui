import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { OpenCodeServerAdapter } from "./adapter"
import { createOpenCodeClient } from "./client"
import { OpenCodeInteractions } from "./interactions"
import { OpenCodeTurnEngine } from "./run"
import { fakeOpenCode } from "./test-utils/fake-opencode"

runServerRuntimeContract(
  "OpenCode",
  () => {
    const opencode = fakeOpenCode()
    const client = createOpenCodeClient({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspaces/contract",
      username: "operator",
      password: async () => "test-password",
      fetcher: opencode.fetcher,
    })
    const interactions = new OpenCodeInteractions({
      questions: client.sessions.questions,
      permissions: client.sessions.permissions,
    })
    const engine = new OpenCodeTurnEngine(client, {
      logger: captureLogs().logger,
      replies: interactions,
    })
    const runtime = new OpenCodeServerAdapter({
      client,
      turns: engine,
      interactions,
      link: engine.link,
    })
    return {
      ...opencode,
      runtime,
      records: () => engine.retainedRecords,
      close: async () => {
        engine.close()
        await runtime.close()
      },
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
