import { describe, expect, it } from "vitest"
import { createMessageQueue, type AppendMessage } from "@assistant-ui/react"

const appendMessage = (text: string, marker: string): AppendMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    metadata: { custom: { marker } },
  }) as unknown as AppendMessage

describe("message queue cancellation", () => {
  it("requires explicit resume and runs exactly one parked item", () => {
    const dispatched: AppendMessage[] = []
    const queue = createMessageQueue({
      run: async (message) => {
        dispatched.push(message)
      },
    })

    queue.adapter.enqueue(appendMessage("first", "first"))
    const second = appendMessage("second", "second")
    queue.adapter.enqueue(second)
    const secondId = queue.adapter.items[0]?.id

    queue.notifyCancelled()
    queue.notifyIdle()

    expect(dispatched).toHaveLength(1)
    expect(queue.adapter.items).toHaveLength(1)
    expect(secondId).toBeDefined()

    queue.adapter.move(secondId!, { lane: "steer", insertAfter: null })
    queue.adapter.edit(secondId!, appendMessage("edited", "edited"))
    queue.notifyIdle()
    expect(dispatched).toHaveLength(1)

    queue.adapter.enqueue(appendMessage("third", "third"))
    expect(dispatched).toHaveLength(1)

    ;(queue as unknown as { resume: (id: string) => void }).resume(secondId!)
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]).toMatchObject({
      content: [{ type: "text", text: "edited" }],
      metadata: { custom: { marker: "edited" } },
    })

    queue.notifyIdle()
    expect(dispatched).toHaveLength(2)
  })
})
