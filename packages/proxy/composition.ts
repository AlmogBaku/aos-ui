import { randomUUID } from "node:crypto"

import {
  createRuntimeInstance,
  type RuntimeFactory,
} from "./adapters/create-runtime"
import { createProxyApp } from "./app"
import {
  createGuestInvitationService,
  type GuestInvitationKey,
} from "./auth/guest-invitation"
import { parseProxyConfig } from "./config"
import { createReconnectCursorCodec } from "./events/cursor"
import { createOperatorEventService } from "./events/service"
import { createGuestApp } from "./guest/app"
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
  const guest =
    config.guest && invitations
      ? {
          runtimeInstance,
          invitations,
          app: createGuestApp({
            publicOrigin: config.guest.publicOrigin,
            runtime: runtimeInstance,
            invitations,
            ...(dependencies.clock === undefined
              ? {}
              : { now: dependencies.clock }),
          }),
        }
      : undefined
  const eventService = createOperatorEventService({
    publicOrigin: config.publicOrigin,
    deploymentId: config.deploymentId,
    bootEpoch: randomUUID(),
    cursor,
    runtimeInstance,
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const app = createProxyApp({
    publicOrigin: config.publicOrigin,
    runtimeInstance,
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
    guest,
  }
}
