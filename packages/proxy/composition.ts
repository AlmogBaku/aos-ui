import { randomUUID } from "node:crypto"

import { createProxyApp } from "./app"
import {
  createGuestInvitationService,
  type GuestInvitationKey,
} from "./auth/guest-invitation"
import { SessionCoordinator } from "./core/session-coordinator"
import type { RuntimeInstance } from "./core/runtime"
import { parseProxyConfig } from "./config"
import { createReconnectCursorCodec } from "./events/cursor"
import { createOperatorEventService } from "./events/service"
import {
  HermesServerAdapter,
  type HermesRpcTransport,
} from "./adapters/hermes/adapter"
import {
  HermesWebSocketRpcTransport,
  type HermesWebSocketRpcTransportOptions,
} from "./adapters/hermes/transport"
import { createGuestListenerService } from "./guest/service"
import { readSecretFile, readSecretKeyFile } from "./secrets"

export type ConfiguredProxyDependencies = {
  transportFactory?: (
    options: HermesWebSocketRpcTransportOptions
  ) => HermesRpcTransport
  logger: { info(value: unknown): void; error(value: unknown): void }
  clock?: () => number
}

/** Loads secrets once and constructs one runtime shared by every listener. */
export async function createConfiguredProxy(
  input: unknown,
  dependencies: ConfiguredProxyDependencies
) {
  const config = parseProxyConfig(input)
  const [token, cursorKeys, invitationKeys] = await Promise.all([
    readSecretFile(config.runtime.tokenFile),
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
  const transportFactory =
    dependencies.transportFactory ??
    ((options: HermesWebSocketRpcTransportOptions) =>
      new HermesWebSocketRpcTransport(options))
  const transport = transportFactory({
    baseUrl: config.runtime.baseUrl,
    credentials: async () => ({ "X-Hermes-Session-Token": token }),
  })
  const hermes = new HermesServerAdapter(transport, {
    sessionIdleMs: config.runtime.sessionIdleMs,
  })
  const sessions = new SessionCoordinator({
    engine: hermes.runs,
    maxActiveExecutions: config.limits.activeExecutions,
    maxGuestActiveExecutions: config.limits.guestActiveExecutions,
    maxSubscriberEvents: config.limits.subscriberEvents,
    maxSubscriberBytes: config.limits.subscriberBytes,
    maxReplayEvents: config.limits.subscriberEvents,
    maxReplayBytes: config.limits.subscriberBytes,
  })
  let closePromise: Promise<void> | undefined
  const runtimeInstance: RuntimeInstance = {
    id: config.runtime.id,
    runtime: hermes,
    sessions,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        sessions.close()
        await hermes.close()
      })
      return closePromise
    },
  }
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
          issuer: config.guest.publicOrigin,
          audience: "aos-guest-listener",
          deploymentId: config.deploymentId,
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
          service: createGuestListenerService({
            publicOrigin: config.guest.publicOrigin,
            deploymentId: config.deploymentId,
            bootEpoch: randomUUID(),
            runtime: runtimeInstance,
            invitations,
            cursor,
            maxEventPeers: config.limits.guestEventPeers,
            maxEventPeersPerInvitation:
              config.limits.guestEventPeersPerInvitation,
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
    ...(invitations === undefined ? {} : { guestInvitations: invitations }),
    readiness: async () => {
      try {
        return (await hermes.runtimeInfo()).status === "unavailable"
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
    hermes,
    transport,
    cursor,
    eventService,
    guest,
  }
}
