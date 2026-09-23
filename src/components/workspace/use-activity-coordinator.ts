"use client"

import type { ActivityRecord } from "@/lib/notifications/activity"
import { categoryOf } from "@aos/protocol/push"
import type { ActivityContext } from "@/lib/notifications/policy"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
  isSelectionExposed,
  shouldChime,
} from "@/lib/notifications/policy"
import {
  isSessionUnread,
  workspaceUnreadCount,
} from "@/lib/workspace-view-model"
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
import {
  createActivitySoundPort,
  type ActivitySoundPort,
} from "@/lib/notifications/sound"
import type {
  PushOpenTarget,
  PushSubscriptionManager,
} from "@/lib/notifications/push-subscription"
import {
  createHeartbeat,
  createIdleTracker,
  type IdleTracker,
} from "@/lib/notifications/presence"
import type { Locale } from "@/lib/i18n/config"
import type { BrowserSettingsView } from "./activity"
import { useInstallPrompt } from "./use-install-prompt"
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { sameData } from "@/lib/utils"
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
  /** Sessions the operator has not read, including open attention requests. */
  unreadCount: number
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
  /** Push notifications are authored on the proxy, in the device's language. */
  locale: Locale
  readNow: () => Date
  onOpenTarget: (agentId: string, threadId: string) => Promise<void>
  browser?: {
    port?: BrowserNotificationPort
    platform?: ActivityBrowserPlatform
    sound?: ActivitySoundPort
    /** Present only where a provider can subscribe this device to Web Push. */
    push?: PushSubscriptionManager
    copy: { completion: string; failure: string; input: string }
  }
}
/**
 * State re-read from a store on every focus change and activity event. The
 * setter keeps the value it has when the re-read carries the same data, so an
 * unchanged read does not re-render the workspace.
 */
function useDataState<Value>(initial: Value) {
  const [value, setValue] = useState(initial)
  const setData = useCallback(
    (next: Value) =>
      setValue((previous) => (sameData(previous, next) ? previous : next)),
    []
  )
  return [value, setData] as const
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
  const syncPushRef = useRef<() => void>(() => {})
  const [browserState, setBrowserState] = useDataState<
    Pick<BrowserSettingsView, "status" | "preferences" | "ask" | "pushActive">
  >({
    status: "not-configured",
    preferences: { ...defaultBrowserPreferences },
    ask: false,
    pushActive: false,
  })
  const [pushStatus, setPushStatus] =
    useState<BrowserSettingsView["push"]>("not-configured")
  const install = useInstallPrompt()
  // The ask has to know it can only point at the Home Screen, and the
  // coordinator outlives the renders that carry the hint.
  const installFirstRef = useRef(install.iosInstallHint)
  useEffect(() => {
    installFirstRef.current = install.iosInstallHint
  })
  const validateOwnerRef = useRef<
    (threadId: string, revalidate?: boolean) => Promise<string | undefined>
  >(async () => undefined)
  const [records, setRecords] = useDataState<ActivityRecord[]>([])
  const [notice, setNotice] = useState<{ urgent: boolean } | null>(null)
  const reported = useRef<
    { threadId: string | null; foreground: boolean; idle: boolean } | undefined
  >(undefined)
  const idleRef = useRef<IdleTracker | null>(null)
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
  /**
   * The proxy owns read state, so the browser only reports what is exposed, and
   * it decides which devices still need a push from the presence reported with
   * it. A repeat carries the same values, which is what keeps presence fresh.
   */
  const reportPresence = useEffectEvent((repeat = false) => {
    const state = context()
    const exposed = isSelectionExposed(state)
      ? (state.selection?.threadId ?? null)
      : null
    const foreground = state.pageVisible && state.pageFocused
    // Only a foreground connection can be attended, so a hidden one is not idle.
    const idle = foreground && (idleRef.current?.idle() ?? false)
    const last = reported.current
    if (
      !repeat &&
      last?.threadId === exposed &&
      last.foreground === foreground &&
      last.idle === idle
    )
      return
    reported.current = { threadId: exposed, foreground, idle }
    current.current.workspace.reportFocus?.(exposed, { foreground, idle })
  })
  const refresh = useEffectEvent(() => {
    reportPresence()
    const store = storeRef.current
    if (!store) return
    const state = context()
    const nextRecords = store.records()
    setRecords(nextRecords)
    browserRef.current?.publish()
    if (
      !state.pageVisible ||
      !state.pageFocused ||
      !nextRecords.some((record) => !record.read && !record.resolved)
    ) {
      setNotice(null)
    }
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
      getSessions: () => current.current.sessions,
    })
    storeRef.current = store
    const browserOptions = current.current.browser
    const sound = browserOptions
      ? (browserOptions.sound ?? createActivitySoundPort())
      : null
    const push = browserOptions?.push
    const browser = browserOptions
      ? new BrowserActivityCoordinator({
          store,
          port: browserOptions.port ?? createBrowserNotificationPort(),
          platform: browserOptions.platform ?? createActivityBrowserPlatform(),
          now: () => current.current.readNow().getTime(),
          context,
          copy: () => current.current.browser!.copy,
          open: (id) => openRef.current(id),
          // A subscribed device leaves the OS alerts to push.
          ...(push ? { push } : {}),
          installFirst: () => installFirstRef.current,
          onChange: () =>
            queueMicrotask(() => {
              if (!active) return
              setRecords(store.records())
              if (browser) setBrowserState(browser.settings())
              syncPush()
            }),
        })
      : null
    browserRef.current = browser
    // Preferences, permission, and locale are what the proxy has to be told.
    let pushQueue = Promise.resolve()
    function syncPush() {
      if (!push || !browser) return
      pushQueue = pushQueue.then(async () => {
        if (!active || !browser) return
        const { status, preferences } = browser.settings()
        await push.sync({
          permission: status,
          preferences,
          locale: current.current.locale,
        })
      })
    }
    syncPushRef.current = syncPush
    /** A notification click routes through the same ownership check as Activity. */
    async function openPushed(target?: PushOpenTarget) {
      // Without ids the worker already focused this tab and nothing more is owed.
      if (!target) return
      try {
        const validated = await validateOwner(target.sessionId, true)
        if (!active || validated !== target.agentId) return
        await current.current.onOpenTarget(target.agentId, target.sessionId)
        if (!active) return
        void Promise.resolve(
          current.current.workspace.markSessionRead?.(target.sessionId)
        ).catch(() => {})
        setRecords(store.records())
        setNotice(null)
      } catch {
        if (active) setError(true)
      }
    }
    const stopPushListening = push?.listen({
      onChange: () =>
        queueMicrotask(() => {
          if (!active) return
          setPushStatus(push.status())
          // Whether this device still holds a subscription is part of what the
          // settings panel promises, so it cannot wait for the next arrival.
          if (browser) setBrowserState(browser.settings())
        }),
      onOpen: (target) => void openPushed(target),
    })
    browser?.start()
    if (push && browser)
      void push.prepare(browser.settings().status).then(() => {
        if (!active) return
        setPushStatus(push.status())
        syncPush()
      })
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
          // A start is bookkeeping the store drops, but it is the proof the
          // operator is watching this Session work.
          if (event.type === "turn-started") browser?.noteTurnStarted(event)
          const arrival = store.ingest(event)
          browser?.publish(arrival)
          setRecords(store.records())
          setError(false)
          if (arrival) {
            const preferences =
              browser?.settings().preferences ?? defaultBrowserPreferences
            if (
              getActivityPolicy(arrival, state, preferences, "unsupported")
                .inAppNotice
            )
              setNotice((previous) => ({
                urgent:
                  categoryOf(arrival.type) !== "completion" ||
                  !!previous?.urgent,
              }))
            if (shouldChime(arrival, state, preferences)) sound?.play()
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
    // An attended tab holds this device's pushes back, so going idle and staying
    // present are both reports the proxy has to hear. The tracker listens to
    // `focus` first, so a return to the window is attended before it is reported.
    const idleTracker = createIdleTracker({ target: window })
    idleRef.current = idleTracker
    const stopWatchingIdle = idleTracker.onChange(() => reportPresence())
    const onFocus = () => {
      browser?.recheckPermission()
      refresh()
    }
    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", refresh)
    document.addEventListener("visibilitychange", refresh)
    const heartbeat = createHeartbeat({
      active: () =>
        document.visibilityState === "visible" && document.hasFocus(),
      tick: () => reportPresence(true),
    })
    return () => {
      active = false
      reported.current = undefined
      try {
        workspace.reportFocus?.(null, { foreground: false, idle: false })
      } catch {
        /* A provider that cannot accept the report keeps the workspace usable. */
      }
      heartbeat.stop()
      stopWatchingIdle()
      idleTracker.stop()
      if (idleRef.current === idleTracker) idleRef.current = null
      browser?.stop()
      sound?.stop()
      stopPushListening?.()
      if (syncPushRef.current === syncPush) syncPushRef.current = () => {}
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
  }, [setBrowserState, setRecords, workspace])

  useEffect(() => {
    refresh()
  }, [
    selection?.agentId,
    selection?.threadId,
    options.sessions,
    options.conversationExposed,
    records.length,
  ])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timeout)
  }, [notice])
  // The proxy authors push bodies, so a language change is a registration change.
  useEffect(() => {
    syncPushRef.current()
  }, [options.locale])

  const unreadCount = workspaceUnreadCount(options.sessions)
  /** Reading a Session is a provider write; the browser never stores it. */
  const markSessionsRead = (threadIds: readonly string[]) => {
    void Promise.all(
      threadIds.map((threadId) =>
        current.current.workspace.markSessionRead?.(threadId)
      )
    ).catch(() => setError(true))
  }
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
    unreadCount,
    notice: notice ? { count: unreadCount, urgent: notice.urgent } : null,
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
          setRecords(store.records())
          browserRef.current?.publish()
          return false
        }
        await current.current.onOpenTarget(record.agentId, record.threadId)
        if (storeRef.current !== store) return false
        markSessionsRead([record.threadId])
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
      markSessionsRead(
        current.current.sessions
          .filter(isSessionUnread)
          .map(({ threadId }) => threadId)
      )
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
      push: pushStatus,
      installable: install.installable,
      iosInstallHint: install.iosInstallHint,
      onInstall: install.install,
      onEnabledChange: (enabled) => {
        void browserRef.current?.setEnabled(enabled)
      },
      onCategoryChange: (category, enabled) =>
        browserRef.current?.setCategory(category, enabled),
      onSoundChange: (enabled) => browserRef.current?.setSound(enabled),
      onAcceptAsk: () => {
        void browserRef.current?.acceptAsk()
      },
      onDeclineAsk: () => browserRef.current?.declineAsk(),
    },
  }
}
