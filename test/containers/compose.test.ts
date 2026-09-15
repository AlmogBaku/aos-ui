// @vitest-environment node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type ComposeConfig = {
  configs?: Record<string, { file?: string }>
  secrets?: Record<string, { file?: string }>
  services: Record<
    string,
    {
      build?: { target?: string }
      command?: string[]
      depends_on?: Record<string, { condition: string }>
      environment?: Record<string, string>
      expose?: string[]
      ports?: Array<{ host_ip?: string; published?: string; target: number }>
      configs?: Array<{ source: string; target: string }>
      secrets?: Array<{ source: string; target: string }>
      volumes?: Array<{ source: string; target: string; type: string }>
    }
  >
}

const root = resolve(import.meta.dirname, "../..")

function composeConfig(
  files: string[],
  overrides: Record<string, string> = {}
) {
  const args = ["compose"]
  for (const file of files) args.push("-f", file)
  args.push("config", "--format", "json")
  return JSON.parse(
    execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV ?? "test",
        PATH: process.env.PATH,
        AOS_UI_OPENCODE_WORKTREE: root,
        ...overrides,
      },
    })
  ) as ComposeConfig
}

describe("container orchestration", () => {
  it("keeps the Hermes browser configuration credential-free", () => {
    const runtime = JSON.parse(
      readFileSync(resolve(root, "deploy/runtime-config.hermes.json"), "utf8")
    ) as Record<string, unknown>
    expect(runtime).toEqual({ mode: "aos" })
    expect(JSON.stringify(runtime).toLowerCase()).not.toMatch(
      /token|secret|password|authorization|hermes\.baseurl/u
    )
  })

  it("ships the V1 Hermes proxy example with one runtime credential", () => {
    const proxy = JSON.parse(
      readFileSync(
        resolve(root, "deploy/proxy-config.hermes.example.json"),
        "utf8"
      )
    ) as {
      deploymentId: string
      listen: { host: string; port: number; exposure: string }
      runtime: {
        id: string
        kind: string
        baseUrl: string
        tokenFile: string
        sessionIdleMs: number
      }
      events: { keys: Array<{ secretFile: string }> }
      guest: {
        listen: { host: string; port: number; exposure: string }
        publicOrigin: string
        invitations: { keys: Array<{ secretFile: string }> }
      }
      limits: Record<string, number>
    }
    expect(proxy.deploymentId).toBe("aos-hermes-local")
    expect(proxy.listen).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      exposure: "private-container",
    })
    expect(proxy.runtime).toEqual({
      id: "hermes-default",
      kind: "hermes",
      baseUrl: "http://host.docker.internal:9119",
      tokenFile: "/run/secrets/hermes-token",
      sessionIdleMs: 300_000,
    })
    expect(proxy.guest).toMatchObject({
      listen: { host: "0.0.0.0", port: 3001, exposure: "private-container" },
      publicOrigin: "http://127.0.0.1:3001",
    })
    expect(proxy.guest.invitations.keys[0]!.secretFile).toBe(
      "/run/secrets/guest-invite-signing-key"
    )
    expect(proxy.events.keys[0].secretFile).toMatch(/^\/run\/secrets\//u)
    expect(proxy.limits).toMatchObject({
      activeExecutions: 256,
      guestActiveExecutions: 32,
      operatorEventPeers: 256,
      guestEventPeers: 64,
      guestEventPeersPerInvitation: 4,
    })
    expect(proxy).not.toHaveProperty("operator")
    expect(proxy.guest).not.toHaveProperty("hermes")
    expect(JSON.stringify(proxy).toLowerCase()).not.toMatch(
      /oidc|browser-broker|operator-session|guest-hermes-token/u
    )
  })

  it("keeps the base composition web-only and loopback-only", () => {
    const config = composeConfig(["compose.yaml"])

    expect(Object.keys(config.services)).toEqual(["web"])
    expect(config.services.web.ports).toContainEqual(
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "3000",
        target: 3000,
      })
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.json")
    )
  })

  it("adds OpenCode only through the explicit engine overlay", () => {
    const config = composeConfig(["compose.yaml", "compose.opencode.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.opencode.json"
      ),
    })

    expect(Object.keys(config.services).sort()).toEqual(["opencode", "web"])
    expect(config.services.web.depends_on?.opencode.condition).toBe(
      "service_healthy"
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.opencode.json")
    )
    expect(config.services.opencode.environment).toMatchObject({
      AOS_UI_OPENCODE_WORKTREE: "/workspace",
    })
    expect(JSON.stringify(config)).not.toContain("AOS_GATEWAY_")
  })

  it("does not package the deleted Go gateway in the OpenCode runtime image", () => {
    const dockerfile = readFileSync(
      resolve(root, "Dockerfile.opencode"),
      "utf8"
    )

    expect(dockerfile).not.toContain("golang:")
    expect(dockerfile).not.toContain("gateway/")
    expect(dockerfile).not.toContain("aos-gateway")
  })

  it("runs the private AOS proxy as the web service for Hermes", () => {
    const config = composeConfig(["compose.yaml", "compose.hermes.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.hermes.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy-config.hermes.example.json"
      ),
      AOS_UI_HERMES_TOKEN_FILE: resolve(root, ".env.example"),
      AOS_UI_RECONNECT_CURSOR_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
    })

    expect(Object.keys(config.services)).toEqual(["web"])
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_STATIC_ROOT: "/app/dist",
      AOS_UI_RUNTIME_CONFIG_FILE: "/run/aos-ui/runtime-config.json",
      AOS_UI_WEB_PORT: "3000",
    })
    expect(config.services.web.build?.target).toBe("proxy")
    expect(config.services.web.command).toEqual([
      "bun",
      "run",
      "proxy:serve",
      "--",
      "--config",
      "/run/aos-ui/proxy-config.json",
    ])
    expect(config.services.web.ports).toContainEqual(
      expect.objectContaining({ published: "3000", target: 3000 })
    )
    expect(config.services.web.ports).toContainEqual(
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "3001",
        target: 3001,
      })
    )
    expect(config.services.web.configs).toContainEqual(
      expect.objectContaining({
        source: "proxy-config",
        target: "/run/aos-ui/proxy-config.json",
      })
    )
    expect(config.services.web.secrets).toEqual([
      expect.objectContaining({
        source: "hermes-token",
        target: "hermes-token",
      }),
      expect.objectContaining({
        source: "reconnect-cursor-key",
        target: "reconnect-cursor-key",
      }),
      expect.objectContaining({
        source: "guest-invite-signing-key",
        target: "guest-invite-signing-key",
      }),
    ])
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.hermes.json")
    )
    expect(config.configs?.["proxy-config"]?.file).toBe(
      resolve(root, "deploy/proxy-config.hermes.example.json")
    )
    expect(config.secrets?.["hermes-token"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(config.secrets?.["reconnect-cursor-key"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(config.secrets?.["guest-invite-signing-key"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(Object.keys(config.secrets ?? {}).sort()).toEqual([
      "guest-invite-signing-key",
      "hermes-token",
      "reconnect-cursor-key",
    ])
    expect(JSON.stringify(config.services.web.environment)).not.toMatch(
      /HERMES|TOKEN|OIDC|SECRET/u
    )
  })

  it("keeps the planned OpenClaw overlay fail-closed", () => {
    const config = composeConfig(["compose.yaml", "compose.openclaw.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.openclaw.json"
      ),
    })

    expect(Object.keys(config.services)).toEqual(["web"])
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_OPENCLAW_HOST"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_OPENCLAW_PORT"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_GATEWAY_OPENCLAW_TOKEN"
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.openclaw.json")
    )
    expect(
      JSON.parse(
        readFileSync(
          resolve(root, "deploy/runtime-config.openclaw.json"),
          "utf8"
        )
      )
    ).toEqual({ status: "unavailable", reason: "invalid-runtime-mode" })
  })

  it("uses the Vite development target and source mount", () => {
    const config = composeConfig(["compose.yaml", "compose.dev.yaml"])
    const web = config.services.web

    expect(web.command).toEqual([
      "bun",
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
    ])
    expect(web.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: root, target: "/app", type: "bind" }),
        expect.objectContaining({
          target: "/app/node_modules",
          type: "volume",
        }),
      ])
    )
    expect(web.environment).toMatchObject({
      AOS_UI_RUNTIME_CONFIG_FILE: "/run/aos-ui/runtime-config.json",
    })
  })

  it("builds static assets into the Bun proxy image", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")

    expect(dockerfile).toContain("FROM dependencies AS proxy")
    expect(dockerfile).toContain("COPY --from=builder")
    expect(dockerfile).toContain('CMD ["bun", "run", "static:serve"]')
    expect(dockerfile).toContain("USER bun")
    expect(dockerfile).toContain("/app/dist")
    expect(
      readFileSync(resolve(root, "packages/proxy/static.ts"), "utf8")
    ).toContain("/runtime-config.json")
  })

  it("packages the Bun proxy as a dedicated non-root image target", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")

    expect(dockerfile).toMatch(/FROM dependencies AS proxy/)
    expect(dockerfile).toContain('CMD ["bun", "run", "static:serve"]')
    expect(dockerfile).toContain("USER bun")
  })
})
