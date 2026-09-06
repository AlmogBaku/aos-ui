import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import {
  getLocaleFromPathname,
  resolveLocale,
  stripLocaleFromPathname,
} from "@/lib/i18n/routing"
import { localeCookieName, localeRequestHeader } from "@/lib/i18n/config"

const localeCookieOptions = {
  maxAge: 60 * 60 * 24 * 365,
  path: "/",
  sameSite: "lax" as const,
}

export function proxy(request: NextRequest) {
  const pathnameLocale = getLocaleFromPathname(request.nextUrl.pathname)
  if (pathnameLocale) {
    const compactUrl = request.nextUrl.clone()
    compactUrl.pathname = stripLocaleFromPathname(compactUrl.pathname)
    const response = NextResponse.redirect(compactUrl)
    response.cookies.set(localeCookieName, pathnameLocale, localeCookieOptions)
    return response
  }

  const locale = resolveLocale(
    request.cookies.get(localeCookieName)?.value,
    request.headers.get("accept-language")
  )
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(localeRequestHeader, locale)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  if (!request.cookies.has(localeCookieName)) {
    response.cookies.set(localeCookieName, locale, localeCookieOptions)
  }

  return response
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
