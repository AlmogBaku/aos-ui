"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type {
  RuntimeApprovalRequest,
  RuntimeInteractionAdapter,
} from "@/runtime-adapters/contracts"

const copy: Record<Locale, { label: string; failed: string }> = {
  en: {
    label: "Permission request",
    failed:
      "The decision could not be sent; the request may no longer be current.",
  },
  he: {
    label: "בקשת הרשאה",
    failed: "לא ניתן לשלוח את ההחלטה. ייתכן שהבקשה כבר אינה בתוקף.",
  },
}

/** Renders provider-defined approvals without exposing a provider implementation. */
export function RuntimeApprovalComposer({
  locale,
  request,
  interactions,
  onResolved,
}: {
  locale: Locale
  request: RuntimeApprovalRequest
  interactions: RuntimeInteractionAdapter
  onResolved: (request: RuntimeApprovalRequest) => void
}) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const labels = copy[locale]

  async function respond(option: string) {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      await interactions.respond(request, { kind: "approval", option })
      onResolved(request)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <section
      className="flex flex-col gap-2"
      role="group"
      aria-label={labels.label}
      data-slot="approval-composer"
    >
      <p className="text-sm text-muted-foreground" dir="auto">
        {request.message}
      </p>
      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {labels.failed}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.value ?? option.label}
            type="button"
            disabled={pending}
            variant={option.value === "deny" ? "outline" : "default"}
            onClick={() => void respond(option.value ?? option.label)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </section>
  )
}
