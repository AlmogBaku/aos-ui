import { vi } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { OpenClawServerAdapter, openClawPublicError } from "./adapter"
import { OpenClawClient } from "./client"
import { OpenClawInteractions } from "./interactions"
import { createOpenClawMcpToolNames } from "./mcp-tool-names"
import { OpenClawTurnEngine } from "./run"
import { OpenClawSessionSubscriptions } from "./subscriptions"
import { fakeOpenClaw } from "./test-utils/fake-openclaw"

vi.mock("@openclaw/gateway-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openclaw/gateway-client")>()
  return {
    ...actual,
    // The official client dials through the `ws` package, out of reach of the
    // contract's global WebSocket stub, so it refuses here: only the fake dials.
    GatewayClient: function GatewayClient() {
      throw new Error(
        "The runtime contract reached the official Gateway client"
      )
    },
    // The official client marks every Gateway answer it builds; here the
    // fake's GatewayClientRequestError stands for one.
    isGatewayProtocolResponseError: (error: unknown) =>
      error instanceof actual.GatewayClientRequestError,
  }
})

/** The runtime `createOpenClawRuntime` composes, over the fake Gateway. */
async function openClawRuntime(openclaw: ReturnType<typeof fakeOpenClaw>) {
  const { logger } = captureLogs()
  const state: { subscriptions?: OpenClawSessionSubscriptions } = {}
  const client = new OpenClawClient({
    url: "ws://127.0.0.1:18789",
    credentials: async () => ({
      deviceIdentity: {
        deviceId: "device-test",
        privateKeyPem: "test-private-key",
        publicKeyPem: "test-public-key",
      },
      deviceToken: "test-token",
      signDevicePayload: () => "test-signature",
      publicKeyRawBase64UrlFromPem: () => "test-public-key-raw",
    }),
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    caps: [],
    onEvent: (event) =>
      state.subscriptions?.accept(event, state.subscriptions.generation),
    onGap: () => void state.subscriptions?.replaceGeneration("gap"),
    logger,
    createGatewayClient: openclaw.createGatewayClient,
  })
  const subscriptions = new OpenClawSessionSubscriptions(client, logger)
  state.subscriptions = subscriptions
  client.link.subscribe((link) => {
    if (link === "ready") void subscriptions.replaceGeneration("reconnect")
    else subscriptions.pause()
  })
  const mcpToolNames = createOpenClawMcpToolNames(client)
  const runtime = new OpenClawServerAdapter({
    client,
    turns: new OpenClawTurnEngine({
      client,
      subscriptions,
      toolEvents: true,
      replies: new OpenClawInteractions(client),
      mcpToolNames,
      watch: {
        publicError: openClawPublicError,
        upstream: client.link,
        logger,
      },
    }),
    mcpToolNames,
    subscribeSession: async (agentId, sessionKey, onInvalidate) => {
      const lease = await subscriptions.acquire(
        { agentId, sessionKey },
        onInvalidate
      )
      return () => void lease.release()
    },
  })
  // A runtime whose link is up, as it is once the proxy has read its catalog.
  await client.start()
  return {
    runtime,
    records: () => mcpToolNames.size,
    close: async () => {
      subscriptions.close()
      await runtime.close()
    },
  }
}

runServerRuntimeContract(
  "OpenClaw",
  async () => {
    const openclaw = fakeOpenClaw()
    return { ...openclaw, ...(await openClawRuntime(openclaw)) }
  },
  {
    callerErrors: ["runtime_authentication_required"],
    gaps: {
      typedMessageFields:
        "capability: OpenClaw history carries no correction or turn error code",
    },
  }
)
