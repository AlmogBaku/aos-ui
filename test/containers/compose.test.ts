// @vitest-environment node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type ComposeConfig = {
  services: Record<
    string,
    {
      build?: {
        args?: Record<string, string>
      }
      command?: string[]
      depends_on?: Record<string, { condition: string }>
      environment?: Record<string, string>
      ports?: Array<{
        host_ip?: string
        published?: string
        target: number
      }>
      user?: string
      volumes?: Array<{
        read_only?: boolean
        source: string
        target: string
        type: string
      }>
    }
  >
  volumes: Record<string, unknown>
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
        ...overrides,
      },
    })
  ) as ComposeConfig
}

describe("container orchestration", () => {
  it("keeps both production services loopback-only with browser-facing defaults", () => {
    const config = composeConfig(["compose.yaml"])
    const web = config.services.web
    const opencode = config.services.opencode

    expect(web.ports).toContainEqual({
      host_ip: "127.0.0.1",
      mode: "ingress",
      protocol: "tcp",
      published: "3000",
      target: 3000,
    })
    expect(opencode.ports).toContainEqual({
      host_ip: "127.0.0.1",
      mode: "ingress",
      protocol: "tcp",
      published: "4096",
      target: 4096,
    })
    expect(web.environment).toMatchObject({
      AOS_UI_OPENCODE_MANAGEMENT_URL: "http://127.0.0.1:4097",
      AOS_UI_OPENCODE_BASE_URL: "http://127.0.0.1:4096",
      AOS_UI_RUNTIME_MODE: "opencode",
    })
    expect(opencode.environment).toMatchObject({
      AOS_UI_OPENCODE_MANAGEMENT_PORT: "4097",
      GEMINI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      AOS_UI_OPENCODE_CORS_ORIGINS:
        "http://localhost:3000,http://127.0.0.1:3000",
      AOS_UI_OPENCODE_HOST: "0.0.0.0",
      AOS_UI_OPENCODE_PORT: "4096",
      UV_PROJECT_ENVIRONMENT: "/opt/aos-ui/monty/.venv",
    })
    expect(opencode.build?.args).toMatchObject({
      AOS_UI_HOST_GID: "1000",
      AOS_UI_HOST_UID: "1000",
    })
    expect(web.depends_on?.opencode.condition).toBe("service_healthy")
    expect(opencode.ports).toContainEqual(
      expect.objectContaining({
        host_ip: "127.0.0.1",
        published: "4097",
        target: 4097,
      })
    )
  })

  it("uses writable persistent state and workspace with read-only AWS configuration", () => {
    const config = composeConfig(["compose.yaml"])
    const mounts = config.services.opencode.volumes ?? []

    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "/workspace",
          type: "bind",
        }),
        expect.objectContaining({
          read_only: true,
          source: resolve(process.env.HOME ?? "", ".aws"),
          target: "/home/aos-ui/.aws",
          type: "bind",
        }),
        expect.objectContaining({
          target: "/home/aos-ui/.local/share/opencode",
          type: "volume",
        }),
        expect.objectContaining({
          target: "/opt/aos-ui/monty/.venv",
          type: "volume",
        }),
      ])
    )
    expect(Object.keys(config.volumes)).toHaveLength(2)
  })

  it("honors published-port, browser URL, CORS, and AWS path overrides", () => {
    const config = composeConfig(["compose.yaml"], {
      AOS_UI_AWS_CONFIG_DIR: "/credentials/aws",
      AOS_UI_BIND_ADDRESS: "192.0.2.10",
      AOS_UI_HOST_GID: "2345",
      AOS_UI_HOST_UID: "1234",
      AOS_UI_OPENCODE_BASE_URL: "https://opencode.example.test",
      AOS_UI_OPENCODE_CORS_ORIGINS: "https://web.example.test",
      AOS_UI_OPENCODE_PUBLISHED_PORT: "14096",
      AOS_UI_WEB_PUBLISHED_PORT: "13000",
    })

    expect(config.services.web.ports?.[0]).toMatchObject({
      host_ip: "192.0.2.10",
      published: "13000",
    })
    expect(config.services.opencode.ports?.[0]).toMatchObject({
      host_ip: "192.0.2.10",
      published: "14096",
    })
    expect(config.services.opencode.build?.args).toMatchObject({
      AOS_UI_HOST_GID: "2345",
      AOS_UI_HOST_UID: "1234",
    })
    expect(config.services.web.environment?.AOS_UI_OPENCODE_BASE_URL).toBe(
      "https://opencode.example.test"
    )
    expect(
      config.services.opencode.environment?.AOS_UI_OPENCODE_CORS_ORIGINS
    ).toBe("https://web.example.test")
    expect(config.services.opencode.volumes).toContainEqual(
      expect.objectContaining({
        source: "/credentials/aws",
        target: "/home/aos-ui/.aws",
      })
    )
  })

  it("passes Google credentials only to the OpenCode service", () => {
    const config = composeConfig(["compose.yaml"], {
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
    })

    expect(config.services.opencode.environment).toMatchObject({
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
    })
    expect(config.services.web.environment).not.toHaveProperty("GEMINI_API_KEY")
    expect(config.services.web.environment).not.toHaveProperty(
      "GOOGLE_GENERATIVE_AI_API_KEY"
    )
  })

  it("changes only the web service to hot-reloading development", () => {
    const production = composeConfig(["compose.yaml"])
    const development = composeConfig(["compose.yaml", "compose.dev.yaml"])

    expect(development.services.web.command).toEqual([
      "bun",
      "run",
      "dev",
      "--hostname",
      "0.0.0.0",
    ])
    expect(development.services.web.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: root, target: "/app", type: "bind" }),
        expect.objectContaining({
          target: "/app/node_modules",
          type: "volume",
        }),
      ])
    )
    expect(development.services.opencode).toEqual(production.services.opencode)
  })

  it("pins production runtimes and runs both services as non-root users", () => {
    const webDockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8")
    const opencodeDockerfile = readFileSync(
      resolve(root, "Dockerfile.opencode"),
      "utf8"
    )
    const nextConfig = readFileSync(resolve(root, "next.config.ts"), "utf8")

    expect(webDockerfile).toContain("oven/bun:1.3.10-debian")
    expect(webDockerfile).toContain("node:22.22.0-bookworm-slim")
    expect(webDockerfile).toContain("USER node")
    expect(opencodeDockerfile).toContain("ghcr.io/anomalyco/opencode:1.18.29")
    expect(opencodeDockerfile).toContain("ghcr.io/astral-sh/uv:0.12.5")
    expect(opencodeDockerfile).toContain("oven/bun:1.3.10-alpine")
    expect(opencodeDockerfile).toContain("ARG AOS_UI_HOST_UID=1000")
    expect(opencodeDockerfile).toContain("ARG AOS_UI_HOST_GID=1000")
    expect(opencodeDockerfile).toContain(
      "USER ${AOS_UI_HOST_UID}:${AOS_UI_HOST_GID}"
    )
    expect(opencodeDockerfile).not.toContain("addgroup -g")
    expect(opencodeDockerfile).not.toContain("adduser -u")
    expect(opencodeDockerfile).toContain("/home/aos-ui/.local/state")
    expect(opencodeDockerfile).not.toContain("uv sync --frozen --no-dev")
    expect(opencodeDockerfile).not.toContain("USER root")
    expect(nextConfig).toContain('output: "standalone"')
  })
})
