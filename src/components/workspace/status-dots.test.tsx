import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  RowIndicators,
  StatusDot,
  UnreadDot,
  type RowStatus,
} from "./status-dots"

afterEach(cleanup)

describe("StatusDot", () => {
  it.each([undefined, "idle"] as const)(
    "shows no indicator for a quiet %s status",
    (status) => {
      const { container } = render(<StatusDot status={status} label="Idle" />)
      expect(container).toBeEmptyDOMElement()
    }
  )

  it.each<[RowStatus, string]>([
    ["running", "Running"],
    ["active", "Active"],
    ["attention", "Needs attention"],
    ["waiting-for-input", "Waiting for input"],
    ["failed", "Failed"],
    ["unknown", "Status unavailable"],
  ])("labels the %s dot with its own status", (status, label) => {
    render(<StatusDot status={status} label={label} />)
    expect(screen.getByTitle(label)).toHaveAttribute("aria-hidden", "true")
  })
})

describe("UnreadDot", () => {
  it("labels the unread dot without repeating it to assistive technology", () => {
    render(<UnreadDot label="Unread" />)
    const dot = screen.getByTitle("Unread")
    expect(dot).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByText("Unread")).toBeNull()
  })
})

describe("RowIndicators", () => {
  it.each<[RowStatus, string]>([
    ["waiting-for-input", "Waiting for input"],
    ["attention", "Needs attention"],
    ["failed", "Failed"],
  ])("lets a %s Session outrank its unread dot", (status, label) => {
    render(
      <RowIndicators
        status={status}
        statusLabel={label}
        unread
        unreadLabel="Unread"
      />
    )
    expect(screen.getByTitle(label)).toBeVisible()
    expect(screen.queryByTitle("Unread")).toBeNull()
  })

  it("lets unread outrank a run that is still in progress", () => {
    render(
      <RowIndicators
        status="running"
        statusLabel="Running"
        unread
        unreadLabel="Unread"
      />
    )
    expect(screen.getByTitle("Unread")).toBeVisible()
    expect(screen.queryByTitle("Running")).toBeNull()
  })

  it("shows the unread dot alone for an idle Session", () => {
    render(
      <RowIndicators
        status="idle"
        statusLabel="Idle"
        unread
        unreadLabel="Unread"
      />
    )
    expect(screen.queryByTitle("Idle")).toBeNull()
    expect(screen.getByTitle("Unread")).toBeVisible()
  })

  it("shows nothing for an idle Session the operator has read", () => {
    const { container } = render(
      <RowIndicators
        status="idle"
        statusLabel="Idle"
        unread={false}
        unreadLabel="Unread"
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
