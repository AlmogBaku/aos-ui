import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto"

import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info"

import type { RuntimeLimits } from "../../config"
import { createCoordinator } from "../create-coordinator"
import type { RuntimeServices } from "../create-runtime"
import type { ServerLink } from "../../core/link"
import type { RuntimeInstance } from "../../core/runtime"
import { withMcpApps } from "../../mcp-apps/annotate"
import type { CredentialValues } from "../../redaction"
import { readSecretFile } from "../../secrets"
import { OpenClawServerAdapter, openClawPublicError } from "./adapter"
import {
  OpenClawClient,
  type OpenClawClientOptions,
  type OpenClawGatewayClient,
} from "./client"
import { OpenClawInteractions } from "./interactions"
import { createOpenClawMcpToolNames } from "./mcp-tool-names"
import { OpenClawTurnEngine } from "./run"
import { OpenClawSessionSubscriptions } from "./subscriptions"

export type OpenClawRuntimeConfig = Readonly<{
  kind: "openclaw"
  id: string
  baseUrl: string
  deviceIdentityFile: string
  deviceTokenFile: string
}>

type OpenClawRuntimeClient = OpenClawGatewayClient & {
  readonly link: ServerLink
  negotiatedPolicy?(): ReturnType<OpenClawClient["negotiatedPolicy"]>
}

export type OpenClawRuntimeFactoryDependencies = RuntimeServices &
  Readonly<{
    clientFactory?: (options: OpenClawClientOptions) => OpenClawRuntimeClient
  }>

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function publicKeyBytes(publicKeyPem: string) {
  let key: KeyObject
  try {
    key = createPublicKey(publicKeyPem)
  } catch {
    throw new Error("Invalid OpenClaw device identity")
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Invalid OpenClaw device identity")
  const der = key.export({ type: "spki", format: "der" })
  if (
    der.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32 ||
    !der.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)
  )
    throw new Error("Invalid OpenClaw device identity")
  return der.subarray(ED25519_SPKI_PREFIX.byteLength)
}

function privateKey(privateKeyPem: string) {
  try {
    const key = createPrivateKey(privateKeyPem)
    if (key.asymmetricKeyType !== "ed25519") throw new Error()
    return key
  } catch {
    throw new Error("Invalid OpenClaw device identity")
  }
}

/** The device identity file, checked against the key pair it carries. */
async function readDeviceIdentity(path: string) {
  const encoded = await readSecretFile(path)
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error("Invalid OpenClaw device identity")
  }
  if (
    !record(value) ||
    typeof value.deviceId !== "string" ||
    !value.deviceId.trim() ||
    typeof value.privateKeyPem !== "string" ||
    typeof value.publicKeyPem !== "string"
  )
    throw new Error("Invalid OpenClaw device identity")
  const privateKeyValue = privateKey(value.privateKeyPem)
  const publicKeyValue = publicKeyBytes(value.publicKeyPem)
  const derivedPublicKey = createPublicKey(privateKeyValue).export({
    type: "spki",
    format: "der",
  })
  const deviceId = createHash("sha256").update(publicKeyValue).digest("hex")
  if (
    !/^[a-f0-9]{64}$/u.test(value.deviceId) ||
    value.deviceId !== deviceId ||
    !derivedPublicKey.equals(
      Buffer.concat([ED25519_SPKI_PREFIX, publicKeyValue])
    )
  )
    throw new Error("Invalid OpenClaw device identity")
  return {
    deviceId: value.deviceId,
    privateKeyPem: value.privateKeyPem,
    publicKeyPem: value.publicKeyPem,
  }
}

async function readCredentials(
  config: OpenClawRuntimeConfig,
  credentials: CredentialValues
) {
  const [deviceIdentity, deviceToken] = await Promise.all([
    credentials.register(readDeviceIdentity, ({ privateKeyPem }) => [
      privateKeyPem,
    ])(config.deviceIdentityFile),
    credentials.register(readSecretFile, (value) => [value])(
      config.deviceTokenFile
    ),
  ])
  return {
    deviceIdentity,
    deviceToken,
    signDevicePayload: (pem: string, payload: string) =>
      sign(null, Buffer.from(payload, "utf8"), privateKey(pem)).toString(
        "base64url"
      ),
    publicKeyRawBase64UrlFromPem: (pem: string) =>
      publicKeyBytes(pem).toString("base64url"),
  }
}

/** The gateway serves HTTP on its WebSocket origin; media tickets resolve there. */
function gatewayHttpOrigin(baseUrl: string) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  return url.origin
}

export async function createOpenClawRuntime(
  config: OpenClawRuntimeConfig,
  limits: RuntimeLimits,
  dependencies: OpenClawRuntimeFactoryDependencies
): Promise<RuntimeInstance> {
  const credentials = () => readCredentials(config, dependencies.credentials)
  // Read once here so a bad identity fails startup; every dial reads again.
  await credentials()
  const { logger } = dependencies
  const state: { subscriptions?: OpenClawSessionSubscriptions } = {}
  const resubscribe = (reason: "gap" | "reconnect") => {
    state.subscriptions
      ?.replaceGeneration(reason)
      .catch((err: unknown) =>
        logger.warn({ err, reason }, "openclaw.subscription.replace_failed")
      )
  }
  const client = (
    dependencies.clientFactory ?? ((options) => new OpenClawClient(options))
  )({
    url: config.baseUrl,
    credentials,
    role: "operator",
    scopes: [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      // A Session's `toolOverrides` enable the `aos-ui` MCP server; the gateway
      // admits that field on create and patch only with admin scope.
      "operator.admin",
    ],
    caps: [
      GATEWAY_CLIENT_CAPS.APPROVALS,
      GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    ],
    onEvent(event) {
      state.subscriptions?.accept(event, state.subscriptions.generation)
    },
    onGap() {
      resubscribe("gap")
    },
    logger,
  })
  const subscriptions = new OpenClawSessionSubscriptions(client, logger)
  state.subscriptions = subscriptions
  // Each time the link is up, the first included, re-subscribes on a fresh
  // generation; a drop holds delivery until then.
  client.link.subscribe((link) => {
    if (link === "ready") resubscribe("reconnect")
    else subscriptions.pause()
  })
  const interactions = new OpenClawInteractions(client)
  const mcpToolNames = createOpenClawMcpToolNames(client)
  const turns = new OpenClawTurnEngine({
    client,
    subscriptions,
    toolEvents: true,
    replies: interactions,
    mcpToolNames,
    watch: { publicError: openClawPublicError, upstream: client.link, logger },
  })
  // Wrapped before the coordinator, which runs turns through `runtime.turns`.
  const runtime = withMcpApps(
    new OpenClawServerAdapter({
      client,
      turns,
      gatewayOrigin: gatewayHttpOrigin(config.baseUrl),
      mcpToolNames,
      subscribeSession: async (agentId, sessionKey, onInvalidate) => {
        const lease = await subscriptions!.acquire(
          { agentId, sessionKey },
          onInvalidate
        )
        return () => {
          lease
            .release()
            .catch((err: unknown) =>
              logger.warn({ err }, "openclaw.history.release_failed")
            )
        }
      },
    })
  )
  const sessions = createCoordinator(runtime, limits, logger)
  let closePromise: Promise<void> | undefined
  return {
    id: config.id,
    runtime,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        subscriptions.close()
        await runtime.close()
      })
      return closePromise
    },
  }
}
