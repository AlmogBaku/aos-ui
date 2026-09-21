import { createBrowserId } from "@/lib/browser-id"

import type { BrowserNotificationPort } from "./browser-port"
import type { ActivityBrowserPlatform } from "./browser-coordinator"
import { DeliveryLeader } from "./delivery-leader"

/** Factory and imports are SSR-safe; browser globals are read only on use. */
export function createBrowserNotificationPort(): BrowserNotificationPort {
  return {
    getPermission: () =>
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    requestPermission: () =>
      typeof Notification === "undefined"
        ? Promise.resolve("unsupported")
        : Notification.requestPermission(),
    show: ({ title, body, icon, timestamp, tag, renotify }, onClick) => {
      const options = { body, icon, timestamp, tag, renotify }
      const notification = new Notification(title, options)
      notification.onclick = () => {
        try {
          onClick()
        } catch {}
      }
      return {
        close() {
          notification.onclick = null
          notification.close()
        },
      }
    },
    onPermissionChange: (listener) => {
      let status: PermissionStatus | undefined
      let stopped = false
      try {
        // A permission changed from the browser's own chrome never touches this
        // page, so nothing else would notice until the next focus.
        void navigator.permissions
          ?.query({ name: "notifications" as PermissionName })
          .then((result) => {
            if (stopped) return
            status = result
            result.addEventListener("change", listener)
          })
          .catch(() => {})
      } catch {
        /* Without the Permissions API the recheck stays focus-driven. */
      }
      return () => {
        stopped = true
        try {
          status?.removeEventListener("change", listener)
        } catch {}
      }
    },
  }
}
const snapshotKey = "aos-ui.activity.v1"
const messageKey = "aos-ui.activity.message.v1"
export function createActivityBrowserPlatform(): ActivityBrowserPlatform {
  let channel: BroadcastChannel | undefined
  let leader: DeliveryLeader | undefined
  let messageSequence = 0
  return {
    read: () => window.localStorage.getItem(snapshotKey),
    write: (value) => window.localStorage.setItem(snapshotKey, value),
    send(value) {
      let channelSent = false
      try {
        if (channel) {
          channel.postMessage(value)
          channelSent = true
        }
      } catch {}
      window.localStorage.setItem(
        messageKey,
        JSON.stringify({ sequence: ++messageSequence, channelSent, value })
      )
    },
    subscribe(listener) {
      try {
        if (typeof BroadcastChannel !== "undefined") {
          channel = new BroadcastChannel(snapshotKey)
          channel.onmessage = (event) => listener(event.data)
        }
      } catch {
        channel = undefined
      }
      const onStorage = (event: StorageEvent) => {
        if (event.key !== messageKey || !event.newValue) return
        try {
          const message = JSON.parse(event.newValue)
          // Channel peers already receive this write in FIFO order. Avoid a
          // delayed storage duplicate restoring an older preference value.
          if (channel && message.channelSent === true) return
          listener(message.value)
        } catch {}
      }
      // Listen even with a channel, so tabs with a failed channel can reach us.
      window.addEventListener("storage", onStorage)
      return () => {
        window.removeEventListener("storage", onStorage)
        channel?.close()
        channel = undefined
      }
    },
    startLeadership(onLeader) {
      const start = () => {
        leader = new DeliveryLeader({
          id: createBrowserId(),
          now: Date.now,
          storage: {
            getItem: (key) => window.localStorage.getItem(key),
            setItem: (key, value) => window.localStorage.setItem(key, value),
            removeItem: (key) => window.localStorage.removeItem(key),
          },
          locks: window.navigator.locks,
          repeat: (callback, ms) => {
            const timer = window.setInterval(callback, ms)
            return () => window.clearInterval(timer)
          },
        })
        return leader.start(onLeader)
      }
      let stop = start()
      let suspended = false
      const onPageHide = () => {
        suspended = true
        stop()
      }
      const onPageShow = () => {
        if (suspended) {
          suspended = false
          stop = start()
        }
      }
      window.addEventListener("pagehide", onPageHide)
      window.addEventListener("pageshow", onPageShow)
      return () => {
        window.removeEventListener("pagehide", onPageHide)
        window.removeEventListener("pageshow", onPageShow)
        stop()
      }
    },
    isLeader: () => leader?.isLeader() ?? false,
    settleDelivery(callback) {
      const timer = window.setTimeout(callback, 150)
      return () => window.clearTimeout(timer)
    },
    focus: () => window.focus(),
  }
}
