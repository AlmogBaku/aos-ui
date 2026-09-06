import { describe, expect, it } from "vitest"

import { createProviderMock } from "./provider-mock"

describe("provider mock", () => {
  it("binds loopback, logs expected requests, and rejects unexpected traffic", async () => {
    const provider = createProviderMock({ mode: "ag-ui", port: 0 })
    await provider.start()
    try {
      const response = await fetch(`${provider.origin}/agents`)
      expect(response.status).toBe(200)
      expect(provider.requests.map((request) => request.path)).toEqual([
        "/agents",
      ])
      const rejected = await fetch(`${provider.origin}/not-a-provider-route`)
      expect(rejected.status).toBe(404)
      expect(provider.unexpectedRequests[0]?.path).toBe("/not-a-provider-route")
      expect(provider.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await provider.stop()
    }
  })

  it("holds an AG-UI run until released and can fail once", async () => {
    const provider = createProviderMock({
      mode: "ag-ui",
      port: 0,
      run: { hold: true },
    })
    provider.failOnce("/agents", 503)
    await provider.start()
    try {
      expect((await fetch(`${provider.origin}/agents`)).status).toBe(503)
      expect((await fetch(`${provider.origin}/agents`)).status).toBe(200)
      const runResponse = await fetch(`${provider.origin}/runs`, {
        method: "POST",
        body: JSON.stringify({ runId: "run-1", threadId: "thread-1" }),
      })
      expect(runResponse.body).toBeTruthy()
      expect(provider.pendingRuns).toEqual(["run-1"])
      provider.releaseRun("run-1")
      const body = await runResponse.text()
      expect(body).toContain('"type":"RUN_FINISHED"')
    } finally {
      await provider.stop()
    }
  })

  it("serves the minimal OpenCode session and question contract", async () => {
    const provider = createProviderMock({ mode: "opencode", port: 0 })
    provider.enqueueQuestion({
      id: "question-1",
      sessionID: "session-research",
      questions: [
        {
          header: "Scope",
          question: "Which scope should I use?",
          options: [{ label: "Current file", description: "Stay focused" }],
        },
      ],
    })
    await provider.start()
    try {
      expect((await fetch(`${provider.origin}/event`)).status).toBe(200)
      expect(await (await fetch(`${provider.origin}/agent`)).json()).toEqual([
        expect.objectContaining({ name: "build" }),
      ])
      expect(
        await (await fetch(`${provider.origin}/experimental/session`)).json()
      ).toEqual([expect.objectContaining({ id: "session-research" })])
      expect(
        await (await fetch(`${provider.origin}/session/status`)).json()
      ).toEqual({ "session-research": { type: "idle" } })
      expect(await (await fetch(`${provider.origin}/question`)).json()).toEqual(
        [expect.objectContaining({ id: "question-1" })]
      )
      expect(
        await (
          await fetch(`${provider.origin}/session/session-research`)
        ).json()
      ).toEqual(expect.objectContaining({ id: "session-research" }))
      expect(
        (await fetch(`${provider.origin}/session/session-research/message`))
          .status
      ).toBe(200)
      expect(
        (await fetch(`${provider.origin}/session/session-research/todo`)).status
      ).toBe(200)

      const reply = await fetch(
        `${provider.origin}/question/question-1/reply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: [["Current file"]] }),
        }
      )
      expect(reply.status).toBe(200)
      expect(provider.pendingQuestions).toEqual([])
    } finally {
      await provider.stop()
    }
  })
})
