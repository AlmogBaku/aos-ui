import { z } from "zod"

import { IdentifierSchema } from "./acp"

/**
 * Web Push contract shared by the browser, the service worker, and the proxy.
 * Content-free by construction: a category, a count, opaque ids when exactly
 * one Session is meant, a timestamp, and the device locale.
 */

export const PushCategorySchema = z.enum(["input", "failure", "completion"])
export type PushCategory = z.infer<typeof PushCategorySchema>

/** Which category, if any, an execution or Agent lifecycle event notifies as. */
export function categoryOf(type: string): PushCategory | undefined {
  switch (type) {
    case "attention-requested":
      return "input"
    case "run-failed":
    case "agent-activation-failed":
      return "failure"
    case "run-finished":
    case "agent-ready":
      return "completion"
    default:
      return undefined
  }
}

export const PushLocaleSchema = z.enum(["en", "he"])
export type PushLocale = z.infer<typeof PushLocaleSchema>

/** No input for this long makes a foreground connection non-present. */
export const PRESENCE_IDLE_MS = 180_000
/** Foreground connections re-send their focus report at this cadence. */
export const PRESENCE_HEARTBEAT_MS = 60_000
/** A connection present within this window still holds pushes. */
export const PRESENCE_GRACE_MS = 60_000
/**
 * The same window for a principal with no connection left at all. A closed
 * connection may still be a reload or an in-app navigation, which reopens the
 * socket and reports presence again: that is one round trip, so this covers a
 * reconnect and nothing more. Anything longer would delay the notification an
 * operator who really left is owed, inside a 3-second input window.
 */
export const PRESENCE_CLOSED_GRACE_MS = 2_000
/** Fixed window from the first event in which one push per category is sent. */
export const COALESCE_WINDOW_MS: Readonly<Record<PushCategory, number>> = {
  input: 3_000,
  failure: 5_000,
  completion: 20_000,
}

/**
 * `type` of the message the service worker posts to a focused window when a
 * notification is clicked: `{ type, agentId?, sessionId? }`, ids iff one Session.
 */
export const OPEN_MESSAGE_TYPE = "aos:open"

/** The encrypted payload a device receives; ids are present iff count is 1. */
export const PushMessageSchema = z
  .strictObject({
    v: z.literal(1),
    category: PushCategorySchema,
    count: z.number().int().min(1),
    agentId: IdentifierSchema.optional(),
    sessionId: IdentifierSchema.optional(),
    occurredAt: z.string().datetime(),
    locale: PushLocaleSchema,
  })
  .refine(
    (message) =>
      (message.count === 1) ===
      (message.agentId !== undefined && message.sessionId !== undefined),
    { message: "A single-Session push carries both ids; a count carries none" }
  )
export type PushMessage = z.infer<typeof PushMessageSchema>

export const PushCategoriesSchema = z.strictObject({
  input: z.boolean(),
  failure: z.boolean(),
  completion: z.boolean(),
})
export type PushCategories = z.infer<typeof PushCategoriesSchema>

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u)

/** `PushSubscription.toJSON()` as the browser produces it. */
export const PushSubscriptionJsonSchema = z.strictObject({
  endpoint: z.string().max(2_048),
  expirationTime: z.number().int().nullable().optional(),
  keys: z.strictObject({
    p256dh: Base64UrlSchema.length(87),
    auth: Base64UrlSchema.length(22),
  }),
})
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJsonSchema>

/** `GET /push` */
export const PushInfoSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-configured") }),
  z.strictObject({
    status: z.literal("available"),
    publicKey: Base64UrlSchema.length(87),
  }),
])
export type PushInfo = z.infer<typeof PushInfoSchema>

/** `PUT /push/subscriptions` */
export const PushRegistrationSchema = z.strictObject({
  subscription: PushSubscriptionJsonSchema,
  locale: PushLocaleSchema,
  categories: PushCategoriesSchema,
})
export type PushRegistration = z.infer<typeof PushRegistrationSchema>

/** `DELETE /push/subscriptions` */
export const PushUnregistrationSchema = z.strictObject({
  endpoint: z.string().max(2_048),
})
export type PushUnregistration = z.infer<typeof PushUnregistrationSchema>
