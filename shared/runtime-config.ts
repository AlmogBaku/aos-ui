import { z } from "zod"

export type RuntimeUnavailableReason =
  | "invalid-public-config"
  | "missing-hermes-base-url"
  | "invalid-hermes-base-url"
  | "invalid-runtime-mode"
  | "invalid-opencode-base-url"
  | "missing-opencode-directory"
  | "invalid-opencode-directory"
  | "incomplete-opencode-model-override"
  | "missing-ag-ui-run-url"
  | "invalid-ag-ui-run-url"
  | "missing-ag-ui-workspace-url"
  | "invalid-ag-ui-workspace-url"

export type ComposerFeatureConfig = {
  readonly modelSelectorEnabled: boolean
  readonly contextEnabled: boolean
}

export const DEFAULT_COMPOSER_FEATURE_CONFIG: ComposerFeatureConfig = {
  modelSelectorEnabled: true,
  contextEnabled: true,
}

type ArtifactHtmlConfiguration = {
  artifactHtmlAssetOrigins?: string[]
}

type ReadyRuntimeConfiguration = ArtifactHtmlConfiguration & {
  status: "ready"
  composerFeatures: ComposerFeatureConfig
}

export type RuntimeConfiguration =
  | (ReadyRuntimeConfiguration & { mode: "fixture" })
  | (ReadyRuntimeConfiguration & { mode: "hermes"; baseUrl: string })
  | (ReadyRuntimeConfiguration & {
      mode: "opencode"
      baseUrl: string
      directory: string
      defaultModel?: { providerID: string; modelID: string }
    })
  | (ReadyRuntimeConfiguration & {
      mode: "ag-ui"
      runUrl: string
      workspaceUrl: string
    })
  | { status: "unavailable"; reason: RuntimeUnavailableReason }

export type PublicRuntimeConfiguration =
  | ({
      mode: "fixture"
      composerModelSelectorEnabled: boolean
      composerContextEnabled: boolean
    } & ArtifactHtmlConfiguration)
  | ({
      mode: "hermes"
      baseUrl: string
      composerModelSelectorEnabled: boolean
      composerContextEnabled: boolean
    } & ArtifactHtmlConfiguration)
  | ({
      mode: "opencode"
      baseUrl: string
      directory: string
      defaultModel?: { providerID: string; modelID: string }
      composerModelSelectorEnabled: boolean
      composerContextEnabled: boolean
    } & ArtifactHtmlConfiguration)
  | ({
      mode: "ag-ui"
      runUrl: string
      workspaceUrl: string
      composerModelSelectorEnabled: boolean
      composerContextEnabled: boolean
    } & ArtifactHtmlConfiguration)
  | { status: "unavailable"; reason: RuntimeUnavailableReason }

type RuntimeEnvironment = Partial<
  Record<
    | "AOS_UI_RUNTIME_MODE"
    | "AOS_UI_HERMES_BASE_URL"
    | "AOS_UI_OPENCODE_BASE_URL"
    | "AOS_UI_OPENCODE_WORKTREE"
    | "AOS_UI_OPENCODE_PROVIDER_ID"
    | "AOS_UI_OPENCODE_MODEL_ID"
    | "AOS_UI_AG_UI_URL"
    | "AOS_UI_AG_UI_WORKSPACE_URL"
    | "AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED"
    | "AOS_UI_COMPOSER_CONTEXT_ENABLED",
    string | undefined
  >
>

function resolveHttpUrl(value: string | undefined) {
  if (!value) return undefined

  try {
    const parsed = new URL(value)
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      /[?#]/.test(parsed.href)
    ) {
      return null
    }

    return parsed.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

function featureEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() !== "false"
}

function resolveComposerFeatures(
  environment: RuntimeEnvironment
): ComposerFeatureConfig {
  return {
    modelSelectorEnabled: featureEnabled(
      environment.AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED
    ),
    contextEnabled: featureEnabled(environment.AOS_UI_COMPOSER_CONTEXT_ENABLED),
  }
}

/**
 * Runtime choice is intentionally strict. A misspelled production mode must
 * never expose deterministic fixture data as though it came from a provider.
 */
export function resolveRuntimeConfiguration(
  environment: RuntimeEnvironment
): RuntimeConfiguration {
  const mode = environment.AOS_UI_RUNTIME_MODE ?? "opencode"
  const composerFeatures = resolveComposerFeatures(environment)

  if (mode === "fixture") {
    return { status: "ready", mode: "fixture", composerFeatures }
  }
  if (mode === "hermes") {
    const baseUrl = environment.AOS_UI_HERMES_BASE_URL
    if (!baseUrl)
      return { status: "unavailable", reason: "missing-hermes-base-url" }
    if (/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(baseUrl))
      return {
        status: "ready",
        mode,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        composerFeatures,
      }
    const resolved = resolveHttpUrl(baseUrl)
    return resolved
      ? { status: "ready", mode, baseUrl: resolved, composerFeatures }
      : { status: "unavailable", reason: "invalid-hermes-base-url" }
  }
  if (mode === "opencode") {
    const configuredBaseUrl = resolveHttpUrl(
      environment.AOS_UI_OPENCODE_BASE_URL
    )
    if (configuredBaseUrl === null) {
      return { status: "unavailable", reason: "invalid-opencode-base-url" }
    }
    const baseUrl = configuredBaseUrl ?? "http://127.0.0.1:4096"
    const providerID = environment.AOS_UI_OPENCODE_PROVIDER_ID?.trim()
    const modelID = environment.AOS_UI_OPENCODE_MODEL_ID?.trim()

    if (Boolean(providerID) !== Boolean(modelID)) {
      return {
        status: "unavailable",
        reason: "incomplete-opencode-model-override",
      }
    }

    const directory = environment.AOS_UI_OPENCODE_WORKTREE?.trim()
    if (!directory)
      return { status: "unavailable", reason: "missing-opencode-directory" }
    if (
      !/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(directory) ||
      [...directory].some((character) => character.charCodeAt(0) < 32)
    )
      return { status: "unavailable", reason: "invalid-opencode-directory" }
    return {
      status: "ready",
      mode,
      baseUrl,
      directory,
      composerFeatures,
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

  return { status: "ready", mode, runUrl, workspaceUrl, composerFeatures }
}

/** Maps internal resolved configuration to the strict browser-visible shape. */
export function serializePublicRuntimeConfiguration(
  config: RuntimeConfiguration
): PublicRuntimeConfiguration {
  if (config.status === "unavailable") return config

  const featureFields = {
    composerModelSelectorEnabled: config.composerFeatures.modelSelectorEnabled,
    composerContextEnabled: config.composerFeatures.contextEnabled,
    ...(config.artifactHtmlAssetOrigins
      ? { artifactHtmlAssetOrigins: config.artifactHtmlAssetOrigins }
      : {}),
  }
  if (config.mode === "fixture") return { mode: config.mode, ...featureFields }
  if (config.mode === "hermes")
    return { mode: config.mode, baseUrl: config.baseUrl, ...featureFields }
  if (config.mode === "opencode") {
    return {
      mode: config.mode,
      baseUrl: config.baseUrl,
      directory: config.directory,
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      ...featureFields,
    }
  }
  return {
    mode: config.mode,
    runUrl: config.runUrl,
    workspaceUrl: config.workspaceUrl,
    ...featureFields,
  }
}

const publicComposerFeatureFields = {
  composerModelSelectorEnabled: z.boolean().optional(),
  composerContextEnabled: z.boolean().optional(),
}

const artifactHtmlAssetOriginsSchema = z
  .array(
    z.string().refine((value) => {
      try {
        const parsed = new URL(value)
        return (
          parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          parsed.href === `${value}/`
        )
      } catch {
        return false
      }
    })
  )
  .max(16)
  .optional()

const publicConfigurationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("fixture"),
      status: z.literal("ready").optional(),
      ...publicComposerFeatureFields,
      artifactHtmlAssetOrigins: artifactHtmlAssetOriginsSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("opencode"),
      status: z.literal("ready").optional(),
      baseUrl: z.string().min(1),
      directory: z.string().min(1),
      defaultModel: z
        .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
        .strict()
        .optional(),
      ...publicComposerFeatureFields,
      artifactHtmlAssetOrigins: artifactHtmlAssetOriginsSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("hermes"),
      status: z.literal("ready").optional(),
      baseUrl: z.string().min(1),
      ...publicComposerFeatureFields,
      artifactHtmlAssetOrigins: artifactHtmlAssetOriginsSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("ag-ui"),
      status: z.literal("ready").optional(),
      runUrl: z.string().min(1),
      workspaceUrl: z.string().min(1),
      ...publicComposerFeatureFields,
      artifactHtmlAssetOrigins: artifactHtmlAssetOriginsSchema,
    })
    .strict(),
])

/** Deliberately allowlists public fields; native credentials are never accepted. */
export function parsePublicRuntimeConfiguration(
  input: unknown
): RuntimeConfiguration {
  const parsed = publicConfigurationSchema.safeParse(input)
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid-public-config" }
  const config = parsed.data
  const composerEnvironment = {
    AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED:
      config.composerModelSelectorEnabled === false ? "false" : undefined,
    AOS_UI_COMPOSER_CONTEXT_ENABLED:
      config.composerContextEnabled === false ? "false" : undefined,
  }
  const withArtifactOrigins = (resolved: RuntimeConfiguration) =>
    resolved.status === "ready" && config.artifactHtmlAssetOrigins
      ? {
          ...resolved,
          artifactHtmlAssetOrigins: config.artifactHtmlAssetOrigins,
        }
      : resolved
  if (config.mode === "fixture")
    return withArtifactOrigins(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "fixture",
        ...composerEnvironment,
      })
    )
  if (config.mode === "hermes")
    return withArtifactOrigins(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "hermes",
        AOS_UI_HERMES_BASE_URL: config.baseUrl,
        ...composerEnvironment,
      })
    )
  if (config.mode === "opencode")
    return withArtifactOrigins(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "opencode",
        AOS_UI_OPENCODE_BASE_URL: config.baseUrl,
        AOS_UI_OPENCODE_WORKTREE: config.directory,
        AOS_UI_OPENCODE_PROVIDER_ID: config.defaultModel?.providerID,
        AOS_UI_OPENCODE_MODEL_ID: config.defaultModel?.modelID,
        ...composerEnvironment,
      })
    )
  return withArtifactOrigins(
    resolveRuntimeConfiguration({
      AOS_UI_RUNTIME_MODE: "ag-ui",
      AOS_UI_AG_UI_URL: config.runUrl,
      AOS_UI_AG_UI_WORKSPACE_URL: config.workspaceUrl,
      ...composerEnvironment,
    })
  )
}
