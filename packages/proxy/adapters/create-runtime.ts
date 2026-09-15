import type { RuntimeConfig, RuntimeLimits } from "../config"
import type { RuntimeInstance } from "../core/runtime"
import { createHermesRuntime } from "./hermes/factory"
import { createOpenCodeRuntime } from "./opencode/factory"

export type RuntimeFactory = (
  config: RuntimeConfig,
  limits: RuntimeLimits
) => Promise<RuntimeInstance>

export const createRuntimeInstance: RuntimeFactory = (config, limits) => {
  switch (config.kind) {
    case "hermes":
      return createHermesRuntime(config, limits)
    case "opencode":
      return createOpenCodeRuntime(config, limits)
    case "openclaw":
      throw new Error("OpenClaw runtime is not available")
  }
}
