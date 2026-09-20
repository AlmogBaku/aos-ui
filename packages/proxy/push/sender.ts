import { createHash } from "node:crypto"
import { buildPushPayload } from "@block65/webcrypto-web-push"

import type {
  PushCategory,
  PushMessage,
  PushRegistration,
} from "../../protocol/push"
import {
  parsePushEndpoint,
  resolvePublicAddresses,
  type PushHostLookup,
} from "./endpoint"

/** How long a push service may hold an undelivered message. */
const TTL_SECONDS = 3_600

/** Input needs answering now; a finished run can wait behind the screen lock. */
export type PushUrgency = "normal" | "high"

export type PushSendResult = {
  result: "sent" | "gone" | "failed"
  /** The push service's status, when it answered with one. */
  status?: number
}

/** What one device the proxy sends to is addressed by. */
export type PushTarget = Pick<PushRegistration, "subscription">

export interface PushSender {
  send(
    target: PushTarget,
    message: PushMessage,
    urgency: PushUrgency
  ): Promise<PushSendResult>
}

/**
 * The topic a push service collapses undelivered messages by. It is derived
 * from the category alone, so it stays opaque to the vendor while still letting
 * a second unread summary replace the first.
 */
export function topicFor(category: PushCategory) {
  return createHash("sha256")
    .update(`aos:${category}`)
    .digest("hex")
    .slice(0, 32)
}

/** Just enough of `fetch` to post one encrypted message. */
export type PushFetch = (
  endpoint: string,
  init: {
    method: string
    headers: Record<string, string>
    body: Uint8Array
    redirect: "error"
  }
) => Promise<{ ok: boolean; status: number }>

export type PushSenderOptions = {
  vapid: {
    /** `mailto:` or `https:` contact a push service can reach an operator at. */
    subject: string
    /** The 87-character raw point derived from the private scalar. */
    publicKey: string
    privateKey: Uint8Array
  }
  fetch?: PushFetch
  lookup?: PushHostLookup
}

/** A status a push service uses to say this device is no longer subscribed. */
const GONE_STATUSES = [404, 410]

/**
 * Sends one encrypted, content-free message to one device. Every failure is a
 * result rather than a throw, and nothing derived from the endpoint reaches a
 * caller: a dispatcher logs counts, and the device either stays or is dropped.
 */
export function createPushSender({
  vapid,
  fetch: post = globalThis.fetch,
  lookup,
}: PushSenderOptions): PushSender {
  const credentials = {
    subject: vapid.subject,
    publicKey: vapid.publicKey,
    privateKey: Buffer.from(vapid.privateKey).toString("base64url"),
  }

  return {
    async send({ subscription }, message, urgency) {
      try {
        const endpoint = parsePushEndpoint(subscription.endpoint)
        await resolvePublicAddresses(endpoint.hostname, lookup)
        const payload = await buildPushPayload(
          {
            data: message,
            options: {
              ttl: TTL_SECONDS,
              urgency,
              topic: topicFor(message.category),
            },
          },
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime ?? null,
            keys: subscription.keys,
          },
          credentials
        )
        const response = await post(subscription.endpoint, {
          ...payload,
          redirect: "error",
        })
        if (response.ok) return { result: "sent" }
        return {
          result: GONE_STATUSES.includes(response.status) ? "gone" : "failed",
          status: response.status,
        }
      } catch {
        // A refused endpoint, an encryption failure, and a transport failure are
        // the same thing to a caller: this message did not reach this device.
        return { result: "failed" }
      }
    },
  }
}
