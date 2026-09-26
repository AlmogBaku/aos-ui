import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"
import runtimeBoundaries from "./scripts/eslint-runtime-boundaries.mjs"

/** The UI-owned MCP tool server runs beside the harness, not in the browser or proxy. */
const toolsMcpImports = [
  "packages/tools-mcp",
  "packages/tools-mcp/**",
  "../**/tools-mcp",
  "../**/tools-mcp/**",
]

/** Native implementations and private Assistant UI internals, off limits to src. */
const browserRestrictedImports = [
  ...toolsMcpImports,
  "node:*",
  "scripts/*",
  "scripts/**",
  "../**/scripts/**",
  "@assistant-ui/*/dist/**",
  "@assistant-ui/*/src/**",
]

/** The proxy too, for production browser code; tests may compose both sides. */
const productionBrowserRestrictedImports = [
  ...browserRestrictedImports,
  "packages/proxy/*",
  "packages/proxy/**",
  "../**/packages/proxy/**",
]

const productionBrowserPattern = {
  group: productionBrowserRestrictedImports,
  message:
    "Browser code must not import the proxy, native implementations, or private Assistant UI internals.",
}

/** The UI the browser ACP client serves, which it must never depend on. */
const componentImports = [
  "@/components",
  "@/components/*",
  "../**/components",
  "../**/components/**",
]

export default defineConfig([
  globalIgnores([
    "dist/**",
    "coverage/**",
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
              group: browserRestrictedImports,
              message:
                "Browser code must not import native implementations or private Assistant UI internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [productionBrowserPattern] },
      ],
    },
  },
  {
    // A later block replaces the rule's options, so it repeats the browser ban.
    files: ["src/runtime-adapters/aos/acp/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            productionBrowserPattern,
            {
              group: componentImports,
              message:
                "The ACP client must not import UI components; what it shares with them lives in src/runtime-adapters/contracts.ts or src/lib.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/proxy/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: toolsMcpImports,
              message:
                "The proxy must not import the tools MCP server; harnesses reach it over MCP.",
            },
            {
              group: ["@aos/lifecycle", "@aos/lifecycle/*"],
              message:
                "The proxy imports the lifecycle package by relative path; the server image resolves no aliases.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/lifecycle/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "bun",
                "bun:*",
                "@/*",
                "src/*",
                "src/**",
                "../**/src/**",
                "packages/proxy",
                "packages/proxy/**",
                "../proxy",
                "../proxy/**",
                "../**/packages/proxy/**",
              ],
              message:
                "The lifecycle package stays pure: no Node, Bun, browser or proxy imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/tools-mcp/views/**/*.{ts,tsx}"],
    ignores: ["packages/tools-mcp/views/build.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["packages/tools-mcp/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/*",
                "src/*",
                "src/**",
                "../**/src/**",
                "packages/proxy",
                "packages/proxy/**",
                "../proxy",
                "../proxy/**",
                "../**/packages/proxy/**",
              ],
              message:
                "The tools MCP server and its views depend only on shared contracts, never on browser or proxy code.",
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
    // Type-aware promise rules for the proxy, lifecycle, and browser ACP adapter.
    // part b removes the per-rule ignores for the six files other lanes own.
    files: [
      "packages/proxy/**/*.{ts,tsx}",
      "packages/lifecycle/**/*.{ts,tsx}",
      "src/runtime-adapters/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/*.bun-spec.ts",
      // part b removes this
      "packages/proxy/adapters/**",
      "packages/proxy/core/link.ts",
      "packages/proxy/core/limits.ts",
      "packages/proxy/core/channel.ts",
      "packages/proxy/core/session-coordinator.ts",
      "packages/proxy/core/session-reporter.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          // allowDefaultProject covers the virtual lintText paths used in the
          // architecture test that do not exist on disk. Real source files are
          // discoverable through packages/proxy/tsconfig.json,
          // packages/lifecycle/tsconfig.json, and the root tsconfig.json.
          allowDefaultProject: [
            "packages/proxy/example.ts",
            "packages/proxy/acp/example.ts",
            "packages/proxy/core/example.ts",
            "packages/lifecycle/example.ts",
            "src/components/example.tsx",
            "src/components/example.test.tsx",
            "src/runtime-adapters/fixture/example.ts",
            "src/runtime-adapters/aos/example.ts",
            "src/runtime-adapters/aos/acp/example.ts",
            "packages/tools-mcp/example.ts",
            "packages/tools-mcp/views/example.tsx",
            "shared/example.ts",
          ],
        }
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, ignoreIIFE: true },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
])
