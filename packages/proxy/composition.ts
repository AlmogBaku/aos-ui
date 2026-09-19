import { randomUUID } from "node:crypto"

import { createOperatorAcpService } from "./acp/operator"
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
import { parseProxyConfig } from "./config"
import { createReconnectCursorCodec } from "./events/cursor"
import { createOperatorEventService } from "./events/service"
import { createGuestAcpService } from "./guest/acp"
import { createGuestApp } from "./guest/app"
import { createGuestAttachmentStages } from "./guest/context"
import { readSecretKeyFile } from "./secrets"

export type ConfiguredProxyDependencies = {
  runtimeFactory?: RuntimeFactory
  logger: { info(value: unknown): void; error(value: unknown): void }
  clock?: () => number
}

/** Loads secrets once and constructs one runtime shared by every listener. */
export async function createConfiguredProxy(
  input: unknown,
  dependencies: ConfiguredProxyDependencies
) {
  const config = parseProxyConfig(input)
  const [runtimeInstance, cursorKeys, invitationKeys] = await Promise.all([
    (dependencies.runtimeFactory ?? createRuntimeInstance)(
      config.runtime,
      config.limits
    ),
    Promise.all(
      config.events.keys.map(async ({ id, secretFile }) => ({
        id,
        secret: await readSecretKeyFile(secretFile),
      }))
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
  ])
  const cursor = createReconnectCursorCodec({
    activeKeyId: config.events.activeKeyId,
    keys: Object.fromEntries(cursorKeys.map(({ id, secret }) => [id, secret])),
    ...(dependencies.clock === undefined
      ? {}
      : { now: () => Math.floor(dependencies.clock!() / 1_000) }),
  })
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
          ...(dependencies.clock === undefined
            ? {}
            : { now: dependencies.clock }),
        })
      : undefined
  /** One guest listener: its HTTP app and ACP socket share staged uploads. */
  const guestLane = (publicOrigin: string, service: GuestInvitationService) => {
    const clock =
      dependencies.clock === undefined ? {} : { now: dependencies.clock }
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
        ...clock,
      }),
    }
  }
  const guest =
    config.guest && invitations
      ? guestLane(config.guest.publicOrigin, invitations)
      : undefined
  const eventService = createOperatorEventService({
    publicOrigin: config.publicOrigin,
    deploymentId: config.deploymentId,
    bootEpoch: randomUUID(),
    cursor,
    runtimeInstance,
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const attachmentStages = new AttachmentStageRegistry()
  const acpService = createOperatorAcpService({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
    attachmentStages,
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const app = createProxyApp({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
    attachmentStages,
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
    cursor,
    eventService,
    acpService,
    guest,
  }
}
