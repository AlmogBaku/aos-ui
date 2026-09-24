import { describe, expect, it, vi } from "vitest"

import {
  PendingRequestKind,
  ReplyStatus,
  TurnEventKind,
  type PendingRequest,
} from "../../core/events"
import {
  CommandRefusedError,
  runCommand,
  runEvents,
  type MemberEvent,
  type TurnStream,
} from "../../core/member"
import type { GuestGrant } from "./index"
import { createPermissionsMiddleware } from "./permissions"

const GUEST = "guest-principal"

const grant: GuestGrant = {
  agentId: "agent",
  ref: "ref",
  principalId: GUEST,
  expiresAt: 100,
}

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  message: "Run the command?",
  responseSchema: { type: "string", enum: ["once", "always", "deny"] },
}

const QUESTION: PendingRequest = {
  requestId: "question-1",
  kind: PendingRequestKind.Elicitation,
  message: "Which folder? Not /srv/aos/repo.",
  questions: [
    {
      label: "Folder under /srv/aos",
      text: "Which folder? Not /srv/aos/repo.",
      choices: ["/home/operator/exports", "later"],
      multiple: false,
      custom: true,
    },
  ],
}

const STREAM: TurnStream = {
  turnId: "turn-1",
  replayedCorrections: 0,
  dropped: false,
}

/** One event through a guest's permissions layer, with the declines it asked. */
function shown(event: MemberEvent) {
  const decline = vi.fn()
  const result = runEvents([createPermissionsMiddleware({ grant })], event, {
    decline,
  })
  return { result, declined: decline.mock.calls.map(([id]) => id) }
}

const asked = (request: PendingRequest, startedBy?: string): MemberEvent => ({
  sessionId: "ref",
  kind: "request-asked",
  request,
  ...(startedBy === undefined ? {} : { startedBy }),
})

const requiresAction = (requests: PendingRequest[]): MemberEvent => ({
  sessionId: "ref",
  kind: "turn",
  stream: STREAM,
  sequence: 3,
  event: { kind: TurnEventKind.TurnRequiresAction, requests },
  stopping: false,
})

describe("guest permissions", () => {
  it("declines a permission in the guest's own turn and shows it nothing", () => {
    expect(shown(asked(APPROVAL, GUEST))).toEqual({
      result: undefined,
      declined: [APPROVAL.requestId],
    })
  })

  it.each([
    ["an operator's turn", "operator"],
    ["an adopted turn", undefined],
  ])(
    "leaves a permission in %s alone and shows it nothing",
    (_turn, startedBy) => {
      expect(shown(asked(APPROVAL, startedBy))).toEqual({
        result: undefined,
        declined: [],
      })
    }
  )

  it("passes a question whole, whoever started the turn", () => {
    for (const startedBy of [GUEST, "operator"]) {
      const event = asked(QUESTION, startedBy)
      expect(shown(event)).toEqual({ result: event, declined: [] })
    }
  })

  it("keeps a turn's questions and drops its permissions", () => {
    expect(shown(requiresAction([APPROVAL, QUESTION])).result).toEqual(
      requiresAction([QUESTION])
    )
    expect(shown(requiresAction([APPROVAL])).result).toBeUndefined()
  })

  it("refuses a permission answer and passes a question's", async () => {
    const execute = vi.fn(async () => undefined)
    const answer = (request: PendingRequest, payload: unknown) =>
      runCommand(
        [createPermissionsMiddleware({ grant })],
        "answer",
        {
          sessionId: "ref",
          request,
          reply: {
            requestId: request.requestId,
            status: ReplyStatus.Resolved,
            payload,
          },
        },
        execute
      )

    for (const payload of ["once", "deny"])
      await expect(answer(APPROVAL, payload)).rejects.toBeInstanceOf(
        CommandRefusedError
      )
    await answer(QUESTION, { answers: [["later"]] })

    expect(execute).toHaveBeenCalledOnce()
  })
})
