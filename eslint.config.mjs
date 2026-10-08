import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"
import runtimeBoundaries from "./scripts/eslint-runtime-boundaries.mjs"

/** The UI-owned MCP tool server runs beside the harness, not in the browser. */
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

const productionBrowserPattern = {
  group: browserRestrictedImports,
  message:
    "Browser code must not import native implementations or private Assistant UI internals.",
}

/** The UI the browser ACP client serves, which it must never depend on. */
const componentImports = [
  "@/components",
  "@/components/*",
  "../**/components",
  "../**/components/**",
]

const styleAssertionMessage =
  "Tests never assert styling (classes, data-slot, computed styles, geometry, screenshots); look at the rendered app instead. See AGENTS.md › Writing tests."

/** A read of styling or geometry, banned as the subject of an `expect`. */
const styleRead =
  ":matches(CallExpression[callee.name='getComputedStyle'], CallExpression[callee.property.name=/^(getComputedStyle|boundingBox|getBoundingClientRect)$/], MemberExpression[property.name=/^(className|classList|style|offsetWidth|offsetHeight|clientWidth|clientHeight)$/])"

export default defineConfig([
  globalIgnores([
    "dist/**",
    "packages/tools-mcp/dist/**",
    "coverage/**",
    "**/.venv/**",
    ".agents/**",
    ".claude/**",
    ".hermes/**",
    ".impeccable/**",
    ".worktrees/**",
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
              group: ["@/*", "src/*", "src/**", "../**/src/**"],
              message:
                "The tools MCP server and its views depend only on shared contracts, never on browser code.",
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
    // Tests assert behavior, never styling. Geometry and computed styles stay
    // available for driving the page (pointer coordinates, finding the
    // scroller); only asserting on them is banned.
    files: ["e2e/**/*.ts", "test/**/*.ts", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(toHaveClass|toHaveStyle|toHaveCSS|toHaveScreenshot)$/]",
          message: styleAssertionMessage,
        },
        {
          selector:
            "CallExpression[callee.property.name='toHaveAttribute'] > Literal.arguments:first-child[value=/^(class|style|data-slot)$/]",
          message: styleAssertionMessage,
        },
        {
          selector: `CallExpression[callee.name='expect'] > ${styleRead}`,
          message: styleAssertionMessage,
        },
        {
          selector: `CallExpression[callee.name='expect'] > * ${styleRead}`,
          message: styleAssertionMessage,
        },
      ],
    },
  },
  {
    // Type-aware promise rules for the web server and the browser runtime adapters.
    files: ["server/**/*.ts", "src/runtime-adapters/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/*.bun-spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // allowDefaultProject covers the virtual lintText paths used in the
          // architecture test that do not exist on disk. Real source files are
          // discoverable through the root tsconfig.json.
          allowDefaultProject: [
            "src/components/example.tsx",
            "src/components/example.test.tsx",
            "src/runtime-adapters/fixture/example.ts",
            "src/runtime-adapters/aos/example.ts",
            "src/runtime-adapters/aos/acp/example.ts",
            "packages/tools-mcp/example.ts",
            "packages/tools-mcp/views/example.tsx",
            "shared/example.ts",
          ],
        },
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
