import { isAbsolute, resolve } from "node:path"

type Environment = Readonly<Record<string, string | undefined>>

const customProviderVariables = [
  "AOS_UI_OPENAI_COMPATIBLE_BASE_URL",
  "AOS_UI_OPENAI_COMPATIBLE_API_KEY",
  "AOS_UI_OPENAI_COMPATIBLE_MODEL_ID",
] as const

const defaultCorsOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"]
const montyToolNames = "monty_execute,monty_search"

type MontyConfiguration =
  { type: "local"; command: string[] } | { type: "remote"; url: string }

function parseMontyConfiguration(
  environment: Environment
): MontyConfiguration | undefined {
  const rawCommand = environment.AOS_UI_OPENCODE_MONTY_COMMAND_JSON?.trim()
  const rawUrl = environment.AOS_UI_OPENCODE_MONTY_URL?.trim()
  if (rawCommand && rawUrl) {
    throw new Error(
      "Monty configuration accepts either AOS_UI_OPENCODE_MONTY_COMMAND_JSON or AOS_UI_OPENCODE_MONTY_URL, not both."
    )
  }

  if (rawCommand) {
    let command: unknown
    try {
      command = JSON.parse(rawCommand)
    } catch {
      throw new Error(
        "Monty AOS_UI_OPENCODE_MONTY_COMMAND_JSON must be a JSON array of non-empty strings."
      )
    }
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || !part.trim())
    ) {
      throw new Error(
        "Monty AOS_UI_OPENCODE_MONTY_COMMAND_JSON must be a JSON array of non-empty strings."
      )
    }
    return { type: "local", command }
  }

  if (rawUrl) {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error("Monty AOS_UI_OPENCODE_MONTY_URL must be an http(s) URL.")
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Monty AOS_UI_OPENCODE_MONTY_URL must be an http(s) URL.")
    }
    return { type: "remote", url: url.href }
  }

  return undefined
}

export function buildOpenCodeConfigContent(
  environment: Environment,
  integrationPluginUrl?: string
): string | undefined {
  const monty = parseMontyConfiguration(environment)
  const configuredVariableCount = customProviderVariables.filter((variable) =>
    environment[variable]?.trim()
  ).length

  if (configuredVariableCount === 0 && !integrationPluginUrl && !monty) {
    return undefined
  }

  if (
    configuredVariableCount > 0 &&
    configuredVariableCount !== customProviderVariables.length
  ) {
    throw new Error(
      "Custom OpenAI-compatible provider configuration requires all three AOS_UI_OPENAI_COMPATIBLE_* variables: AOS_UI_OPENAI_COMPATIBLE_BASE_URL, AOS_UI_OPENAI_COMPATIBLE_API_KEY, and AOS_UI_OPENAI_COMPATIBLE_MODEL_ID."
    )
  }

  return JSON.stringify({
    ...(integrationPluginUrl || monty
      ? {
          permission: {
            ...(integrationPluginUrl
              ? {
                  create_agent: "deny",
                  start_session: "allow",
                  render_chart: "allow",
                  render_map: "allow",
                  render_stats: "allow",
                  present_plan: "allow",
                }
              : {}),
            ...(monty ? { monty_execute: "allow", monty_search: "allow" } : {}),
          },
          ...(integrationPluginUrl ? { plugin: [integrationPluginUrl] } : {}),
        }
      : {}),
    ...(monty
      ? {
          mcp: {
            monty: {
              ...monty,
              enabled: true,
              timeout: 120_000,
            },
          },
        }
      : {}),
    ...(configuredVariableCount
      ? {
          provider: {
            "openai-compatible": {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: "{env:AOS_UI_OPENAI_COMPATIBLE_BASE_URL}",
                apiKey: "{env:AOS_UI_OPENAI_COMPATIBLE_API_KEY}",
              },
              models: {
                default: {
                  id: "{env:AOS_UI_OPENAI_COMPATIBLE_MODEL_ID}",
                },
              },
            },
          },
        }
      : {}),
  })
}

export function parseOpenCodeWorktree(environment: Environment) {
  const value = environment.AOS_UI_OPENCODE_WORKTREE?.trim()
  if (!value)
    throw new Error(
      "AOS_UI_OPENCODE_WORKTREE must name an external OpenCode worktree."
    )
  if (!isAbsolute(value))
    throw new Error("AOS_UI_OPENCODE_WORKTREE must be an absolute path.")
  return resolve(value)
}

export function createOpenCodeChildEnvironment<
  TEnvironment extends Environment,
>(
  environment: TEnvironment,
  configContent?: string
): TEnvironment & {
  AOS_UI_OPENCODE_MONTY_TOOLS?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  OPENCODE_CONFIG_CONTENT?: string
} {
  const monty = parseMontyConfiguration(environment)
  const googleApiKey =
    environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    environment.GEMINI_API_KEY?.trim()

  return {
    ...environment,
    ...(googleApiKey ? { GOOGLE_GENERATIVE_AI_API_KEY: googleApiKey } : {}),
    ...(monty && !environment.AOS_UI_OPENCODE_MONTY_TOOLS?.trim()
      ? { AOS_UI_OPENCODE_MONTY_TOOLS: montyToolNames }
      : {}),
    ...(configContent ? { OPENCODE_CONFIG_CONTENT: configContent } : {}),
  }
}

export function parseCorsOrigins(rawOrigins: string | undefined): string[] {
  if (rawOrigins === undefined) {
    return defaultCorsOrigins
  }

  const origins = rawOrigins.split(",").map((origin) => origin.trim())
  if (origins.length === 0 || origins.some((origin) => !origin)) {
    throw new Error(
      "AOS_UI_OPENCODE_CORS_ORIGINS must contain at least one non-empty origin."
    )
  }

  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error(
        `AOS_UI_OPENCODE_CORS_ORIGINS must contain only valid http(s) origins; received ${JSON.stringify(origin)}.`
      )
    }

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== origin
    ) {
      throw new Error(
        `AOS_UI_OPENCODE_CORS_ORIGINS must contain only valid http(s) origins; received ${JSON.stringify(origin)}.`
      )
    }
  }

  return origins
}

export function createOpenCodeServeArguments(
  host: string,
  port: number,
  corsOrigins: readonly string[]
): string[] {
  return [
    "serve",
    "--hostname",
    host,
    "--port",
    String(port),
    ...corsOrigins.flatMap((origin) => ["--cors", origin]),
  ]
}
