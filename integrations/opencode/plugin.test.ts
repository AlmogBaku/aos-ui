// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { createAosUiPlugin, resolveConfiguredWorktree } from "./plugin"

function input(directory = "/external/worktree") {
  return {
    directory,
    worktree: directory,
    client: {
      app: {
        agents: vi.fn(async () => ({ data: [] })),
        log: vi.fn(async () => ({})),
      },
      session: {
        get: vi.fn(async () => ({ data: { agent: "researcher" } })),
        create: vi.fn(),
        promptAsync: vi.fn(),
      },
    },
  }
}

describe("packaged OpenCode plugin", () => {
  it("requires one explicit absolute external worktree", () => {
    expect(() => resolveConfiguredWorktree({})).toThrow(
      /AOS_UI_OPENCODE_WORKTREE/
    )
    expect(() =>
      resolveConfiguredWorktree({ AOS_UI_OPENCODE_WORKTREE: "relative/path" })
    ).toThrow(/absolute/i)
    expect(
      resolveConfiguredWorktree({
        AOS_UI_OPENCODE_WORKTREE: " /external/worktree ",
      })
    ).toBe("/external/worktree")
  })

  it("refuses to attach the privileged tools to another directory", async () => {
    await expect(
      createAosUiPlugin(
        input("/another/worktree") as never,
        "/external/worktree"
      )
    ).rejects.toThrow(/configured worktree/i)
  })

  it("registers native tools while retaining OpenCode-native interaction support", async () => {
    const hooks = await createAosUiPlugin(
      input() as never,
      "/external/worktree"
    )

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "create_agent",
      "present_artifact",
      "present_plan",
      "render_chart",
      "render_map",
      "render_stats",
      "start_session",
    ])
    expect(hooks).not.toHaveProperty("permission.ask")
    expect(hooks).not.toHaveProperty("event")
  })

  it("removes AOS Agent metadata from native model parameters", async () => {
    const hooks = await createAosUiPlugin(
      input() as never,
      "/external/worktree"
    )
    const output = {
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 2_048,
      options: {
        aos_ui_managed: true,
        aos_ui_name: "Live Probe",
        aos_ui_role: "creator",
        reasoningEffort: "low",
        providerExtension: { enabled: true },
      },
    }

    await hooks["chat.params"]?.(
      {
        sessionID: "session-probe",
        agent: "probe",
        model: {} as never,
        provider: {} as never,
        message: {} as never,
      },
      output
    )

    expect(output.options).toEqual({
      reasoningEffort: "low",
      providerExtension: { enabled: true },
    })
    expect(output).toMatchObject({
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 2_048,
    })
  })

  it("enforces shared semantic presentation validation before returning display output", async () => {
    const hooks = await createAosUiPlugin(
      input() as never,
      "/external/worktree"
    )
    const chart = hooks.tool?.render_chart
    if (!chart) throw new Error("Missing chart tool")

    await expect(
      chart.execute(
        {
          title: "Invalid pie",
          type: "pie",
          xKey: "label",
          series: [
            { key: "one", label: "One" },
            { key: "two", label: "Two" },
          ],
          data: [{ label: "A", one: 1, two: 2 }],
        },
        {} as never
      )
    ).rejects.toThrow()
  })

  it("injects conservative native guidance without Monty instructions by default", async () => {
    const hooks = await createAosUiPlugin(
      input() as never,
      "/external/worktree"
    )
    const output = { system: [] as string[] }

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: {} as never },
      output
    )

    expect(output.system.join("\n")).toContain("AOS presentation harness:")
    expect(output.system.join("\n")).not.toContain("Monty sandbox guidance")
  })
})
