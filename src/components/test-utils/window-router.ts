/**
 * The react-router surface the workspace reads, backed by `window.history`, so
 * a test mounts the workspace without a router and reads navigation from the
 * URL. Install with `vi.mock("react-router", () => import(".../window-router"))`.
 */
export const useLocation = () => ({ pathname: window.location.pathname })

export const useNavigate =
  () => (href: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"](
      null,
      "",
      href
    )
  }
