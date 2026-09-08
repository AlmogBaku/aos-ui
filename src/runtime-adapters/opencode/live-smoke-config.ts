export type LiveOpenCodeSmokeConfig =
  | { enabled: false }
  | {
      enabled: true
      baseUrl: string
      providerID: string
      modelID: string
      agentId?: string
    }

type Environment = Readonly<Record<string, string | undefined>>

function configured(value: string | undefined) {
  const result = value?.trim()
  return result ? result : undefined
}

export function readLiveOpenCodeSmokeConfig(
  environment: Environment
): LiveOpenCodeSmokeConfig {
  if (environment.AOS_UI_LIVE_OPENCODE !== "1" || environment.CI) {
    return { enabled: false }
  }

  const modelID = configured(environment.AOS_UI_OPENCODE_MODEL_ID)
  if (!modelID) {
    throw new Error(
      "AOS_UI_OPENCODE_MODEL_ID is required for the live OpenCode smoke"
    )
  }
  if (!/(?:haiku|nova)/i.test(modelID)) {
    throw new Error(
      "AOS_UI_OPENCODE_MODEL_ID must select a cheap Bedrock Haiku or Nova model"
    )
  }

  const baseUrl =
    configured(environment.AOS_UI_OPENCODE_BASE_URL)?.replace(/\/+$/, "") ??
    "http://127.0.0.1:4096"
  const providerID =
    configured(environment.AOS_UI_OPENCODE_PROVIDER_ID) ?? "amazon-bedrock"
  const agentId = configured(environment.AOS_UI_OPENCODE_AGENT_ID)

  return {
    enabled: true,
    baseUrl,
    providerID,
    modelID,
    ...(agentId ? { agentId } : {}),
  }
}
