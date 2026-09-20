/// <reference lib="webworker" />

import { handleNotificationClick, handlePush } from "./logic"

/**
 * Push-only service worker: no fetch handling, no caching, no offline shell.
 * All behavior lives in `logic.ts`; this file only registers listeners.
 */

declare const self: ServiceWorkerGlobalScope

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(self.registration, event.data?.text()))
})

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(handleNotificationClick(self.clients, event.notification))
})
