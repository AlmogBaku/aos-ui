// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { GuestInvitationService } from "../auth/guest-invitation"
import type { RuntimeInstance } from "../core/runtime"
import { createGuestRoutes } from "./context"

function routes() {
  return createGuestRoutes({
    publicOrigin: "https://guest.example.test",
    runtime: {} as RuntimeInstance,
    invitations: {} as GuestInvitationService,
  })
}

describe("guest request limits", () => {
  it("limits streams per invitation and releases capacity", () => {
    const subject = routes()
    const releases = Array.from({ length: 4 }, () =>
      subject.acquireStream("one-invitation")
    )

    expect(releases.every(Boolean)).toBe(true)
    expect(subject.acquireStream("one-invitation")).toBeUndefined()
    releases[0]?.()
    expect(subject.acquireStream("one-invitation")).toBeDefined()
  })

  it("limits aggregate guest streams without coupling invitations", () => {
    const subject = routes()
    const releases = Array.from({ length: 64 }, (_, index) =>
      subject.acquireStream(`invitation-${index}`)
    )

    expect(releases.every(Boolean)).toBe(true)
    expect(subject.acquireStream("overflow")).toBeUndefined()
    releases[0]?.()
    expect(subject.acquireStream("after-release")).toBeDefined()
  })
})
