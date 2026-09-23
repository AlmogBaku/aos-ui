import { describe, expect, it } from "vitest"

import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"
import {
  defaultBrowserPreferences,
  getActivityPolicy,
  isSelectionExposed,
  shouldChime,
  shouldOfferAsk,
  type ActivityContext,
  type BrowserPermission,
  type BrowserPreferences,
} from "./policy"

const event: WorkspaceActivityEvent = {
  id: "event-1",
  agentId: "agent-1",
  threadId: "thread-1",
  occurredAt: "2026-09-05T12:00:00.000Z",
  type: "agent-ready",
}

describe("selection exposure", () => {
  const selection = { agentId: "agent-1", threadId: "thread-1" }

  it.each<[string, ActivityContext, boolean]>([
    [
      "visible, focused, and uncovered",
      { selection, pageVisible: true, pageFocused: true },
      true,
    ],
    [
      "covered by a drawer",
      {
        selection,
        pageVisible: true,
        pageFocused: true,
        conversationExposed: false,
      },
      false,
    ],
    ["hidden", { selection, pageVisible: false, pageFocused: true }, false],
    ["blurred", { selection, pageVisible: true, pageFocused: false }, false],
    [
      "without a selection",
      { selection: null, pageVisible: true, pageFocused: true },
      false,
    ],
  ])("reports the selection %s as exposed=%s", (_label, context, exposed) => {
    expect(isSelectionExposed(context)).toBe(exposed)
    expect(
      getActivityPolicy(event, context, defaultBrowserPreferences, "granted")
        .markRead
    ).toBe(exposed)
  })
})

describe("activity visibility and delivery", () => {
  it.each([
    [true, true, "agent-1", "thread-1", true, false, false],
    [true, true, "agent-2", "thread-1", false, true, false],
    [true, true, "agent-1", "thread-2", false, true, false],
    [true, false, "agent-1", "thread-1", false, false, true],
    [false, true, "agent-1", "thread-1", false, false, true],
    [false, false, "agent-1", "thread-1", false, false, true],
  ])(
    "scopes read state and delivery: visible=%s focused=%s selected=%s/%s",
    (
      pageVisible,
      pageFocused,
      agentId,
      threadId,
      markRead,
      inAppNotice,
      browserNotification
    ) => {
      expect(
        getActivityPolicy(
          event,
          {
            pageVisible,
            pageFocused,
            selection: { agentId, threadId },
          },
          { ...defaultBrowserPreferences, enabled: true },
          "granted"
        )
      ).toEqual({
        markRead,
        inAppNotice,
        browserNotification,
      })
    }
  )

  it("delivers on the shipped defaults while permitting in-app notices", () => {
    const context = { pageVisible: false, pageFocused: false, selection: null }
    expect(defaultBrowserPreferences.enabled).toBe(true)
    expect(defaultBrowserPreferences.sound).toBe(true)
    expect(defaultBrowserPreferences.prompt).toBe("pending")
    expect(
      getActivityPolicy(event, context, defaultBrowserPreferences, "granted")
        .browserNotification
    ).toBe(true)
    expect(
      getActivityPolicy(
        event,
        { ...context, pageVisible: true, pageFocused: true },
        defaultBrowserPreferences,
        "denied"
      ).inAppNotice
    ).toBe(true)
  })

  it("leaves OS alerts to a push-subscribed device", () => {
    expect(
      getActivityPolicy(
        event,
        {
          pageVisible: false,
          pageFocused: false,
          selection: null,
          pushActive: true,
        },
        defaultBrowserPreferences,
        "granted"
      )
    ).toEqual({
      markRead: false,
      inAppNotice: false,
      browserNotification: false,
    })
  })

  it("keeps the selected conversation unread while a drawer covers it", () => {
    const covered = getActivityPolicy(
      event,
      {
        pageVisible: true,
        pageFocused: true,
        conversationExposed: false,
        selection: { agentId: "agent-1", threadId: "thread-1" },
      },
      { ...defaultBrowserPreferences, enabled: true },
      "granted"
    )

    expect(covered).toEqual({
      markRead: false,
      inAppNotice: true,
      browserNotification: false,
    })
  })

  it.each(["default", "denied", "unsupported"] as const)(
    "suppresses browser delivery for %s permission",
    (permission) => {
      expect(
        getActivityPolicy(
          event,
          { pageVisible: false, pageFocused: false, selection: null },
          { ...defaultBrowserPreferences, enabled: true },
          permission
        ).browserNotification
      ).toBe(false)
    }
  )

  it.each([
    [{ ...event, type: "turn-finished", turnId: "run-1" }, "completion"],
    [{ ...event, type: "turn-failed", turnId: "run-1" }, "failure"],
    [{ ...event, type: "agent-ready" }, "completion"],
    [{ ...event, type: "agent-activation-failed" }, "failure"],
    [
      {
        ...event,
        type: "attention-requested",
        attentionKind: "question",
        requestId: "request-1",
      },
      "input",
    ],
    [
      {
        ...event,
        type: "attention-requested",
        attentionKind: "permission",
        requestId: "request-1",
      },
      "input",
    ],
  ] as const)("gates %j through %s preferences", (activity, category) => {
    const context = { pageVisible: false, pageFocused: false, selection: null }
    expect(
      getActivityPolicy(
        activity,
        context,
        { ...defaultBrowserPreferences, enabled: true },
        "granted"
      ).browserNotification
    ).toBe(true)
    expect(
      getActivityPolicy(
        activity,
        context,
        { ...defaultBrowserPreferences, enabled: true, [category]: false },
        "granted"
      ).browserNotification
    ).toBe(false)
  })

  it.each([
    { ...event, type: "turn-started", turnId: "run-1" },
    { ...event, type: "attention-resolved", requestId: "request-1" },
  ] as const)("never surfaces bookkeeping event %j", (activity) => {
    expect(
      getActivityPolicy(
        activity,
        { pageVisible: true, pageFocused: true, selection: null },
        { ...defaultBrowserPreferences, enabled: true },
        "granted"
      )
    ).toEqual({
      markRead: false,
      inAppNotice: false,
      browserNotification: false,
    })
  })

  it("never redelivers read, resolved, or already delivered records", () => {
    for (const state of [
      { read: true },
      { resolved: true },
      { browserDeliveredAt: event.occurredAt },
    ]) {
      expect(
        getActivityPolicy(
          { ...event, ...state },
          { pageVisible: false, pageFocused: false, selection: null },
          { ...defaultBrowserPreferences, enabled: true },
          "granted"
        ).browserNotification
      ).toBe(false)
    }
  })
})

describe("the one-time ask", () => {
  it.each<
    [BrowserPermission, Partial<BrowserPreferences>, boolean, boolean, boolean]
  >([
    ["default", {}, true, false, true],
    ["granted", {}, true, false, false],
    ["denied", {}, true, false, false],
    ["unsupported", {}, true, false, false],
    ["default", { prompt: "declined" }, true, false, false],
    // The browser reset a permission this device believed it had granted, so the
    // stored accept is stale and the ask is the only way back.
    ["default", { prompt: "accepted" }, true, false, true],
    ["granted", { prompt: "accepted" }, true, false, false],
    ["denied", { prompt: "accepted" }, true, false, false],
    ["default", { enabled: false }, true, false, false],
    ["default", {}, false, false, false],
    // An uninstalled iOS tab exposes no notification API to ask through.
    ["unsupported", {}, true, true, true],
    ["unsupported", { prompt: "declined" }, true, true, false],
    ["unsupported", {}, false, true, false],
    ["denied", {}, true, true, false],
  ])(
    "offers the ask for %s permission with %j after a seen run=%s, install first=%s: %s",
    (permission, overrides, firstRunSeen, installFirst, offered) => {
      expect(
        shouldOfferAsk(
          permission,
          { ...defaultBrowserPreferences, ...overrides },
          firstRunSeen,
          installFirst
        )
      ).toBe(offered)
    }
  )
})

describe("the in-app chime", () => {
  const focused: ActivityContext = {
    pageVisible: true,
    pageFocused: true,
    selection: { agentId: "agent-1", threadId: "thread-2" },
  }
  const attention = {
    ...event,
    type: "attention-requested",
    attentionKind: "question",
    requestId: "request-1",
  } as const

  it("chimes for input and failure the operator can see", () => {
    expect(shouldChime(attention, focused, defaultBrowserPreferences)).toBe(
      true
    )
    expect(
      shouldChime(
        { ...event, type: "turn-failed", turnId: "run-1" },
        focused,
        defaultBrowserPreferences
      )
    ).toBe(true)
  })

  it.each<
    [string, WorkspaceActivityEvent, ActivityContext, BrowserPreferences]
  >([
    ["a completion", event, focused, defaultBrowserPreferences],
    [
      "sound turned off",
      attention,
      focused,
      { ...defaultBrowserPreferences, sound: false },
    ],
    [
      "an unfocused page",
      attention,
      { ...focused, pageFocused: false },
      defaultBrowserPreferences,
    ],
    [
      "the exposed Session itself",
      attention,
      { ...focused, selection: { agentId: "agent-1", threadId: "thread-1" } },
      defaultBrowserPreferences,
    ],
  ])("stays silent for %s", (_label, activity, context, preferences) => {
    expect(shouldChime(activity, context, preferences)).toBe(false)
  })
})
