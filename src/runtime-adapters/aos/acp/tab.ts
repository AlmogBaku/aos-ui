import {
  acpDebugEnabled,
  createAcpLogger,
  type AcpConnection,
  type OwnerInspector,
  type PageSignals,
} from "@harness-gw/sdk"

import { reloadForServedBuild, watchServedBuild } from "./build-check"

/** Whether this tab asked for debug lines with `?debug=acp`. */
function tabDebugEnabled() {
  return acpDebugEnabled(globalThis.location.search, globalThis.sessionStorage)
}

/** This tab's ACP logger. */
export function tabAcpLogger() {
  return createAcpLogger({ debug: tabDebugEnabled() })
}

/** This tab's visibility and network, as the connection reads them. */
const tabPage: PageSignals = {
  visible: () => globalThis.document.visibilityState !== "hidden",
  subscribe(listener) {
    const onVisibility = () => listener("visibility")
    const onOnline = () => listener("online")
    globalThis.document.addEventListener("visibilitychange", onVisibility)
    globalThis.addEventListener("online", onOnline)
    return () => {
      globalThis.document.removeEventListener("visibilitychange", onVisibility)
      globalThis.removeEventListener("online", onOnline)
    }
  },
}

/**
 * The Stately inspector, in a debug dev build only: Rollup drops the branch,
 * and the inspector with it, in production.
 */
async function devInspector(): Promise<OwnerInspector | undefined> {
  if (!import.meta.env.DEV || !tabDebugEnabled()) return undefined
  const { createBrowserInspector } = await import("@statelyai/inspect")
  return createBrowserInspector().inspect
}

/** What a connection opened in this tab takes from the tab. */
export function tabConnectionOptions() {
  return {
    logger: tabAcpLogger(),
    page: tabPage,
    inspector: devInspector,
  }
}

/** The build the server serves now, from its runtime configuration. */
async function servedBuild() {
  const response = await fetch("/runtime-config.json", { cache: "no-store" })
  if (!response.ok) return undefined
  const { buildId } = (await response.json()) as { buildId?: unknown }
  return typeof buildId === "string" ? buildId : undefined
}

/** Reloads this tab when a reconnect or a return finds a newer build served. */
export function watchTabBuild(connection: AcpConnection) {
  return watchServedBuild({
    connection,
    page: tabPage,
    check: () => {
      void servedBuild().then(
        (served) =>
          reloadForServedBuild({
            compiled: __AOS_BUILD_ID__,
            served,
            storage: globalThis.sessionStorage,
            reload: () => globalThis.location.reload(),
          }),
        // An unreachable server says nothing about the build; the next
        // reconnect or return asks again.
        () => undefined
      )
    },
  })
}
