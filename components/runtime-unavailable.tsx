import Image from "next/image"
import { AlertCircle } from "lucide-react"

import type { Locale } from "@/lib/i18n/config"
import type { RuntimeUnavailableReason } from "@/lib/runtime-config"

const copy = {
  en: {
    eyebrow: "AOS",
    title: {
      runtime: "The configured runtime is not supported",
      agUi: "AG-UI configuration is incomplete",
    },
    description: {
      runtime:
        "Set AOS_UI_RUNTIME_MODE to fixture, opencode, or ag-ui and restart the application.",
      opencodeUrl:
        "AOS_UI_OPENCODE_BASE_URL must be an absolute HTTP or HTTPS URL.",
      managementUrl:
        "AOS_UI_OPENCODE_MANAGEMENT_URL must be an absolute HTTP or HTTPS URL.",
      incompleteOpencodeModelOverride:
        "Set both AOS_UI_OPENCODE_PROVIDER_ID and AOS_UI_OPENCODE_MODEL_ID, or neither.",
      runUrl:
        "Set AOS_UI_AG_UI_URL to the HTTP endpoint that streams AG-UI events.",
      workspaceUrl:
        "Set AOS_UI_AG_UI_WORKSPACE_URL to the host that provides Agent and Session ownership.",
      invalidRunUrl: "AOS_UI_AG_UI_URL must be an absolute HTTP or HTTPS URL.",
      invalidWorkspaceUrl:
        "AOS_UI_AG_UI_WORKSPACE_URL must be an absolute HTTP or HTTPS URL.",
    },
  },
  he: {
    eyebrow: "AOS",
    title: {
      runtime: "סביבת ההרצה שהוגדרה אינה נתמכת",
      agUi: "תצורת AG-UI אינה מלאה",
    },
    description: {
      runtime:
        "יש להגדיר את AOS_UI_RUNTIME_MODE כ־fixture, opencode או ag-ui ולהפעיל מחדש את היישום.",
      opencodeUrl:
        "הערך AOS_UI_OPENCODE_BASE_URL חייב להיות כתובת HTTP או HTTPS מלאה.",
      managementUrl:
        "הערך AOS_UI_OPENCODE_MANAGEMENT_URL חייב להיות כתובת HTTP או HTTPS מלאה.",
      incompleteOpencodeModelOverride:
        "יש להגדיר גם AOS_UI_OPENCODE_PROVIDER_ID וגם AOS_UI_OPENCODE_MODEL_ID, או לא להגדיר אף אחד מהם.",
      runUrl: "יש להגדיר את AOS_UI_AG_UI_URL כנקודת הקצה שמזרימה אירועי AG-UI.",
      workspaceUrl:
        "יש להגדיר את AOS_UI_AG_UI_WORKSPACE_URL כמארח שמספק בעלות על סוכנים ושיחות.",
      invalidRunUrl:
        "הערך AOS_UI_AG_UI_URL חייב להיות כתובת HTTP או HTTPS מלאה.",
      invalidWorkspaceUrl:
        "הערך AOS_UI_AG_UI_WORKSPACE_URL חייב להיות כתובת HTTP או HTTPS מלאה.",
    },
  },
} as const

function getMessage(locale: Locale, reason: RuntimeUnavailableReason) {
  const labels = copy[locale]

  switch (reason) {
    case "invalid-runtime-mode":
      return { title: labels.title.runtime, body: labels.description.runtime }
    case "invalid-opencode-base-url":
      return {
        title: labels.title.runtime,
        body: labels.description.opencodeUrl,
      }
    case "incomplete-opencode-model-override":
      return {
        title: labels.title.runtime,
        body: labels.description.incompleteOpencodeModelOverride,
      }
    case "invalid-opencode-management-url":
      return {
        title: labels.title.runtime,
        body: labels.description.managementUrl,
      }
    case "missing-ag-ui-run-url":
      return { title: labels.title.agUi, body: labels.description.runUrl }
    case "invalid-ag-ui-run-url":
      return {
        title: labels.title.agUi,
        body: labels.description.invalidRunUrl,
      }
    case "missing-ag-ui-workspace-url":
      return {
        title: labels.title.agUi,
        body: labels.description.workspaceUrl,
      }
    case "invalid-ag-ui-workspace-url":
      return {
        title: labels.title.agUi,
        body: labels.description.invalidWorkspaceUrl,
      }
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
            <Image
              src="/aos-ui-placeholder.svg"
              alt=""
              width={40}
              height={40}
              priority
              className="size-10 object-contain"
            />
          </span>
          <span className="text-sm font-semibold tracking-tight">
            {labels.eyebrow}
          </span>
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
