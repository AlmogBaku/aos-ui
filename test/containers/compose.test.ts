// @vitest-environment node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"

import { parseProxyConfig } from "../../packages/proxy/config"

type ComposeConfig = {
  configs?: Record<string, { file?: string }>
  secrets?: Record<
    string,
    { file?: string; mode?: string; uid?: string; gid?: string }
  >
  services: Record<
    string,
    {
      build?: { target?: string }
      command?: string[]
      depends_on?: Record<string, { condition: string }>
      healthcheck?: { test?: string[] }
      environment?: Record<string, string>
      expose?: string[]
      extra_hosts?: string[]
      ports?: Array<{ host_ip?: string; published?: string; target: number }>
      user?: string
      configs?: Array<{ source: string; target: string; mode?: string }>
      secrets?: Array<{
        source: string
        target: string
        mode?: string
        uid?: string
        gid?: string
      }>
      volumes?: Array<{ source: string; target: string; type: string }>
    }
  >
}

const root = resolve(import.meta.dirname, "../..")

// Each overlay and environment variant renders once per file; tests that ask
// for the same variant share its result and must not mutate it.
const rendered = new Map<string, ComposeConfig>()

function composeConfig(
  files: string[],
  overrides: Record<string, string> = {}
) {
  const key = JSON.stringify([files, overrides])
  let config = rendered.get(key)
  if (!config) {
    config = renderComposeConfig(files, overrides)
    rendered.set(key, config)
  }
  return config
}

function renderComposeConfig(
  files: string[],
  overrides: Record<string, string>
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

  it.each(["runtime-config.opencode.json", "runtime-config.openclaw.json"])(
    "keeps %s provider-neutral and credential-free",
    (filename) => {
      const runtime = JSON.parse(
        readFileSync(resolve(root, "deploy", filename), "utf8")
      ) as Record<string, unknown>
      expect(runtime.mode).toBe("aos")
      expect(JSON.stringify(runtime).toLowerCase()).not.toMatch(
        /opencode|openclaw|hermes|baseurl|directory|token|secret|password|authorization/u
      )
    }
  )

  it.each([
    "proxy.hermes.example.yaml",
    "proxy.openclaw.example.yaml",
    "proxy.opencode.example.yaml",
  ])("ships %s as a loadable proxy configuration without push", (filename) => {
    const proxy: unknown = parse(
      readFileSync(resolve(root, "deploy", filename), "utf8")
    )
    expect(() => parseProxyConfig(proxy)).not.toThrow()
    expect(proxy).not.toHaveProperty("push")
  })

  it("points the Hermes proxy example at the mounted credentials", () => {
    const proxy = parse(
      readFileSync(resolve(root, "deploy/proxy.hermes.example.yaml"), "utf8")
    ) as {
      runtime: { tokenFile: string }
      guest: { invitations: { keys: Array<{ secretFile: string }> } }
      mcpApps: unknown
    }
    expect(proxy.runtime.tokenFile).toBe("/run/secrets/hermes-token")
    expect(proxy.guest.invitations.keys[0]!.secretFile).toBe(
      "/run/secrets/guest-invite-signing-key"
    )
    // Hermes registers the host's loopback URL; the container overrides it.
    expect(proxy.mcpApps).toEqual({
      fallback: { servers: { "aos-ui": { url: "http://tools-mcp:4110/mcp" } } },
    })
  })

  it("keeps the base composition web plus tools MCP and loopback-only", () => {
    const config = composeConfig(["compose.yaml"])

    expect(Object.keys(config.services).sort()).toEqual(["tools-mcp", "web"])
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

  it("publishes the tools MCP server on loopback only, with a health check", () => {
    const toolsMcp = composeConfig(["compose.yaml"]).services["tools-mcp"]!

    expect(toolsMcp.build?.target).toBe("tools-mcp")
    expect(toolsMcp.ports).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "4110",
        target: 4110,
      }),
    ])
    expect(toolsMcp.healthcheck?.test?.join(" ")).toContain(
      "http://127.0.0.1:4110/health"
    )
    expect(
      composeConfig(["compose.yaml"], {
        AOS_UI_BIND_ADDRESS: "0.0.0.0",
        AOS_UI_TOOLS_MCP_PORT: "4999",
      }).services["tools-mcp"]!.ports
    ).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "4999",
        target: 4110,
      }),
    ])
  })

  it("adds OpenCode only through the explicit engine overlay", () => {
    const config = composeConfig(["compose.yaml", "compose.opencode.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.opencode.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy.opencode.example.yaml"
      ),
      AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_OPENCODE_PASSWORD_FILE: resolve(root, ".env.example"),
      AOS_UI_HOST_UID: "1234",
      AOS_UI_HOST_GID: "2345",
    })

    expect(Object.keys(config.services).sort()).toEqual([
      "opencode",
      "tools-mcp",
      "web",
    ])
    expect(config.services.web.depends_on?.opencode.condition).toBe(
      "service_healthy"
    )
    expect(config.services.web.user).toBe("1234:2345")
    expect(config.services.web.secrets).toEqual([
      expect.objectContaining({
        source: "opencode-password",
        target: "opencode-password",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
      expect.objectContaining({
        source: "guest-invite-signing-key",
        target: "guest-invite-signing-key",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
    ])
    expect(config.services.opencode.depends_on?.["tools-mcp"]?.condition).toBe(
      "service_healthy"
    )
    expect(config.services.opencode.expose).toEqual(["4096"])
    expect(config.services.opencode.ports).toBeUndefined()
    expect(config.services.opencode.environment).not.toHaveProperty(
      "AOS_UI_OPENCODE_CORS_ORIGINS"
    )
    expect(config.services.opencode.environment).not.toHaveProperty(
      "AOS_UI_OPENCODE_PUBLISHED_PORT"
    )
    expect(config.services.opencode.secrets).toEqual([
      expect.objectContaining({
        source: "opencode-password",
        target: "opencode-password",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
    ])
    const proxy = parse(
      readFileSync(resolve(root, "deploy/proxy.opencode.example.yaml"), "utf8")
    ) as { runtime: Record<string, unknown> }
    expect(proxy.runtime.passwordFile).toBe("/run/secrets/opencode-password")
    expect(JSON.stringify(config)).not.toContain("AOS_GATEWAY_")
  })

  it("runs the private AOS proxy as the web service for Hermes", () => {
    const config = composeConfig(["compose.yaml", "compose.hermes.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.hermes.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy.hermes.example.yaml"
      ),
      AOS_UI_HERMES_TOKEN_FILE: resolve(root, ".env.example"),
      AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_HOST_UID: "1234",
      AOS_UI_HOST_GID: "2345",
    })

    expect(Object.keys(config.services).sort()).toEqual(["tools-mcp", "web"])
    expect(config.services.web.user).toBe("1234:2345")
    expect(config.services.web.build?.target).toBe("proxy")
    expect(config.services.web.ports).toContainEqual(
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "3001",
        target: 3001,
      })
    )
    expect(config.services.web.secrets).toEqual([
      expect.objectContaining({
        source: "hermes-token",
        target: "hermes-token",
        uid: "1234",
        gid: "2345",
      }),
      expect.objectContaining({
        source: "guest-invite-signing-key",
        target: "guest-invite-signing-key",
        uid: "1234",
        gid: "2345",
      }),
    ])
    expect(Object.keys(config.secrets ?? {}).sort()).toEqual([
      "guest-invite-signing-key",
      "hermes-token",
    ])
    expect(JSON.stringify(config.services.web.environment)).not.toMatch(
      /HERMES|TOKEN|OIDC|SECRET/u
    )
  })

  it("runs OpenClaw through the private AOS proxy", () => {
    const config = composeConfig(["compose.yaml", "compose.openclaw.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.openclaw.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy.openclaw.example.yaml"
      ),
      AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE: resolve(root, ".env.example"),
      AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE: resolve(root, ".env.example"),
      AOS_UI_HOST_UID: "1234",
      AOS_UI_HOST_GID: "2345",
    })

    expect(Object.keys(config.services).sort()).toEqual(["tools-mcp", "web"])
    expect(config.services.web.user).toBe("1234:2345")
    expect(config.services.web.secrets).toEqual([
      expect.objectContaining({
        source: "openclaw-device-identity",
        target: "openclaw-device-identity",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
      expect.objectContaining({
        source: "openclaw-device-token",
        target: "openclaw-device-token",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
      expect.objectContaining({
        source: "guest-invite-signing-key",
        target: "guest-invite-signing-key",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      }),
    ])
    const proxy = parse(
      readFileSync(resolve(root, "deploy/proxy.openclaw.example.yaml"), "utf8")
    ) as { runtime: Record<string, unknown> }
    expect(proxy.runtime).toMatchObject({
      deviceIdentityFile: "/run/secrets/openclaw-device-identity",
      deviceTokenFile: "/run/secrets/openclaw-device-token",
    })
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_OPENCLAW_HOST"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_OPENCLAW_PORT"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_GATEWAY_OPENCLAW_TOKEN"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_OPENCLAW_DEVICE_TOKEN"
    )
  })

  it("mounts push state and VAPID secret when the push overlay is added", () => {
    const config = composeConfig(
      ["compose.yaml", "compose.hermes.yaml", "compose.push.yaml"],
      {
        AOS_UI_RUNTIME_CONFIG_FILE: resolve(
          root,
          "deploy/runtime-config.hermes.json"
        ),
        AOS_UI_PROXY_CONFIG_FILE: resolve(
          root,
          "deploy/proxy.hermes.example.yaml"
        ),
        AOS_UI_HERMES_TOKEN_FILE: resolve(root, ".env.example"),
        AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
        AOS_UI_PUSH_STATE_DIR: root,
        AOS_UI_VAPID_PRIVATE_KEY_FILE: resolve(root, ".env.example"),
        AOS_UI_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
        AOS_UI_HOST_UID: "1234",
        AOS_UI_HOST_GID: "2345",
      }
    )

    expect(config.services.web.volumes).toContainEqual(
      expect.objectContaining({
        type: "bind",
        source: root,
        target: "/var/lib/aos-ui/push",
      })
    )
    expect(config.services.web.secrets).toContainEqual(
      expect.objectContaining({
        source: "vapid-private-key",
        target: "vapid-private-key",
        mode: "0400",
        uid: "1234",
        gid: "2345",
      })
    )
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_PROXY_PUSH_STATE_DIR: "/var/lib/aos-ui/push",
      AOS_UI_PROXY_PUSH_VAPID_PRIVATE_KEY_FILE:
        "/run/secrets/vapid-private-key",
      AOS_UI_PROXY_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
    })
    for (const [key, value] of Object.entries(
      config.services.web.environment ?? {}
    )) {
      if (!key.startsWith("AOS_UI_PROXY_")) continue
      expect(value).toMatch(/^(?:\/|mailto:|https:)/u)
    }
  })

  it("does not require push variables and carries no push state without the push overlay", () => {
    // Push vars must be absent from the override map to prove they are not required.
    const config = composeConfig(["compose.yaml", "compose.hermes.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.hermes.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy.hermes.example.yaml"
      ),
      AOS_UI_HERMES_TOKEN_FILE: resolve(root, ".env.example"),
      AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_HOST_UID: "1234",
      AOS_UI_HOST_GID: "2345",
    })

    expect(config.secrets).not.toHaveProperty("vapid-private-key")
    expect(config.services.web.volumes ?? []).not.toContainEqual(
      expect.objectContaining({ target: "/var/lib/aos-ui/push" })
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_PROXY_PUSH_STATE_DIR"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_PROXY_PUSH_VAPID_PRIVATE_KEY_FILE"
    )
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_UI_PROXY_PUSH_VAPID_SUBJECT"
    )
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

  it("runs the Bun proxy image as a non-root user", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")

    expect(dockerfile).toContain("USER bun")
  })
})
