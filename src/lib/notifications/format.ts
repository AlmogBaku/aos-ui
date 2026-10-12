import type { PushCategory, PushLocale } from "@harness-gw/sdk/protocol"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Dictionary } from "@/lib/i18n/dictionary"

/**
 * The one OS notification for a Session, for push and for the in-tab
 * fallback alike. The service worker imports this, so it stays free of zod
 * and of anything that would pull it in.
 */
export type NotificationContent = {
  category: PushCategory
  agentName?: string | undefined
  sessionTitle?: string | undefined
  requestText?: string | undefined
  requestMore?: number | undefined
  locale: PushLocale
}

const dictionaries = { en, he } satisfies Record<PushLocale, Dictionary>

const phrases = {
  input: "needsInput",
  failure: "turnFailed",
  completion: "turnFinished",
} as const satisfies Record<PushCategory, keyof Dictionary["activity"]>

/** Bidi marks, embeddings, and isolates a piece could escape its own with. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

/** One flat line of someone else's text, or nothing when none is left. */
function piece(value: unknown) {
  if (typeof value !== "string") return undefined
  const flat = value
    .replace(/\s/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/ {2,}/g, " ")
    .trim()
  return flat || undefined
}

/** Keeps an embedded piece's direction from reordering the text around it. */
const isolate = (text: string) => `\u2068${text}\u2069`

export function formatNotification(content: NotificationContent) {
  const copy = dictionaries[content.locale]
  const agent = piece(content.agentName)
  const session = piece(content.sessionTitle)
  const request = piece(content.requestText)
  const count = content.requestMore
  const more =
    count !== undefined && Number.isInteger(count) && count >= 1
      ? copy.activity.requestMore.replace("{count}", () => String(count))
      : undefined
  const lines = [
    // The Session follows only when the title already names the Agent.
    [
      copy.activity[phrases[content.category]],
      agent && session && isolate(session),
    ]
      .filter(Boolean)
      .join(" · "),
    request && [isolate(request), more].filter(Boolean).join(" "),
  ]
  return {
    title: agent ?? session ?? copy.productName,
    body: lines.filter(Boolean).join("\n"),
  }
}
