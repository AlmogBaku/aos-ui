import { describe, expect, it, vi } from "vitest"

import {
  createAppFileCalls,
  readablePath,
  servesFiles,
  type AppFileVerdict,
  type AppFolderSet,
} from "./app-files"
import { providerSessionId, sessionId } from "./ids"
import type { ServerMcpApps } from "./runtime"

const AGENT = "/srv/agent"

/** A folder set that serves the Agent folder unless told otherwise. */
function folders(overrides: Partial<AppFolderSet> = {}): AppFolderSet {
  return { agentFolder: true, allow: [], deny: [], ...overrides }
}

/** What a guest gets until configured. */
const unconfigured = folders({ agentFolder: false })

describe("app file folder rules", () => {
  it.each<[string, AppFolderSet[], string | undefined, string, boolean]>([
    [
      "a file in the Agent folder",
      [folders()],
      AGENT,
      "/srv/agent/report.pdf",
      true,
    ],
    [
      "a file in an allow folder",
      [folders({ allow: ["/srv/shared/"] })],
      AGENT,
      "/srv/shared/plan.pdf",
      true,
    ],
    [
      "a file outside both",
      [folders({ allow: ["/srv/shared"] })],
      AGENT,
      "/srv/other/plan.pdf",
      false,
    ],
    [
      "a sibling that shares the folder's prefix",
      [folders()],
      AGENT,
      "/srv/agent-evil/x",
      false,
    ],
    [
      "an Agent folder reported with a trailing slash",
      [folders()],
      `${AGENT}/`,
      "/srv/agent/report.pdf",
      true,
    ],
    [
      "the Agent folder when the runtime reports none",
      [folders({ allow: ["/srv/shared"] })],
      undefined,
      "/srv/agent/report.pdf",
      false,
    ],
    [
      "an allow folder when the runtime reports no Agent folder",
      [folders({ allow: ["/srv/shared"] })],
      undefined,
      "/srv/shared/plan.pdf",
      true,
    ],
    [
      "a denied folder named in another case",
      [folders({ deny: ["/srv/agent/Private"] })],
      AGENT,
      "/srv/agent/private/x.pdf",
      false,
    ],
    ["an SSH folder", [folders()], AGENT, "/srv/agent/.ssh/config", false],
    [
      "an SSH folder in capitals",
      [folders()],
      AGENT,
      "/srv/agent/.SSH/config",
      false,
    ],
    ["an environment file", [folders()], AGENT, "/srv/agent/.env", false],
    ["an SSH key", [folders()], AGENT, "/srv/agent/keys/id_ed25519", false],
    [
      "a certificate in capitals",
      [folders()],
      AGENT,
      "/srv/agent/certs/server.PEM",
      false,
    ],
    [
      "a CLI's credentials folder",
      [folders()],
      AGENT,
      "/srv/agent/.config/gh/hosts.yml",
      false,
    ],
    [
      "a built-in denial that an allow folder names",
      [folders({ allow: ["/srv/agent/.ssh"] })],
      AGENT,
      "/srv/agent/.ssh/config",
      false,
    ],
    [
      "a name that only resembles a key",
      [folders()],
      AGENT,
      "/srv/agent/id_card.pdf",
      true,
    ],
    [
      "another tool's config folder",
      [folders()],
      AGENT,
      "/srv/agent/.config/nvim/init.lua",
      true,
    ],
    [
      "a guest's file by default",
      [unconfigured, folders()],
      AGENT,
      "/srv/agent/report.pdf",
      false,
    ],
    [
      "a guest's file once guests get the Agent folder",
      [folders(), folders()],
      AGENT,
      "/srv/agent/report.pdf",
      true,
    ],
    [
      "a guest's file the operator allows and the guest set denies",
      [folders({ deny: ["/srv/agent/private"] }), folders()],
      AGENT,
      "/srv/agent/private/x.pdf",
      false,
    ],
    [
      "a guest allow folder outside the operator set",
      [folders({ agentFolder: false, allow: ["/srv/guest"] }), folders()],
      AGENT,
      "/srv/guest/x.pdf",
      false,
    ],
  ])("judges %s", async (_, sets, agentFolder, path, allowed) => {
    expect(await readablePath(sets, agentFolder, path)).toEqual(
      allowed ? { ok: true, path } : { ok: false, reason: "denied" }
    )
  })

  it.each<[string, string, string | undefined, AppFileVerdict]>([
    [
      "inside the Agent folder",
      "/srv/agent/link.pdf",
      "/srv/agent/data/report.pdf",
      { ok: true, path: "/srv/agent/data/report.pdf" },
    ],
    [
      "outside the Agent folder",
      "/srv/agent/link.pdf",
      "/srv/other/report.pdf",
      { ok: false, reason: "real_path_denied" },
    ],
    [
      "denied",
      "/srv/agent/link.pdf",
      "/srv/agent/.ssh/id_rsa",
      { ok: false, reason: "real_path_denied" },
    ],
    [
      "unknown",
      "/srv/agent/link.pdf",
      undefined,
      { ok: false, reason: "real_path_unknown" },
    ],
    [
      "relative",
      "/srv/agent/link.pdf",
      "data/report.pdf",
      { ok: false, reason: "real_path_unknown" },
    ],
    [
      "inside, from a written path outside",
      "/srv/other/link.pdf",
      "/srv/agent/report.pdf",
      { ok: false, reason: "denied" },
    ],
  ])(
    "reads a path whose real path is %s only when both pass",
    async (_, written, real, verdict) => {
      const realPath = async (path: string) =>
        path === written ? real : undefined

      expect(await readablePath([folders()], AGENT, written, realPath)).toEqual(
        verdict
      )
    }
  )

  it.each<[string, AppFolderSet[], string | undefined, boolean]>([
    ["the Agent folder", [folders()], AGENT, true],
    [
      "an allow folder alone",
      [folders({ allow: ["/srv/shared"] })],
      undefined,
      true,
    ],
    ["no folder at all", [folders()], undefined, false],
    ["an unconfigured guest", [unconfigured, folders()], AGENT, false],
  ])("offers addresses from %s: %s", (_, sets, agentFolder, offered) => {
    expect(servesFiles(sets, agentFolder)).toBe(offered)
  })
})

describe("app file calls", () => {
  it("asks the runtime once per call, forgets the oldest past its bound, and asks again after a miss", async () => {
    const toolCall = vi.fn<NonNullable<ServerMcpApps["toolCall"]>>(
      async (_scope, toolCallId) =>
        toolCallId === "call-missing"
          ? undefined
          : {
              server: "aos-ui",
              tool: "present_artifact",
              input: { path: "/srv/agent/report.pdf", pages: 3 },
            }
    )
    const apps = { toolCall } as unknown as ServerMcpApps
    const scope = {
      agentId: "researcher",
      providerSessionId: providerSessionId("stored"),
      sessionId: sessionId("stored"),
    }
    const calls = createAppFileCalls(1)

    const first = await calls.lookup(apps, scope, "call-1")
    expect(first).toEqual({
      server: "aos-ui",
      servable: new Map([["path", "/srv/agent/report.pdf"]]),
    })
    expect(await calls.lookup(apps, scope, "call-1")).toBe(first)
    expect(toolCall).toHaveBeenCalledTimes(1)

    // Room for one call: a second one pushes the first out.
    await calls.lookup(apps, scope, "call-2")
    await calls.lookup(apps, scope, "call-1")
    expect(toolCall).toHaveBeenCalledTimes(3)

    // A call not stored yet may be stored by the next request.
    expect(await calls.lookup(apps, scope, "call-missing")).toBeUndefined()
    await calls.lookup(apps, scope, "call-missing")
    expect(toolCall).toHaveBeenCalledTimes(5)
  })
})
