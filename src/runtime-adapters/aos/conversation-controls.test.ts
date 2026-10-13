import { describe, expect, it } from "vitest"

import { aosMessageRewind, sessionMessageRewind } from "./conversation-controls"

describe("sessionMessageRewind", () => {
  // A rewind the Session cannot take fails, so Edit and Retry wait for its
  // report, as steering does.
  it.each([
    [
      "reports it can rewind",
      { status: "available", scope: "user-turn" } as const,
      aosMessageRewind,
    ],
    [
      "reports it cannot rewind",
      { status: "unavailable", reason: "not-supported" } as const,
      false,
    ],
    ["has not reported yet", undefined, false],
  ])(
    "offers Edit and Retry only where the Session %s",
    (_, rewind, offered) => {
      expect(sessionMessageRewind(rewind)).toBe(offered)
    }
  )
})
