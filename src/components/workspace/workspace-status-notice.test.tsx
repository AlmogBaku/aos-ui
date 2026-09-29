import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { WorkspaceStatusNotice } from "./workspace-status-notice"

afterEach(cleanup)

it.each([
  ["en", { connectionStatus: "reconnecting" }, "Reconnecting to AOS…"],
  ["he", { connectionStatus: "reconnecting" }, "מתחברים מחדש ל-AOS…"],
  ["en", { connectionStatus: "reconnected" }, "Reconnected"],
  ["he", { connectionStatus: "reconnected" }, "החיבור חזר"],
  [
    "en",
    { connectionStatus: "capacity" },
    "The AOS server is full. Reconnecting shortly.",
  ],
  [
    "he",
    { connectionStatus: "capacity" },
    "שרת AOS מלא כרגע. מתחברים מחדש בקרוב.",
  ],
  [
    "en",
    { sessionStatus: "unavailable" },
    "This Session is no longer available.",
  ],
  ["he", { sessionStatus: "unavailable" }, "השיחה הזו כבר אינה זמינה."],
] as const)(
  "tells the %s reader %o until it clears",
  (locale, status, statusText) => {
    const { rerender } = render(
      <WorkspaceStatusNotice locale={locale} {...status}>
        {null}
      </WorkspaceStatusNotice>
    )
    expect(screen.getByRole("status")).toHaveTextContent(statusText)
    rerender(
      <WorkspaceStatusNotice locale={locale}>{null}</WorkspaceStatusNotice>
    )
    expect(screen.queryByText(statusText)).toBeNull()
  }
)
