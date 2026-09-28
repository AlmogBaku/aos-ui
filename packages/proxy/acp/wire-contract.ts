/**
 * The wire contract every runtime meets: what a plain ACP v2 client reads
 * from the proxy over its WebSocket, proven over each adapter's own native
 * fake. An adapter's `wire-contract.test.ts` calls `runWireContract` with the
 * runtime it composes; the real proxy is built around it by
 * `createConfiguredProxy`, and the SDK's own client reaches its ACP services
 * through `acpBridge`, the calls the network listener makes. A row the runtime
 * cannot express is named in `gaps` with its reason and listed as skipped.
 *
 * The client is plain: it sends no `_meta` of its own, registers no `_aos/*`
 * handler, and reads standard fields only. Only its Session setup names the
 * Agent in `_meta.aos.agentId`. A case that tests an extra on purpose uses an
 * extras client, and a case no runtime changes runs in
 * `runWireListenerContract`, over one runtime.
 *
 * Test-only: the architecture guard keeps production code from importing it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  client,
  methods,
  type AnyWireMessage,
} from "@agentclientprotocol/sdk/experimental/v2"
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  acpBridge,
  type BridgedAcpService,
} from "../../../test/support/acp-bridge-socket"
import { useFakeClock } from "../../../test/support/fake-clock"
import { captureLogs } from "../../../test/support/log-capture"
import {
  AOS_ACP_GUEST_PATH,
  AOS_ACP_OPERATOR_PATH,
  AOS_AUTH_METHOD_INVITE,
  AOS_META_KEY,
} from "../../protocol/acp"
import type { RuntimeFactory } from "../adapters/create-runtime"
import { createConfiguredProxy } from "../composition"
import { stubUnreachableTransports, until } from "../core/runtime-contract"
import { CredentialValues } from "../redaction"

/** The contract's rows, each named for the rule it protects. */
export type WireContractRow = "promptAnswerCarriesMessageId"

/** The runtime one adapter's fake stands behind. */
export type WireRuntime = Readonly<{
  /** The deployment's `runtime` block; its secret files are never read. */
  config: Readonly<Record<string, unknown>>
  /** Builds the real adapter over the fake, as `createRuntimeInstance` would. */
  runtimeFactory: RuntimeFactory
  /** An Agent the fake holds. */
  agentId: string
}>

export type WireContractOptions = {
  /** Rows skipped, each with why the runtime cannot express it. */
  gaps?: Partial<Record<WireContractRow, string>>
}

const OPERATOR_ORIGIN = "https://aos.example.test"
const GUEST_ORIGIN = "https://guest.example.test"

type Clock = ReturnType<typeof useFakeClock>
type Proxy = Awaited<ReturnType<typeof createConfiguredProxy>>

/** What one case holds: the proxy, the Agent, and whatever it opened. */
type WireHarness = Readonly<{
  proxy: Proxy
  agentId: string
  clock: Clock
  /** Connects a client to `service`, closed with the case. */
  connect(
    service: BridgedAcpService,
    origin: string,
    path: string
  ): ReturnType<typeof connectClient>
}>

/**
 * The real proxy over `runtime`, an operator and a guest listener, with its
 * invitation key written to a private directory as a deployment keeps it.
 */
async function composeProxy(runtime: WireRuntime, clock: Clock) {
  const directory = await mkdtemp(join(tmpdir(), "aos-wire-contract-"))
  const invitationKey = join(directory, "invitation-key")
  await writeFile(
    invitationKey,
    `${Buffer.alloc(32, 7).toString("base64url")}\n`,
    { mode: 0o600 }
  )
  const release = () => rm(directory, { recursive: true })
  try {
    const proxy = await until(
      clock,
      createConfiguredProxy(
        {
          version: 1,
          deploymentId: "wire-contract",
          listen: { host: "127.0.0.1", port: 4100 },
          publicOrigin: OPERATOR_ORIGIN,
          runtime: runtime.config,
          limits: {
            activeExecutions: 256,
            guestActiveExecutions: 32,
            operatorEventPeers: 256,
            subscriberEvents: 512,
            subscriberBytes: 2_097_152,
          },
          guest: {
            listen: { host: "127.0.0.1", port: 4101 },
            publicOrigin: GUEST_ORIGIN,
            invitations: {
              keys: [{ id: "guest-current", secretFile: invitationKey }],
              clockSkewSeconds: 0,
            },
          },
          shutdownGraceMs: 5_000,
        },
        {
          runtimeFactory: runtime.runtimeFactory,
          logger: captureLogs().logger,
          credentials: new CredentialValues(),
        }
      )
    )
    return { proxy, release }
  } catch (error) {
    await release()
    throw error
  }
}

/** The SDK's own client on `service`, over the WebSocket stream it builds. */
function connectClient(
  service: BridgedAcpService,
  origin: string,
  path: string
) {
  const bridge = acpBridge(service)
  const connection = client({ name: "wire-contract" }).connect(
    createWebSocketStream<AnyWireMessage>(
      `wss://${new URL(origin).host}${path}`,
      {
        WebSocket: bridge.WebSocket,
        headers: { Origin: origin },
      }
    )
  )
  return {
    connection,
    bridge,
    initialize: () =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "wire-contract", version: "1.0.0" },
        capabilities: {},
      }),
  }
}

type WireClient = ReturnType<typeof connectClient>

/** A Session on `agentId`, created as the plain client's one setup step. */
async function newSession({ connection }: WireClient, agentId: string) {
  const { sessionId } = await connection.agent.request(
    methods.agent.session.new,
    { cwd: "/", _meta: { [AOS_META_KEY]: { agentId } } }
  )
  return sessionId
}

/** One case over a freshly composed proxy, closing all it opened. */
function wireCase(
  createRuntime: () => WireRuntime,
  body: (harness: WireHarness) => Promise<void>
) {
  return async () => {
    const clock = useFakeClock()
    const runtime = createRuntime()
    const { proxy, release } = await composeProxy(runtime, clock)
    const clients: WireClient[] = []
    try {
      await body({
        proxy,
        agentId: runtime.agentId,
        clock,
        connect(service, origin, path) {
          const opened = connectClient(service, origin, path)
          clients.push(opened)
          return opened
        },
      })
    } finally {
      for (const { connection } of clients) connection.close()
      await until(clock, proxy.runtimeInstance.close())
      await release()
    }
  }
}

function withTransportsStubbed(describeBody: () => void) {
  return () => {
    beforeEach(stubUnreachableTransports)
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    describeBody()
  }
}

export function runWireContract(
  name: string,
  createRuntime: () => WireRuntime,
  { gaps = {} }: WireContractOptions = {}
) {
  function row(
    id: WireContractRow,
    title: string,
    body: (harness: WireHarness) => Promise<void>
  ) {
    if (gaps[id] !== undefined) it.skip(`${title} (gap: ${gaps[id]})`)
    else it(title, wireCase(createRuntime, body))
  }

  describe(
    `${name} ACP wire contract`,
    withTransportsStubbed(() => {
      row(
        "promptAnswerCarriesMessageId",
        "answers a prompt with a message id the SDK's own client reads",
        async ({ proxy, agentId, clock, connect }) => {
          const plain = connect(
            proxy.acpService,
            OPERATOR_ORIGIN,
            AOS_ACP_OPERATOR_PATH
          )
          await until(clock, plain.initialize())
          const sessionId = await until(clock, newSession(plain, agentId))

          const answer = await until(
            clock,
            plain.connection.agent.request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "list the files" }],
            })
          )

          expect(answer.messageId).toEqual(expect.any(String))
        }
      )
    })
  )
}

/** The cases no runtime changes, run once over one runtime's fake. */
export function runWireListenerContract(
  name: string,
  createRuntime: () => WireRuntime
) {
  describe(
    `${name} ACP listener wire contract`,
    withTransportsStubbed(() => {
      it(
        "admits a guest on its own listener once it logs in with an invite",
        wireCase(createRuntime, async ({ proxy, agentId, clock, connect }) => {
          const guest = proxy.guest!
          const extras = connect(
            guest.acpService,
            GUEST_ORIGIN,
            AOS_ACP_GUEST_PATH
          )
          const { token } = await guest.invitations.issue({
            agentId,
            ref: "wire-contract",
          })
          await until(clock, extras.initialize())

          await expect(
            until(
              clock,
              extras.connection.agent.request(methods.agent.auth.login, {
                methodId: AOS_AUTH_METHOD_INVITE,
                _meta: { [AOS_META_KEY]: { token } },
              })
            )
          ).resolves.toBeTypeOf("object")
        })
      )
    })
  )
}
