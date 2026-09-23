import { describe, expect, it, vi } from "vitest"

import {
  HermesAuthenticationError,
  HermesRpcRejectedError,
  HermesRpcUncertainError,
  HermesUnavailableError,
} from "./gateway"
import { HermesNativeRuntime } from "./run-native"
import { rpcRouter, type RpcHandler } from "./test-utils/rpc-router"
import type { HermesRunScope } from "./run"
import { PendingRequestKind, type PendingRequest } from "../../core/events"

const scope: HermesRunScope = {
  agentId: "researcher",
  sessionId: "stored",
  threadId: "stored",
}

const MAX_REPLAY_RESPONSE_BYTES = 6_291_456

function stubInteractions() {
  const listeners = new Set<(request: PendingRequest) => void>()
  return {
    onPendingRequest: vi.fn(
      (_scope: HermesRunScope, listener: (request: PendingRequest) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    ),
    respond: vi.fn(async () => ({ status: "resolved" })),
    resume: vi.fn(async () => ({ running: false, status: "idle" as const })),
    raise(request: PendingRequest) {
      for (const listener of [...listeners]) listener(request)
    },
  }
}

function runtime(
  handlers: Partial<Record<string, RpcHandler>> = {},
  history: readonly unknown[] = []
) {
  const router = rpcRouter(handlers)
  const release = vi.fn()
  const attachments = {
    ensure: vi.fn(async () => ({
      liveSessionId: "live-secret",
      running: true,
    })),
    retain: vi.fn(async () => release),
    subscribeLive: vi.fn(async () => () => {}),
    invalidate: vi.fn(),
  }
  const interactions = stubInteractions()
  const warn = vi.fn()
  const wait = vi.fn(async () => undefined)
  const native = new HermesNativeRuntime({
    transport: router,
    attachments,
    interactions,
    history: async () => history,
    log: { warn },
    retry: { delaysMs: [0, 0, 0], wait },
  })
  return { native, router, attachments, interactions, release, warn, wait }
}

describe("Hermes native submit outcomes", () => {
  it.each(["streaming", "queued", "steered", "redirected"] as const)(
    "accepts the authoritative native admission status %s",
    async (status) => {
      const { native, router } = runtime({
        "prompt.submit": async () => ({ status }),
      })

      await expect(
        native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
      ).resolves.toEqual({ acknowledgement: "accepted", status })
      expect(router.calls("prompt.submit")[0]?.params).toEqual({
        session_id: "live-secret",
        text: "Hello",
      })
    }
  )

  it.each([
    [4001, "session-gone"],
    [4007, "session-gone"],
    [4009, "busy"],
    [4090, "unknown"],
    [4091, "busy"],
    [5070, "storage"],
    [5071, "storage"],
    [-32600, "invalid"],
    [-32602, "invalid"],
    [4121, "unknown"],
    [undefined, "unknown"],
  ] as const)(
    "classifies the authoritative native rejection %s as %s",
    async (code, reason) => {
      const { native, attachments } = runtime({
        "prompt.submit": async () => {
          throw new HermesRpcRejectedError(code)
        },
      })

      await expect(
        native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
      ).resolves.toEqual({
        acknowledgement: "rejected",
        reason,
        // A refused write ran nothing, so the refusal reports it: the single
        // session-gone re-send repeats that `prompt.submit` and nothing else.
        refused: { params: { text: "Hello" } },
      })
      if (reason === "session-gone")
        expect(attachments.invalidate).toHaveBeenCalledWith("live-secret")
      else expect(attachments.invalidate).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      "SESSION_NOT_OWNED",
      "in-use",
      "This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\nDetails: owned by another Hermes process",
    ],
    [
      "MAX_CONCURRENT_SESSIONS",
      "session-limit",
      "Hermes is at the active session limit (4/4). Try again when another session finishes.",
    ],
  ] as const)(
    "classifies a 4090 refusal with reason %s as %s and keeps Hermes' words",
    async (nativeReason, reason, message) => {
      const { native, router } = runtime({
        "prompt.submit": async () => {
          throw new HermesRpcRejectedError(4090, message, nativeReason)
        },
      })

      await expect(
        native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
      ).resolves.toEqual({
        acknowledgement: "rejected",
        reason,
        detail: message,
        refused: { params: { text: "Hello" } },
      })
      // A final refusal is never retried.
      expect(router.calls("prompt.submit")).toHaveLength(1)
    }
  )

  it("keeps Hermes' instruction on a busy refusal", async () => {
    const message =
      "session busy — Hermes is still replying. Stop the current reply first (Stop button, or Ctrl+C in a terminal), then run /undo."
    const { native } = runtime({
      "prompt.submit": async () => {
        throw new HermesRpcRejectedError(4009, message)
      },
    })

    await expect(
      native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
    ).resolves.toMatchObject({ reason: "busy", detail: message })
  })

  it("drops refusal text that names a private location", async () => {
    const { native } = runtime({
      "prompt.submit": async () => {
        throw new HermesRpcRejectedError(
          4009,
          "session busy: /home/operator/.hermes/state.db is locked"
        )
      },
    })

    const outcome = await native.submit("live-secret", {
      scope,
      text: "Hello",
      runId: "run-1",
    })

    expect(outcome).toMatchObject({ reason: "busy" })
    expect(outcome).not.toHaveProperty("detail")
  })

  it.each([
    [4009, "session disconnect interrupt settling", undefined],
    [
      4090,
      "Hermes could not verify session ownership.",
      "SESSION_COORDINATION_UNAVAILABLE",
    ],
  ] as const)(
    "retries the transient refusal %s until Hermes settles",
    async (code, message, nativeReason) => {
      let attempts = 0
      const { native, router, wait } = runtime({
        "prompt.submit": async () => {
          if (++attempts < 3)
            throw new HermesRpcRejectedError(code, message, nativeReason)
          return { status: "streaming" }
        },
      })

      await expect(
        native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
      ).resolves.toEqual({ acknowledgement: "accepted", status: "streaming" })
      expect(router.calls("prompt.submit")).toHaveLength(3)
      expect(wait).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    [4009, "session disconnect interrupt settling", undefined],
    [
      4090,
      "Hermes could not verify session ownership.",
      "SESSION_COORDINATION_UNAVAILABLE",
    ],
  ] as const)(
    "reports a transient refusal %s that outlasts its retries as an outage",
    async (code, message, nativeReason) => {
      const { native, router } = runtime({
        "prompt.submit": async () => {
          throw new HermesRpcRejectedError(code, message, nativeReason)
        },
      })

      await expect(
        native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
      ).rejects.toBeInstanceOf(HermesUnavailableError)
      expect(router.calls("prompt.submit")).toHaveLength(4)
    }
  )

  it("logs the native rejection code and no native message", async () => {
    const { native, warn } = runtime({
      "prompt.submit": async () => {
        throw new HermesRpcRejectedError(4090)
      },
    })

    await native.submit("live-secret", {
      scope,
      text: "Hello",
      runId: "run-1",
    })

    expect(warn).toHaveBeenCalledExactlyOnceWith("hermes.native.rejected", {
      method: "prompt.submit",
      code: 4090,
    })
  })

  it("reports a lost transport acknowledgement as uncertain", async () => {
    const { native } = runtime({
      "prompt.submit": async () => {
        throw new HermesRpcUncertainError()
      },
    })

    await expect(
      native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
    ).resolves.toEqual({ acknowledgement: "uncertain" })
  })

  it("treats a failed pre-submit command catalog read as an outage and never submits", async () => {
    const { native, router } = runtime({
      "commands.catalog": async () => {
        throw new HermesRpcUncertainError()
      },
    })

    await expect(
      native.submit("live-secret", {
        scope,
        text: "/etc hosts is missing",
        runId: "run-1",
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    expect(router.calls("prompt.submit")).toHaveLength(0)
  })

  it("treats a failed pre-submit rewind history read as an outage and never submits", async () => {
    const router = rpcRouter({ "prompt.submit": async () => ({}) })
    const native = new HermesNativeRuntime({
      transport: router,
      attachments: {
        ensure: async () => ({ liveSessionId: "live-secret", running: false }),
        retain: async () => () => {},
        subscribeLive: async () => () => {},
        invalidate: () => {},
      },
      interactions: stubInteractions(),
      history: async () => {
        throw new Error("dashboard unavailable")
      },
    })

    await expect(
      native.submit("live-secret", {
        scope,
        text: "Edited",
        runId: "run-1",
        rewindSourceId: "hermes-row-12",
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    expect(router.calls("prompt.submit")).toHaveLength(0)
  })

  it("logs the durable address a rewind submit truncated before", async () => {
    const { native, warn } = runtime(
      { "prompt.submit": async () => ({ status: "streaming" }) },
      [
        { row_id: 10, role: "user", text: "Keep" },
        { row_id: 11, role: "assistant", text: "Kept reply" },
        { row_id: 12, role: "user", text: "Original" },
      ]
    )

    await native.submit("live-secret", {
      scope,
      text: "Edited",
      runId: "edit-run",
      rewindSourceId: "hermes-row-12",
    })

    expect(warn).toHaveBeenCalledExactlyOnceWith("hermes.rewind.submit", {
      sessionId: "stored",
      rewindSourceId: "hermes-row-12",
      confirm_truncate: true,
      truncate_before_row_id: 12,
    })
  })

  it("reports an unusable native admission status as a lost acknowledgement", async () => {
    const { native, router } = runtime({
      "prompt.submit": async () => ({ accepted: true }),
    })

    // Hermes took the write, so the turn may be running: the acknowledgement is
    // lost rather than an outage, and the prompt is never sent again.
    await expect(
      native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
    ).resolves.toEqual({ acknowledgement: "uncertain" })
    expect(router.calls("prompt.submit")).toHaveLength(1)
  })

  it("reports an unusable admission status of an expanded command as lost", async () => {
    const { native, router } = runtime({
      "commands.catalog": async () => ({
        pairs: [["/summarize", "Summarize"]],
      }),
      "slash.exec": async () => ({ type: "send", message: "Summarize this" }),
      "prompt.submit": async () => ({ status: "accepted-ish" }),
    })

    // The command expanded into a prompt Hermes took, so the acknowledgement is
    // lost exactly as it is for a direct submit: never an outage.
    await expect(
      native.submit("live-secret", {
        scope,
        text: "/summarize",
        runId: "run-1",
      })
    ).resolves.toEqual({ acknowledgement: "uncertain" })
    expect(router.calls("prompt.submit")).toHaveLength(1)
  })

  it("propagates rejected Hermes credentials instead of classifying them", async () => {
    const { native } = runtime({
      "prompt.submit": async () => {
        throw new HermesAuthenticationError()
      },
    })

    await expect(
      native.submit("live-secret", { scope, text: "Hello", runId: "run-1" })
    ).rejects.toBeInstanceOf(HermesAuthenticationError)
  })

  it("refuses a recognized command that carries attachments before any write", async () => {
    const { native, router } = runtime({
      "commands.catalog": async () => ({ pairs: [["/help", "Help"]] }),
    })

    await expect(
      native.submit("live-secret", {
        scope: { ...scope, hasAttachments: true },
        text: "/help",
        runId: "run-1",
      })
    ).resolves.toEqual({
      acknowledgement: "rejected",
      reason: "command-with-attachments",
    })
    expect(router.calls("slash.exec")).toHaveLength(0)
    expect(router.calls("prompt.submit")).toHaveLength(0)
  })
})

describe("Hermes native interrupt", () => {
  it("reports an acknowledged interrupt", async () => {
    const { native, router } = runtime({
      "session.interrupt": async () => ({ status: "interrupted" }),
    })

    await expect(native.interrupt("live-secret")).resolves.toBe("interrupted")
    expect(router.calls("session.interrupt")[0]?.params).toEqual({
      session_id: "live-secret",
    })
  })

  it.each([4001, 4007, -32602])(
    "reports an authoritative %s rejection as a gone live Session",
    async (code) => {
      const { native, attachments } = runtime({
        "session.interrupt": async () => {
          throw new HermesRpcRejectedError(code)
        },
      })

      await expect(native.interrupt("live-secret")).resolves.toBe("gone")
      expect(attachments.invalidate).toHaveBeenCalledWith("live-secret")
    }
  )

  it("keeps a lost interrupt acknowledgement uncertain and any other rejection an outage", async () => {
    const uncertain = runtime({
      "session.interrupt": async () => {
        throw new HermesRpcUncertainError()
      },
    })
    await expect(
      uncertain.native.interrupt("live-secret")
    ).rejects.toBeInstanceOf(HermesRpcUncertainError)

    const rejected = runtime({
      "session.interrupt": async () => {
        throw new HermesRpcRejectedError(5030)
      },
    })
    await expect(
      rejected.native.interrupt("live-secret")
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    expect(rejected.attachments.invalidate).not.toHaveBeenCalled()
  })
})

describe("Hermes native status", () => {
  it.each(["starting", "working", "waiting", "idle"] as const)(
    "returns the native turn state %s verbatim",
    async (status) => {
      const { native } = runtime({
        "session.active_list": async () => ({
          sessions: [{ id: "live-secret", status }],
        }),
      })

      await expect(native.status("live-secret")).resolves.toBe(status)
    }
  )

  it("reports a live Session Hermes no longer lists as absent", async () => {
    const { native } = runtime({
      "session.active_list": async () => ({ sessions: [] }),
    })

    await expect(native.status("live-secret")).resolves.toBe("absent")
  })

  it("rejects an unknown native turn state as invalid native data", async () => {
    const { native } = runtime({
      "session.active_list": async () => ({
        sessions: [{ id: "live-secret", status: "compacting" }],
      }),
    })

    await expect(native.status("live-secret")).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
  })
})

describe("Hermes native replay cursor", () => {
  const since = {
    "session.events.since": async () => ({
      epoch: "epoch-1",
      latest_seq: 4,
      truncated: false,
      events: [],
    }),
  }

  it("reads the current epoch and sequence watermark without retained events", async () => {
    const { native, router } = runtime(since)

    await expect(native.cursor("live-secret")).resolves.toEqual({
      epoch: "epoch-1",
      latestSeq: 4,
    })
    expect(router.calls("session.events.since")[0]).toEqual({
      params: { session_id: "live-secret", last_seen: Number.MAX_SAFE_INTEGER },
      maxResponseBytes: undefined,
    })
  })

  it("replays from an integer cursor under the bounded replay reply size", async () => {
    const { native, router } = runtime(since)

    await expect(native.replay("live-secret", 2)).resolves.toEqual({
      epoch: "epoch-1",
      lastSeen: 4,
      truncated: false,
      events: [],
    })
    expect(router.calls("session.events.since")[0]).toEqual({
      params: { session_id: "live-secret", last_seen: 2 },
      maxResponseBytes: MAX_REPLAY_RESPONSE_BYTES,
    })
  })

  it("refuses a replay cursor that is not a safe non-negative integer", async () => {
    const { native, router } = runtime(since)

    await expect(native.replay("live-secret", -1)).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    await expect(native.replay("live-secret", 1.5)).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    expect(router.calls("session.events.since")).toHaveLength(0)
  })

  it.each([
    ["a missing epoch", { latest_seq: 1, events: [] }],
    ["a blank epoch", { epoch: "  ", latest_seq: 1, events: [] }],
    ["a negative watermark", { epoch: "e", latest_seq: -1, events: [] }],
    ["a fractional watermark", { epoch: "e", latest_seq: 1.5, events: [] }],
    ["a missing watermark", { epoch: "e", events: [] }],
    [
      "a non-boolean truncation flag",
      { epoch: "e", latest_seq: 1, truncated: "yes", events: [] },
    ],
    ["a missing event list", { epoch: "e", latest_seq: 1 }],
  ])("rejects %s in a native replay reply", async (_label, payload) => {
    const { native } = runtime({
      "session.events.since": async () => payload,
    })

    await expect(native.replay("live-secret", 0)).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
    await expect(native.cursor("live-secret")).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
  })

  it("accepts the legacy last_seen watermark field", async () => {
    const { native } = runtime({
      "session.events.since": async () => ({
        epoch: "epoch-1",
        last_seen: 7,
        events: [],
      }),
    })

    await expect(native.cursor("live-secret")).resolves.toEqual({
      epoch: "epoch-1",
      latestSeq: 7,
    })
  })
})

describe("Hermes native retention", () => {
  it("delegates retention to the attachment registry", async () => {
    const { native, attachments, release } = runtime()

    const stop = await native.retain(scope, "settling")

    expect(attachments.retain).toHaveBeenCalledWith(scope, "settling")
    stop()
    expect(release).toHaveBeenCalledOnce()
  })

  it("passes pending requests through from the interaction surface", () => {
    const { native, interactions } = runtime()
    const observed = vi.fn()

    const stop = native.onPendingRequest(scope, observed)
    const request = {
      requestId: "srq-1",
      kind: PendingRequestKind.Permission,
      message: "Continue?",
    }
    interactions.raise(request)

    expect(observed).toHaveBeenCalledWith(request)
    expect(interactions.onPendingRequest).toHaveBeenCalledWith(
      scope,
      expect.any(Function)
    )

    stop()
    interactions.raise(request)
    expect(observed).toHaveBeenCalledTimes(1)
  })

  it("refuses to observe a live Session that was never attached", async () => {
    const router = rpcRouter()
    const native = new HermesNativeRuntime({
      transport: router,
      attachments: {
        ensure: async () => ({ liveSessionId: "live-secret", running: false }),
        retain: async () => () => {},
        subscribeLive: async () => {
          throw new Error("Hermes Session is not attached")
        },
        invalidate: () => {},
      },
      interactions: stubInteractions(),
      history: async () => [],
    })

    await expect(
      native.observe("live-secret", () => {})
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })
})
