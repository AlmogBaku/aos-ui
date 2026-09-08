"use client"

import type { ActivityRecord } from "@/lib/notifications/activity"
import type { ActivityContext } from "@/lib/notifications/policy"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
} from "@/lib/notifications/policy"
import { ActivityStore } from "@/lib/notifications/store"
import { activityEventSchema } from "@/lib/notifications/activity"
import {
  BrowserActivityCoordinator,
  type ActivityBrowserPlatform,
} from "@/lib/notifications/browser-coordinator"
import {
  createActivityBrowserPlatform,
  createBrowserNotificationPort,
} from "@/lib/notifications/browser-platform"
import type { BrowserNotificationPort } from "@/lib/notifications/browser-port"
import type { BrowserSettingsView } from "./activity"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import type {
  SessionMetadata,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"

export type ActivityItem = ActivityRecord & {
  agentName?: string
  sessionTitle?: string
  available: boolean
}
export type ActivityNoticeState = { count: number; urgent: boolean }
export type ActivityView = {
  items: ActivityItem[]
  notice: ActivityNoticeState | null
  error: boolean
  supported: boolean
  openActivity: (id: string) => Promise<boolean>
  markAllRead: () => void
  dismissNotice: () => void
}
type Options = {
  workspace: WorkspaceAdapter
  agents: readonly { id: string; name: string }[]
  sessions: readonly SessionMetadata[]
  titles: ReadonlyMap<string, string>
  selection: ActivityContext["selection"]
  conversationExposed?: boolean
  readNow: () => Date
  onOpenTarget: (agentId: string, threadId: string) => Promise<void>
  browser?: {
    port?: BrowserNotificationPort
    platform?: ActivityBrowserPlatform
    copy: { completion: string; failure: string; input: string }
  }
}
export function useActivityCoordinator(
  options: Options
): ActivityView & { browserSettings: Omit<BrowserSettingsView, "coverage"> } {
  const { workspace, selection } = options
  const current = useRef(options)
  useEffect(() => {
    current.current = options
  })
  const storeRef = useRef<ActivityStore | null>(null)
  const browserRef = useRef<BrowserActivityCoordinator | null>(null)
  const openRef = useRef<(id: string) => Promise<boolean>>(async () => false)
  const [browserState, setBrowserState] = useState<
    Pick<BrowserSettingsView, "status" | "preferences">
  >({ status: "not-configured", preferences: { ...defaultBrowserPreferences } })
  const validateOwnerRef = useRef<
    (threadId: string, revalidate?: boolean) => Promise<string | undefined>
  >(async () => undefined)
  const [records, setRecords] = useState<ActivityRecord[]>([])
  const [notice, setNotice] = useState<ActivityNoticeState | null>(null)
  const [error, setError] = useState(false)
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<string>>(
    new Set()
  )

  const context = (): ActivityContext => ({
    selection: current.current.selection,
    conversationExposed: current.current.conversationExposed,
    pageVisible: document.visibilityState === "visible",
    pageFocused: document.hasFocus(),
  })
  const refresh = useEffectEvent(() => {
    const store = storeRef.current
    if (!store) return
    const snapshot = store.records()
    const state = context()
    for (const record of snapshot) {
      if (
        getActivityPolicy(
          record,
          state,
          defaultBrowserPreferences,
          "unsupported"
        ).markRead
      )
        store.markRead(record.id)
    }
    setRecords(store.records())
    browserRef.current?.publish()
    if (!state.pageVisible || !state.pageFocused) setNotice(null)
  })

  useEffect(() => {
    let active = true
    const verifiedOwners = new Map<string, string>()
    const snapshotOwner = (threadId: string) =>
      current.current.sessions.find((session) => session.threadId === threadId)
        ?.agentId
    const owner = (threadId: string) =>
      snapshotOwner(threadId) ?? verifiedOwners.get(threadId)
    async function validateOwner(threadId: string, revalidate = false) {
      const knownOwner = snapshotOwner(threadId)
      if (knownOwner !== undefined && !revalidate) return knownOwner
      const metadata = await workspace.getSessionMetadata([threadId])
      if (!active) return undefined
      const providerOwner = metadata.find(
        (session) => session.threadId === threadId
      )?.agentId
      if (providerOwner === undefined) {
        verifiedOwners.delete(threadId)
        if (revalidate || snapshotOwner(threadId) === undefined) {
          const stale = store
            .records()
            .filter((record) => record.threadId === threadId)
          for (const record of stale) store.markUnavailable(record.id)
          if (stale.length) {
            setUnavailableIds(
              (previous) =>
                new Set([...previous, ...stale.map((record) => record.id)])
            )
            setRecords(store.records())
          }
        }
      } else verifiedOwners.set(threadId, providerOwner)
      // A newer authoritative snapshot supersedes an in-flight event lookup.
      if (!revalidate) return snapshotOwner(threadId) ?? providerOwner
      const latestOwner = snapshotOwner(threadId)
      return latestOwner !== undefined && latestOwner !== providerOwner
        ? undefined
        : providerOwner
    }
    validateOwnerRef.current = validateOwner
    const store = new ActivityStore({
      now: () => current.current.readNow().getTime(),
      getThreadOwner: owner,
    })
    storeRef.current = store
    const browserOptions = current.current.browser
    const browser = browserOptions
      ? new BrowserActivityCoordinator({
          store,
          port: browserOptions.port ?? createBrowserNotificationPort(),
          platform: browserOptions.platform ?? createActivityBrowserPlatform(),
          now: () => current.current.readNow().getTime(),
          context,
          copy: () => current.current.browser!.copy,
          open: (id) => openRef.current(id),
          onChange: () =>
            queueMicrotask(() => {
              if (!active) return
              setRecords(store.records())
              if (browser) setBrowserState(browser.settings())
            }),
        })
      : null
    browserRef.current = browser
    browser?.start()
    queueMicrotask(() => {
      if (!active) return
      setRecords(store.records())
      setNotice(null)
      setError(false)
      setUnavailableIds(new Set())
    })
    let queue = Promise.resolve()
    let unsubscribe: (() => void) | undefined
    function ingest(input: unknown) {
      const parsed = activityEventSchema.safeParse(input)
      if (!parsed.success) return
      const event = parsed.data
      queue = queue
        .then(async () => {
          if (!active) return
          const validatedOwner = await validateOwner(event.threadId)
          if (!active) return
          if (validatedOwner !== event.agentId) return
          const state = context()
          const arrival = store.ingest(event, state)
          browser?.publish(arrival)
          setRecords(store.records())
          setError(false)
          if (
            arrival &&
            getActivityPolicy(
              arrival,
              state,
              defaultBrowserPreferences,
              "unsupported"
            ).inAppNotice
          ) {
            const urgent =
              arrival.type === "attention-requested" ||
              arrival.type === "run-failed" ||
              arrival.type === "agent-activation-failed"
            setNotice((previous) => ({
              count: (previous?.count ?? 0) + 1,
              urgent: urgent || !!previous?.urgent,
            }))
          }
        })
        .catch(() => {
          if (active) setError(true)
        })
    }
    try {
      unsubscribe = workspace.subscribeActivity?.(ingest, () => {
        queueMicrotask(() => {
          if (active) setError(true)
        })
      })
    } catch {
      queueMicrotask(() => {
        if (active) setError(true)
      })
    }
    const onFocus = () => {
      browser?.recheckPermission()
      refresh()
    }
    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      active = false
      browser?.stop()
      if (browserRef.current === browser) browserRef.current = null
      if (storeRef.current === store) storeRef.current = null
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("blur", refresh)
      document.removeEventListener("visibilitychange", refresh)
      try {
        unsubscribe?.()
      } catch {
        /* Subscription teardown cannot break the workspace. */
      }
    }
  }, [workspace])

  useEffect(() => {
    refresh()
  }, [selection?.agentId, selection?.threadId, options.sessions])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const view: ActivityView = {
    items: records.map((record) => ({
      ...record,
      agentName: options.agents.find(({ id }) => id === record.agentId)?.name,
      sessionTitle: options.titles.get(record.threadId),
      available:
        !unavailableIds.has(record.id) &&
        options.agents.some(({ id }) => id === record.agentId) &&
        !options.sessions.some(
          (session) =>
            session.threadId === record.threadId &&
            session.agentId !== record.agentId
        ),
    })),
    notice,
    error,
    supported: !!workspace.subscribeActivity,
    async openActivity(id) {
      const store = storeRef.current
      const record = store?.records().find((item) => item.id === id)
      if (!record || !store) return false
      try {
        const validatedOwner = await validateOwnerRef.current(
          record.threadId,
          true
        )
        if (storeRef.current !== store) return false
        if (
          !current.current.agents.some(({ id }) => id === record.agentId) ||
          validatedOwner !== record.agentId
        ) {
          setUnavailableIds((previous) => new Set([...previous, id]))
          store.markUnavailable(id)
          store.markRead(id)
          setRecords(store.records())
          browserRef.current?.publish()
          return false
        }
        await current.current.onOpenTarget(record.agentId, record.threadId)
        if (storeRef.current !== store) return false
        store.markRead(id)
        setUnavailableIds(
          (previous) =>
            new Set([...previous].filter((entryId) => entryId !== id))
        )
        setRecords(store.records())
        browserRef.current?.publish()
        setNotice(null)
        return true
      } catch {
        setError(true)
        return false
      }
    },
    markAllRead() {
      storeRef.current?.markAllRead()
      setRecords(storeRef.current?.records() ?? [])
      browserRef.current?.publish()
      setNotice(null)
    },
    dismissNotice() {
      setNotice(null)
    },
  }
  useEffect(() => {
    openRef.current = view.openActivity
  })
  return {
    ...view,
    browserSettings: {
      ...browserState,
      onEnabledChange: (enabled) => {
        void browserRef.current?.setEnabled(enabled)
      },
      onCategoryChange: (category, enabled) =>
        browserRef.current?.setCategory(category, enabled),
    },
  }
}
