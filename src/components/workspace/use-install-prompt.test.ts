import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { useInstallPrompt } from "./use-install-prompt"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("offers installation only once the browser volunteers a prompt", () => {
  const { result } = renderHook(useInstallPrompt)
  expect(result.current.installable).toBe(false)
  // No iOS user agent in the test browser, so the Home Screen hint stays off.
  expect(result.current.iosInstallHint).toBe(false)

  const prompt = vi.fn(async () => {})
  const event = Object.assign(new Event("beforeinstallprompt"), { prompt })
  act(() => void window.dispatchEvent(event))

  expect(result.current.installable).toBe(true)
  act(() => result.current.install())
  expect(prompt).toHaveBeenCalledOnce()
  expect(result.current.installable).toBe(false)
})

it("reports the Home Screen hint for a browser that cannot install itself", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
  )
  const { result } = renderHook(useInstallPrompt)
  expect(result.current.iosInstallHint).toBe(true)
  expect(result.current.installable).toBe(false)
})
