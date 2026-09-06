"use client"

import { useLayoutEffect } from "react"

import { getLocaleDirection, type Locale } from "@/lib/i18n/config"

export function DocumentLocale({ locale }: { locale: Locale }) {
  useLayoutEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = getLocaleDirection(locale)
  }, [locale])

  return null
}
