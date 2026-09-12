import { randomUUID } from "node:crypto"

import { RuntimeAuthStateSchema } from "../protocol"
import { createProxyApp } from "./app"
import { createOidcCore, type OidcFetch, type OidcProvider } from "./auth/oidc"
import { createOperatorSessionAuthenticator } from "./auth/operator-session-auth"
import { createOperatorSessionCookie } from "./auth/session-cookie"
import { createGuestInvitationService } from "./auth/guest-invitation"
import { parseProxyConfig } from "./config"
import { createReconnectCursorCodec } from "./events/cursor"
import { createOperatorEventService } from "./events/service"
import {
  HermesServerAdapter,
  type HermesRpcTransport,
} from "./runtimes/hermes/adapter"
import {
  createHermesBrowserAuthBroker,
  type HermesBrowserAuthBrokerOptions,
} from "./runtimes/hermes/auth-broker"
import {
  HermesAuthenticationError,
  HermesWebSocketRpcTransport,
  type HermesWebSocketRpcTransportOptions,
} from "./runtimes/hermes/transport"
import { readSecretFile, readSecretKeyFile } from "./secrets"
import { createGuestListenerService } from "./guest/service"

type BrowserAuthBroker = ReturnType<typeof createHermesBrowserAuthBroker>

export type ConfiguredProxyDependencies = {
  oidcProvider?: OidcProvider
  oidcFetcher?: OidcFetch
  browserAuthBrokerFactory?: (
    options: HermesBrowserAuthBrokerOptions
  ) => BrowserAuthBroker
  transportFactory?: (
    options: HermesWebSocketRpcTransportOptions
  ) => HermesRpcTransport
  logger: { info(value: unknown): void; error(value: unknown): void }
  clock?: () => number
}

/** Loads every secret before constructing a listener or native transport. */
export async function createConfiguredProxy(
  input: unknown,
  dependencies: ConfiguredProxyDependencies
) {
  const config = parseProxyConfig(input)
  const [clientSecret, principalHmacKey, sessionKeys, cursorKeys] =
    await Promise.all([
      readSecretFile(config.operator.clientSecretFile),
      readSecretKeyFile(config.operator.principalHmacKeyFile),
      Promise.all(
        config.operator.session.keys.map(async ({ id, secretFile }) => ({
          id,
          secret: await readSecretKeyFile(secretFile),
        }))
      ),
      Promise.all(
        config.events.keys.map(async ({ id, secretFile }) => ({
          id,
          secret: await readSecretKeyFile(secretFile),
        }))
      ),
    ])

  const operatorSessions = createOperatorSessionCookie({
    deploymentId: config.operator.session.deploymentId,
    keys: sessionKeys,
    ttlSeconds: config.operator.session.ttlSeconds,
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const operatorAuth = createOperatorSessionAuthenticator(operatorSessions)
  const operatorOidc = createOidcCore({
    issuer: config.operator.issuer,
    clientId: config.operator.clientId,
    clientSecret,
    redirectUri: config.operator.redirectUri,
    publicOrigin: config.publicOrigin,
    allowedSubjects: config.operator.allowedSubjects,
    principalHmacKey,
    sessionIssuer: operatorSessions,
    ...(dependencies.oidcProvider === undefined
      ? {}
      : { provider: dependencies.oidcProvider }),
    ...(dependencies.oidcFetcher === undefined
      ? {}
      : { fetcher: dependencies.oidcFetcher }),
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const cursor = createReconnectCursorCodec({
    activeKeyId: config.events.activeKeyId,
    keys: Object.fromEntries(cursorKeys.map(({ id, secret }) => [id, secret])),
    ...(dependencies.clock === undefined
      ? {}
      : { now: () => Math.floor(dependencies.clock!() / 1_000) }),
  })

  const transportFactory: (
    options: HermesWebSocketRpcTransportOptions
  ) => HermesRpcTransport =
    dependencies.transportFactory ??
    ((options: HermesWebSocketRpcTransportOptions) =>
      new HermesWebSocketRpcTransport(options))

  const guestSecrets = config.guest
    ? await Promise.all([
        readSecretFile(config.guest.hermes.tokenFile),
        Promise.all(
          config.guest.invitations.keys.map(async ({ id, secretFile }) => ({
            id,
            secret: await readSecretKeyFile(secretFile),
          }))
        ),
      ])
    : undefined
  let transport: HermesRpcTransport
  let runtimeAuth: NonNullable<
    Parameters<typeof createProxyApp>[0]["runtimeAuth"]
  >
  let browserAuthBroker: BrowserAuthBroker | undefined
  let hermesForOperator:
    ((principalId: string) => HermesServerAdapter) | undefined

  if (config.hermes.auth.mode === "static-token") {
    const token = await readSecretFile(config.hermes.auth.tokenFile)
    transport = transportFactory({
      baseUrl: config.hermes.baseUrl,
      credentials: async () => ({ "X-Hermes-Session-Token": token }),
    })
    runtimeAuth = { state: () => hermes.authState() }
  } else {
    const factory =
      dependencies.browserAuthBrokerFactory ?? createHermesBrowserAuthBroker
    browserAuthBroker = factory({
      baseUrl: config.hermes.baseUrl,
      publicOrigin: config.publicOrigin,
      callbackUrl: config.hermes.auth.callbackUrl,
      allowedIdentityOrigins: config.hermes.auth.allowedIdentityOrigins,
      ...(config.hermes.auth.provider === undefined
        ? {}
        : { provider: config.hermes.auth.provider }),
    })
    runtimeAuth = {
      state: (scope) => browserAuthBroker!.authState(scope),
      begin: (binding) => browserAuthBroker!.begin(binding),
      complete: (binding) => browserAuthBroker!.complete(binding),
    }
    hermesForOperator = (principalId) => {
      const scope = { principalId, lane: "operator" as const }
      const native: HermesRpcTransport = transportFactory({
        baseUrl: config.hermes.baseUrl,
        credentials: () => browserAuthBroker!.credentials(scope),
      })
      const invalidateOnRejectedCredentials = async <T>(
        operation: () => Promise<T>
      ) => {
        try {
          return await operation()
        } catch (error) {
          if (error instanceof HermesAuthenticationError)
            browserAuthBroker!.invalidate(scope)
          throw error
        }
      }
      const bound: HermesRpcTransport = {
        request: (method, params) =>
          invalidateOnRejectedCredentials(() => native.request(method, params)),
        ...(native.http
          ? {
              http: (path, init) =>
                invalidateOnRejectedCredentials(() => native.http!(path, init)),
            }
          : {}),
        ...(native.observeEvents
          ? {
              observeEvents: (listener, disconnected) =>
                invalidateOnRejectedCredentials(() =>
                  native.observeEvents!(listener, disconnected)
                ),
            }
          : {}),
        authState: async () =>
          RuntimeAuthStateSchema.parse(await runtimeAuth.state(scope)),
        ...(native.close ? { close: () => native.close!() } : {}),
      }
      return new HermesServerAdapter(bound)
    }
    transport = {
      async request() {
        throw new Error("Runtime authentication required")
      },
      async authState() {
        return { status: "authentication-required" }
      },
    }
  }

  const hermes = new HermesServerAdapter(transport)
  const guest = config.guest
    ? (() => {
        const [token, keys] = guestSecrets!
        const guestTransport = transportFactory({
          baseUrl: config.guest.hermes.baseUrl,
          credentials: async () => ({ "X-Hermes-Session-Token": token }),
        })
        const guestHermes = new HermesServerAdapter(guestTransport)
        const invitations = createGuestInvitationService({
          issuer: config.guest.publicOrigin,
          audience: "aos-guest-listener",
          deploymentId: config.operator.session.deploymentId,
          keys,
          ttlSeconds: config.guest.invitations.ttlSeconds,
          clockSkewSeconds: config.guest.invitations.clockSkewSeconds,
          ...(dependencies.clock === undefined
            ? {}
            : { now: dependencies.clock }),
        })
        return {
          transport: guestTransport,
          hermes: guestHermes,
          invitations,
          service: createGuestListenerService({
            publicOrigin: config.guest.publicOrigin,
            deploymentId: config.operator.session.deploymentId,
            bootEpoch: randomUUID(),
            invitations,
            cursor,
            hermes: guestHermes,
            content: guestHermes,
            ...(dependencies.clock === undefined
              ? {}
              : { now: dependencies.clock }),
          }),
        }
      })()
    : undefined
  const eventService = createOperatorEventService({
    publicOrigin: config.publicOrigin,
    deploymentId: config.operator.session.deploymentId,
    bootEpoch: randomUUID(),
    cursor,
    operatorSession: (request) => operatorAuth.session(request),
    runtimeState: async (scope) =>
      RuntimeAuthStateSchema.parse(await runtimeAuth.state(scope)),
    hermesForOperator: hermesForOperator ?? (() => hermes),
    ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
  })
  const app = createProxyApp({
    publicOrigin: config.publicOrigin,
    operatorAuth,
    operatorOidc,
    runtimeAuth,
    hermes,
    ...(guest === undefined ? {} : { guestInvitations: guest.invitations }),
    ...(hermesForOperator === undefined ? {} : { hermesForOperator }),
    ...(config.hermes.auth.mode === "browser-broker"
      ? { readiness: async () => "ready" as const }
      : {}),
    logger: dependencies.logger,
    clock: dependencies.clock,
  })
  return {
    app,
    config,
    hermes,
    operatorSessions,
    cursor,
    eventService,
    browserAuthBroker,
    guest,
  }
}
