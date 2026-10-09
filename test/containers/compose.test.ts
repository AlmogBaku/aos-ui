// @vitest-environment node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type Port = { host_ip?: string; published?: string; target: number }

type Service = {
  build?: { target?: string }
  command?: string[]
  depends_on?: Record<string, { condition: string }>
  healthcheck?: { test?: string[] }
  environment?: Record<string, string>
  expose?: string[]
  network_mode?: string
  configs?: Array<{ source: string; target: string }>
  ports?: Port[]
  user?: string
  secrets?: Array<{
    source: string
    target: string
    mode?: string
    uid?: string
    gid?: string
  }>
  volumes?: Array<{ source: string; target: string; type: string }>
}

type ComposeConfig = {
  configs?: Record<string, { file?: string }>
  secrets?: Record<string, { file?: string }>
  services: Record<string, Service>
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

/** Any existing file stands in for a private config or secret file. */
const PLACEHOLDER_FILE = resolve(root, ".env.example")

/** The variables a harness overlay requires, every file a placeholder. */
function harnessEnvironment(
  runtime: "hermes" | "openclaw" | "opencode",
  extra: Record<string, string> = {}
) {
  const files = {
    hermes: ["HARNESS_GW_HERMES_TOKEN_FILE"],
    openclaw: [
      "HARNESS_GW_OPENCLAW_DEVICE_IDENTITY_FILE",
      "HARNESS_GW_OPENCLAW_DEVICE_TOKEN_FILE",
    ],
    opencode: ["HARNESS_GW_OPENCODE_PASSWORD_FILE"],
  }[runtime]
  return {
    AOS_UI_RUNTIME_CONFIG_FILE: resolve(
      root,
      `deploy/runtime-config.${runtime}.json`
    ),
    HARNESS_GW_CONFIG_FILE: PLACEHOLDER_FILE,
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE: PLACEHOLDER_FILE,
    ...Object.fromEntries(files.map((name) => [name, PLACEHOLDER_FILE])),
    AOS_UI_HOST_UID: "1234",
    AOS_UI_HOST_GID: "2345",
    ...extra,
  }
}

/** A secret mounted at /run/secrets/<name>, readable by the host user only. */
const ownedSecret = (name: string) =>
  expect.objectContaining({
    source: name,
    target: name,
    mode: "0400",
    uid: "1234",
    gid: "2345",
  })

/** Every published port in the composition, by service. */
function publishedPorts(config: ComposeConfig) {
  return Object.fromEntries(
    Object.entries(config.services)
      .filter(([, service]) => service.ports?.length)
      .map(([name, service]) => [name, service.ports])
  )
}

const loopbackPort = (published: string, target: number) =>
  expect.objectContaining({ host_ip: "127.0.0.1", published, target })

/** The body of one Caddy site block, by its address. */
function caddySite(source: string, address: string) {
  const start = source.indexOf(`${address} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++
    if (source[index] === "}" && --depth === 0)
      return source.slice(start, index + 1)
  }
  throw new Error(`unterminated site ${address}`)
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

  it("publishes only Caddy and the tools MCP server, on loopback", () => {
    const config = composeConfig(["compose.yaml"])

    expect(Object.keys(config.services).sort()).toEqual([
      "caddy",
      "tools-mcp",
      "web",
    ])
    expect(publishedPorts(config)).toEqual({
      caddy: [loopbackPort("3000", 18080)],
      "tools-mcp": [loopbackPort("4110", 4110)],
    })
    // Docker forwards a published port to the container's interface, so
    // Caddy listens there; the host side above stays on loopback.
    expect(config.services.caddy.environment?.AOS_UI_CADDY_BIND).toBe("0.0.0.0")
    // An empty public host leaves Caddy's host matcher empty, and Caddy
    // refuses to start.
    expect(
      composeConfig(["compose.yaml"], { AOS_UI_PUBLIC_HOST: "" }).services.caddy
        .environment?.AOS_UI_PUBLIC_HOST
    ).toBe("localhost")
    expect(config.services.web.build?.target).toBe("web")
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.json")
    )
  })

  it("keeps the tools MCP server on loopback whatever the bind address", () => {
    const toolsMcp = composeConfig(["compose.yaml"], {
      AOS_UI_BIND_ADDRESS: "0.0.0.0",
      AOS_UI_TOOLS_MCP_PORT: "4999",
    }).services["tools-mcp"]!

    expect(toolsMcp.ports).toEqual([loopbackPort("4999", 4110)])
    expect(toolsMcp.healthcheck?.test?.join(" ")).toContain(
      "http://127.0.0.1:4110/health"
    )
  })

  it("wires each Caddy site to its own lane, on loopback, without a log", () => {
    const operator = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8")
    const guest = readFileSync(
      resolve(root, "deploy/caddy/guest.caddy"),
      "utf8"
    )
    const directives = (source: string) =>
      source.replace(/#.*$/gmu, "").split(/\s+/u)

    for (const [site, host, gateway, web] of [
      [
        caddySite(operator, "http://:18080"),
        "AOS_UI_PUBLIC_HOST",
        "AOS_UI_GATEWAY_UPSTREAM:gateway:4100",
        "AOS_UI_WEB_UPSTREAM:web:4200",
      ],
      [
        caddySite(guest, "http://:18081"),
        "AOS_UI_GUEST_PUBLIC_HOST",
        "AOS_UI_GATEWAY_GUEST_UPSTREAM:gateway:4101",
        "AOS_UI_WEB_GUEST_UPSTREAM:web:4201",
      ],
    ] as const) {
      expect(site).toContain("bind {$AOS_UI_CADDY_BIND:127.0.0.1}")
      expect(site).toContain(
        `@foreign {\n\t\t\tnot host 127.0.0.1 localhost\n\t\t\tnot host {$${host}:localhost}\n\t\t}\n\t\trespond @foreign 421`
      )
      expect(site).toContain(`reverse_proxy /api/v1/* {$${gateway}}`)
      expect(site).toContain(`reverse_proxy {$${web}}`)
    }
    for (const source of [operator, guest])
      expect(directives(source)).not.toContain("log")
    expect(operator).toMatch(/^\s*admin off$/mu)
    expect(operator).toMatch(/^\s*auto_https off$/mu)
  })

  it("runs the Hermes gateway beside the web server and opens the guest lane", () => {
    const config = composeConfig(
      ["compose.yaml", "compose.hermes.yaml"],
      harnessEnvironment("hermes")
    )
    const gateway = config.services.gateway!

    expect(Object.keys(config.services).sort()).toEqual([
      "caddy",
      "gateway",
      "tools-mcp",
      "web",
    ])
    expect(publishedPorts(config)).toEqual({
      caddy: [loopbackPort("3000", 18080), loopbackPort("3001", 18081)],
      "tools-mcp": [loopbackPort("4110", 4110)],
    })
    expect(gateway.user).toBe("1234:2345")
    expect(gateway.environment).toEqual({
      HARNESS_GW_CONFIG_FILE: "/run/harness-gw/config.yaml",
    })
    // The paths harness-gw's own example configuration test pins.
    expect(gateway.secrets).toEqual([
      ownedSecret("hermes-token"),
      ownedSecret("guest-invite-signing-key"),
    ])
    expect(gateway.healthcheck?.test?.join(" ")).toContain(
      "http://127.0.0.1:4100/api/v1/healthz"
    )
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_GUEST_WEB_PORT: "4201",
    })
    expect(JSON.stringify(config.services.web)).not.toMatch(
      /HERMES|TOKEN|SECRET|HARNESS_GW/u
    )
  })

  it("runs OpenClaw through the gateway with its device credentials", () => {
    const config = composeConfig(
      ["compose.yaml", "compose.openclaw.yaml"],
      harnessEnvironment("openclaw")
    )

    expect(config.services.gateway!.secrets).toEqual([
      ownedSecret("openclaw-device-identity"),
      ownedSecret("openclaw-device-token"),
      ownedSecret("guest-invite-signing-key"),
    ])
    expect(publishedPorts(config)).toEqual({
      caddy: [loopbackPort("3000", 18080), loopbackPort("3001", 18081)],
      "tools-mcp": [loopbackPort("4110", 4110)],
    })
  })

  it("adds OpenCode only through its overlay, reachable from the gateway alone", () => {
    const config = composeConfig(
      ["compose.yaml", "compose.opencode.yaml"],
      harnessEnvironment("opencode")
    )
    const opencode = config.services.opencode!

    expect(Object.keys(config.services).sort()).toEqual([
      "caddy",
      "gateway",
      "opencode",
      "tools-mcp",
      "web",
    ])
    expect(config.services.gateway!.depends_on?.opencode.condition).toBe(
      "service_healthy"
    )
    expect(config.services.gateway!.secrets).toEqual([
      ownedSecret("opencode-password"),
      ownedSecret("guest-invite-signing-key"),
    ])
    expect(opencode.secrets).toEqual([ownedSecret("opencode-password")])
    expect(opencode.depends_on?.["tools-mcp"]?.condition).toBe(
      "service_healthy"
    )
    expect(opencode.expose).toEqual(["4096"])
    expect(opencode.ports).toBeUndefined()
  })

  it("mounts push state and the VAPID secret on the gateway only with the push overlay", () => {
    const push = composeConfig(
      ["compose.yaml", "compose.hermes.yaml", "compose.push.yaml"],
      harnessEnvironment("hermes", {
        HARNESS_GW_PUSH_STATE_DIR: root,
        HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE: PLACEHOLDER_FILE,
        HARNESS_GW_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
      })
    ).services.gateway!

    expect(push.volumes).toContainEqual(
      expect.objectContaining({
        type: "bind",
        source: root,
        target: "/var/lib/harness-gw/push",
      })
    )
    expect(push.secrets).toContainEqual(ownedSecret("vapid-private-key"))
    expect(push.environment).toMatchObject({
      HARNESS_GW_PUSH_STATE_DIR: "/var/lib/harness-gw/push",
      HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE: "/run/secrets/vapid-private-key",
      HARNESS_GW_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
    })

    // Without the overlay the push variables are not required at all.
    const plain = composeConfig(
      ["compose.yaml", "compose.hermes.yaml"],
      harnessEnvironment("hermes")
    )
    expect(plain.secrets).not.toHaveProperty("vapid-private-key")
    expect(plain.services.gateway!.volumes).toBeUndefined()
    expect(Object.keys(plain.services.gateway!.environment ?? {})).toEqual([
      "HARNESS_GW_CONFIG_FILE",
    ])
  })

  it("keeps every listener on loopback under host networking", () => {
    const config = composeConfig(
      ["compose.yaml", "compose.hermes.yaml", "deploy/compose.host.yaml"],
      harnessEnvironment("hermes")
    )
    const { caddy, web, gateway, "tools-mcp": toolsMcp } = config.services

    for (const service of [caddy, web, gateway, toolsMcp]) {
      expect(service!.network_mode).toBe("host")
      expect(service!.ports ?? []).toEqual([])
    }
    expect(caddy!.environment).toMatchObject({
      AOS_UI_CADDY_BIND: "127.0.0.1",
      AOS_UI_GATEWAY_UPSTREAM: "127.0.0.1:4100",
      AOS_UI_GATEWAY_GUEST_UPSTREAM: "127.0.0.1:4101",
      AOS_UI_WEB_UPSTREAM: "127.0.0.1:4200",
      AOS_UI_WEB_GUEST_UPSTREAM: "127.0.0.1:4201",
    })
    expect(web!.environment).toMatchObject({
      AOS_UI_WEB_HOST: "127.0.0.1",
      AOS_UI_GUEST_WEB_HOST: "127.0.0.1",
    })
    expect(toolsMcp!.command?.join(" ")).toContain("--host 127.0.0.1")
  })

  it("moves bundled OpenCode onto host loopback with the host-network overlay", () => {
    const { gateway, opencode } = composeConfig(
      [
        "compose.yaml",
        "compose.opencode.yaml",
        "deploy/compose.host.yaml",
        "deploy/compose.host.opencode.yaml",
      ],
      harnessEnvironment("opencode")
    ).services

    for (const service of [gateway, opencode]) {
      expect(service!.network_mode).toBe("host")
      expect(service!.expose ?? []).toEqual([])
    }
    expect(opencode!.environment).toMatchObject({
      AOS_UI_OPENCODE_HOST: "127.0.0.1",
      AOS_UI_TOOLS_MCP_URL: "http://127.0.0.1:4110/mcp",
    })
  })

  it("mounts no guest site under the operator-only overlay", () => {
    const caddyFiles = (operatorOnly: boolean) =>
      composeConfig(
        [
          "compose.yaml",
          "compose.hermes.yaml",
          ...(operatorOnly ? ["deploy/compose.operator-only.yaml"] : []),
        ],
        harnessEnvironment("hermes")
      ).services.caddy.configs?.map((config) => config.target)

    expect(caddyFiles(false)).toContain("/etc/caddy/lanes/guest.caddy")
    expect(caddyFiles(true)).toEqual(["/etc/caddy/Caddyfile"])
  })

  it("uses the Vite development target and source mount behind Caddy", () => {
    const web = composeConfig(["compose.yaml", "compose.dev.yaml"]).services.web

    expect(web.command).toEqual([
      "bun",
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      "4200",
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
      AOS_UI_GATEWAY_TARGET: "http://gateway:4100",
    })
  })

  it("runs the web server image as a non-root user", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")
    const web = dockerfile.slice(dockerfile.indexOf("AS web"))

    expect(web).toContain("USER bun")
  })
})
