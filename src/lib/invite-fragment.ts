export function captureInviteToken() {
  if (typeof window === "undefined") return undefined
  const parameters = new URLSearchParams(location.hash.slice(1))
  const token = parameters.get("invite") ?? undefined
  if (!token) return undefined
  parameters.delete("invite")
  const hash = parameters.toString()
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`
  )
  return token
}
