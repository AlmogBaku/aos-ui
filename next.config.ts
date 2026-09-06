import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  // Playwright must not contend with an interactive `next dev` process for
  // `.next/dev/lock`. Its server is intentionally ephemeral and isolated.
  distDir: process.env.AOS_UI_E2E_DIST_DIR ?? ".next",
  turbopack: {
    root: process.cwd(),
  },
}

export default nextConfig
