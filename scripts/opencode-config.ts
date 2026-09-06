type Environment = Readonly<Record<string, string | undefined>>

const customProviderVariables = [
  "AOS_UI_OPENAI_COMPATIBLE_BASE_URL",
  "AOS_UI_OPENAI_COMPATIBLE_API_KEY",
  "AOS_UI_OPENAI_COMPATIBLE_MODEL_ID",
] as const

const defaultCorsOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"]

export function buildOpenCodeConfigContent(
  environment: Environment
): string | undefined {
  const configuredVariableCount = customProviderVariables.filter((variable) =>
    environment[variable]?.trim()
  ).length

  if (configuredVariableCount === 0) {
    return undefined
  }

  if (configuredVariableCount !== customProviderVariables.length) {
    throw new Error(
      "Custom OpenAI-compatible provider configuration requires all three AOS_UI_OPENAI_COMPATIBLE_* variables: AOS_UI_OPENAI_COMPATIBLE_BASE_URL, AOS_UI_OPENAI_COMPATIBLE_API_KEY, and AOS_UI_OPENAI_COMPATIBLE_MODEL_ID."
    )
  }

  return JSON.stringify({
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
  })
}

export function createOpenCodeChildEnvironment<
  TEnvironment extends Environment,
>(
  environment: TEnvironment,
  configContent?: string
): TEnvironment & {
  GOOGLE_GENERATIVE_AI_API_KEY?: string
  OPENCODE_CONFIG_CONTENT?: string
} {
  const googleApiKey =
    environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    environment.GEMINI_API_KEY?.trim()

  return {
    ...environment,
    ...(googleApiKey ? { GOOGLE_GENERATIVE_AI_API_KEY: googleApiKey } : {}),
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
