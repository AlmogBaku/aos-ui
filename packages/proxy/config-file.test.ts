// @vitest-environment node

import { describe, expect, it } from "vitest"

import { parseProxyConfig } from "./config"
import {
  describeStartFailure,
  loadProxyConfig,
  PROXY_ENV_OVERRIDES,
  PROXY_ENV_PREFIX,
  ProxyConfigurationError,
  resolveProxyConfigPath,
} from "./config-file"
import { redactForLog } from "./redaction"

/** Every test reads its own synthetic environment; none reads the real one. */
function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name]
}

describe("proxy configuration path resolution", () => {
  it("prefers the flag, then the environment, then the XDG default", () => {
    expect(
      resolveProxyConfigPath({
        flag: "/etc/aos-ui/flag.yaml",
        getenv: env({
          AOS_UI_PROXY_CONFIG_FILE: "/etc/aos-ui/env.yaml",
          XDG_CONFIG_HOME: "/config",
          HOME: "/home/operator",
        }),
      })
    ).toEqual({ path: "/etc/aos-ui/flag.yaml", explicit: true })

    expect(
      resolveProxyConfigPath({
        getenv: env({
          AOS_UI_PROXY_CONFIG_FILE: "/etc/aos-ui/env.yaml",
          XDG_CONFIG_HOME: "/config",
          HOME: "/home/operator",
        }),
      })
    ).toEqual({ path: "/etc/aos-ui/env.yaml", explicit: true })

    expect(
      resolveProxyConfigPath({
        getenv: env({ XDG_CONFIG_HOME: "/config", HOME: "/home/operator" }),
      })
    ).toEqual({ path: "/config/aos-ui/proxy.yaml", explicit: false })

    expect(
      resolveProxyConfigPath({ getenv: env({ HOME: "/home/operator" }) })
    ).toEqual({
      path: "/home/operator/.config/aos-ui/proxy.yaml",
      explicit: false,
    })
  })

  it("treats an empty or whitespace-only environment value as unset", () => {
    expect(
      resolveProxyConfigPath({
        getenv: env({
          AOS_UI_PROXY_CONFIG_FILE: "   ",
          XDG_CONFIG_HOME: "",
          HOME: "/home/operator",
        }),
      })
    ).toEqual({
      path: "/home/operator/.config/aos-ui/proxy.yaml",
      explicit: false,
    })
  })

  it("rejects a relative XDG_CONFIG_HOME by name", () => {
    expect(() =>
      resolveProxyConfigPath({
        getenv: env({ XDG_CONFIG_HOME: "relative/config", HOME: "/home/o" }),
      })
    ).toThrow(/XDG_CONFIG_HOME/u)
  })

  it("names both variables when neither XDG_CONFIG_HOME nor HOME is set", () => {
    let message = ""
    try {
      resolveProxyConfigPath({ getenv: env({}) })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("XDG_CONFIG_HOME")
    expect(message).toMatch(/\bHOME\b/u)
    expect(message).toContain("--config")
  })

  it("does not discover a path for a command that requires an explicit one", () => {
    let message = ""
    try {
      resolveProxyConfigPath({
        discover: false,
        getenv: env({ XDG_CONFIG_HOME: "/config", HOME: "/home/operator" }),
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("--config")
    expect(message).toContain("AOS_UI_PROXY_CONFIG_FILE")
    expect(message).not.toContain("proxy.yaml")

    expect(
      resolveProxyConfigPath({
        discover: false,
        getenv: env({ AOS_UI_PROXY_CONFIG_FILE: "/etc/aos-ui/env.yaml" }),
      })
    ).toEqual({ path: "/etc/aos-ui/env.yaml", explicit: true })
  })
})

const CONFIG_PATH = "/etc/aos-ui/proxy.yaml"
const DISCOVERED_PATH = "/config/aos-ui/proxy.yaml"
const OWNER_UID = 4321

type FakeEntry = {
  source?: string
  mode?: number
  uid?: number
  size?: number
  directory?: boolean
  statCode?: string
  readCode?: string
}

function fail(code: string) {
  return Object.assign(new Error("synthetic file failure"), { code })
}

/**
 * Stands in for the operator's filesystem: every fact the loader checks is a
 * literal here, so no test depends on the machine it runs on.
 */
function access(entries: Record<string, FakeEntry>) {
  return {
    getuid: () => OWNER_UID,
    stat: async (path: string) => {
      const entry = entries[path]
      if (entry === undefined) throw fail("ENOENT")
      if (entry.statCode !== undefined) throw fail(entry.statCode)
      return {
        isFile: () => entry.directory !== true,
        mode: entry.mode ?? 0o100600,
        uid: entry.uid ?? OWNER_UID,
        size: entry.size ?? Buffer.byteLength(entry.source ?? ""),
      }
    },
    readFile: async (path: string) => {
      const entry = entries[path]
      if (entry?.readCode !== undefined) throw fail(entry.readCode)
      return entry?.source ?? ""
    },
  }
}

/** Loads a configuration expected to be rejected, and reports the rejection. */
async function loadError(options: Parameters<typeof loadProxyConfig>[0]) {
  try {
    await loadProxyConfig(options)
  } catch (error) {
    return error as Error
  }
  throw new Error("the configuration was expected to be rejected")
}

async function loadFailure(options: Parameters<typeof loadProxyConfig>[0]) {
  const error = await loadError(options)
  expect(error).toBeInstanceOf(ProxyConfigurationError)
  return error.message
}

/** A file that needs no built-in default to validate. */
const COMPLETE_YAML = `version: 1
deploymentId: complete-deployment
listen:
  host: 127.0.0.1
  port: 4100
publicOrigin: http://127.0.0.1:4100
runtime:
  id: hermes-main
  kind: hermes
  baseUrl: http://127.0.0.1:9119
  tokenFile: /run/secrets/hermes-token
  sessionIdleMs: 300000
limits:
  activeExecutions: 256
  guestActiveExecutions: 32
  operatorEventPeers: 256
  subscriberEvents: 512
  subscriberBytes: 2097152
shutdownGraceMs: 5000
`

/** Everything an operator must still write once the defaults are applied. */
const MINIMAL_YAML = `deploymentId: local-dev
publicOrigin: http://127.0.0.1:3000
runtime:
  id: hermes-main
  kind: hermes
  baseUrl: http://127.0.0.1:9119
  tokenFile: /run/secrets/hermes-token
`

const MINIMAL_CONFIG = {
  version: 1,
  deploymentId: "local-dev",
  listen: { host: "127.0.0.1", port: 4100 },
  publicOrigin: "http://127.0.0.1:3000",
  runtime: {
    id: "hermes-main",
    kind: "hermes",
    baseUrl: "http://127.0.0.1:9119",
    tokenFile: "/run/secrets/hermes-token",
    sessionIdleMs: 300_000,
  },
  limits: {
    activeExecutions: 256,
    guestActiveExecutions: 32,
    operatorEventPeers: 256,
    subscriberEvents: 512,
    subscriberBytes: 2_097_152,
  },
  shutdownGraceMs: 5_000,
}

describe("proxy configuration file reading", () => {
  it("reads an explicit file the current user owns", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({ [CONFIG_PATH]: { source: COMPLETE_YAML } }),
      })
    ).resolves.toMatchObject({ deploymentId: "complete-deployment" })
  })

  it("accepts a root-owned read-only file, as a container config mount is", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, uid: 0, mode: 0o100444 },
        }),
      })
    ).resolves.toMatchObject({ deploymentId: "complete-deployment" })
  })

  it("names an explicit path that is missing", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({}),
    })
    expect(message).toContain(CONFIG_PATH)
  })

  it("names the path and the code of any other read failure", async () => {
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({ [CONFIG_PATH]: { statCode: "EACCES" } }),
      })
    ).toContain("EACCES")
    const readFailure = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({ [CONFIG_PATH]: { readCode: "EISDIR" } }),
    })
    expect(readFailure).toContain(CONFIG_PATH)
    expect(readFailure).toContain("EISDIR")
  })

  it("rejects a file that is not regular, is group-writable, or is owned by another user", async () => {
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, directory: true },
        }),
      })
    ).toContain("regular file")
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, mode: 0o100664 },
        }),
      })
    ).toContain("writable")
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, uid: OWNER_UID + 1 },
        }),
      })
    ).toContain("owned")
  })

  it("fails the ownership check when no process uid is available", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({ [CONFIG_PATH]: { source: COMPLETE_YAML } }),
      getuid: undefined,
    })
    expect(message).toContain(CONFIG_PATH)
  })

  it("treats a missing discovered path as an empty document and says so", async () => {
    const message = await loadFailure({
      getenv: env({ XDG_CONFIG_HOME: "/config" }),
      ...access({}),
    })
    expect(message).toContain(DISCOVERED_PATH)
    expect(message).toContain("absent")
    expect(message).toContain("deploymentId")
  })

  it("rejects a duplicate key with a code and a line, never the source text", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({
        [CONFIG_PATH]: {
          source:
            "publicOrigin: http://127.0.0.1:3000\npublicOrigin: http://127.0.0.1:3001\n",
        },
      }),
    })
    expect(message).toContain("DUPLICATE_KEY")
    expect(message).toContain("line 2")
    expect(message).not.toContain("127.0.0.1")
  })

  it("rejects an unresolved custom tag without letting the parser warn", async () => {
    const warnings: string[] = []
    const listener = (warning: Error) => warnings.push(warning.message)
    process.on("warning", listener)
    try {
      const message = await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: "runtime: !ruby/object:Foo {}\n" },
        }),
      })
      expect(message).toContain("TAG_RESOLVE_FAILED")
      expect(message).not.toContain("ruby")
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(warnings).toEqual([])
    } finally {
      process.off("warning", listener)
    }
  })

  it("rejects an oversized file, several documents, and an alias", async () => {
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, size: 1_048_577 },
        }),
      })
    ).toContain(CONFIG_PATH)
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: {
            source: "deploymentId: one\n---\ndeploymentId: two\n",
          },
        }),
      })
    ).toContain("single YAML document")
    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: {
            source:
              "loopback: &host 127.0.0.1\nlisten:\n  host: *host\n  port: 4100\n",
          },
        }),
      })
    ).toMatch(/alias/iu)
  })

  it("accepts a file of exactly the size limit", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: COMPLETE_YAML, size: 1_048_576 },
        }),
      })
    ).resolves.toMatchObject({ deploymentId: "complete-deployment" })
  })

  it("rejects a document whose root is not a mapping", async () => {
    for (const source of ["a synthetic scalar\n", "- one\n- two\n"])
      expect(
        await loadFailure({
          flag: CONFIG_PATH,
          getenv: env({}),
          ...access({ [CONFIG_PATH]: { source } }),
        })
      ).toContain(CONFIG_PATH)
  })

  it("reads an empty or comment-only document as no configuration at all", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({ [CONFIG_PATH]: { source: "# nothing configured yet\n" } }),
    })
    expect(message).toContain("deploymentId")
  })

  it("rejects prototype-shaped keys in a mapping and in a sequence item", async () => {
    const sources = [
      "runtime:\n  __proto__:\n    polluted: true\n",
      "guest:\n  invitations:\n    keys:\n      - __proto__:\n          polluted: true\n",
      "constructor: 1\n",
      "runtime:\n  prototype: 1\n",
    ]
    for (const source of sources)
      expect(
        await loadFailure({
          flag: CONFIG_PATH,
          getenv: env({}),
          ...access({ [CONFIG_PATH]: { source } }),
        })
      ).toContain(CONFIG_PATH)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("proxy configuration defaults and merging", () => {
  it("fills every default a minimal file leaves out", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).resolves.toEqual(MINIMAL_CONFIG)
  })

  it("merges a partial block instead of replacing it, and never mutates the defaults", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: { source: `${MINIMAL_YAML}listen:\n  port: 4200\n` },
        }),
      })
    ).resolves.toMatchObject({ listen: { host: "127.0.0.1", port: 4200 } })

    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).resolves.toEqual(MINIMAL_CONFIG)
  })

  it("defaults the Hermes session idle window only for a Hermes runtime", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({}),
        ...access({
          [CONFIG_PATH]: {
            source: `deploymentId: opencode-dev
publicOrigin: http://127.0.0.1:3000
runtime:
  id: opencode-main
  kind: opencode
  baseUrl: http://127.0.0.1:4096
  directory: /srv/worktree
  username: operator
  passwordFile: /run/secrets/opencode-password
`,
          },
        }),
      })
    ).resolves.toMatchObject({
      runtime: { kind: "opencode", directory: "/srv/worktree" },
    })
  })

  it("names the listener and both of its shapes when a wildcard host has no exposure", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({
        [CONFIG_PATH]: {
          source: `${MINIMAL_YAML}listen:\n  host: 0.0.0.0\n  port: 3000\n`,
        },
      }),
    })
    expect(message).toContain("listen")
    expect(message).toContain("127.0.0.1")
    expect(message).toContain("private-container")
  })

  it("names an omitted required field that has no default", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({
        [CONFIG_PATH]: {
          source: `deploymentId: local-dev
runtime:
  id: hermes-main
  kind: hermes
  baseUrl: http://127.0.0.1:9119
  tokenFile: /run/secrets/hermes-token
`,
        },
      }),
    })
    expect(message).toContain("publicOrigin")
  })
})

/** The value every override row is exercised with, keyed by its suffix. */
const EVERY_OVERRIDE: Record<string, string> = {
  DEPLOYMENT_ID: "env-deployment",
  PUBLIC_ORIGIN: "https://aos.example.test",
  LISTEN_HOST: "0.0.0.0",
  LISTEN_PORT: "4100",
  LISTEN_EXPOSURE: "private-container",
  RUNTIME_ID: "hermes-env",
  RUNTIME_KIND: "hermes",
  RUNTIME_BASE_URL: "http://127.0.0.1:9119",
  RUNTIME_TOKEN_FILE: "/run/secrets/hermes-token",
  RUNTIME_SESSION_IDLE_MS: "300000",
  LIMITS_ACTIVE_EXECUTIONS: "256",
  LIMITS_GUEST_ACTIVE_EXECUTIONS: "32",
  LIMITS_OPERATOR_EVENT_PEERS: "256",
  LIMITS_SUBSCRIBER_EVENTS: "512",
  LIMITS_SUBSCRIBER_BYTES: "2097152",
  GUEST_LISTEN_HOST: "0.0.0.0",
  GUEST_LISTEN_PORT: "4101",
  GUEST_LISTEN_EXPOSURE: "private-container",
  GUEST_PUBLIC_ORIGIN: "https://guest.example.test",
  GUEST_INVITATIONS_TTL_SECONDS: "259200",
  GUEST_INVITATIONS_CLOCK_SKEW_SECONDS: "0",
  PUSH_STATE_DIR: "/var/lib/aos-ui/push",
  PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
  PUSH_VAPID_PRIVATE_KEY_FILE: "/run/secrets/vapid-private-key",
  VOICE_TRANSCRIPTION_PROVIDER: "openai-compatible",
  VOICE_TRANSCRIPTION_BASE_URL: "https://voice.example.test",
  VOICE_TRANSCRIPTION_API_KEY_FILE: "/run/secrets/voice-key",
  VOICE_TRANSCRIPTION_MODEL: "synthetic-transcribe",
  VOICE_TRANSCRIPTION_MODE: "fallback",
  VOICE_TRANSCRIPTION_TIMEOUT_MS: "60000",
  VOICE_TRANSCRIPTION_LANGUAGE: "en",
  VOICE_SPEECH_PROVIDER: "openai-compatible",
  VOICE_SPEECH_BASE_URL: "https://voice.example.test",
  VOICE_SPEECH_API_KEY_FILE: "/run/secrets/voice-key",
  VOICE_SPEECH_MODEL: "synthetic-speak",
  VOICE_SPEECH_MODE: "override",
  VOICE_SPEECH_TIMEOUT_MS: "60000",
  VOICE_SPEECH_VOICE: "synthetic-voice",
  VOICE_SPEECH_FORMAT: "mp3",
  SHUTDOWN_GRACE_MS: "5000",
}

describe("proxy configuration environment overrides", () => {
  it("lets an override win over the file", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({
          AOS_UI_PROXY_DEPLOYMENT_ID: "env-deployment",
          AOS_UI_PROXY_LISTEN_PORT: " 4200 ",
          AOS_UI_PROXY_RUNTIME_SESSION_IDLE_MS: "60000",
          AOS_UI_PROXY_LIMITS_SUBSCRIBER_EVENTS: "1024",
        }),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).resolves.toMatchObject({
      deploymentId: "env-deployment",
      listen: { host: "127.0.0.1", port: 4_200 },
      runtime: { sessionIdleMs: 60_000 },
      limits: { subscriberEvents: 1_024 },
    })
  })

  it("names the variable, never the value, when an integer override is not a number", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_LISTEN_PORT: "42ab" }),
      ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
    })
    expect(message).toContain("AOS_UI_PROXY_LISTEN_PORT")
    expect(message).not.toContain("42ab")
  })

  it("reports an out-of-range override at its field and names the variable", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_LISTEN_PORT: "70000" }),
      ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
    })
    expect(message).toContain("listen.port")
    expect(message).toContain("AOS_UI_PROXY_LISTEN_PORT")
    expect(message).not.toContain("70000")
  })

  it("names the accepted runtime kinds when the kind matches none, from the file or the environment", async () => {
    const fromFile = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({
        [CONFIG_PATH]: {
          source: MINIMAL_YAML.replace("kind: hermes", "kind: hermez"),
        },
      }),
    })
    expect(fromFile).toContain("runtime.kind")
    expect(fromFile).toContain("hermes")
    expect(fromFile).toContain("opencode")
    expect(fromFile).toContain("openclaw")
    expect(fromFile).not.toContain("hermez")

    const fromEnvironment = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_RUNTIME_KIND: "hermez" }),
      ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
    })
    expect(fromEnvironment).toContain("runtime.kind")
    expect(fromEnvironment).toContain("set by AOS_UI_PROXY_RUNTIME_KIND")
    expect(fromEnvironment).not.toContain("hermez")
  })

  it("switches the runtime branch from the environment and rejects an off-branch variable", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({
          AOS_UI_PROXY_RUNTIME_KIND: "opencode",
          AOS_UI_PROXY_RUNTIME_BASE_URL: "http://127.0.0.1:4096",
          AOS_UI_PROXY_RUNTIME_DIRECTORY: "/srv/worktree",
          AOS_UI_PROXY_RUNTIME_USERNAME: "operator",
          AOS_UI_PROXY_RUNTIME_PASSWORD_FILE: "/run/secrets/opencode-password",
        }),
        // An override cannot remove a file key, so the file names no branch.
        ...access({
          [CONFIG_PATH]: {
            source: `deploymentId: local-dev
publicOrigin: http://127.0.0.1:3000
runtime:
  id: switched-main
`,
          },
        }),
      })
    ).resolves.toMatchObject({
      runtime: {
        kind: "opencode",
        directory: "/srv/worktree",
        username: "operator",
      },
    })

    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({
        AOS_UI_PROXY_RUNTIME_KIND: "opencode",
        AOS_UI_PROXY_RUNTIME_TOKEN_FILE: "/run/secrets/hermes-token",
      }),
      ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
    })
    expect(message).toContain("AOS_UI_PROXY_RUNTIME_TOKEN_FILE")
    expect(message).toContain("hermes")
  })

  it("creates the push block from the environment and reports a partial one", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({
          AOS_UI_PROXY_PUSH_STATE_DIR: "/var/lib/aos-ui/push",
          AOS_UI_PROXY_PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
          AOS_UI_PROXY_PUSH_VAPID_PRIVATE_KEY_FILE:
            "/run/secrets/vapid-private-key",
        }),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).resolves.toMatchObject({
      push: {
        stateDir: "/var/lib/aos-ui/push",
        vapid: {
          subject: "mailto:ops@example.test",
          privateKeyFile: "/run/secrets/vapid-private-key",
        },
      },
    })

    expect(
      await loadFailure({
        flag: CONFIG_PATH,
        getenv: env({ AOS_UI_PROXY_PUSH_STATE_DIR: "/var/lib/aos-ui/push" }),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).toContain("push.vapid")
  })

  it("creates a voice direction from the environment alone", async () => {
    await expect(
      loadProxyConfig({
        flag: CONFIG_PATH,
        getenv: env({
          AOS_UI_PROXY_VOICE_TRANSCRIPTION_PROVIDER: "openai-compatible",
          AOS_UI_PROXY_VOICE_TRANSCRIPTION_BASE_URL:
            "https://voice.example.test",
          AOS_UI_PROXY_VOICE_TRANSCRIPTION_MODEL: "synthetic-transcribe",
          AOS_UI_PROXY_VOICE_TRANSCRIPTION_LANGUAGE: "en",
          AOS_UI_PROXY_VOICE_SPEECH_PROVIDER: "openai-compatible",
          AOS_UI_PROXY_VOICE_SPEECH_BASE_URL: "https://voice.example.test",
          AOS_UI_PROXY_VOICE_SPEECH_MODEL: "synthetic-speak",
          AOS_UI_PROXY_VOICE_SPEECH_VOICE: "synthetic-voice",
          AOS_UI_PROXY_VOICE_SPEECH_TIMEOUT_MS: "30000",
        }),
        ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
      })
    ).resolves.toMatchObject({
      voice: {
        transcription: {
          model: "synthetic-transcribe",
          language: "en",
          mode: "fallback",
          timeoutMs: 60_000,
        },
        speech: {
          model: "synthetic-speak",
          voice: "synthetic-voice",
          format: "mp3",
          timeoutMs: 30_000,
        },
      },
    })
  })

  it("treats a guest key with no value as no guest block", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_GUEST_LISTEN_PORT: "4101" }),
      ...access({ [CONFIG_PATH]: { source: `${MINIMAL_YAML}guest: ~\n` } }),
    })
    expect(message).toContain("AOS_UI_PROXY_GUEST_LISTEN_PORT")
    expect(message).toContain("guest block")
  })

  it("lets the schema report an unknown runtime kind before any branch row is judged", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_RUNTIME_TOKEN_FILE: "/run/secrets/token" }),
      ...access({
        [CONFIG_PATH]: {
          source: MINIMAL_YAML.replace("kind: hermes", "kind: hermez"),
        },
      }),
    })
    expect(message).toContain("runtime.kind")
    expect(message).not.toContain("applies only")
  })

  it("refuses a guest override when the file has no guest block", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({ AOS_UI_PROXY_GUEST_LISTEN_PORT: "4101" }),
      ...access({ [CONFIG_PATH]: { source: MINIMAL_YAML } }),
    })
    expect(message).toContain("AOS_UI_PROXY_GUEST_LISTEN_PORT")
    expect(message).toContain("guest")
  })

  it("cannot complete a guest lane from the environment, because its keys are file-only", async () => {
    const values: Record<string, string> = {}
    for (const row of PROXY_ENV_OVERRIDES) {
      if (row.appliesWhen !== undefined && row.appliesWhen === "opencode")
        continue
      if (row.appliesWhen !== undefined && row.appliesWhen === "openclaw")
        continue
      const value = EVERY_OVERRIDE[row.suffix]
      expect(value, `${row.suffix} needs a value in this test`).toBeDefined()
      values[`${PROXY_ENV_PREFIX}${row.suffix}`] = value!
    }

    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env(values),
      ...access({ [CONFIG_PATH]: { source: `${MINIMAL_YAML}guest: {}\n` } }),
    })
    expect(message).toContain("guest.invitations.keys")
  })

  it("keeps one override row for every scalar leaf, and no row without one", () => {
    const runtimes: Record<string, Record<string, unknown>> = {
      hermes: {
        id: "hermes-main",
        kind: "hermes",
        baseUrl: "http://127.0.0.1:9119",
        tokenFile: "/run/secrets/hermes-token",
        sessionIdleMs: 300_000,
      },
      opencode: {
        id: "opencode-main",
        kind: "opencode",
        baseUrl: "http://127.0.0.1:4096",
        directory: "/srv/worktree",
        username: "operator",
        passwordFile: "/run/secrets/opencode-password",
      },
      openclaw: {
        id: "openclaw-main",
        kind: "openclaw",
        baseUrl: "wss://openclaw.example.test",
        deviceIdentityFile: "/run/secrets/openclaw-identity",
        deviceTokenFile: "/run/secrets/openclaw-token",
      },
    }
    const populated = (runtime: Record<string, unknown>) => ({
      version: 1,
      deploymentId: "drift-deployment",
      listen: { host: "0.0.0.0", port: 4_100, exposure: "private-container" },
      publicOrigin: "https://aos.example.test",
      runtime,
      limits: {
        activeExecutions: 256,
        guestActiveExecutions: 32,
        operatorEventPeers: 256,
        subscriberEvents: 512,
        subscriberBytes: 2_097_152,
      },
      guest: {
        listen: { host: "0.0.0.0", port: 4_101, exposure: "private-container" },
        publicOrigin: "https://guest.example.test",
        invitations: {
          keys: [{ id: "current", secretFile: "/run/secrets/invitation-key" }],
          ttlSeconds: 259_200,
          clockSkewSeconds: 0,
        },
      },
      push: {
        stateDir: "/var/lib/aos-ui/push",
        vapid: {
          subject: "mailto:ops@example.test",
          privateKeyFile: "/run/secrets/vapid-private-key",
        },
      },
      voice: {
        transcription: {
          provider: "openai-compatible",
          baseUrl: "https://voice.example.test",
          apiKeyFile: "/run/secrets/voice-key",
          model: "synthetic-transcribe",
          mode: "fallback",
          timeoutMs: 60_000,
          language: "en",
        },
        speech: {
          provider: "openai-compatible",
          baseUrl: "https://voice.example.test",
          apiKeyFile: "/run/secrets/voice-key",
          model: "synthetic-speak",
          mode: "override",
          timeoutMs: 60_000,
          voice: "synthetic-voice",
          format: "mp3",
        },
      },
      shutdownGraceMs: 5_000,
    })

    const leaves = (
      value: unknown,
      prefix: string[] = []
    ): Array<{ path: string; array: boolean }> => {
      if (Array.isArray(value)) return [{ path: prefix.join("."), array: true }]
      if (typeof value === "object" && value !== null)
        return Object.entries(value).flatMap(([key, child]) =>
          leaves(child, [...prefix, key])
        )
      return [{ path: prefix.join("."), array: false }]
    }

    const rows = new Set(
      PROXY_ENV_OVERRIDES.map((override) => override.path.join("."))
    )
    const reachable = new Set<string>()
    for (const runtime of Object.values(runtimes))
      for (const leaf of leaves(parseProxyConfig(populated(runtime)))) {
        if (leaf.array) continue
        reachable.add(leaf.path)
        if (leaf.path === "version") continue
        expect(rows.has(leaf.path), `${leaf.path} has no override row`).toBe(
          true
        )
      }
    for (const path of rows)
      expect(reachable.has(path), `${path} is not a configuration leaf`).toBe(
        true
      )
  })

  it("never lets a secret-bearing field be set by value", () => {
    // Every credential leaf is reachable only as a file path, so a row whose
    // name ends in a secret word must be a *_FILE row.
    for (const { suffix } of PROXY_ENV_OVERRIDES)
      if (/(TOKEN|PASSWORD|SECRET|KEY|IDENTITY)$/u.test(suffix))
        expect(suffix).toMatch(/_FILE$/u)
  })

  it("claims no variable name the deployment already uses", () => {
    const names = PROXY_ENV_OVERRIDES.map(
      (override) => `${PROXY_ENV_PREFIX}${override.suffix}`
    )
    expect(new Set(names).size).toBe(names.length)
    for (const reserved of [
      "AOS_UI_PROXY_TARGET",
      "AOS_UI_PROXY_HOST",
      "AOS_UI_PROXY_PORT",
      "AOS_UI_PROXY_CONFIG_FILE",
    ])
      expect(names).not.toContain(reserved)
  })
})

describe("proxy configuration reporting", () => {
  it("keeps a rejected value and a rejected key out of the message", async () => {
    const message = await loadFailure({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({
        [CONFIG_PATH]: {
          source: `deploymentId: local-dev
publicOrigin: SYNTHETIC-TOKEN-9f3a
SYNTHETIC-TOKEN-9f3a: 1
runtime:
  id: hermes-main
  kind: hermes
  baseUrl: http://127.0.0.1:9119
  tokenFile: /run/secrets/hermes-token
`,
        },
      }),
    })
    expect(message).not.toContain("SYNTHETIC-TOKEN-9f3a")
    expect(message).toContain("publicOrigin")
    expect(message).toContain("1 unrecognized key")
  })

  it("survives the log redactor a start failure is written through", async () => {
    const error = await loadError({
      flag: CONFIG_PATH,
      getenv: env({}),
      ...access({ [CONFIG_PATH]: { source: "deploymentId: local-dev\n" } }),
    })

    expect(
      redactForLog({
        event: "proxy.start_failed",
        error: describeStartFailure(error),
      })
    ).toEqual({
      event: "proxy.start_failed",
      error: { name: "ProxyConfigurationError", message: error.message },
    })
    expect(error.message).toContain("publicOrigin")

    // Every other failure stays opaque, as the shared redactor intends.
    expect(redactForLog(describeStartFailure(new Error("boom")))).toEqual({
      name: "Error",
      message: "Upstream request failed",
    })
  })
})
