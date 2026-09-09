import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  RuntimeApprovalRequest,
  RuntimeInteractionAdapter,
} from "@/runtime-adapters/contracts"
import { RuntimeApprovalComposer } from "./approval-composer"

const request: RuntimeApprovalRequest = {
  kind: "approval",
  requestId: "permission-one",
  sessionId: "session-one",
  message: "Approve this native action?",
  options: [
    { label: "Allow for this session", value: "session" },
    { label: "Deny", value: "deny" },
  ],
}

describe("RuntimeApprovalComposer", () => {
  it("submits the provider-neutral option value", async () => {
    const interactions: RuntimeInteractionAdapter = {
      respond: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn(),
    }
    render(
      <RuntimeApprovalComposer
        locale="en"
        request={request}
        interactions={interactions}
        onResolved={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Allow for this session" })
    )

    await vi.waitFor(() =>
      expect(interactions.respond).toHaveBeenCalledWith(request, {
        kind: "approval",
        option: "session",
      })
    )
  })
})
