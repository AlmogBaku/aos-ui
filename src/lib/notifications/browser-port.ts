import type { BrowserPermission } from "./policy"

export type BrowserNotificationPayload = {
  title: "AOS"
  body: string
  icon: string
  timestamp: number
  tag: string
  renotify: false
}

/** Injected by the browser boundary; importing the domain never accesses the DOM. */
export interface BrowserNotificationPort {
  getPermission(): BrowserPermission
  requestPermission(): Promise<BrowserPermission>
  show(
    payload: BrowserNotificationPayload,
    onClick: () => void
  ): { close(): void }
}
