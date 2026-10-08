import { z } from "zod"

import { DEFAULT_RUNTIME_MODE } from "./runtime-modes"

export type RuntimeUnavailableReason =
  "invalid-public-config" | "invalid-runtime-mode"

export type ComposerFeatureConfig = {
  readonly modelSelectorEnabled: boolean
  readonly contextEnabled: boolean
}

export const DEFAULT_COMPOSER_FEATURE_CONFIG: ComposerFeatureConfig = {
  modelSelectorEnabled: true,
  contextEnabled: true,
}

type ReadyRuntimeConfiguration = {
  status: "ready"
  composerFeatures: ComposerFeatureConfig
}

export type RuntimeConfiguration =
  | (ReadyRuntimeConfiguration & { mode: "fixture" })
  | (ReadyRuntimeConfiguration & { mode: "aos" })
  | { status: "unavailable"; reason: RuntimeUnavailableReason }

export type PublicRuntimeConfiguration =
  | {
      mode: "fixture" | "aos"
      composerModelSelectorEnabled?: boolean
      composerContextEnabled?: boolean
    }
  | { status: "unavailable"; reason: RuntimeUnavailableReason }

export type GuestSurfaceConfiguration = {
  status: "ready"
  surface: "guest"
}

export type ApplicationConfiguration =
  RuntimeConfiguration | GuestSurfaceConfiguration

type RuntimeEnvironment = Partial<
  Record<
    | "AOS_UI_RUNTIME_MODE"
    | "AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED"
    | "AOS_UI_COMPOSER_CONTEXT_ENABLED",
    string | undefined
  >
>

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
 * Browser configuration never names a native provider. The AOS proxy owns
 * provider selection and credentials; fixture is deliberately explicit.
 */
export function resolveRuntimeConfiguration(
  environment: RuntimeEnvironment
): RuntimeConfiguration {
  const mode = environment.AOS_UI_RUNTIME_MODE ?? DEFAULT_RUNTIME_MODE
  if (mode !== "aos" && mode !== "fixture")
    return { status: "unavailable", reason: "invalid-runtime-mode" }
  return {
    status: "ready",
    mode,
    composerFeatures: resolveComposerFeatures(environment),
  }
}

/** Maps the resolved configuration to the strict browser-visible shape. */
export function serializePublicRuntimeConfiguration(
  config: RuntimeConfiguration
): PublicRuntimeConfiguration {
  if (config.status === "unavailable") return config
  return {
    mode: config.mode,
    ...(config.composerFeatures.modelSelectorEnabled === false
      ? { composerModelSelectorEnabled: false }
      : {}),
    ...(config.composerFeatures.contextEnabled === false
      ? { composerContextEnabled: false }
      : {}),
  }
}

/**
 * The build the server serves, read by the tab that compares it with its own;
 * neither surface's configuration depends on it.
 */
const buildIdField = { buildId: z.string().optional() }

const publicComposerFeatureFields = {
  composerModelSelectorEnabled: z.boolean().optional(),
  composerContextEnabled: z.boolean().optional(),
}

const publicConfigurationSchema = z
  .object({
    mode: z.enum(["aos", "fixture"]),
    ...publicComposerFeatureFields,
    ...buildIdField,
  })
  .strict()

/** Deliberately allowlists public fields; native credentials are never accepted. */
export function parsePublicRuntimeConfiguration(
  input: unknown
): RuntimeConfiguration {
  const parsed = publicConfigurationSchema.safeParse(input)
  if (!parsed.success)
    return { status: "unavailable", reason: "invalid-public-config" }
  const config = parsed.data
  return resolveRuntimeConfiguration({
    AOS_UI_RUNTIME_MODE: config.mode,
    AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED:
      config.composerModelSelectorEnabled === false ? "false" : undefined,
    AOS_UI_COMPOSER_CONTEXT_ENABLED:
      config.composerContextEnabled === false ? "false" : undefined,
  })
}

const guestSurfaceSchema = z
  .object({ surface: z.literal("guest"), ...buildIdField })
  .strict()

/** Selects the guest surface before runtime parsing; guest code never selects a provider. */
export function parsePublicApplicationConfiguration(
  input: unknown
): ApplicationConfiguration {
  const guest = guestSurfaceSchema.safeParse(input)
  if (guest.success) return { status: "ready", surface: guest.data.surface }
  return parsePublicRuntimeConfiguration(input)
}
