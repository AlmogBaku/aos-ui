import { AlertCircle } from "lucide-react"

import type { Locale } from "@/lib/i18n/config"
import type { RuntimeUnavailableReason } from "@/lib/runtime-config"

const copy = {
  en: {
    eyebrow: "AOS",
    title: "The configured runtime is not supported",
    invalid: "The deployment runtime configuration is missing or malformed.",
    mode: "Configure fixture or aos in runtime-config.json.",
  },
  he: {
    eyebrow: "AOS",
    title: "סביבת ההרצה שהוגדרה אינה נתמכת",
    invalid: "תצורת סביבת ההרצה חסרה או אינה תקינה.",
    mode: "יש להגדיר fixture או aos בקובץ runtime-config.json.",
  },
} as const

function getMessage(locale: Locale, reason: RuntimeUnavailableReason) {
  const labels = copy[locale]
  return {
    title: labels.title,
    body: reason === "invalid-public-config" ? labels.invalid : labels.mode,
  }
}

export function RuntimeUnavailable({
  locale,
  reason,
}: {
  locale: Locale
  reason: RuntimeUnavailableReason
}) {
  const labels = copy[locale]
  const message = getMessage(locale, reason)

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12">
      <section
        className="w-full max-w-md rounded-3xl border border-border/80 bg-card/95 p-7 shadow-xl shadow-black/10"
        role="alert"
        dir={locale === "he" ? "rtl" : "ltr"}
      >
        <div className="mb-7 flex items-center gap-3">
          <span className="flex size-11 items-center justify-center overflow-hidden rounded-2xl bg-secondary">
            <img
              src="/logo-adaptive.svg"
              alt=""
              width={40}
              height={40}
              className="size-10 object-contain"
            />
          </span>
          <span className="aos-wordmark text-base">{labels.eyebrow}</span>
        </div>
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {message.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {message.body}
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
