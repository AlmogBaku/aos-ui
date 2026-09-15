export function captureInviteToken() {
  if (typeof window === "undefined") return undefined
  const parameters = new URLSearchParams(location.hash.slice(1))
  return parameters.get("invite") ?? undefined
}
