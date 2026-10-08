import type { AcpConnectionStatus, PageSignals } from "@harness-gw/sdk"
import { describe, expect, it, vi } from "vitest"

import { reloadForServedBuild, watchServedBuild } from "./build-check"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe("reloadForServedBuild", () => {
  it("reloads once for each served build that differs from the tab's", () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const check = (served: string | undefined) =>
      reloadForServedBuild({ compiled: "build-1", served, storage, reload })

    check("build-1")
    expect(reload).not.toHaveBeenCalled()
    check("build-2")
    // The reload loaded the old bundle again: the guard stops a loop.
    check("build-2")
    expect(reload).toHaveBeenCalledOnce()
    // A later deployment reloads the same tab again.
    check("build-3")
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it.each([
    { compiled: null, served: "build-2" },
    { compiled: undefined, served: "build-2" },
    { compiled: "build-1", served: undefined },
  ])(
    "never reloads when either build is unknown ($compiled, $served)",
    ({ compiled, served }) => {
      const reload = vi.fn()
      reloadForServedBuild({
        compiled,
        served,
        storage: memoryStorage(),
        reload,
      })
      expect(reload).not.toHaveBeenCalled()
    }
  )
})

describe("watchServedBuild", () => {
  function harness(initial: AcpConnectionStatus) {
    const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
    const pageListeners = new Set<(signal: "visibility" | "online") => void>()
    let visible = true
    const page: PageSignals = {
      visible: () => visible,
      subscribe(listener) {
        pageListeners.add(listener)
        return () => pageListeners.delete(listener)
      },
    }
    const check = vi.fn()
    const stop = watchServedBuild({
      connection: {
        status: initial,
        subscribeStatus(listener) {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        },
      },
      page,
      check,
    })
    return {
      check,
      stop,
      status: (status: AcpConnectionStatus) =>
        statusListeners.forEach((listener) => listener(status)),
      page: (signal: "visibility" | "online", isVisible = true) => {
        visible = isVisible
        pageListeners.forEach((listener) => listener(signal))
      },
    }
  }

  it("asks again when the socket comes back, not when it first opens", () => {
    const tab = harness("connecting")

    tab.status("ready")
    expect(tab.check).not.toHaveBeenCalled()
    tab.status("reconnecting")
    tab.status("ready")
    expect(tab.check).toHaveBeenCalledOnce()
  })

  it("asks again when the tab becomes visible, not when it hides or goes online", () => {
    const tab = harness("ready")

    tab.page("visibility", false)
    tab.page("online")
    expect(tab.check).not.toHaveBeenCalled()
    tab.page("visibility", true)
    expect(tab.check).toHaveBeenCalledOnce()
  })

  it("stops asking once stopped", () => {
    const tab = harness("ready")

    tab.stop()
    tab.status("reconnecting")
    tab.status("ready")
    tab.page("visibility", true)
    expect(tab.check).not.toHaveBeenCalled()
  })
})
