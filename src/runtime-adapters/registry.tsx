import { createElement, lazy } from "react"
import { isRuntimeMode, type RuntimeMode } from "@shared/runtime-modes"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "./definition"

function defineLazyAdapter<M extends RuntimeMode>(
  mode: M,
  load: () => Promise<{ runtimeAdapter: RuntimeAdapterDefinition<M> }>
): RuntimeAdapterDefinition<M> {
  return {
    mode,
    Provider: lazy(async () => {
      const { runtimeAdapter } = await load()
      return {
        default: ({ config, locale, children }: RuntimeAdapterProps<M>) => {
          if (config.mode !== mode)
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
  fixture: defineLazyAdapter("fixture", () => import("./fixture")),
  opencode: defineLazyAdapter("opencode", () => import("./opencode")),
  hermes: defineLazyAdapter("hermes", () => import("./hermes")),
  "ag-ui": defineLazyAdapter("ag-ui", () => import("./ag-ui")),
  openclaw: defineLazyAdapter("openclaw", () => import("./openclaw")),
  aos: defineLazyAdapter("aos", () => import("./aos")),
} satisfies { [M in RuntimeMode]: RuntimeAdapterDefinition<M> }

export function getRuntimeAdapter<M extends RuntimeMode>(
  mode: M
): (typeof runtimeAdapters)[M]
export function getRuntimeAdapter(
  mode: unknown
): (typeof runtimeAdapters)[RuntimeMode] | undefined
export function getRuntimeAdapter(mode: unknown) {
  return isRuntimeMode(mode) ? runtimeAdapters[mode] : undefined
}

/** Select and render together so a union config never loses its mode correlation. */
export function HarnessRuntimeProvider({
  config,
  ...props
}: RuntimeAdapterProps) {
  switch (config.mode) {
    case "fixture":
      return createElement(runtimeAdapters.fixture.Provider, {
        ...props,
        config,
      })
    case "opencode":
      return createElement(runtimeAdapters.opencode.Provider, {
        ...props,
        config,
      })
    case "hermes":
      return createElement(runtimeAdapters.hermes.Provider, {
        ...props,
        config,
      })
    case "ag-ui":
      return createElement(runtimeAdapters["ag-ui"].Provider, {
        ...props,
        config,
      })
    case "openclaw":
      return createElement(runtimeAdapters.openclaw.Provider, {
        ...props,
        config,
      })
    case "aos":
      return createElement(runtimeAdapters.aos.Provider, {
        ...props,
        config,
      })
    default:
      return unsupportedRuntime(config)
  }
}

function unsupportedRuntime(config: never): never {
  throw new Error("Unsupported runtime configuration", { cause: config })
}
