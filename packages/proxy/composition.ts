import { createOperatorAcpService } from "./acp/operator"
import type { AcpLogger } from "./acp/types"
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
import { parseProxyConfig, type ProxyConfig, type VoiceConfig } from "./config"
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
import { readSecretFile, readSecretKeyFile } from "./secrets"
import {
  createOpenAiCompatibleSynthesizer,
  createOpenAiCompatibleTranscriber,
} from "./voice/openai-compatible"
import { withVoiceProviders, type VoiceProviders } from "./voice/runtime"

export type ConfiguredProxyDependencies = {
  runtimeFactory?: RuntimeFactory
  logger: AcpLogger
  clock?: () => number
  /** Reaches the configured speech providers; tests hand in a stub. */
  fetch?: typeof fetch
}

/** One provider per configured direction, each key read once at startup. */
async function createVoiceProviders(
  voice: VoiceConfig,
  fetchImpl: typeof fetch
): Promise<VoiceProviders> {
  const apiKey = (file: string | undefined) =>
    file === undefined ? undefined : readSecretFile(file)
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

/**
 * Everything one push-enabled deployment needs: the public key derived from the
 * configured private one, the stored devices, the presence the ACP lane reports
 * into, and the dispatcher that observes the runtime. A state directory the
 * proxy cannot write fails startup here rather than at the first notification.
 */
async function createPushLane(
  push: NonNullable<ProxyConfig["push"]>,
  runtimeInstance: RuntimeInstance,
  sessionRows: SessionRows,
  dependencies: ConfiguredProxyDependencies,
  clock: { now?: () => number }
) {
  const privateKey = await readSecretKeyFile(push.vapid.privateKeyFile)
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
  const [nativeInstance, invitationKeys, voiceProviders] = await Promise.all([
    (dependencies.runtimeFactory ?? createRuntimeInstance)(
      config.runtime,
      config.limits
    ),
    config.guest
      ? Promise.all(
          config.guest.invitations.keys.map(
            async ({ id, secretFile }): Promise<GuestInvitationKey> => ({
              id,
              secret: await readSecretKeyFile(secretFile),
            })
          )
        )
      : Promise.resolve(undefined),
    config.voice
      ? createVoiceProviders(config.voice, dependencies.fetch ?? fetch)
      : Promise.resolve(undefined),
  ])
  // Proxy speech sits in front of the adapter for every lane at once, so the
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
  const invitations =
    config.guest && invitationKeys
      ? createGuestInvitationService({
          issuer: "aos-invite",
          audience: "aos-guest",
          deploymentId: config.deploymentId,
          runtimeId: config.runtime.id,
          keys: invitationKeys,
          ttlSeconds: config.guest.invitations.ttlSeconds,
          clockSkewSeconds: config.guest.invitations.clockSkewSeconds,
          ...clock,
        })
      : undefined
  /** One guest listener: its HTTP app and ACP socket share staged uploads. */
  const guestLane = (publicOrigin: string, service: GuestInvitationService) => {
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
        logger: dependencies.logger,
        ...clock,
      }),
    }
  }
  const guest =
    config.guest && invitations
      ? guestLane(config.guest.publicOrigin, invitations)
      : undefined
  const attachmentStages = new AttachmentStageRegistry()
  /**
   * One row cache for the operator surface: the ACP lane keeps it current and
   * push delivery reads the same rows to gate a notification on read state.
   */
  const sessionRows = createSessionRows(clock)
  const push = config.push
    ? await createPushLane(
        config.push,
        runtimeInstance,
        sessionRows,
        dependencies,
        clock
      )
    : undefined
  const acpService = createOperatorAcpService({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
    attachmentStages,
    sessionRows,
    logger: dependencies.logger,
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
