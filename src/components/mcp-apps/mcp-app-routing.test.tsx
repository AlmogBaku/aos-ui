import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AosToolPresentation,
  isAosRichTool,
  type RichToolPart,
} from "@/components/tool-ui"
import type { McpAppAdapter } from "@/runtime-adapters/contracts"

import { McpAppHostProvider } from "./mcp-app-host"
import type { McpAppFrameProps } from "./mcp-app-frame"
import { MCP_APP_TOOL_ARTIFACT, mcpAppToolArtifact } from "./tool-part"

const frames = vi.hoisted(() => [] as McpAppFrameProps[])
vi.mock("./mcp-app-frame", () => ({
  default: (props: McpAppFrameProps) => {
    frames.push(props)
    return <iframe title={props.title} />
  },
}))

afterEach(() => {
  cleanup()
  frames.length = 0
})

const lastFrame = () => frames.at(-1)

function toolPart(
  overrides: Partial<RichToolPart> & Pick<RichToolPart, "toolName">
): RichToolPart {
  const args = overrides.args ?? {}
  return {
    type: "tool-call",
    toolCallId: `call-${overrides.toolName}`,
    args,
    argsText: JSON.stringify(args),
    status: { type: "complete" },
    result: "done",
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function adapter(
  open: McpAppAdapter["open"] = async () => ({ html: "<p>app</p>" })
) {
  return {
    open: vi.fn(open),
    callTool: vi.fn(),
    readResource: vi.fn(),
  } satisfies McpAppAdapter
}

function renderHosted(part: RichToolPart, apps: McpAppAdapter | undefined) {
  return render(
    <McpAppHostProvider
      adapter={apps}
      agentId="researcher"
      threadId="session-1"
    >
      <AosToolPresentation {...part} />
    </McpAppHostProvider>
  )
}

describe("MCP App routing", () => {
  it("counts an App-flagged call as rich content", () => {
    expect(
      isAosRichTool(
        toolPart({ toolName: "show_board", artifact: MCP_APP_TOOL_ARTIFACT })
      )
    ).toBe(true)
    expect(isAosRichTool(toolPart({ toolName: "show_board" }))).toBe(false)
  })

  it("hosts the App above the call's own inspectable details", async () => {
    const apps = adapter()
    renderHosted(
      toolPart({ toolName: "show_board", artifact: MCP_APP_TOOL_ARTIFACT }),
      apps
    )
    expect(await screen.findByTitle("show_board app")).toBeInTheDocument()
    expect(apps.open).toHaveBeenCalledWith(
      {
        agentId: "researcher",
        threadId: "session-1",
        toolCallId: "call-show_board",
      },
      expect.any(AbortSignal)
    )
    expect(screen.getByRole("button", { name: /show_board/ })).toBeVisible()
  })

  it("hosts a settled call that carries neither input nor result", async () => {
    // A guest receives an App call as its id, name, status, and flag alone.
    const apps = adapter()
    renderHosted(
      toolPart({
        toolName: "show_board",
        artifact: mcpAppToolArtifact({ input: false, settled: true }),
        result: undefined,
      }),
      apps
    )
    expect(await screen.findByTitle("show_board app")).toBeInTheDocument()
    expect(apps.open).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: /show_board/ })).toBeNull()
  })

  it("mounts a running call's view at once and completes it at settle", async () => {
    const result = { content: [{ type: "text" as const, text: "done" }] }
    let settled = false
    const apps = adapter(async () =>
      settled
        ? {
            html: "<p>app</p>",
            toolInput: { board: "launch" },
            toolResult: result,
          }
        : { html: "<p>app</p>" }
    )
    const running = toolPart({
      toolName: "show_board",
      args: {},
      argsText: "",
      artifact: MCP_APP_TOOL_ARTIFACT,
      result: undefined,
      status: { type: "running" },
    })
    const { rerender } = renderHosted(running, apps)
    expect(await screen.findByTitle("show_board app")).toBeInTheDocument()
    expect(lastFrame()?.input).toBeUndefined()
    expect(lastFrame()?.result).toBeUndefined()

    const args = { board: "launch" }
    const withInput = {
      ...running,
      args,
      argsText: JSON.stringify(args),
      artifact: mcpAppToolArtifact({ input: true, settled: false }),
    }
    rerender(
      <McpAppHostProvider
        adapter={apps}
        agentId="researcher"
        threadId="session-1"
      >
        <AosToolPresentation {...withInput} />
      </McpAppHostProvider>
    )
    expect(lastFrame()?.input).toEqual(args)
    expect(apps.open).toHaveBeenCalledOnce()

    settled = true
    rerender(
      <McpAppHostProvider
        adapter={apps}
        agentId="researcher"
        threadId="session-1"
      >
        <AosToolPresentation
          {...withInput}
          result="done"
          status={{ type: "complete" }}
          artifact={mcpAppToolArtifact({ input: true, settled: true })}
        />
      </McpAppHostProvider>
    )
    await waitFor(() => expect(lastFrame()?.result).toEqual(result))
    expect(apps.open).toHaveBeenCalledTimes(2)
    const views = new Set(frames.map((frame) => frame.view))
    expect(views.size).toBe(1)
  })

  it("says the App is unavailable and keeps the call when the view fails", async () => {
    const apps = adapter(async () => {
      throw new Error("gone")
    })
    renderHosted(
      toolPart({ toolName: "show_board", artifact: MCP_APP_TOOL_ARTIFACT }),
      apps
    )
    expect(
      await screen.findByRole("status", {
        name: /The app could not be shown\./,
      })
    ).toBeVisible()
    expect(screen.getByRole("button", { name: /show_board/ })).toBeVisible()
  })

  it.each([
    ["an unflagged call", { toolName: "show_board" }, true],
    [
      "a flagged call with no App host",
      { toolName: "show_board", artifact: MCP_APP_TOOL_ARTIFACT },
      false,
    ],
  ])("falls back to the ordinary call for %s", (_label, overrides, hosted) => {
    const apps = adapter()
    renderHosted(toolPart(overrides), hosted ? apps : undefined)
    expect(apps.open).not.toHaveBeenCalled()
    expect(screen.queryByTitle("show_board app")).toBeNull()
    expect(screen.getByRole("button", { name: /show_board/ })).toBeVisible()
  })
})
