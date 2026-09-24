import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AgentTile } from "@/components/agent-icons/agent-tile"

describe("AgentTile", () => {
  it.each([
    ["a pool token", <AgentTile key="pool" avatar="ring/blue" running />],
    ["an unknown token", <AgentTile key="unknown" avatar="future/shape" />],
    ["the draft tile", <AgentTile key="draft" variant="draft" />],
    ["the hidden tile", <AgentTile key="hidden" variant="hidden" />],
  ])("keeps %s out of the accessibility tree", (_, tile) => {
    const { container } = render(
      <button type="button">{tile}Researcher</button>
    )
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull()
    expect(container.querySelector("button")).toHaveAccessibleName("Researcher")
  })
})
