// @vitest-environment node

import {
  methods,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it } from "vitest"

import {
  ACP_PROTOCOL_VERSION,
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_AUTH_METHOD_INVITE,
  AOS_METHODS,
  AOS_META_KEY,
} from "../../protocol/acp"
import {
  AGENT,
  SESSION,
  chunk,
  connectClient,
  endedTurn,
  flow,
  gate,
  harness,
  liveTurn,
  open,
  prompt,
  prompts,
  replyWhileWatched,
  storedLiveTurn,
  turnStarted,
  waitFor,
  withoutStates,
} from "../acp/test-harness"
import { createGuestInvitationService } from "../auth/guest-invitation"
import { AttachmentStageRegistry } from "../core/attachment-stages"
import {
  PendingRequestKind,
  TurnEventKind,
  type PendingRequest,
} from "../core/events"
import { createSessionRows } from "../core/session-rows"
import { createGuestConnection } from "./acp"

/**
 * The guest lane in a room with operator browsers: a redeemed invitation to
 * the operator harness's seeded Session, on the same runtime and registry.
 */

const GUEST_REF = "guest-ref"

const APPROVAL: PendingRequest = {
  requestId: "approval-1",
  kind: PendingRequestKind.Permission,
  message: "permission-required",
  responseSchema: { type: "string", enum: ["once", "session", "always"] },
}

type Operator = Awaited<ReturnType<typeof harness>>

/** A guest browser that redeemed an invitation to the seeded Session. */
async function connectGuest(
  test: Operator,
  permission?: (
    params: unknown,
    signal: AbortSignal
  ) => Promise<RequestPermissionResponse>
) {
  const invitations = createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: test.runtimeInstance.id,
    keys: [{ id: "current", secret: new Uint8Array(32).fill(7) }],
    ttlSeconds: 259_200,
  })
  const context = createGuestConnection(
    {
      publicOrigin: "https://guest.example.test",
      runtimeInstance: test.runtimeInstance,
      invitations,
      attachmentStages: new AttachmentStageRegistry(),
      rooms: test.rooms,
    },
    createSessionRows(),
    "guest-connection"
  )
  const { connection, recorder } = connectClient(context, {
    name: "aos-guest-browser",
    ...(permission ? { permission } : {}),
  })
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    info: { name: "aos-guest-browser", version: "1" },
    capabilities: { _meta: { [AOS_META_KEY]: { historyPages: true } } },
  })
  const { token } = await invitations.issue({ agentId: AGENT, ref: GUEST_REF })
  await connection.agent.request(methods.agent.auth.login, {
    methodId: AOS_AUTH_METHOD_INVITE,
    _meta: { [AOS_META_KEY]: { token } },
  })
  return {
    agent: connection.agent,
    recorder,
    close: () => connection.close(),
  }
}

describe("guest in a Session room", () => {
  it("keeps a guest's exposure out of presence and read state", async () => {
    const test = await harness({ providerIds: true })
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })

    await guest.agent.notify(AOS_METHODS.session.focus, {
      sessionId: GUEST_REF,
    })
    // One round trip after the notification proves the lane has handled it.
    await expect(
      guest.agent.request(methods.agent.session.list, {})
    ).rejects.toThrow()

    expect(test.presence.set).not.toHaveBeenCalled()
    expect(test.readState.focus).not.toHaveBeenCalled()
    test.close()
    guest.close()
  })

  it("shows a guest a live turn history already stored once", async () => {
    const test = await harness({ providerIds: true, history: storedLiveTurn() })
    await test.list()
    const guest = await connectGuest(test)
    await liveTurn(test, [test])

    await open(guest, { sessionId: GUEST_REF, replayFrom: { type: "start" } })
    chunk(test.sources[0], "More")
    test.sources[0]?.emit({ kind: TurnEventKind.TurnEnded })
    await guest.recorder.wait(endedTurn, "the turn to end")

    const seen = withoutStates(flow(guest.recorder, GUEST_REF))
    expect(seen.filter((item) => item === "chunk Live")).toHaveLength(1)
    expect(seen.at(-1)).toBe("chunk More")
    test.close()
    guest.close()
  })

  it("shows a guest an operator's prompt as its text alone, and lets it Stop", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })
    const other = await test.connect("connection-2")
    await other.list()
    await open(other)
    const attachment = {
      type: "resource_link" as const,
      uri: `${AOS_ATTACHMENT_URI_SCHEME}stage/notes`,
      name: "notes.md",
      mimeType: "text/markdown",
    }

    const messageId = await prompt(test, [
      { type: "text", text: "Summarize" },
      attachment,
    ])
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    chunk(test.sources[0], "Live")
    await guest.recorder.wait(
      (entry) => JSON.stringify(entry.params).includes("Live"),
      "an update carrying Live"
    )

    expect(flow(guest.recorder, GUEST_REF)).toContain(`prompt ${messageId}`)
    expect(prompts(guest.recorder, GUEST_REF)).toEqual([
      [{ type: "text", text: "Summarize" }],
    ])
    expect(prompts(other.recorder)).toEqual([
      [{ type: "text", text: "Summarize" }, attachment],
    ])
    await guest.agent.notify(methods.agent.session.cancel, {
      sessionId: GUEST_REF,
    })
    await waitFor(() => expect(test.sources[0]?.stop).toHaveBeenCalledOnce())
    test.close()
    guest.close()
    other.close()
  })

  it("streams a guest an operator's turn whose prompt it may not see", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })

    // One byte past the guest message text bound.
    await prompt(test, "x".repeat(16_385))
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [guest])

    expect(prompts(guest.recorder, GUEST_REF)).toEqual([])
    expect(flow(guest.recorder, GUEST_REF)).toContain("chunk Done")
    test.close()
    guest.close()
  })

  it("lets a guest answer an operator's approval once only within its grant", async () => {
    const unanswered = gate()
    const test = await harness({
      providerIds: true,
      // The operator's own browser never answers, so the guest's answer decides.
      permission: async () => {
        await unanswered.held
        return { outcome: { outcome: "cancelled" } }
      },
    })
    await test.list()
    await open(test)
    const guest = await connectGuest(test, async () => ({
      outcome: { outcome: "selected", optionId: "once" },
    }))
    await open(guest, { sessionId: GUEST_REF })
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [{ requestId: APPROVAL.requestId, status: "resolved" }],
    })
    unanswered.release()
    test.close()
    guest.close()
  })

  it("shows an operator a guest's prompt rebuilt from its allowed fields", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    await open(test)
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })

    const messageId = await prompt(
      guest,
      [
        {
          type: "text",
          text: "Hello",
          annotations: { priority: 1 },
          _meta: { private: "guest-only" },
        },
      ],
      GUEST_REF
    )
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [test])

    expect(flow(test.recorder)).toContain(`prompt ${messageId}`)
    expect(prompts(test.recorder, SESSION)).toEqual([
      [{ type: "text", text: "Hello" }],
    ])
    test.close()
    guest.close()
  })
})
