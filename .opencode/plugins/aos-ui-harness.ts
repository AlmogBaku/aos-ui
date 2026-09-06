import type { Plugin } from "@opencode-ai/plugin"

import {
  agentBuilderProviderInstructions,
  agUiProviderInstructions,
  openCodeProviderInstructions,
} from "../../lib/harness/manifests"
import { appendAosUiHarness } from "../lib/aos-ui-harness"

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

const AosUiHarnessPlugin: Plugin = async ({ client }) => {
  let reportedHealthy = false

  const report = async (
    level: "info" | "warn",
    message: string,
    extra: Record<string, unknown>
  ) => {
    try {
      await client.app.log({
        body: {
          service: "aos-ui-harness",
          level,
          message,
          extra,
        },
        throwOnError: true,
      })
    } catch {
      // Harness guidance must not block a usable provider when logging fails.
    }
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      let instructions = openCodeProviderInstructions
      let manifest = "opencode"
      let resolutionError: unknown
      if (input.sessionID) {
        try {
          const session = await client.session.get({
            path: { id: input.sessionID },
            throwOnError: true,
          })
          const sessionData = session.data as { agent?: unknown } | undefined
          if (sessionData?.agent === "agent-builder") {
            instructions = agentBuilderProviderInstructions
            manifest = "agent-builder"
          }
        } catch (reason) {
          // Keep the injected contract conservative if the provider cannot
          // authoritatively resolve the Session owner during this hook.
          instructions = agUiProviderInstructions
          manifest = "ag-ui-fallback"
          resolutionError = reason
        }
      }
      appendAosUiHarness(output.system, instructions)

      const sessionContext = input.sessionID
        ? { sessionID: input.sessionID }
        : {}
      if (resolutionError !== undefined) {
        await report(
          "warn",
          "AOS harness could not resolve Session ownership; conservative guidance was injected",
          {
            error: toErrorMessage(resolutionError),
            manifest,
            ...sessionContext,
          }
        )
      } else if (!reportedHealthy) {
        reportedHealthy = true
        await report("info", "AOS presentation harness is active", {
          manifest,
          ...sessionContext,
        })
      }
    },
  }
}

export default AosUiHarnessPlugin
