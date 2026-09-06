import {
  Geist,
  Geist_Mono,
  Michroma,
  Noto_Sans_Hebrew,
} from "next/font/google"
import { headers } from "next/headers"
import type { ReactNode } from "react"

import { ThemeProvider } from "@/components/theme-provider"
import { DocumentLocale } from "@/components/document-locale"
import { getDictionary } from "@/lib/i18n/get-dictionary"
import {
  defaultLocale,
  getLocaleDirection,
  isLocale,
  localeRequestHeader,
} from "@/lib/i18n/config"
import { cn } from "@/lib/utils"

import "./globals.css"

export async function generateMetadata() {
  const requestLocale = (await headers()).get(localeRequestHeader)
  const locale =
    requestLocale && isLocale(requestLocale) ? requestLocale : defaultLocale
  const dictionary = await getDictionary(locale)
  return {
    title: dictionary.productName,
    description: dictionary.empty.conversationDescription,
    icons: { icon: "/logo-adaptive.svg" },
  }
}

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
})

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})

const notoSansHebrew = Noto_Sans_Hebrew({
  subsets: ["hebrew"],
  variable: "--font-hebrew",
})

const michroma = Michroma({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-aos-wordmark",
})

export default async function RootLayout({
  children,
}: {
  children: ReactNode
}) {
  const requestLocale = (await headers()).get(localeRequestHeader)
  const locale =
    requestLocale && isLocale(requestLocale) ? requestLocale : defaultLocale

  return (
    <html
      className={cn(
        "antialiased",
        geist.variable,
        geistMono.variable,
        notoSansHebrew.variable,
        michroma.variable
      )}
      lang={locale}
      dir={getLocaleDirection(locale)}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider>
          <DocumentLocale locale={locale} />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
