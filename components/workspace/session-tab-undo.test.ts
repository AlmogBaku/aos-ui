import { act, renderHook, cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { neighborAfterClose, useSessionTabUndo } from "./session-tab-undo"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const closed = {
  agentId: "aster",
  threadId: "b",
  title: "Brief",
  selectedThreadId: "b",
}

describe("Session tab undo", () => {
  it("chooses the next tab, then the previous tab, without changing a background selection", () => {
    expect(neighborAfterClose(["a", "b", "c"], "b", "b")).toBe("c")
    expect(neighborAfterClose(["a", "b", "c"], "c", "c")).toBe("b")
    expect(neighborAfterClose(["a", "b", "c"], "b", "a")).toBe("a")
    expect(neighborAfterClose(["a"], "a", "a")).toBeNull()
  })

  it("retains the exact close until 8 seconds and expires it at the boundary", () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSessionTabUndo())
    act(() => result.current.remember(closed))
    act(() => vi.advanceTimersByTime(7999))
    expect(result.current.pending).toEqual(closed)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.pending).toBeNull()
    expect(result.current.take()).toBeNull()
  })

  it("replaces the most recent close and its timer; Undo consumes exactly once", () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSessionTabUndo())
    act(() => result.current.remember(closed))
    act(() => vi.advanceTimersByTime(7000))
    const next = { ...closed, threadId: "c", selectedThreadId: "a" }
    act(() => result.current.remember(next))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.pending).toEqual(next)
    act(() => {
      expect(result.current.take()).toEqual(next)
    })
    expect(result.current.pending).toBeNull()
    expect(result.current.take()).toBeNull()
    act(() => result.current.remember(closed))
    act(() => vi.advanceTimersByTime(7000))
    expect(result.current.pending).toEqual(closed)
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.pending).toBeNull()
  })
})
