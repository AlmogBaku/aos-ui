import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"
import runtimeBoundaries from "./scripts/eslint-runtime-boundaries.mjs"

export default defineConfig([
  globalIgnores([
    "dist/**",
    "coverage/**",
    "integrations/**/dist/**",
    "**/.venv/**",
    ".agents/**",
    ".claude/**",
    ".hermes/**",
    ".impeccable/**",
    ".worktrees/**",
    // Upstream-verbatim files are ignored; AOS-authored files in the same
    // directory (gateway-events.ts, snapshot.test.ts, UPSTREAM.md) are not.
    "packages/proxy/adapters/hermes/vendor/**/json-rpc-gateway.ts",
    "packages/proxy/adapters/hermes/vendor/**/json-rpc-channel.ts",
    "packages/proxy/adapters/hermes/vendor/**/reconnect-backoff.ts",
    "packages/proxy/adapters/hermes/vendor/**/json-rpc-channel.test.ts",
    "packages/proxy/adapters/hermes/vendor/**/json-rpc-gateway-replay.test.ts",
    "packages/proxy/adapters/hermes/vendor/**/reconnect-backoff.test.ts",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx,mts,cts}"],
    plugins: { aos: runtimeBoundaries },
    rules: { "aos/runtime-package-boundaries": "error" },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-restricted-globals": ["error", "process"],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "integrations/*",
                "integrations/**",
                "../**/integrations/**",
                "../../integrations/**",
                "scripts/*",
                "scripts/**",
                "../**/scripts/**",
                "@assistant-ui/*/dist/**",
                "@assistant-ui/*/src/**",
              ],
              message:
                "Browser code must not import native implementations or private Assistant UI internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["shared/**/*.ts"],
    ignores: ["shared/**/*.test.ts"],
    languageOptions: {
      globals: { URL: "readonly" },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/*",
                "react",
                "react/*",
                "@ag-ui/*",
                "@assistant-ui/*",
                "@opencode-ai/*",
                "src/*",
                "src/**",
                "../src/**",
                "integrations/*",
                "integrations/**",
                "../integrations/**",
                "../**/integrations/**",
                "node:*",
              ],
              message:
                "Shared contracts must remain browser- and native-independent.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "navigator",
        "process",
      ],
    },
  },
  {
    files: [
      "scripts/**/*.{ts,mts}",
      "test/**/*.ts",
      "e2e/**/*.ts",
      "**/*.config.{ts,mts,mjs}",
      "**/*.test.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        Bun: "readonly",
      },
    },
    rules: {
      "no-restricted-globals": "off",
    },
  },
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
])
