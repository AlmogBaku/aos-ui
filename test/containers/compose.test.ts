// @vitest-environment node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type ComposeConfig = {
  configs?: Record<string, { file?: string }>
  services: Record<
    string,
    {
      command?: string[]
      depends_on?: Record<string, { condition: string }>
      environment?: Record<string, string>
      ports?: Array<{ host_ip?: string; published?: string; target: number }>
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

  it("forwards to operator-managed Hermes without adding an AOS service", () => {
    const config = composeConfig(["compose.yaml", "compose.hermes.yaml"], {
      AOS_UI_RUNTIME_CONFIG_FILE: resolve(
        root,
        "deploy/runtime-config.hermes-native.json"
      ),
    })

    expect(Object.keys(config.services)).toEqual(["web"])
    expect(config.services.web.environment).toMatchObject({
      AOS_UI_HERMES_HOST: "host.docker.internal",
      AOS_UI_HERMES_PORT: "9119",
    })
    expect(config.configs?.["runtime-config"]?.file).toBe(
      resolve(root, "deploy/runtime-config.hermes-native.json")
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
    expect(nginx).toContain("location ^~ /auth/")
    expect(nginx).toContain("location ^~ /openclaw/")
    expect(nginx).toContain(
      "location = /openclaw { rewrite ^ /openclaw/ last; }"
    )
    expect(nginx).not.toContain("location = /openclaw { return 308")
    expect(nginx).toContain("rewrite ^/openclaw/?(.*)$ /$1 break;")
    expect(nginx).toContain("proxy_set_header Origin $http_origin;")
    expect(nginx).not.toContain("proxy_set_header Origin $scheme://$http_host;")
    expect(nginx).toContain("proxy_buffering off")
    expect(nginx).toContain("max-age=31536000, immutable")
  })

  it("raises the upload limit only for exact native Hermes transcription", () => {
    const nginx = readFileSync(
      resolve(root, "deploy/nginx/default.conf.template"),
      "utf8"
    )
    const transcription = nginx.match(
      /location = \/hermes\/api\/audio\/transcribe \{([\s\S]*?)^ {2}\}/m
    )?.[1]

    expect(transcription).toBeDefined()
    expect(transcription).toContain("client_max_body_size 8m;")
    expect(nginx.match(/client_max_body_size/g)).toHaveLength(1)
    expect(transcription).toContain("rewrite ^/hermes/?(.*)$ /$1 break;")
    expect(transcription).toContain("proxy_pass $hermes_upstream;")
    expect(transcription).toContain("proxy_http_version 1.1;")
    expect(transcription).toContain("proxy_buffering off;")
    expect(transcription).toContain("proxy_request_buffering off;")
    expect(transcription).toContain("proxy_cache off;")
    expect(transcription).toContain("proxy_read_timeout 1h;")
    expect(transcription).toContain("proxy_send_timeout 1h;")
    for (const header of [
      "Upgrade $http_upgrade",
      "Connection $connection_upgrade",
      "Host $http_host",
      "X-Forwarded-Prefix /hermes",
      "X-Forwarded-For $proxy_add_x_forwarded_for",
      "X-Forwarded-Proto $scheme",
    ]) {
      expect(transcription).toContain(`proxy_set_header ${header};`)
    }
  })
})
