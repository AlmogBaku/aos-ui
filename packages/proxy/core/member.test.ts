import { describe, expect, it } from "vitest"

import {
  admits,
  CommandRefusedError,
  runCommand,
  runEvents,
  type MemberEvent,
  type Middleware,
} from "./member"

const close = { sessionId: "session-1" }
const prompt = (text: string): MemberEvent => ({
  sessionId: "session-1",
  kind: "prompt",
  messageId: "message-1",
  content: [{ kind: "text", text }],
  own: false,
})
const textOf = (event: MemberEvent | undefined) =>
  event?.kind === "prompt" && event.content[0]?.kind === "text"
    ? event.content[0].text
    : undefined

describe("member stack", () => {
  it("passes a command down the stack in order and its result back up", async () => {
    const order: string[] = []
    const layer = (name: string): Middleware => ({
      commands: {
        close: async (command, next) => {
          order.push(`${name}:${command.sessionId}`)
          await next({ sessionId: `${command.sessionId}>${name}` })
          order.push(`${name}:done`)
        },
      },
    })

    await runCommand(
      [layer("a"), {}, layer("b")],
      "close",
      close,
      async (c) => {
        order.push(`execute:${c.sessionId}`)
      }
    )

    expect(order).toEqual([
      "a:session-1",
      "b:session-1>a",
      "execute:session-1>a>b",
      "b:done",
      "a:done",
    ])
  })

  it("never executes a command a layer refused", async () => {
    let executed = false
    const refusing: Middleware = {
      commands: {
        close: async () => {
          throw new CommandRefusedError("not-found")
        },
      },
    }

    await expect(
      runCommand([refusing], "close", close, async () => {
        executed = true
      })
    ).rejects.toMatchObject({ refusal: "not-found" })
    expect(executed).toBe(false)
  })

  it("admits a kind only when every layer does", () => {
    const stack: Middleware[] = [{}, { admits: (kind) => kind !== "delete" }]

    expect(admits(stack, "close")).toBe(true)
    expect(admits(stack, "delete")).toBe(false)
    expect(admits([], "delete")).toBe(true)
  })

  it("passes an event up the stack in reverse and stops at the layer that hides it", () => {
    const seen: string[] = []
    const layer = (name: string, hide = false): Middleware => ({
      event: (event) => {
        seen.push(name)
        return hide ? undefined : { ...prompt(`${textOf(event)}<${name}`) }
      },
    })

    const act = { decline: () => undefined }
    expect(textOf(runEvents([layer("a"), layer("b")], prompt("x"), act))).toBe(
      "x<b<a"
    )
    expect(runEvents([layer("a"), layer("b", true)], prompt("x"), act)).toBe(
      undefined
    )
    expect(seen).toEqual(["b", "a", "b"])
  })
})
