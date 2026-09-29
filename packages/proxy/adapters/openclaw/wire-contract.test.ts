import { vi } from "vitest"

import { runWireContract } from "../../acp/wire-contract"
import { coordinatedRuntime } from "../create-coordinator"
import { composeOpenClawRuntime } from "./factory"
import {
  AGENT_WORKSPACE,
  fakeOpenClaw,
  fakeOpenClawClient,
} from "./test-utils/fake-openclaw"

vi.mock("@openclaw/gateway-client", async (importOriginal) =>
  (await import("./test-utils/gateway-client-mock")).gatewayClientMock(
    await importOriginal()
  )
)

/**
 * OpenClaw's push names no assistant message: an agent event carries its run
 * and sequence alone (`AgentEventSchema`, and each `ChatEventSchema` state, in
 * `@openclaw/gateway-protocol` 2026.9.4), and only a stored transcript row has
 * an id (`readSessionMessageIdentity` in `@openclaw/gateway-client`). The
 * adapter names its live messages itself, so a reload cannot give them back.
 */
const LIVE_IDS_ADAPTER_MADE =
  "OpenClaw's push names no assistant message, so live ids are the adapter's and history's are the transcript's"

runWireContract(
  "OpenClaw",
  () => {
    const openclaw = fakeOpenClaw()
    return {
      config: {
        id: "openclaw-contract",
        kind: "openclaw",
        baseUrl: "ws://127.0.0.1:18789",
        deviceIdentityFile: "/run/secrets/openclaw-device-identity",
        deviceTokenFile: "/run/secrets/openclaw-device-token",
      },
      runtimeFactory: async (config, limits, { logger }) =>
        coordinatedRuntime(
          config.id,
          // Unstarted, as the real factory leaves it: the proxy's first read
          // brings the link up.
          composeOpenClawRuntime({
            ...fakeOpenClawClient(openclaw),
            baseUrl: "ws://127.0.0.1:18789",
            logger,
          }),
          limits,
          logger
        ),
      agentId: openclaw.scope.agentId,
      folder: AGENT_WORKSPACE,
      turn: openclaw.turn,
    }
  },
  {
    gaps: {
      sameIdsLiveAndAfterReload: LIVE_IDS_ADAPTER_MADE,
      historyAndLiveJoinedById: LIVE_IDS_ADAPTER_MADE,
      oneTurnThroughQuestion: LIVE_IDS_ADAPTER_MADE,
      catchUpWithStandardUpdates: LIVE_IDS_ADAPTER_MADE,
      // Every approval carries a reviewer-safe presentation, so the adapter
      // holds none back, and `sessions.messages.subscribe` replays each
      // pending one (`SessionApprovalReplaySchema`), so a restarted proxy
      // presents it again rather than losing it.
      heldAndLostQuestions:
        "OpenClaw holds no approval back and replays every pending one on subscribe",
      // The release pushes no question, so the in-turn prompt is a plugin
      // approval, which ACP's `session/request_permission` offers every client
      // as options rather than an elicitation form.
      questionsOnlyToCapableClients:
        "OpenClaw asks only approvals, which every client answers",
      choiceOnlyQuestion: "OpenClaw asks only approvals, not questions",
      // The adapter projects no file change from an OpenClaw tool result.
      diffAddedWithGitPatchOrNone: "the adapter maps no OpenClaw file change",
      // `ModelChoiceSchema.thinkingLevels` is not mapped to efforts yet, so no
      // thought level is offered.
      thoughtLevelDefault: "the adapter offers no OpenClaw thought level",
      // A Session's `verboseLevel` is a free string in the pinned protocol,
      // which does not say what any level withholds from the stream.
      quietStreamPassedThrough:
        "the pinned OpenClaw protocol names no quieter stream",
    },
  }
)
