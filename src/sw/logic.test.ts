import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { formatNotification } from "@/lib/notifications/format"
import { sessionTag } from "@/lib/notifications/tag"
import { OPEN_MESSAGE_TYPE } from "@/sw/open-messages"
import type { PushMessage } from "@harness-gw/sdk/protocol"

import {
  handleNotificationClick,
  handlePush,
  type PushNotificationOptions,
} from "./logic"

const occurredAt = "2026-09-20T10:11:12.000Z"

function singlePush(overrides: Partial<PushMessage> = {}) {
  return {
    v: 2,
    category: "input",
    agentId: "agent one",
    sessionId: "session/one",
    occurredAt,
    locale: "en",
    agentName: "Travel Planner",
    sessionTitle: "Lisbon trip in May",
    requestText: "Which dates work for you?",
    ...overrides,
  }
}

/** What a notification keeps for its click: the category and the ids. */
const clickData = {
  category: "input",
  agentId: "agent one",
  sessionId: "session/one",
}

function createRegistration(openTags: string[] = []) {
  const shown: { title: string; options: PushNotificationOptions }[] = []
  const closedBeforeShowing: string[] = []
  return {
    shown,
    closedBeforeShowing,
    getNotifications: async ({ tag }: { tag: string }) =>
      openTags
        .filter((openTag) => openTag === tag)
        .map((openTag) => ({
          close: () => {
            if (shown.length === 0) closedBeforeShowing.push(openTag)
          },
        })),
    showNotification: async (title: string, options: PushNotificationOptions) =>
      void shown.push({ title, options }),
  }
}

function createTab(
  traits: { focused?: boolean; visibilityState?: string } = {}
) {
  return {
    ...traits,
    focus: vi.fn(async () => undefined),
    postMessage: vi.fn(),
  }
}

function createClients(...tabs: ReturnType<typeof createTab>[]) {
  return {
    openWindow: vi.fn(async () => undefined),
    matchAll: async (options: {
      type: string
      includeUncontrolled: boolean
    }) =>
      options.type === "window" && options.includeUncontrolled ? tabs : [],
  }
}

/** Stands in for the port the worker hands the tab it is asking. */
const PORT = { transferred: "port" }
/** A window whose app is running answers at once. */
const answering = () => ({ port: PORT, answered: Promise.resolve(true) })
/** A window that is loading, frozen, or gone never answers. */
const silent = () => ({ port: PORT, answered: Promise.resolve(false) })

function click(
  clients: ReturnType<typeof createClients>,
  notification: { close(): void; data: unknown },
  acknowledge = answering
) {
  return handleNotificationClick(clients, notification, acknowledge)
}

async function pushed(payload: unknown, openTags: string[] = []) {
  const registration = createRegistration(openTags)
  await handlePush(
    registration,
    typeof payload === "string" || payload === undefined
      ? payload
      : JSON.stringify(payload)
  )
  return registration
}

describe("push notifications", () => {
  it("names the Agent, the Session, and what is asked", async () => {
    const { shown } = await pushed(singlePush({ requestMore: 2 }))

    expect(shown).toEqual([
      {
        title: "Travel Planner",
        options: {
          body: formatNotification(
            singlePush({ requestMore: 2 }) as PushMessage
          ).body,
          tag: sessionTag("agent one", "session/one"),
          icon: "/icons/pwa-192x192.png",
          timestamp: Date.parse(occurredAt),
          requireInteraction: true,
          data: clickData,
        },
      },
    ])
  })

  it("uses the locale the payload carries", async () => {
    const { shown } = await pushed(
      singlePush({
        category: "completion",
        locale: "he",
        requestText: undefined,
      })
    )

    expect(shown[0]!.options.body).toBe(
      `${he.activity.turnFinished} · \u2068Lisbon trip in May\u2069`
    )
  })

  it("asks for interaction only for input requests", async () => {
    const failure = await pushed(singlePush({ category: "failure" }))

    expect(failure.shown[0]!.options.requireInteraction).toBe(false)
  })

  it("closes the predecessor of the same Session before showing", async () => {
    const same = sessionTag("agent one", "session/one")
    const registration = await pushed(singlePush({ category: "failure" }), [
      same,
      sessionTag("agent one", "session/two"),
      same,
    ])

    expect(registration.closedBeforeShowing).toEqual([same, same])
    expect(registration.shown).toHaveLength(1)
  })

  it("still shows one notification when predecessors cannot be listed", async () => {
    const registration = createRegistration()
    await handlePush(
      {
        ...registration,
        getNotifications: async () => {
          throw new Error("unsupported")
        },
      },
      JSON.stringify(singlePush())
    )

    expect(registration.shown).toHaveLength(1)
  })

  it("ends quietly when a revoked permission refuses the display", async () => {
    const showNotification = vi.fn(async () => {
      throw new Error("No notification permission has been granted")
    })

    await expect(
      handlePush(
        { ...createRegistration(), showNotification },
        JSON.stringify(singlePush())
      )
    ).resolves.toBeUndefined()
    expect(showNotification).toHaveBeenCalledOnce()
  })

  it("lets no unknown key reach the notification, and keeps only the ids for its click", async () => {
    const { shown } = await pushed({
      ...singlePush(),
      image: "https://tracker.example/pixel.png",
      actions: [{ action: "approve", title: "Approve" }],
      url: "https://elsewhere.example",
      badge: "/badge.png",
      count: 3,
    })

    expect(Object.keys(shown[0]!.options).sort()).toEqual([
      "body",
      "data",
      "icon",
      "requireInteraction",
      "tag",
      "timestamp",
    ])
    expect(shown[0]!.options.data).toEqual(clickData)
    expect(JSON.stringify(shown)).not.toMatch(/tracker|approve|elsewhere|badge/)
  })

  it("drops a malformed label's line and keeps the rest", async () => {
    const { shown } = await pushed(
      singlePush({
        agentName: "a".repeat(65),
        requestText: 42 as never,
        requestMore: -1,
      })
    )

    expect(shown[0]!.title).toBe("Lisbon trip in May")
    expect(shown[0]!.options.body).toBe(en.activity.needsInput)
  })

  it.each([
    ["no payload", undefined],
    ["unparseable text", "not json"],
    ["a payload that is not an object", "[1, 2]"],
    ["the previous version", { ...singlePush(), v: 1 }],
    ["a version that is not a number", { ...singlePush(), v: "2" }],
    ["an unknown category", singlePush({ category: "attention" as never })],
    [
      "a category named after a prototype member",
      { ...singlePush(), category: "constructor" },
    ],
    ["an unknown locale", singlePush({ locale: "ar" as never })],
    ["an unreadable date", singlePush({ occurredAt: "soon" })],
    [
      "an id carrying a control character",
      singlePush({ agentId: "agent\u0007" }),
    ],
    [
      "an id longer than the protocol allows",
      singlePush({ agentId: "a".repeat(257) }),
    ],
    ["an empty id", singlePush({ agentId: "" })],
    ["no Agent id", { ...singlePush(), agentId: undefined }],
    ["no Session id", { ...singlePush(), sessionId: undefined }],
  ])("shows one content-free notification for %s", async (_, payload) => {
    const { shown } = await pushed(payload)

    expect(shown).toEqual([
      {
        title: "AOS",
        options: {
          body: en.activity.pushGeneric,
          tag: "aos",
          icon: "/icons/pwa-192x192.png",
        },
      },
    ])
  })
})

describe("notification clicks", () => {
  it("focuses an open tab and asks it to open the Session", async () => {
    const tab = createTab()
    const clients = createClients(tab)
    const close = vi.fn()
    await click(clients, {
      close,
      data: { ...clickData, agentId: "agent-1", sessionId: "session-1" },
    })

    expect(close).toHaveBeenCalledOnce()
    expect(tab.focus).toHaveBeenCalledOnce()
    expect(tab.postMessage).toHaveBeenCalledWith(
      {
        type: OPEN_MESSAGE_TYPE,
        agentId: "agent-1",
        sessionId: "session-1",
      },
      [PORT]
    )
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it("opens a window when the tab it was handed never answers", async () => {
    // The browser reports windows it has restored but not loaded, documents it
    // has frozen, and tabs still starting the app. None of them will act on a
    // message, so the click has to end in a window of its own.
    const loading = createTab({ focused: false, visibilityState: "hidden" })
    const clients = createClients(loading)
    await click(clients, { close: vi.fn(), data: clickData }, silent)

    expect(loading.focus).toHaveBeenCalledOnce()
    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("hands no ids to the tab when the data names no Session", async () => {
    const tab = createTab()
    await click(createClients(tab), {
      close: vi.fn(),
      data: { category: "completion" },
    })

    expect(tab.postMessage).toHaveBeenCalledWith({ type: OPEN_MESSAGE_TYPE }, [
      PORT,
    ])
  })

  it("opens the Session deep link when no tab is open", async () => {
    const clients = createClients()
    await click(clients, {
      close: vi.fn(),
      data: clickData,
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("opens the workspace root for data that names no Session", async () => {
    const unnamed = createClients()
    await click(unnamed, {
      close: vi.fn(),
      data: { ...clickData, sessionId: "" },
    })
    const unreadable = createClients()
    await click(unreadable, {
      close: vi.fn(),
      data: undefined,
    })

    expect(unnamed.openWindow).toHaveBeenCalledWith("/")
    expect(unreadable.openWindow).toHaveBeenCalledWith("/")
  })

  it("prefers the tab the operator is looking at", async () => {
    const background = createTab({ focused: false, visibilityState: "hidden" })
    const focused = createTab({ focused: true, visibilityState: "visible" })
    await click(createClients(background, focused), {
      close: vi.fn(),
      data: clickData,
    })

    expect(focused.focus).toHaveBeenCalledOnce()
    expect(background.focus).not.toHaveBeenCalled()
  })

  it("prefers a visible tab over a hidden one when none is focused", async () => {
    const hidden = createTab({ focused: false, visibilityState: "hidden" })
    const visible = createTab({ focused: false, visibilityState: "visible" })
    await click(createClients(hidden, visible), {
      close: vi.fn(),
      data: clickData,
    })

    expect(visible.postMessage).toHaveBeenCalledOnce()
    expect(hidden.postMessage).not.toHaveBeenCalled()
  })

  it("takes the first tab when the browser reports neither trait", async () => {
    const first = createTab()
    const second = createTab()
    await click(createClients(first, second), {
      close: vi.fn(),
      data: clickData,
    })

    expect(first.focus).toHaveBeenCalledOnce()
    expect(second.focus).not.toHaveBeenCalled()
  })

  it("opens a window when the tab it was handed refuses to focus", async () => {
    const closing = createTab()
    closing.focus.mockRejectedValue(new Error("client is closing"))
    const clients = createClients(closing)
    await click(clients, {
      close: vi.fn(),
      data: clickData,
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("opens a window when the tab cannot be given the Session", async () => {
    const unreachable = createTab()
    unreachable.postMessage.mockImplementation(() => {
      throw new Error("channel closed")
    })
    const clients = createClients(unreachable)
    await click(clients, {
      close: vi.fn(),
      data: clickData,
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("opens a window when the open tabs cannot be listed", async () => {
    const clients = {
      ...createClients(createTab()),
      matchAll: async () => {
        throw new Error("unsupported")
      },
    }
    await click(clients, {
      close: vi.fn(),
      data: clickData,
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("falls back to the workspace root when the deep link will not open", async () => {
    const clients = createClients()
    clients.openWindow.mockRejectedValueOnce(new Error("cannot open"))
    await click(clients, {
      close: vi.fn(),
      data: clickData,
    })

    expect(clients.openWindow.mock.calls).toEqual([
      ["/agent%20one/session%2Fone"],
      ["/"],
    ])
  })

  it("gives up quietly when no window can be opened at all", async () => {
    const clients = createClients()
    clients.openWindow.mockRejectedValue(new Error("cannot open"))

    await expect(
      click(clients, {
        close: vi.fn(),
        data: clickData,
      })
    ).resolves.toBeUndefined()
    expect(clients.openWindow).toHaveBeenCalledTimes(2)
  })

  it("opens a window even when the notification will not dismiss", async () => {
    const clients = createClients()
    await click(clients, {
      close: () => {
        throw new Error("already closed")
      },
      data: clickData,
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })
})
