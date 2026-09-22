import { describe, expect, it } from "vitest"

import { projectTodos } from "./todos"

describe("projectTodos", () => {
  it("reads a native list whose rows carry content instead of a label", () => {
    expect(
      projectTodos({
        todos: [
          { id: "one", content: "Inspect the adapter", status: "completed" },
          { id: "two", label: "Write the test", status: "active" },
        ],
      })
    ).toEqual([
      { id: "one", label: "Inspect the adapter", status: "completed" },
      { id: "two", label: "Write the test", status: "active" },
    ])
  })

  it("names an identity-free row by its position so the list stays addressable", () => {
    expect(
      projectTodos({
        todos: [
          { content: "First", status: "completed" },
          { content: "Second", status: "pending" },
        ],
      })
    ).toEqual([
      { id: "0", label: "First", status: "completed" },
      { id: "1", label: "Second", status: "pending" },
    ])
  })

  it("maps a provider status onto the normalized vocabulary through its aliases", () => {
    expect(
      projectTodos(
        {
          todos: [
            { content: "Running", status: "in_progress" },
            { content: "Abandoned", status: "cancelled" },
            { content: "Waiting", status: "pending" },
            { content: "Done", status: "completed" },
          ],
        },
        { in_progress: "active", cancelled: "failed" }
      )
    ).toEqual([
      { id: "0", label: "Running", status: "active" },
      { id: "1", label: "Abandoned", status: "failed" },
      { id: "2", label: "Waiting", status: "pending" },
      { id: "3", label: "Done", status: "completed" },
    ])
  })

  it("reports an unrecognized or missing status as pending", () => {
    expect(
      projectTodos({
        todos: [
          { id: "unknown", content: "Unknown", status: "blocked" },
          { id: "absent", content: "Absent" },
          { id: "aliased", content: "Unaliased", status: "in_progress" },
        ],
      })
    ).toEqual([
      { id: "unknown", label: "Unknown", status: "pending" },
      { id: "absent", label: "Absent", status: "pending" },
      { id: "aliased", label: "Unaliased", status: "pending" },
    ])
  })

  it("reads a list the provider delivered as a JSON string", () => {
    expect(
      projectTodos(
        JSON.stringify({
          todos: [{ content: "Serialized", status: "pending" }],
        })
      )
    ).toEqual([{ id: "0", label: "Serialized", status: "pending" }])
  })

  it("reports no Todos at all for a payload that is not a Todo list", () => {
    expect(projectTodos(undefined)).toBeUndefined()
    expect(projectTodos("not json")).toBeUndefined()
    expect(projectTodos({ status: "ok" })).toBeUndefined()
    expect(projectTodos({ todos: "everything" })).toBeUndefined()
    expect(projectTodos([{ content: "Bare array" }])).toBeUndefined()
  })

  it("publishes an empty plan for an empty native list", () => {
    expect(projectTodos({ todos: [] })).toEqual([])
  })

  it("truncates a machine-sized list and drops duplicate and unusable rows", () => {
    const projected = projectTodos({
      todos: Array.from({ length: 5_000 }, (_unused, index) => ({
        id: `todo-${index}`,
        content: `Step ${index}`,
        status: "pending",
      })),
    })

    expect(projected).toHaveLength(256)
    expect(projected?.at(-1)).toEqual({
      id: "todo-255",
      label: "Step 255",
      status: "pending",
    })
    expect(
      projectTodos({
        todos: [
          { id: "same", content: "Kept", status: "pending" },
          { id: "same", content: "Dropped", status: "completed" },
          { id: "empty", content: "   ", status: "pending" },
          { id: "oversized", content: "x".repeat(4_097), status: "pending" },
          {
            id: "x".repeat(257),
            content: "Unbounded identity",
            status: "pending",
          },
        ],
      })
    ).toEqual([
      { id: "same", label: "Kept", status: "pending" },
      { id: "4", label: "Unbounded identity", status: "pending" },
    ])
  })
})
