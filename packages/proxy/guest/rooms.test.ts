// @vitest-environment node

import { methods } from "@agentclientprotocol/sdk/experimental/v2"
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
  EventSource,
  endedTurn,
  flow,
  gate,
  harness,
  heldUntilWithdrawn,
  liveTurn,
  open,
  prompt,
  prompts,
  replyWhileWatched,
  settled,
  storedLiveTurn,
  turnStarted,
  waitFor,
  withoutStates,
  type ClientAnswers,
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
  responseSchema: { type: "string", enum: ["once", "deny"] },
}

const question = (requestId: string): PendingRequest => ({
  requestId,
  kind: PendingRequestKind.Elicitation,
  message: `Which folder for ${requestId}?`,
})

type Operator = Awaited<ReturnType<typeof harness>>

/** One invitation to the seeded Session, which every tab it opens acts as. */
async function invite(test: Operator) {
  const invitations = createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: test.runtimeInstance.id,
    keys: [{ id: "current", secret: new Uint8Array(32).fill(7) }],
    ttlSeconds: 259_200,
  })
  const { token } = await invitations.issue({ agentId: AGENT, ref: GUEST_REF })
  return { invitations, token }
}

type Invitation = Awaited<ReturnType<typeof invite>>

/** A guest browser that redeemed an invitation to the seeded Session. */
async function connectGuest(
  test: Operator,
  answers: ClientAnswers = {},
  invitation?: Invitation
) {
  const { invitations, token } = invitation ?? (await invite(test))
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
    ...answers,
  })
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    info: { name: "aos-guest-browser", version: "1" },
    capabilities: { _meta: { [AOS_META_KEY]: { historyPages: true } } },
  })
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

  it("streams a guest an operator's long prompt whole", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })

    const text = "x".repeat(80_000)
    await prompt(test, text)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    await replyWhileWatched(test.sources[0], "Done", [guest])

    expect(prompts(guest.recorder, GUEST_REF)).toEqual([
      [{ type: "text", text }],
    ])
    expect(flow(guest.recorder, GUEST_REF)).toContain("chunk Done")
    test.close()
    guest.close()
  })

  it("leaves an operator's approval pending for the operator and shows the guest nothing", async () => {
    const answered = gate()
    const test = await harness({
      providerIds: true,
      permission: async () => {
        await answered.held
        return { outcome: { outcome: "selected", optionId: "once" } }
      },
    })
    await test.list()
    await open(test)
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the operator's permission request"
    )
    await settled()

    expect(test.coordinator.snapshot(test.scope).requests).toEqual([APPROVAL])
    expect(test.start).toHaveBeenCalledTimes(1)
    answered.release()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [{ requestId: APPROVAL.requestId, status: "resolved" }],
    })
    expect(guest.recorder.of(methods.client.session.requestPermission)).toEqual(
      []
    )
    test.close()
    guest.close()
  })

  it("declines a guest's own permission and leaves an operator who joined after it nothing pending", async () => {
    const pending = new Set<AbortSignal>()
    const test = await harness({
      providerIds: true,
      permission: async (_params, signal) => {
        pending.add(signal)
        signal.addEventListener("abort", () => pending.delete(signal))
        return heldUntilWithdrawn(signal)
      },
    })
    await test.list()
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })
    await open(test)
    await prompt(guest, "Delete it", GUEST_REF)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [
        { requestId: APPROVAL.requestId, status: "resolved", payload: "deny" },
      ],
    })
    await settled()
    expect(pending.size).toBe(0)
    expect(test.coordinator.snapshot(test.scope).requests).toEqual([])
    expect(guest.recorder.of(methods.client.session.requestPermission)).toEqual(
      []
    )
    test.close()
    guest.close()
  })

  it("declines a guest's own permission after the guest answered a question in it", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const guest = await connectGuest(test)
    await open(guest, { sessionId: GUEST_REF })
    await prompt(guest, "Delete it", GUEST_REF)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [question("question-1")],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))

    test.sources[1]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[1]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(3))
    expect(test.start.mock.calls[2]?.[1]).toMatchObject({
      replies: [{ requestId: APPROVAL.requestId, payload: "deny" }],
    })
    test.close()
    guest.close()
  })

  it("declines a guest's own permission reissued when it reconnects", async () => {
    // The runtime still waits on the request whenever a resume asks.
    const test: Operator = await harness({
      providerIds: true,
      discover: async () => ({
        handle: new EventSource(),
        state: "waiting-for-input",
        requests: [APPROVAL],
      }),
    })
    await test.list()
    const invitation = await invite(test)
    const first = await connectGuest(test, {}, invitation)
    await open(first, { sessionId: GUEST_REF })
    await prompt(first, "Delete it", GUEST_REF)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    first.close()
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()
    await waitFor(() =>
      expect(test.coordinator.state(test.scope)).toBe("waiting-for-input")
    )
    await settled()
    expect(test.start).toHaveBeenCalledTimes(1)

    const reconnected = await connectGuest(test, {}, invitation)
    await open(reconnected, { sessionId: GUEST_REF })

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [{ requestId: APPROVAL.requestId, payload: "deny" }],
    })
    test.close()
    reconnected.close()
  })

  it("declines a guest's own permission once from two tabs", async () => {
    const test = await harness({ providerIds: true })
    await test.list()
    const invitation = await invite(test)
    const tabs = [
      await connectGuest(test, {}, invitation),
      await connectGuest(test, {}, invitation),
    ]
    for (const tab of tabs) await open(tab, { sessionId: GUEST_REF })
    await prompt(tabs[1]!, "Delete it", GUEST_REF)
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    await settled()
    expect(test.start).toHaveBeenCalledTimes(2)
    expect(test.start.mock.calls[1]?.[1]).toMatchObject({
      replies: [{ requestId: APPROVAL.requestId, payload: "deny" }],
    })
    for (const tab of tabs) {
      expect(tab.recorder.of(AOS_METHODS.notify.error)).toEqual([])
      tab.close()
    }
    test.close()
  })

  it("leaves an operator's turn the operator's after a guest answers its last question", async () => {
    const test = await harness({
      providerIds: true,
      question: async (_params, signal) => heldUntilWithdrawn(signal),
      permission: async (_params, signal) => heldUntilWithdrawn(signal),
    })
    await test.list()
    await open(test)
    const guest = await connectGuest(test, {
      question: async () => ({ action: "accept", content: { q0: "exports" } }),
    })
    await open(guest, { sessionId: GUEST_REF })
    await prompt(test, "Delete it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [question("question-1")],
    })
    test.sources[0]?.finish()
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))

    test.sources[1]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [APPROVAL],
    })
    test.sources[1]?.finish()
    await test.recorder.wait(
      (entry) => entry.method === methods.client.session.requestPermission,
      "the operator's permission request"
    )
    await settled()

    expect(test.coordinator.snapshot(test.scope).requests).toEqual([APPROVAL])
    expect(test.start).toHaveBeenCalledTimes(2)
    test.close()
    guest.close()
  })

  it("leaves a turn a guest recovered after a restart undeclined", async () => {
    const test = await harness({
      providerIds: true,
      discover: async () => ({
        handle: new EventSource(),
        state: "waiting-for-input",
        requests: [APPROVAL],
      }),
    })
    await test.list()
    // A restart lost the operator's turn; the runtime still waits on it.
    await test.coordinator.discover(test.scope, "guest")
    const guest = await connectGuest(test)

    await open(guest, { sessionId: GUEST_REF })
    await settled()

    expect(test.discover).toHaveBeenCalled()
    expect(test.coordinator.snapshot(test.scope).requests).toEqual([APPROVAL])
    expect(test.start).not.toHaveBeenCalled()
    test.close()
    guest.close()
  })

  it("continues a turn once a guest and an operator each answered one of its questions", async () => {
    const answerOnly =
      (requestId: string, answer: string): ClientAnswers["question"] =>
      async (params, signal) =>
        (params as { message?: string }).message === question(requestId).message
          ? { action: "accept", content: { q0: answer } }
          : heldUntilWithdrawn(signal)
    const test = await harness({
      providerIds: true,
      question: answerOnly("question-1", "operator's folder"),
    })
    await test.list()
    await open(test)
    const guest = await connectGuest(test, {
      question: answerOnly("question-2", "guest's folder"),
    })
    await open(guest, { sessionId: GUEST_REF })
    await prompt(test, "Export it")
    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(1))
    test.sources[0]?.emit(turnStarted())
    test.sources[0]?.emit({
      kind: TurnEventKind.TurnRequiresAction,
      requests: [question("question-1"), question("question-2")],
    })
    test.sources[0]?.finish()

    await waitFor(() => expect(test.start).toHaveBeenCalledTimes(2))
    const { replies } = test.start.mock.calls[1]?.[1] as {
      replies: Array<{ requestId: string; status: string }>
    }
    expect(replies).toHaveLength(2)
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "question-1",
          status: "resolved",
        }),
        {
          requestId: "question-2",
          status: "resolved",
          payload: { answers: [["guest's folder"]] },
        },
      ])
    )
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
