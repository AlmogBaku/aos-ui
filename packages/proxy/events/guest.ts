import type { GuestInvitationService } from "../auth/guest-invitation"
import {
  createGuestRequestAuthorizer,
  guestBearerToken,
  guestCookieValue,
} from "../auth/guest-request"
import type { RuntimeInstance } from "../core/runtime"
import type { ReconnectCursorCodec } from "./cursor"
import {
  createEventsSocket,
  type EventsSocket,
  type EventSocketServerFrame,
} from "./socket"

export const GUEST_EVENTS_COOKIE = "__Host-aos-guest-events"

export type GuestEventUpgrade = {
  invitationId: string
  authorizationRevision: string
  agentId: string
  sessionId: string
  storedSessionId: string
  expiresAt: number
}

export type GuestEventPeer = {
  send(raw: string): void
  close(code: number, reason: string): void
}

export type GuestEventServiceOptions = {
  publicOrigin: string
  deploymentId: string
  bootEpoch: string
  runtime: RuntimeInstance
  invitations: GuestInvitationService
  cursor: ReconnectCursorCodec
  maxEventPeers?: number
  maxEventPeersPerInvitation?: number
  maxEventStreamsPerPeer?: number
  now?: () => number
  schedule?: (delayMs: number, task: () => void) => unknown
  cancel?: (timer: unknown) => void
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

export function guestEventTarget(request: Request, pathname: string) {
  const url = new URL(request.url)
  if (
    url.pathname !== pathname ||
    url.search.length > 2_048 ||
    [...url.searchParams.keys()].some(
      (key) => key !== "agentId" && key !== "sessionId"
    ) ||
    url.searchParams.getAll("agentId").length !== 1 ||
    url.searchParams.getAll("sessionId").length !== 1
  )
    return undefined
  const agentId = url.searchParams.get("agentId")
  const sessionId = url.searchParams.get("sessionId")
  return validIdentifier(agentId) && validIdentifier(sessionId)
    ? { agentId, sessionId }
    : undefined
}

function canonicalEventScope(scope: {
  workspaceId: string
  agentId: string
  sessionId: string
}) {
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("base64url")
  return `ws1.${encode(scope.workspaceId)}.${encode(scope.agentId)}.${encode(scope.sessionId)}`
}

function projectEventFrame(raw: string, upgrade: GuestEventUpgrade) {
  let frame: EventSocketServerFrame
  try {
    frame = JSON.parse(raw) as EventSocketServerFrame
  } catch {
    return undefined
  }
  if (frame.type === "aos.error")
    return JSON.stringify({
      type: frame.type,
      version: 1,
      ...(frame.streamId === undefined ? {} : { streamId: frame.streamId }),
      code: frame.code,
    })
  if (
    frame.scope.workspaceId !== "guest" ||
    frame.scope.agentId !== upgrade.agentId ||
    frame.scope.sessionId !== upgrade.sessionId
  )
    return undefined
  if (frame.type === "aos.ready")
    return JSON.stringify({
      type: frame.type,
      version: 1,
      streamId: frame.streamId,
      scope: frame.scope,
      generation: frame.generation,
      read: "authoritative",
      ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
    })
  return JSON.stringify({
    type: frame.type,
    version: 1,
    streamId: frame.streamId,
    scope: frame.scope,
    generation: frame.generation,
    ...(frame.type === "aos.reset"
      ? { reason: "reconcile_required" as const }
      : {}),
  })
}

function inertSocket(): EventsSocket {
  return {
    receive: async () => undefined,
    drain: () => [],
    close: () => undefined,
  }
}

/** Guest invalidations over the shared runtime; run delivery remains AG-UI SSE. */
export function createGuestEventService(options: GuestEventServiceOptions) {
  const now = options.now ?? Date.now
  const authorizer = createGuestRequestAuthorizer({
    runtimeId: options.runtime.id,
    invitations: options.invitations,
    now,
  })
  const schedule =
    options.schedule ??
    ((delayMs: number, task: () => void) => setTimeout(task, delayMs))
  const cancel =
    options.cancel ?? ((timer: unknown) => clearTimeout(timer as number))
  const maxEventPeers = options.maxEventPeers ?? 64
  const maxEventPeersPerInvitation = options.maxEventPeersPerInvitation ?? 4
  let eventPeers = 0
  const eventPeersByInvitation = new Map<string, number>()

  async function authorizeUpgrade(
    request: Request
  ): Promise<GuestEventUpgrade | undefined> {
    if (
      request.method !== "GET" ||
      request.headers.get("origin") !== options.publicOrigin
    )
      return undefined
    const target = guestEventTarget(request, "/api/guest/v1/events")
    if (!target) return undefined
    const token =
      guestBearerToken(request) ??
      guestCookieValue(request, GUEST_EVENTS_COOKIE)
    if (!token) return undefined
    const authorization = await authorizer.verify(token, {
      ...target,
      operation: "messages:read",
    })
    if (!authorization) return undefined
    const storedSessionId = options.runtime.runtime.resolveSessionId(
      target.agentId,
      target.sessionId
    )
    if (!storedSessionId) return undefined
    try {
      await options.runtime.runtime.getSession(target.agentId, storedSessionId)
    } catch {
      return undefined
    }
    return {
      invitationId: authorization.invitationId,
      authorizationRevision: authorization.tokenId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      storedSessionId,
      expiresAt: authorization.authorizationExpiresAt * 1_000,
    }
  }

  function open(
    upgrade: GuestEventUpgrade,
    peer: GuestEventPeer
  ): EventsSocket {
    const invitationPeers =
      eventPeersByInvitation.get(upgrade.invitationId) ?? 0
    if (
      eventPeers >= maxEventPeers ||
      invitationPeers >= maxEventPeersPerInvitation ||
      now() >= upgrade.expiresAt
    ) {
      peer.close(
        now() >= upgrade.expiresAt ? 4401 : 1013,
        now() >= upgrade.expiresAt
          ? "Authorization expired"
          : "Guest event peer limit exceeded"
      )
      return inertSocket()
    }
    eventPeers += 1
    eventPeersByInvitation.set(upgrade.invitationId, invitationPeers + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      eventPeers -= 1
      const remaining =
        (eventPeersByInvitation.get(upgrade.invitationId) ?? 1) - 1
      if (remaining === 0) eventPeersByInvitation.delete(upgrade.invitationId)
      else eventPeersByInvitation.set(upgrade.invitationId, remaining)
    }
    const socket = createEventsSocket({
      cursor: options.cursor,
      now,
      schedule,
      cancel,
      ...(options.maxEventStreamsPerPeer === undefined
        ? {}
        : { maxStreams: options.maxEventStreamsPerPeer }),
      close(code, reason) {
        release()
        peer.close(code, reason)
      },
      notify() {
        for (const raw of socket.drain()) {
          const projected = projectEventFrame(raw, upgrade)
          if (projected !== undefined) peer.send(projected)
        }
      },
      async authorize({ scope, streamId }) {
        if (
          now() >= upgrade.expiresAt ||
          scope.workspaceId !== "guest" ||
          scope.agentId !== upgrade.agentId ||
          scope.sessionId !== upgrade.sessionId
        )
          return null
        try {
          await options.runtime.runtime.getSession(
            upgrade.agentId,
            upgrade.storedSessionId
          )
        } catch {
          return null
        }
        return {
          expiresAt: upgrade.expiresAt,
          binding: {
            deploymentId: options.deploymentId,
            lane: "guest",
            invitationId: upgrade.invitationId,
            authorizationRevision: upgrade.authorizationRevision,
            scope: canonicalEventScope(scope),
            agentId: upgrade.agentId,
            sessionId: upgrade.sessionId,
            bootEpoch: options.bootEpoch,
            streamId,
          },
        }
      },
      async observe({ scope, invalidate, reset }) {
        if (
          scope.workspaceId !== "guest" ||
          scope.agentId !== upgrade.agentId ||
          scope.sessionId !== upgrade.sessionId
        )
          throw new Error("Invalid guest event scope")
        const stop = await options.runtime.runtime.subscribeSessionInvalidation(
          upgrade.agentId,
          upgrade.sessionId,
          invalidate,
          reset
        )
        return { stop }
      },
    })
    return {
      receive: (raw) => socket.receive(raw),
      drain: (maxFrames) => socket.drain(maxFrames),
      close() {
        release()
        socket.close()
      },
    }
  }

  return { authorizeUpgrade, open }
}
