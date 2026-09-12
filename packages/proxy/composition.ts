import type { VerifiedOidcSession } from "./operator-auth"
import { createProxyApp } from "./app"
import { parseProxyConfig } from "./config"
import { HermesServerAdapter, type HermesRpcTransport } from "./hermes-adapter"
import {
  HermesWebSocketRpcTransport,
  type HermesWebSocketRpcTransportOptions,
} from "./hermes-transport"
import { createOperatorAuthenticator } from "./operator-auth"
import { readSecretFile } from "./secrets"

type OperatorVerifierFactoryOptions = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

export type ConfiguredProxyDependencies = {
  operatorVerifierFactory(
    options: OperatorVerifierFactoryOptions
  ): (request: Request) => Promise<VerifiedOidcSession | undefined>
  transportFactory?: (
    options: HermesWebSocketRpcTransportOptions
  ) => HermesRpcTransport
  logger: { info(value: unknown): void; error(value: unknown): void }
  clock?: () => number
}

/** Loads secrets before constructing any listener or native transport. */
export async function createConfiguredProxy(
  input: unknown,
  dependencies: ConfiguredProxyDependencies
) {
  const config = parseProxyConfig(input)
  const clientSecret = await readSecretFile(config.operator.clientSecretFile)
  const verifySession = dependencies.operatorVerifierFactory({
    issuer: config.operator.issuer,
    clientId: config.operator.clientId,
    clientSecret,
    redirectUri: config.operator.redirectUri,
  })
  const operatorAuth = createOperatorAuthenticator({
    allowedSubjects: config.operator.allowedSubjects,
    verifySession,
  })

  let transport: HermesRpcTransport
  if (config.hermes.auth.mode === "static-token") {
    const token = await readSecretFile(config.hermes.auth.tokenFile)
    const factory =
      dependencies.transportFactory ??
      ((options: HermesWebSocketRpcTransportOptions) =>
        new HermesWebSocketRpcTransport(options))
    transport = factory({
      baseUrl: config.hermes.baseUrl,
      credentials: async () => ({ "X-Hermes-Session-Token": token }),
    })
  } else {
    // Gated Hermes requires a per-operator cookie/access-bearer broker. Until
    // that broker is explicitly supplied, never reinterpret a static token as
    // gated authentication.
    transport = {
      async request() {
        throw new Error("Hermes browser authentication broker is unavailable")
      },
      async authState() {
        return { status: "unavailable", reason: "not-configured" }
      },
    }
  }
  const hermes = new HermesServerAdapter(transport)
  const app = createProxyApp({
    publicOrigin: config.publicOrigin,
    operatorAuth,
    hermes,
    logger: dependencies.logger,
    clock: dependencies.clock,
  })
  return { app, config, hermes }
}
