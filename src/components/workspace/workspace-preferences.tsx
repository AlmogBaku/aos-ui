"use client"

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useSyncExternalStore } from "react"

import { buttonVariants } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { setPreferredLocale } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"

import styles from "./workspace-shell.module.css"

type ThemeMode = "light" | "system" | "dark"

const themeIcons: Record<ThemeMode, LucideIcon> = {
  light: Sun,
  system: Monitor,
  dark: Moon,
}

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === "light" || value === "system" || value === "dark"
}

function subscribeToClientReady() {
  return () => undefined
}

export function WorkspacePreferences({
  locale,
  dictionary,
  commandsHost = false,
}: {
  locale: Locale
  dictionary: Dictionary
  commandsHost?: boolean
}) {
  const { setTheme, theme } = useTheme()
  const mounted = useSyncExternalStore(
    subscribeToClientReady,
    () => true,
    () => false
  )
  const activeTheme = isThemeMode(theme) ? theme : "system"
  const targetLocale: Locale = locale === "en" ? "he" : "en"
  const targetLocaleLabel = targetLocale === "he" ? "עב" : "EN"
  const switchLocaleLabel =
    targetLocale === "he"
      ? dictionary.actions.switchToHebrew
      : dictionary.actions.switchToEnglish
  function switchLocale() {
    setPreferredLocale(targetLocale)
  }

  const themeOptions: Array<{
    value: ThemeMode
    label: string
    icon: LucideIcon
  }> = [
    {
      value: "light",
      label: dictionary.appearance.light,
      icon: themeIcons.light,
    },
    {
      value: "system",
      label: dictionary.appearance.system,
      icon: themeIcons.system,
    },
    {
      value: "dark",
      label: dictionary.appearance.dark,
      icon: themeIcons.dark,
    },
  ]

  return (
    <div className={styles.workspacePreferences} data-workspace-preferences>
      <TooltipProvider>
        <ToggleGroup
          className={styles.themeControl}
          spacing={0.5}
          role="group"
          aria-label={dictionary.appearance.label}
          value={mounted ? [activeTheme] : []}
          disabled={!mounted}
          onValueChange={(values) => {
            const nextTheme = values[0]
            if (isThemeMode(nextTheme)) setTheme(nextTheme)
          }}
        >
          {themeOptions.map(({ value, label, icon: Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    className={styles.themeButton}
                    type="button"
                    value={value}
                    aria-label={label}
                  >
                    <Icon aria-hidden="true" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </TooltipProvider>

      <div className={styles.preferenceActions}>
        {commandsHost ? <div data-keyboard-commands-host /> : null}
        <button
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            styles.localeButton
          )}
          type="button"
          aria-label={switchLocaleLabel}
          title={switchLocaleLabel}
          lang={targetLocale}
          dir={getLocaleDirection(targetLocale)}
          onClick={switchLocale}
        >
          <bdi>{targetLocaleLabel}</bdi>
        </button>
      </div>
    </div>
  )
}
