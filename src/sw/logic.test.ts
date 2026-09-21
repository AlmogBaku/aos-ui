import { describe, expect, it, vi } from "vitest"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { OPEN_MESSAGE_TYPE, type PushMessage } from "@aos/protocol/push"

import {
  handleNotificationClick,
  handlePush,
  type PushNotificationOptions,
} from "./logic"

const occurredAt = "2026-09-20T10:11:12.000Z"

function singlePush(overrides: Partial<PushMessage> = {}) {
  return {
    v: 1,
    category: "input",
    count: 1,
    agentId: "agent one",
    sessionId: "session/one",
    occurredAt,
    locale: "en",
    ...overrides,
  }
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
  it("shows one notification with the singular body for a single Session", async () => {
    const { shown } = await pushed(singlePush())

    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toBe("AOS")
    expect(shown[0]!.options.body).toBe(en.activity.inputRequested)
    expect(shown[0]!.options.tag).toBe("input")
    expect(shown[0]!.options.requireInteraction).toBe(true)
    expect(shown[0]!.options.timestamp).toBe(Date.parse(occurredAt))
  })

  it("uses the locale the payload carries", async () => {
    const { shown } = await pushed(
      singlePush({ category: "completion", locale: "he" })
    )

    expect(shown[0]!.options.body).toBe(he.activity.runFinished)
    expect(shown[0]!.options.tag).toBe("completion")
  })

  it("asks for interaction only for input requests", async () => {
    const failure = await pushed(singlePush({ category: "failure" }))

    expect(failure.shown[0]!.options.body).toBe(en.activity.runFailed)
    expect(failure.shown[0]!.options.requireInteraction).toBe(false)
  })

  it("closes the predecessor of the same category before showing", async () => {
    const registration = await pushed(singlePush(), [
      "input",
      "completion",
      "input",
    ])

    expect(registration.closedBeforeShowing).toEqual(["input", "input"])
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
    expect(registration.shown[0]!.options.tag).toBe("input")
  })

  it("counts Sessions without naming them once more than one waits", async () => {
    const { shown } = await pushed({
      v: 1,
      category: "failure",
      count: 3,
      occurredAt,
      locale: "he",
    })

    expect(shown).toHaveLength(1)
    expect(shown[0]!.options.body).toBe(
      he.activity.runFailedMany.replace("{count}", "3")
    )
    expect(shown[0]!.options.tag).toBe("failure")
    expect(shown[0]!.options.data).toMatchObject({ count: 3 })
    expect(shown[0]!.options.data?.agentId).toBeUndefined()
    expect(shown[0]!.options.data?.sessionId).toBeUndefined()
  })

  it.each([
    ["no payload", undefined],
    ["unparseable text", "not json"],
    ["a payload that is not an object", "[1, 2]"],
    ["an unknown version", singlePush({ v: 2 as 1 })],
    ["a version that is not a number", { ...singlePush(), v: "1" }],
    ["an unexpected key", { ...singlePush(), agentName: "Research" }],
    [
      "an unknown key the OS would understand",
      { ...singlePush(), badge: "/b" },
    ],
    ["an unknown category", singlePush({ category: "attention" as never })],
    [
      "a category named after a prototype member",
      { ...singlePush(), category: "constructor" },
    ],
    ["an unknown locale", singlePush({ locale: "ar" as never })],
    [
      "a fractional count",
      { v: 1, category: "input", count: 1.5, occurredAt, locale: "en" },
    ],
    [
      "a count below one",
      { v: 1, category: "input", count: 0, occurredAt, locale: "en" },
    ],
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
    ["a single Session without ids", { ...singlePush(), agentId: undefined }],
    ["a count carrying ids", singlePush({ count: 2 })],
  ])("shows one content-free notification for %s", async (_, payload) => {
    const { shown } = await pushed(payload)

    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toBe("AOS")
    expect(shown[0]!.options.body).toBe(en.activity.pushGeneric)
    expect(shown[0]!.options.tag).toBe("aos")
    expect(shown[0]!.options.data).toBeUndefined()
  })

  it("keeps Agent and Session names off the OS surface", async () => {
    const { shown } = await pushed(
      singlePush({ agentId: "agent-1", sessionId: "session-1" })
    )

    expect(JSON.parse(JSON.stringify(shown[0]!.options.data))).toEqual(
      singlePush({ agentId: "agent-1", sessionId: "session-1" })
    )
  })
})

describe("notification clicks", () => {
  it("focuses an open tab and asks it to open the Session", async () => {
    const tab = createTab()
    const clients = createClients(tab)
    const close = vi.fn()
    await handleNotificationClick(clients, {
      close,
      data: singlePush({ agentId: "agent-1", sessionId: "session-1" }),
    })

    expect(close).toHaveBeenCalledOnce()
    expect(tab.focus).toHaveBeenCalledOnce()
    expect(tab.postMessage).toHaveBeenCalledWith({
      type: OPEN_MESSAGE_TYPE,
      agentId: "agent-1",
      sessionId: "session-1",
    })
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it("carries no ids to the tab when a count was notified", async () => {
    const tab = createTab()
    await handleNotificationClick(createClients(tab), {
      close: vi.fn(),
      data: {
        v: 1,
        category: "completion",
        count: 4,
        occurredAt,
        locale: "en",
      },
    })

    expect(tab.postMessage).toHaveBeenCalledWith({
      type: OPEN_MESSAGE_TYPE,
    })
  })

  it("opens the Session deep link when no tab is open", async () => {
    const clients = createClients()
    await handleNotificationClick(clients, {
      close: vi.fn(),
      data: singlePush(),
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("opens the workspace root for a count or unreadable data", async () => {
    const counted = createClients()
    await handleNotificationClick(counted, {
      close: vi.fn(),
      data: { v: 1, category: "input", count: 2, occurredAt, locale: "en" },
    })
    const unreadable = createClients()
    await handleNotificationClick(unreadable, {
      close: vi.fn(),
      data: undefined,
    })

    expect(counted.openWindow).toHaveBeenCalledWith("/")
    expect(unreadable.openWindow).toHaveBeenCalledWith("/")
  })

  it("prefers the tab the operator is looking at", async () => {
    const background = createTab({ focused: false, visibilityState: "hidden" })
    const focused = createTab({ focused: true, visibilityState: "visible" })
    await handleNotificationClick(createClients(background, focused), {
      close: vi.fn(),
      data: singlePush(),
    })

    expect(focused.focus).toHaveBeenCalledOnce()
    expect(background.focus).not.toHaveBeenCalled()
  })

  it("prefers a visible tab over a hidden one when none is focused", async () => {
    const hidden = createTab({ focused: false, visibilityState: "hidden" })
    const visible = createTab({ focused: false, visibilityState: "visible" })
    await handleNotificationClick(createClients(hidden, visible), {
      close: vi.fn(),
      data: singlePush(),
    })

    expect(visible.postMessage).toHaveBeenCalledOnce()
    expect(hidden.postMessage).not.toHaveBeenCalled()
  })

  it("takes the first tab when the browser reports neither trait", async () => {
    const first = createTab()
    const second = createTab()
    await handleNotificationClick(createClients(first, second), {
      close: vi.fn(),
      data: singlePush(),
    })

    expect(first.focus).toHaveBeenCalledOnce()
    expect(second.focus).not.toHaveBeenCalled()
  })

  it("opens a window when the tab it was handed refuses to focus", async () => {
    const closing = createTab()
    closing.focus.mockRejectedValue(new Error("client is closing"))
    const clients = createClients(closing)
    await handleNotificationClick(clients, {
      close: vi.fn(),
      data: singlePush(),
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
    await handleNotificationClick(clients, {
      close: vi.fn(),
      data: singlePush(),
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
    await handleNotificationClick(clients, {
      close: vi.fn(),
      data: singlePush(),
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })

  it("falls back to the workspace root when the deep link will not open", async () => {
    const clients = createClients()
    clients.openWindow.mockRejectedValueOnce(new Error("cannot open"))
    await handleNotificationClick(clients, {
      close: vi.fn(),
      data: singlePush(),
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
      handleNotificationClick(clients, {
        close: vi.fn(),
        data: singlePush(),
      })
    ).resolves.toBeUndefined()
    expect(clients.openWindow).toHaveBeenCalledTimes(2)
  })

  it("opens a window even when the notification will not dismiss", async () => {
    const clients = createClients()
    await handleNotificationClick(clients, {
      close: () => {
        throw new Error("already closed")
      },
      data: singlePush(),
    })

    expect(clients.openWindow).toHaveBeenCalledWith(
      "/agent%20one/session%2Fone"
    )
  })
})
