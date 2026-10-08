import type { AcpConnection, PageSignals } from "@harness-gw/sdk"

/** sessionStorage key naming the served build the tab last reloaded for. */
const RELOADED_FOR_BUILD_KEY = "aos-reloaded-for-build"

type ReloadGuard = Pick<Storage, "getItem" | "setItem">

/**
 * Reloads the tab when the server now serves a build other than the one the
 * tab runs. The tab reloads once per served build, so a reload that still
 * loads the old bundle cannot loop, and a later deployment reloads again. A
 * tab with no compiled build id (the dev server) never reloads.
 */
export function reloadForServedBuild({
  compiled,
  served,
  storage,
  reload,
}: {
  compiled: string | null | undefined
  served: string | undefined
  storage: ReloadGuard
  reload: () => void
}) {
  if (!compiled || !served || served === compiled) return
  if (storage.getItem(RELOADED_FOR_BUILD_KEY) === served) return
  storage.setItem(RELOADED_FOR_BUILD_KEY, served)
  reload()
}

/**
 * Asks the server which build it serves whenever the gateway socket comes
 * back and whenever the tab becomes visible: a deployment restarts the
 * gateway or happens while the tab sits in the background.
 */
export function watchServedBuild({
  connection,
  page,
  check,
}: {
  connection: Pick<AcpConnection, "status" | "subscribeStatus">
  page: PageSignals
  check: () => void
}) {
  let ready = connection.status === "ready"
  let lost = false
  const stopStatus = connection.subscribeStatus((status) => {
    if (status !== "ready") {
      lost ||= ready
      ready = false
      return
    }
    ready = true
    if (lost) check()
    lost = false
  })
  const stopPage = page.subscribe((signal) => {
    if (signal === "visibility" && page.visible()) check()
  })
  return () => {
    stopStatus()
    stopPage()
  }
}
