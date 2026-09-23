import { describe, expect, it } from "vitest"

import {
  createProviderMock,
  LONG_SESSION_ID,
  LONG_SESSION_LENGTH,
} from "./provider-mock"

describe("provider mock", () => {
  it("binds loopback, logs expected requests, and rejects unexpected traffic", async () => {
    const provider = createProviderMock({ port: 0 })
    await provider.start()
    try {
      const response = await fetch(`${provider.origin}/agent`)
      expect(response.status).toBe(200)
      expect(provider.requests.map((request) => request.path)).toEqual([
        "/agent",
      ])
      const rejected = await fetch(`${provider.origin}/not-a-provider-route`)
      expect(rejected.status).toBe(404)
      expect(provider.unexpectedRequests[0]?.path).toBe("/not-a-provider-route")
      expect(provider.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
      await provider.stop()
    }
  })

  it("fails a route once when asked", async () => {
    const provider = createProviderMock({ port: 0 })
    provider.failOnce("/agent", 503)
    await provider.start()
    try {
      expect((await fetch(`${provider.origin}/agent`)).status).toBe(503)
      expect((await fetch(`${provider.origin}/agent`)).status).toBe(200)
    } finally {
      await provider.stop()
    }
  })

  it("serves the minimal OpenCode session and question contract", async () => {
    const provider = createProviderMock({ port: 0 })
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
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "session-research" }),
        ])
      )
      expect(
        await (await fetch(`${provider.origin}/session/status`)).json()
      ).toEqual(
        expect.objectContaining({ "session-research": { type: "idle" } })
      )
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

  it("pages a long Session newest first, following its cursor to the start", async () => {
    const provider = createProviderMock({ port: 0 })
    await provider.start()
    type Page = { data: { id: string }[]; cursor: { next?: string } }
    const read = async (query: string): Promise<Page> =>
      (await (
        await fetch(
          `${provider.origin}/api/session/${LONG_SESSION_ID}/message?${query}`
        )
      ).json()) as Page
    try {
      const ids: string[] = []
      let page = await read("limit=100&order=desc")
      expect(page.data[0]?.id).toBe(`long-${LONG_SESSION_LENGTH - 1}`)
      for (;;) {
        ids.push(...page.data.map((message) => message.id))
        if (!page.cursor.next) break
        page = await read(`limit=100&cursor=${page.cursor.next}`)
      }
      expect(ids).toHaveLength(LONG_SESSION_LENGTH)
      expect(ids.at(-1)).toBe("long-0000")

      const oldest = await read("limit=2&order=asc")
      expect(oldest.data.map((message) => message.id)).toEqual([
        "long-0000",
        "long-0001",
      ])
    } finally {
      await provider.stop()
    }
  })
})
