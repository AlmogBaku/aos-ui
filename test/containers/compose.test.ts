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

  it("ships a browser-broker proxy example with sealed key references", () => {
    const proxy = JSON.parse(
      readFileSync(
        resolve(root, "deploy/proxy-config.hermes.example.json"),
        "utf8"
      )
    ) as {
      listen: { host: string; port: number; exposure: string }
      hermes: { auth: { mode: string } }
      operator: {
        principalHmacKeyFile: string
        session: { keys: Array<{ secretFile: string }> }
      }
      events: { keys: Array<{ secretFile: string }> }
    }
    expect(proxy.listen).toMatchObject({
      host: "0.0.0.0",
      port: 4100,
      exposure: "private-container",
    })
    expect(proxy.hermes.auth).toMatchObject({ mode: "browser-broker" })
    expect(proxy.operator.principalHmacKeyFile).toMatch(/^\/run\/secrets\//u)
    expect(proxy.operator.session.keys[0].secretFile).toMatch(
      /^\/run\/secrets\//u
    )
    expect(proxy.events.keys[0].secretFile).toMatch(/^\/run\/secrets\//u)
    expect(JSON.stringify(proxy).toLowerCase()).not.toContain(
      "hermes-session-token"
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
      AOS_GATEWAY_INVITE_SIGNING_KEY: "test-signing-key",
    })

    expect(Object.keys(config.services).sort()).toEqual(["opencode", "web"])
    expect(config.services.web.depends_on?.opencode.condition).toBe(
      "service_healthy"
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.opencode.json")
    )
    expect(config.services.opencode.environment).toMatchObject({
      AOS_GATEWAY_INVITE_SIGNING_KEY: "test-signing-key",
      AOS_UI_OPENCODE_WORKTREE: "/workspace",
    })
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_GATEWAY_INVITE_SIGNING_KEY"
    )
  })

  it("packages the invite CLI in the OpenCode runtime image", () => {
    const dockerfile = readFileSync(
      resolve(root, "Dockerfile.opencode"),
      "utf8"
    )

    expect(dockerfile).toMatch(/FROM golang:[^\n]+ AS gateway-build/)
    expect(dockerfile).toMatch(/go build [^\n]*-o \/out\/aos-gateway/)
    expect(dockerfile).toContain(
      "COPY --from=gateway-build /out/aos-gateway /usr/local/bin/aos-gateway"
    )
  })

  it("runs the private AOS proxy beside the web service for Hermes", () => {
    const config = composeConfig(["compose.yaml", "compose.hermes.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.hermes.json"
      ),
      AOS_UI_PROXY_CONFIG_FILE: resolve(
        root,
        "deploy/proxy-config.hermes.example.json"
      ),
      AOS_UI_OIDC_CLIENT_SECRET_FILE: resolve(root, ".env.example"),
      AOS_UI_OPERATOR_PRINCIPAL_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_OPERATOR_SESSION_KEY_FILE: resolve(root, ".env.example"),
      AOS_UI_RECONNECT_CURSOR_KEY_FILE: resolve(root, ".env.example"),
    })

    expect(Object.keys(config.services).sort()).toEqual(["proxy", "web"])
    expect(config.services.web.depends_on?.proxy.condition).toBe(
      "service_healthy"
    )
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_PROXY_HOST: "proxy",
      AOS_UI_PROXY_PORT: "4100",
    })
    expect(config.services.proxy.build?.target).toBe("proxy")
    expect(config.services.proxy.command).toEqual([
      "bun",
      "run",
      "proxy:serve",
      "--",
      "--config",
      "/run/aos-ui/proxy-config.json",
    ])
    expect(config.services.proxy.ports).toBeUndefined()
    expect(config.services.proxy.expose).toEqual(["4100"])
    expect(config.services.proxy.configs).toContainEqual(
      expect.objectContaining({
        source: "proxy-config",
        target: "/run/aos-ui/proxy-config.json",
      })
    )
    expect(config.services.proxy.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "operator-oidc-client-secret",
          target: "oidc-client-secret",
        }),
        expect.objectContaining({
          source: "operator-principal-hmac",
          target: "operator-principal-hmac",
        }),
        expect.objectContaining({
          source: "operator-session-key",
          target: "operator-session-key",
        }),
        expect.objectContaining({
          source: "reconnect-cursor-key",
          target: "reconnect-cursor-key",
        }),
      ])
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.hermes.json")
    )
    expect(config.configs?.["proxy-config"]?.file).toBe(
      resolve(root, "deploy/proxy-config.hermes.example.json")
    )
    expect(config.secrets?.["operator-oidc-client-secret"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(config.secrets?.["operator-principal-hmac"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(config.secrets?.["operator-session-key"]?.file).toBe(
      resolve(root, ".env.example")
    )
    expect(config.secrets?.["reconnect-cursor-key"]?.file).toBe(
      resolve(root, ".env.example")
    )
  })

  it("forwards to independently operated OpenClaw without exposing credentials", () => {
    const config = composeConfig(["compose.yaml", "compose.openclaw.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.openclaw.json"
      ),
    })

    expect(Object.keys(config.services)).toEqual(["web"])
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_OPENCLAW_HOST: "host.docker.internal",
      AOS_UI_OPENCLAW_PORT: "18789",
    })
    expect(config.services.web.environment).not.toHaveProperty(
      "AOS_GATEWAY_OPENCLAW_TOKEN"
    )
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.openclaw.json")
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

  it("builds static assets into a non-root Nginx image", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")
    const nginx = readFileSync(
      resolve(root, "deploy/nginx/default.conf.template"),
      "utf8"
    )

    expect(dockerfile).toContain("nginxinc/nginx-unprivileged")
    expect(dockerfile).toContain("USER nginx")
    expect(dockerfile).toContain("/app/dist")
    expect(nginx).toContain("location = /api/health")
    expect(nginx).toContain("location = /runtime-config.json")
    expect(nginx).toContain("location = /api/aos/v1")
    expect(nginx).toContain("location ^~ /api/aos/v1/")
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade;")
    expect(nginx).toContain("proxy_set_header Connection $connection_upgrade;")
    expect(nginx).toContain("proxy_set_header Origin $http_origin;")
    expect(nginx).not.toContain("proxy_set_header Origin $scheme://$http_host;")
    expect(nginx).not.toContain("proxy_pass $hermes_upstream")
    expect(nginx).not.toContain("proxy_pass $openclaw_upstream")
    expect(nginx).toContain("location ^~ /hermes/ { return 404; }")
    expect(nginx).toContain("location ^~ /auth/ { return 404; }")
    expect(nginx).toContain("location ^~ /openclaw/ { return 404; }")
    expect(nginx).toContain("proxy_buffering off")
    expect(nginx).toContain("max-age=31536000, immutable")
  })

  it("packages the Bun proxy as a dedicated non-root image target", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")

    expect(dockerfile).toMatch(/FROM dependencies AS proxy/)
    expect(dockerfile).toContain('CMD ["bun", "run", "proxy:serve"')
    expect(dockerfile).toContain("USER bun")
  })

  it("keeps the operator Nginx boundary free of native Hermes routes", () => {
    const nginx = readFileSync(
      resolve(root, "deploy/nginx/default.conf.template"),
      "utf8"
    )
    expect(nginx).not.toContain("AOS_UI_HERMES_HOST")
    expect(nginx).not.toContain("AOS_UI_OPENCLAW_HOST")
    expect(nginx).not.toContain("/hermes/api/audio/transcribe")
    expect(nginx.match(/proxy_pass/g)).toHaveLength(2)
    expect(nginx.match(/proxy_pass \$aos_upstream/g)).toHaveLength(2)
    expect(nginx).toContain("private TypeScript proxy")
  })
})
