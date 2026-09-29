import { describe, expect, it } from "vitest"

import { ServerTurnEndedError } from "../core/runtime"
import { publicCodeOf, publicRequestError } from "./validation"

const replyOf = (cause: unknown) =>
  publicCodeOf(publicRequestError(() => undefined, cause))

describe("a prompt whose turn ended before its storage receipt", () => {
  it.each([
    ["a stop", new ServerTurnEndedError("stopped"), "request_cancelled"],
    [
      "a failure",
      new ServerTurnEndedError("failed", "AOS_PROVIDER_RUN_FAILED"),
      "temporarily_unavailable",
    ],
    [
      "a detach that may leave the turn alive",
      new ServerTurnEndedError("failed", "AOS_CONNECTION_INTERRUPTED"),
      "uncertain_mutation",
    ],
  ])("answers %s as what happened", (_, cause, reply) => {
    expect(replyOf(cause)).toBe(reply)
  })
})
