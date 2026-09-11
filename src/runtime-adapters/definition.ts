import type { ComponentType, ReactNode } from "react"
import type { Locale } from "@/lib/i18n/config"
import type { RuntimeConfiguration } from "@shared/runtime-config"
import type { RuntimeMode } from "@shared/runtime-modes"
import type { HarnessRuntime } from "./contracts"

export type RuntimeAdapterProps<M extends RuntimeMode = RuntimeMode> = {
  config: Extract<RuntimeConfiguration, { status: "ready"; mode: M }>
  locale: Locale
  children: (runtime: HarnessRuntime) => ReactNode
}

/** Provider owns transport lifecycle; the application owns workspace presentation. */
export type RuntimeAdapterDefinition<M extends RuntimeMode = RuntimeMode> = {
  mode: M
  Provider: ComponentType<RuntimeAdapterProps<M>>
}
