/// <reference lib="webworker" />

import { handleNotificationClick, handlePush } from "./logic"

/**
 * Push-only service worker: no fetch handling, no caching, no offline shell.
 * All behavior lives in `logic.ts`; this file only registers listeners.
 */

declare const self: ServiceWorkerGlobalScope

/**
 * An updated worker otherwise installs into `waiting` and stays there until
 * every tab the old one controls is gone -- reloading is not enough -- so an
 * operator who keeps a tab open would keep running stale push handling with
 * nothing to tell them. Skipping the wait and claiming the open tabs would be
 * wrong for a caching worker, whose old version still owes responses to
 * documents it has already begun serving; this one answers no fetches and holds
 * no cache, so there is no half-updated page to hand anyone.
 */
self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(self.registration, event.data?.text()))
})

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(handleNotificationClick(self.clients, event.notification))
})
