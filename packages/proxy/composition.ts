import type { Logger } from "../lifecycle"
import { createOperatorAcpService } from "./acp/operator"
import { createCatalog } from "./core/catalog"
import { createChannels } from "./core/channel"
import {
  createRuntimeInstance,
  type RuntimeFactory,
} from "./adapters/create-runtime"
import { createProxyApp } from "./app"
import { AttachmentStageRegistry } from "./core/attachment-stages"
import {
  createGuestInvitationService,
  type GuestInvitationKey,
  type GuestInvitationService,
} from "./auth/guest-invitation"
import {
  parseProxyConfig,
  type McpAppsConfig,
  type ProxyConfig,
  type VoiceConfig,
} from "./config"
import type { McpServerOverrides } from "./mcp-apps/client"
import { OPERATOR_PRINCIPAL } from "./core/principal"
import type { RuntimeInstance } from "./core/runtime"
import { createSessionRows, type SessionRows } from "./core/session-rows"
import { createGuestAcpService } from "./guest/acp"
import { createGuestApp } from "./guest/app"
import { createGuestAttachmentStages } from "./guest/context"
import { createPushDispatcher } from "./push/dispatcher"
import { createPresenceRegistry } from "./push/presence"
import { openPushRegistrations } from "./push/registrations"
import { createPushSender } from "./push/sender"
import { deriveVapidPublicKey } from "./push/vapid"
import type { CredentialValues } from "./redaction"
import { readSecretFile, readSecretKeyFile } from "./secrets"
import {
  createOpenAiCompatibleSynthesizer,
  createOpenAiCompatibleTranscriber,
} from "./voice/openai-compatible"
import { withVoiceProviders, type VoiceProviders } from "./voice/runtime"

export type ConfiguredProxyDependencies = {
  runtimeFactory?: RuntimeFactory
  logger: Logger
  /** The credential values the log masks; every secret read here joins it. */
  credentials: CredentialValues
  clock?: () => number
  /** The browser build the static root carries, read once at start. */
  buildId?: string
  /** Reaches the configured speech providers; tests hand in a stub. */
  fetch?: typeof fetch
}

/** The composition's secret readers, each recording what it reads. */
type SecretReaders = {
  secret: (path: string) => Promise<string>
  key: (path: string) => Promise<Uint8Array>
}

/** One provider per configured direction, each key read once at startup. */
async function createVoiceProviders(
  voice: VoiceConfig,
  fetchImpl: typeof fetch,
  readers: SecretReaders
): Promise<VoiceProviders> {
  const apiKey = (file: string | undefined) =>
    file === undefined ? undefined : readers.secret(file)
  const [transcriptionKey, speechKey] = await Promise.all([
    apiKey(voice.transcription?.apiKeyFile),
    apiKey(voice.speech?.apiKeyFile),
  ])
  return {
    ...(voice.transcription
      ? {
          transcription: {
            mode: voice.transcription.mode,
            provider: createOpenAiCompatibleTranscriber(
              voice.transcription,
              transcriptionKey,
              fetchImpl
            ),
          },
        }
      : {}),
    ...(voice.speech
      ? {
          speech: {
            mode: voice.speech.mode,
            provider: createOpenAiCompatibleSynthesizer(
              voice.speech,
              speechKey,
              fetchImpl
            ),
          },
        }
      : {}),
  }
}

/** Header values, each read once at startup from its own file. */
async function readHeaderFiles(
  headers: Record<string, { file: string }>,
  readers: SecretReaders
) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(headers).map(
        async ([header, { file }]) =>
          [header, await readers.secret(file)] as const
      )
    )
  )
}

/** Each configured fallback server: its URL override and its headers. */
async function readMcpServerOverrides(
  mcpApps: McpAppsConfig | undefined,
  readers: SecretReaders
): Promise<McpServerOverrides> {
  const servers = Object.entries(mcpApps?.fallback?.servers ?? {})
  return new Map(
    await Promise.all(
      servers.map(
        async ([name, { url, headers }]) =>
          [
            name,
            {
              ...(url ? { url } : {}),
              ...(headers
                ? { headers: await readHeaderFiles(headers, readers) }
                : {}),
            },
          ] as const
      )
    )
  )
}

/**
 * Everything one push-enabled deployment needs: the public key derived from the
 * configured private one, the stored devices, the presence the ACP listener
 * reports into, and the dispatcher that subscribes to the runtime. A state directory
 * the proxy cannot write fails startup here rather than at the first
 * notification.
 */
async function createPushDelivery(
  push: NonNullable<ProxyConfig["push"]>,
  runtimeInstance: RuntimeInstance,
  sessionRows: SessionRows,
  dependencies: ConfiguredProxyDependencies,
  clock: { now?: () => number },
  readers: SecretReaders
) {
  const privateKey = await readers.key(push.vapid.privateKeyFile)
  const registrations = await openPushRegistrations({
    stateDir: push.stateDir,
    logger: dependencies.logger,
  })
  const publicKey = deriveVapidPublicKey(privateKey)
  const presence = createPresenceRegistry(clock)
  const dispatcher = createPushDispatcher({
    runtimeInstance,
    sessionRows,
    registrations,
    presence,
    sender: createPushSender({
      vapid: { subject: push.vapid.subject, publicKey, privateKey },
    }),
    // One operator owns every Agent on this surface.
    principalOf: () => OPERATOR_PRINCIPAL,
    logger: dependencies.logger,
    ...clock,
  })
  return { publicKey, registrations, presence, dispatcher }
}

/** Loads secrets once and constructs one runtime shared by every listener. */
export async function createConfiguredProxy(
  input: unknown,
  dependencies: ConfiguredProxyDependencies
) {
  const config = parseProxyConfig(input)
  /** One injected clock, in the shape every constructed service takes it. */
  const clock =
    dependencies.clock === undefined ? {} : { now: dependencies.clock }
  const { credentials } = dependencies
  const readers: SecretReaders = {
    secret: credentials.register(readSecretFile, (value) => [value]),
    // A key file holds the key's base64url spelling, which is what could leak.
    key: credentials.register(readSecretKeyFile, (key) => [
      Buffer.from(key).toString("base64url"),
    ]),
  }
  const mcpServerOverrides = await readMcpServerOverrides(
    config.mcpApps,
    readers
  )
  const [nativeInstance, invitationKeys, voiceProviders] = await Promise.all([
    (dependencies.runtimeFactory ?? createRuntimeInstance)(
      config.runtime,
      config.limits,
      { logger: dependencies.logger, credentials, mcpServerOverrides }
    ),
    config.guest
      ? Promise.all(
          config.guest.invitations.keys.map(
            async ({ id, secretFile }): Promise<GuestInvitationKey> => ({
              id,
              secret: await readers.key(secretFile),
            })
          )
        )
      : Promise.resolve(undefined),
    config.voice
      ? createVoiceProviders(config.voice, dependencies.fetch ?? fetch, readers)
      : Promise.resolve(undefined),
  ])
  // Proxy speech sits in front of the adapter for every listener at once, so the
  // wrapped runtime is the only one any listener or ACP service ever sees.
  const runtimeInstance: RuntimeInstance = voiceProviders
    ? {
        ...nativeInstance,
        runtime: withVoiceProviders(
          nativeInstance.runtime,
          voiceProviders,
          dependencies.logger
        ),
      }
    : nativeInstance
  // The coordinator was built on the adapter's runtime; its capabilities read
  // through the wrapped one, so a provider's speech reaches every subscriber.
  runtimeInstance.sessions.bindCapabilities(runtimeInstance.runtime)
  const invitations =
    config.guest && invitationKeys
      ? createGuestInvitationService({
          issuer: "aos-invite",
          audience: "aos-guest",
          deploymentId: config.deploymentId,
          runtimeId: config.runtime.id,
          keys: invitationKeys,
          clockSkewSeconds: config.guest.invitations.clockSkewSeconds,
          ...clock,
        })
      : undefined
  /**
   * One set of channels per process, like the runtime both listeners share: a
   * channel is one provider Session, whichever listener each of its members arrived
   * on.
   */
  const { sessions } = runtimeInstance
  const { turns } = runtimeInstance.runtime
  /**
   * One row cache per process: the catalog keeps it current and push delivery
   * reads the same rows to gate a notification on read state.
   */
  const sessionRows = createSessionRows(clock)
  /** One workspace catalog per process, which both listeners share. */
  const catalog = createCatalog({
    runtime: runtimeInstance.runtime,
    coordinator: sessions,
    rows: sessionRows,
    logger: dependencies.logger,
  })
  const channels = createChannels({
    coordinator: sessions,
    runtime: runtimeInstance.runtime,
    logger: dependencies.logger,
    // A channel adopts what the runtime starts only where the runtime
    // reports it.
    ...(turns.subscribeTurns
      ? {
          adoption: {
            subscribeTurns: (scope, listener) =>
              turns.subscribeTurns!(scope, listener),
            discover: (scope) => sessions.discover(scope),
            subscribeExecutions: (scope, listener) =>
              sessions.subscribeScope(scope, listener),
          },
        }
      : {}),
  })
  /** One guest listener: its HTTP app and ACP socket share staged uploads. */
  const guestListener = (
    publicOrigin: string,
    service: GuestInvitationService
  ) => {
    const attachmentStages = createGuestAttachmentStages()
    return {
      runtimeInstance,
      invitations: service,
      app: createGuestApp({
        publicOrigin,
        runtime: runtimeInstance,
        invitations: service,
        attachmentStages,
        ...clock,
      }),
      acpService: createGuestAcpService({
        publicOrigin,
        runtimeInstance,
        invitations: service,
        attachmentStages,
        channels,
        catalog,
        guestActiveExecutions: config.limits.guestActiveExecutions,
        logger: dependencies.logger,
        buildId: dependencies.buildId,
        ...clock,
      }),
    }
  }
  const guest =
    config.guest && invitations
      ? guestListener(config.guest.publicOrigin, invitations)
      : undefined
  const attachmentStages = new AttachmentStageRegistry()
  const push = config.push
    ? await createPushDelivery(
        config.push,
        runtimeInstance,
        sessionRows,
        dependencies,
        clock,
        readers
      )
    : undefined
  const acpService = createOperatorAcpService({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
    attachmentStages,
    channels,
    catalog,
    logger: dependencies.logger,
    buildId: dependencies.buildId,
    ...(push ? { presence: push.presence } : {}),
    ...clock,
  })
  const app = createProxyApp({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
    attachmentStages,
    ...(push
      ? {
          push: {
            publicKey: push.publicKey,
            registrations: push.registrations,
          },
        }
      : {}),
    ...(config.guest && invitations
      ? {
          guestInvitations: {
            publicOrigin: config.guest.publicOrigin,
            service: invitations,
          },
        }
      : {}),
    health: () => ({
      links: [
        {
          name: runtimeInstance.id,
          state: runtimeInstance.runtime.link.state(),
        },
      ],
      gauges: {
        sockets: acpService.sockets() + (guest?.acpService.sockets() ?? 0),
        memberships: channels.memberships(),
        ...sessions.gauges(),
      },
    }),
    readiness: async () => {
      try {
        return (await runtimeInstance.runtime.runtimeInfo()).status ===
          "unavailable"
          ? "not-ready"
          : "ready"
      } catch {
        return "not-ready"
      }
    },
    logger: dependencies.logger,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  })

  return {
    app,
    config,
    runtimeInstance,
    acpService,
    sessionRows,
    guest,
    ...(push ? { push } : {}),
  }
}
