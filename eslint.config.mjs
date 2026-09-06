import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-e2e/**",
    ".next-e2e-fixture/**",
    ".next-e2e-opencode/**",
    ".next-e2e-keyboard-opencode/**",
    ".next-e2e-ag-ui/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python dependencies can include third-party JavaScript assets.
    "**/.venv/**",
    // Local agent/design tooling is vendored into the workspace, not shipped.
    ".agents/**",
    ".claude/**",
    ".impeccable/**",
    ".worktrees/**",
  ]),
])

export default eslintConfig
