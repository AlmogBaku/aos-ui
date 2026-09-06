// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createManagementHandler,
  createManagementProvider,
  startManagementServer,
} from "./opencode-management"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aos-ui-management-test-"))
  await mkdir(join(root, ".opencode", "agents"), { recursive: true })
  const file = join(root, ".opencode", "agents", "managed.md")
  await writeFile(
    file,
    '---\nmode: primary\naos_ui_name: "Managed"\n---\n\nPrompt.\n'
  )
  let hidden = false
  const agent = () => ({
    name: "managed",
    mode: "primary" as const,
    native: false,
    hidden,
    options: { aos_ui_name: "Managed" },
  })
  const provider = {
    agents: vi.fn(async () => [agent()]),
    isActive: vi.fn(async () => false),
    reload: vi.fn(async () => {
      hidden = (await readFile(file, "utf8")).includes("hidden: true")
    }),
  }
  const handle = createManagementHandler({
    worktree: root,
    origins: ["http://localhost:3000"],
    provider,
  })
  const request = (
    body: unknown = { visibility: "hidden", expectedVisibility: "visible" },
    headers: Record<string, string> = {}
  ) =>
    new Request("http://localhost:4097/agents/managed/visibility", {
      method: "PATCH",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  return { handle, request, provider, file, root }
}

describe("OpenCode management service", () => {
  it("serves only the bounded API and validates preflight", async () => {
    const { handle, request, provider } = await fixture()
    const preflight = new Request(request().url, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    })
    const response = await handle(preflight)
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000"
    )
    expect(
      (
        await handle(
          new Request(request().url, {
            method: "DELETE",
            headers: { origin: "http://localhost:3000" },
          })
        )
      ).status
    ).toBe(405)
    expect(
      (await handle(new Request(request().url, { method: "PATCH" }))).status
    ).toBe(403)
    expect(
      (await handle(request({ visibility: "x".repeat(600) }))).status
    ).toBe(413)
    expect(provider.agents).not.toHaveBeenCalled()
  })

  it("serializes in-flight changes instead of racing the reload", async () => {
    const { handle, request, provider } = await fixture()
    let release!: () => void
    provider.isActive.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return false
    })
    const first = handle(request())
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    expect((await handle(request())).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
  })

  it("bounds provider failures without disclosing filesystem paths", async () => {
    const { handle, request, provider } = await fixture()
    provider.agents.mockRejectedValue(
      new Error("Secret /private/credential/path")
    )
    const response = await handle(request())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("credential")
  })

  it("starts a real listener and releases it on close", async () => {
    const { root, provider } = await fixture()
    const server = await startManagementServer({
      host: "127.0.0.1",
      port: 0,
      worktree: root,
      origins: ["http://localhost:3000"],
      provider,
    })
    const address = server.address
    const health = await fetch(`http://127.0.0.1:${address.port}/health`)
    expect(await health.json()).toEqual({ status: "ok" })
    await server.close()
    await expect(
      fetch(`http://127.0.0.1:${address.port}/health`)
    ).rejects.toThrow()
  })

  it("treats pending provider questions as active and rejects malformed status data", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname
        return Response.json(
          path === "/question"
            ? [{ id: "pending" }]
            : path === "/permission"
              ? []
              : {}
        )
      })
    try {
      const provider = createManagementProvider(
        "http://provider.test",
        "/workspace"
      )
      expect(await provider.isActive()).toBe(true)
      fetcher.mockResolvedValue(Response.json(null))
      await expect(provider.isActive()).rejects.toThrow()
    } finally {
      fetcher.mockRestore()
    }
  })
  it("persists only after idle preflight and confirms authoritative readback", async () => {
    const { handle, request, provider } = await fixture()
    const response = await handle(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      agentId: "managed",
      visibility: "hidden",
    })
    expect(provider.isActive).toHaveBeenCalledTimes(2)
    expect(provider.reload).toHaveBeenCalledOnce()
  })

  it("rejects activity before touching the definition", async () => {
    const { handle, request, provider, file } = await fixture()
    provider.isActive.mockResolvedValue(true)
    expect((await handle(request())).status).toBe(409)
    expect(await readFile(file, "utf8")).not.toContain("hidden:")
    expect(provider.reload).not.toHaveBeenCalled()
  })

  it("recovers a persisted pending reload on the same visibility request", async () => {
    const { handle, request, provider } = await fixture()
    provider.isActive.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const pending = await handle(request())
    expect(pending.status).toBe(409)
    expect(await pending.json()).toMatchObject({
      code: "pending-reload",
      retryable: true,
    })
    expect(provider.reload).not.toHaveBeenCalled()
    expect((await handle(request())).status).toBe(200)
    expect(provider.reload).toHaveBeenCalledOnce()
  })

  it("rejects stale selection and read-only provider Agents", async () => {
    const { handle, request, provider } = await fixture()
    expect(
      (
        await handle(
          request({ visibility: "hidden", expectedVisibility: "hidden" })
        )
      ).status
    ).toBe(409)
    provider.agents.mockResolvedValue([
      {
        name: "managed",
        mode: "primary",
        native: true,
        hidden: false,
        options: { aos_ui_name: "Managed" },
      },
    ])
    expect((await handle(request())).status).toBe(403)
    expect(provider.reload).not.toHaveBeenCalled()
  })

  it("reports provider readback drift as an error", async () => {
    const { handle, request, provider } = await fixture()
    provider.reload.mockResolvedValue(undefined)
    const response = await handle(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "readback-failed" })
  })

  it.each([
    [{ visibility: "bad", expectedVisibility: "visible" }, {}, 400],
    [
      {
        visibility: "hidden",
        expectedVisibility: "visible",
        prompt: "overwrite",
      },
      {},
      400,
    ],
    [
      { visibility: "hidden", expectedVisibility: "visible" },
      { origin: "https://evil.test" },
      403,
    ],
    [
      { visibility: "hidden", expectedVisibility: "visible" },
      { "content-type": "text/plain" },
      415,
    ],
  ])(
    "validates requests before accessing the provider",
    async (body, headers, status) => {
      const { handle, request, provider } = await fixture()
      expect((await handle(request(body, headers))).status).toBe(status)
      expect(provider.agents).not.toHaveBeenCalled()
    }
  )
})
