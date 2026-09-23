import type {
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"

import {
  createAcpComposerStore,
  foldTurnUsage,
} from "./acp-workspace-client-composer"
import type {
  AcpConnection,
  AcpSessionReplayListener,
  AcpSessionUpdateListener,
} from "./types"

const SESSION_ID = "session-1"
const TURN_META = { sequence: 0, turnId: "run-1" }

function configOptions(model: string, effort: string): SessionConfigOption[] {
  return [
    {
      configId: "session-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
    {
      configId: "session-effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ]
}

/** The three connection seams the store uses; the rest is never reached. */
function createStore() {
  let onUpdate: AcpSessionUpdateListener = () => undefined
  let onReplay: AcpSessionReplayListener = () => undefined
  const connection = {
    onSessionUpdate: (_: string, listener: AcpSessionUpdateListener) => {
      onUpdate = listener
      return () => undefined
    },
    onSessionReplay: (_: string, listener: AcpSessionReplayListener) => {
      onReplay = listener
      return () => undefined
    },
    setConfigOption: async (_: string, configId: string, value: string) =>
      configId === "session-model"
        ? configOptions(value, "low")
        : configOptions("sonnet", value),
  } as unknown as AcpConnection
  const store = createAcpComposerStore(connection)
  store.attach(SESSION_ID, {
    configOptions: configOptions("sonnet", "low"),
    capabilities: {} as never,
  })
  const emit = (update: SessionUpdate, meta?: Record<string, unknown>) =>
    onUpdate(update, meta)
  const idle = (usage?: unknown, cost?: unknown) =>
    emit(
      {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        ...(usage ? { usage } : {}),
      } as SessionUpdate,
      {
        ...TURN_META,
        ...(cost ? { cost } : {}),
      }
    )
  return { store, emit, idle, replay: () => onReplay() }
}

const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }

describe("foldTurnUsage", () => {
  it("sums costs while the currency holds and restarts when it changes", () => {
    const usd = (amount: number) => ({ amount, currency: "USD" })
    const first = foldTurnUsage(undefined, undefined, usd(0.5))
    const second = foldTurnUsage(first, undefined, usd(0.25))
    expect(second?.cost).toEqual(usd(0.75))
    const switched = foldTurnUsage(second, undefined, {
      amount: 3,
      currency: "EUR",
    })
    expect(switched?.cost).toEqual({ amount: 3, currency: "EUR" })
  })

  it("keeps the reading when a turn reports neither usage nor cost", () => {
    const reading = foldTurnUsage(undefined, USAGE, undefined)
    expect(foldTurnUsage(reading, undefined, undefined)).toBe(reading)
  })
})

describe("createAcpComposerStore turn usage", () => {
  it("reads the last turn's usage and the Session's cost from idle updates", () => {
    const { store, idle } = createStore()
    const listener = vi.fn()
    store.subscribeContext(SESSION_ID, listener)
    idle(
      { ...USAGE, thoughtTokens: 5, cachedReadTokens: null },
      {
        amount: 0.1,
        currency: "USD",
      }
    )
    idle(USAGE, { amount: 0.2, currency: "USD" })
    expect(store.turnUsage(SESSION_ID)).toEqual({
      lastTurn: USAGE,
      cost: { amount: 0.1 + 0.2, currency: "USD" },
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("ignores a usage missing a count ACP requires", () => {
    const { store, idle } = createStore()
    idle({ inputTokens: 1 })
    expect(store.turnUsage(SESSION_ID)).toBeUndefined()
  })

  it("counts every turn once across a from-start replay", () => {
    const { store, idle, replay } = createStore()
    idle(USAGE, { amount: 1, currency: "USD" })
    replay()
    idle(USAGE, { amount: 1, currency: "USD" })
    expect(store.turnUsage(SESSION_ID)?.cost).toEqual({
      amount: 1,
      currency: "USD",
    })
  })
})

describe("createAcpComposerStore model feed", () => {
  it("keeps one feed and one reading until the model changes", () => {
    const { store, emit } = createStore()
    const feed = store.modelFeed(SESSION_ID)
    expect(store.modelFeed(SESSION_ID)).toBe(feed)
    const first = feed.current()
    expect(first).toEqual({ selectedId: "sonnet", effortId: "low" })

    const listener = vi.fn()
    feed.subscribe(listener)
    emit({
      sessionUpdate: "config_option_update",
      configOptions: configOptions("sonnet", "low"),
    })
    expect(feed.current()).toBe(first)
    expect(listener).not.toHaveBeenCalled()

    emit({
      sessionUpdate: "config_option_update",
      configOptions: configOptions("opus", "high"),
    })
    expect(feed.current()).toEqual({ selectedId: "opus", effortId: "high" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("follows the Session onto what a write settled", async () => {
    const { store } = createStore()
    await store.selectModel(SESSION_ID, "opus")
    expect(store.modelFeed(SESSION_ID).current()).toEqual({
      selectedId: "opus",
      effortId: "low",
    })
  })
})
