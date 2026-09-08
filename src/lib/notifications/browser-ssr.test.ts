// @vitest-environment node
import { expect, it } from "vitest"
import {
  createActivityBrowserPlatform,
  createBrowserNotificationPort,
} from "./browser-platform"
import { BrowserActivityCoordinator } from "./browser-coordinator"
it("imports browser delivery modules and creates ports without browser globals", () => {
  expect(typeof window).toBe("undefined")
  expect(createBrowserNotificationPort().getPermission()).toBe("unsupported")
  expect(() => createActivityBrowserPlatform()).not.toThrow()
  expect(BrowserActivityCoordinator).toBeDefined()
})
