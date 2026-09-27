import type { Logger } from "../../lifecycle"
import type { RuntimeConfig, RuntimeLimits } from "../config"
import type { RuntimeInstance } from "../core/runtime"
import type { McpServerOverrides } from "../mcp-apps/client"
import type { CredentialValues } from "../redaction"
import { createHermesRuntime } from "./hermes/factory"
import { createOpenClawRuntime } from "./openclaw/factory"
import { createOpenCodeRuntime } from "./opencode/factory"

/** What the proxy hands every runtime it constructs. */
export type RuntimeServices = {
  /** The redacting root every runtime line is written through. */
  logger: Logger
  /** Where each credential the runtime reads joins the values the log masks. */
  credentials: CredentialValues
  mcpServerOverrides?: McpServerOverrides
}

export type RuntimeFactory = (
  config: RuntimeConfig,
  limits: RuntimeLimits,
  services: RuntimeServices
) => Promise<RuntimeInstance>

export const createRuntimeInstance: RuntimeFactory = (
  config,
  limits,
  services
) => {
  switch (config.kind) {
    case "hermes":
      return createHermesRuntime(config, limits, services)
    case "opencode":
      return createOpenCodeRuntime(config, limits, services)
    case "openclaw":
      return createOpenClawRuntime(config, limits, services)
  }
}
