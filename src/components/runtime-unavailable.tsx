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
        "Configure fixture, opencode, hermes, or ag-ui in runtime-config.json.",
      opencodeUrl:
        "AOS_UI_OPENCODE_BASE_URL must be an absolute HTTP or HTTPS URL.",
      opencodeDirectory:
        "Configure the absolute OpenCode worktree directory for this deployment.",
      publicConfig:
        "The deployment runtime configuration is missing or malformed.",
      hermesUrl:
        "Configure the native Hermes URL or same-origin proxy path, such as /hermes.",
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
        "יש להגדיר fixture, opencode, hermes או ag-ui בקובץ runtime-config.json.",
      opencodeUrl:
        "הערך AOS_UI_OPENCODE_BASE_URL חייב להיות כתובת HTTP או HTTPS מלאה.",
      opencodeDirectory:
        "יש להגדיר נתיב מוחלט לסביבת העבודה של OpenCode עבור פריסה זו.",
      publicConfig: "תצורת סביבת ההרצה חסרה או אינה תקינה.",
      hermesUrl:
        "יש להגדיר כתובת Hermes או נתיב מתווך באותו מקור, למשל ‎/hermes.",
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
    case "invalid-public-config":
      return {
        title: labels.title.runtime,
        body: labels.description.publicConfig,
      }
    case "missing-hermes-base-url":
    case "invalid-hermes-base-url":
      return {
        title: labels.title.runtime,
        body: labels.description.hermesUrl,
      }
    case "invalid-runtime-mode":
      return { title: labels.title.runtime, body: labels.description.runtime }
    case "invalid-opencode-base-url":
      return {
        title: labels.title.runtime,
        body: labels.description.opencodeUrl,
      }
    case "missing-opencode-directory":
    case "invalid-opencode-directory":
      return {
        title: labels.title.runtime,
        body: labels.description.opencodeDirectory,
      }
    case "incomplete-opencode-model-override":
      return {
        title: labels.title.runtime,
        body: labels.description.incompleteOpencodeModelOverride,
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
