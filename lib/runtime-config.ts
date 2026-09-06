export type RuntimeUnavailableReason =
  | "invalid-runtime-mode"
  | "invalid-opencode-base-url"
  | "invalid-opencode-management-url"
  | "incomplete-opencode-model-override"
  | "missing-ag-ui-run-url"
  | "invalid-ag-ui-run-url"
  | "missing-ag-ui-workspace-url"
  | "invalid-ag-ui-workspace-url"

export type RuntimeConfiguration =
  | { status: "ready"; mode: "fixture" }
  | {
      status: "ready"
      mode: "opencode"
      baseUrl: string
      managementUrl?: string
      defaultModel?: { providerID: string; modelID: string }
    }
  | {
      status: "ready"
      mode: "ag-ui"
      runUrl: string
      workspaceUrl: string
    }
  | { status: "unavailable"; reason: RuntimeUnavailableReason }

type RuntimeEnvironment = Partial<
  Record<
    | "AOS_UI_RUNTIME_MODE"
    | "AOS_UI_OPENCODE_BASE_URL"
    | "AOS_UI_OPENCODE_MANAGEMENT_URL"
    | "AOS_UI_OPENCODE_PROVIDER_ID"
    | "AOS_UI_OPENCODE_MODEL_ID"
    | "AOS_UI_AG_UI_URL"
    | "AOS_UI_AG_UI_WORKSPACE_URL",
    string | undefined
  >
>

function resolveHttpUrl(value: string | undefined) {
  if (!value) return undefined

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }

    return parsed.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

function resolveManagementUrl(value: string | undefined) {
  const resolved = resolveHttpUrl(value)
  if (!resolved) return resolved
  const parsed = new URL(resolved)
  // Endpoint paths append to this prefix; query, fragment, and userinfo are
  // unsupported, including empty query/fragment delimiters.
  if (parsed.username || parsed.password || /[?#]/.test(parsed.href))
    return null
  return parsed.href.replace(/\/+$/, "")
}

/**
 * Runtime choice is intentionally strict. A misspelled production mode must
 * never expose deterministic fixture data as though it came from a provider.
 */
export function resolveRuntimeConfiguration(
  environment: RuntimeEnvironment
): RuntimeConfiguration {
  const mode = environment.AOS_UI_RUNTIME_MODE ?? "opencode"

  if (mode === "fixture") {
    return { status: "ready", mode: "fixture" }
  }
  if (mode === "opencode") {
    const configuredBaseUrl = resolveHttpUrl(
      environment.AOS_UI_OPENCODE_BASE_URL
    )
    if (configuredBaseUrl === null) {
      return { status: "unavailable", reason: "invalid-opencode-base-url" }
    }
    const baseUrl = configuredBaseUrl ?? "http://127.0.0.1:4096"
    const managementUrl = resolveManagementUrl(
      environment.AOS_UI_OPENCODE_MANAGEMENT_URL
    )
    if (managementUrl === null)
      return {
        status: "unavailable",
        reason: "invalid-opencode-management-url",
      }
    const providerID = environment.AOS_UI_OPENCODE_PROVIDER_ID?.trim()
    const modelID = environment.AOS_UI_OPENCODE_MODEL_ID?.trim()

    if (Boolean(providerID) !== Boolean(modelID)) {
      return {
        status: "unavailable",
        reason: "incomplete-opencode-model-override",
      }
    }

    return {
      status: "ready",
      mode,
      baseUrl,
      ...(managementUrl ? { managementUrl } : {}),
      ...(providerID && modelID
        ? { defaultModel: { providerID, modelID } }
        : {}),
    }
  }
  if (mode !== "ag-ui") {
    return { status: "unavailable", reason: "invalid-runtime-mode" }
  }

  const runUrl = resolveHttpUrl(environment.AOS_UI_AG_UI_URL)
  if (runUrl === undefined) {
    return { status: "unavailable", reason: "missing-ag-ui-run-url" }
  }
  if (runUrl === null) {
    return { status: "unavailable", reason: "invalid-ag-ui-run-url" }
  }

  const workspaceUrl = resolveHttpUrl(environment.AOS_UI_AG_UI_WORKSPACE_URL)
  if (workspaceUrl === undefined) {
    return {
      status: "unavailable",
      reason: "missing-ag-ui-workspace-url",
    }
  }
  if (workspaceUrl === null) {
    return {
      status: "unavailable",
      reason: "invalid-ag-ui-workspace-url",
    }
  }

  return { status: "ready", mode, runUrl, workspaceUrl }
}
