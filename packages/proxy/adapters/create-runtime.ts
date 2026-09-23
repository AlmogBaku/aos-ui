import type { RuntimeConfig, RuntimeLimits } from "../config"
import type { RuntimeInstance } from "../core/runtime"
import type { McpServerOverrides } from "../mcp-apps/client"
import { createHermesRuntime } from "./hermes/factory"
import { createOpenClawRuntime } from "./openclaw/factory"
import { createOpenCodeRuntime } from "./opencode/factory"

export type RuntimeFactory = (
  config: RuntimeConfig,
  limits: RuntimeLimits,
  mcpServerOverrides: McpServerOverrides
) => Promise<RuntimeInstance>

export const createRuntimeInstance: RuntimeFactory = (
  config,
  limits,
  mcpServerOverrides
) => {
  switch (config.kind) {
    case "hermes":
      return createHermesRuntime(config, limits, { mcpServerOverrides })
    case "opencode":
      return createOpenCodeRuntime(config, limits, { mcpServerOverrides })
    case "openclaw":
      return createOpenClawRuntime(config, limits)
  }
}
