import { createElement, lazy } from "react"
import { isRuntimeMode, type RuntimeMode } from "@shared/runtime-modes"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "./definition"

function matchesMode<M extends RuntimeMode>(
  config: RuntimeAdapterProps["config"],
  mode: M
): config is RuntimeAdapterProps<M>["config"] {
  return config.mode === mode
}

function defineLazyAdapter<M extends RuntimeMode>(
  mode: M,
  load: () => Promise<{ runtimeAdapter: RuntimeAdapterDefinition<M> }>
) {
  return {
    mode,
    Provider: lazy(async () => {
      const { runtimeAdapter } = await load()
      return {
        default: ({ config, locale, children }: RuntimeAdapterProps) => {
          if (!matchesMode(config, mode))
            throw new Error("Runtime adapter configuration mismatch")
          return createElement(runtimeAdapter.Provider, {
            config,
            locale,
            children,
          })
        },
      }
    }),
  }
}

/** Exhaustive registry. Adding a mode requires an explicit lazy browser adapter. */
const runtimeAdapters = {
  fixture: defineLazyAdapter("fixture", () => import("./fixture/composition")),
  opencode: defineLazyAdapter(
    "opencode",
    () => import("./opencode/composition")
  ),
  hermes: defineLazyAdapter("hermes", () => import("./hermes/composition")),
  "ag-ui": defineLazyAdapter("ag-ui", () => import("./ag-ui/composition")),
} satisfies {
  [M in RuntimeMode]: {
    mode: M
    Provider: RuntimeAdapterDefinition["Provider"]
  }
}

export function getRuntimeAdapter(mode: unknown) {
  return isRuntimeMode(mode) ? runtimeAdapters[mode] : undefined
}
