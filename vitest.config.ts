import { configDefaults, defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

import { reactCompiler } from "./react-compiler.config"

/**
 * The `.test.ts` files that need a DOM: they render, lay out, or reach browser
 * storage, media, or history. Every other `.test.ts` runs in Node, and one
 * missing here fails there on the first browser global it touches.
 */
const domTests = [
  "src/components/agent-icons/pointer-tracking.test.ts",
  "src/components/artifacts/artifact-renderers.test.ts",
  "src/components/assistant-ui/elements/mermaid-sanitize.test.ts",
  "src/components/assistant-ui/elements/thread-reading-position.test.ts",
  "src/components/keyboard/focus-regions.test.ts",
  "src/components/keyboard/keyboard-settings.test.ts",
  "src/components/mcp-apps/sandbox-proxy.test.ts",
  "src/components/mcp-apps/sandbox-relay.test.ts",
  "src/components/workspace/session-tab-undo.test.ts",
  "src/components/workspace/use-install-prompt.test.ts",
  "src/lib/keyboard/foundation.test.ts",
  "src/lib/notifications/browser-platform.test.ts",
  "src/lib/notifications/push-subscription.test.ts",
  "src/lib/notifications/sound.test.ts",
  "src/runtime-adapters/aos/acp/connection.test.ts",
  "src/runtime-adapters/aos/use-connection-outage.test.ts",
]

/**
 * Checks that run a production build or an external tool. They take most of a
 * sweep's time and change only with the build, the bundle, Compose, or the lint
 * rules, so `bun run test` skips them and `bun run test:gate` runs them.
 */
const gateTests = [
  "packages/tools-mcp/views/build.test.ts",
  "test/architecture/runtime-import-boundaries.test.ts",
  "test/architecture/startup-bundle.test.ts",
  "test/containers/compose.test.ts",
]

export default defineConfig({
  plugins: [react(), reactCompiler()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@aos/protocol/acp": path.resolve(
        import.meta.dirname,
        "packages/protocol/acp.ts"
      ),
      "@aos/protocol/push": path.resolve(
        import.meta.dirname,
        "packages/protocol/push.ts"
      ),
      "@aos/protocol/mcp-apps": path.resolve(
        import.meta.dirname,
        "packages/protocol/mcp-apps.ts"
      ),
      "@aos/protocol": path.resolve(
        import.meta.dirname,
        "packages/protocol/index.ts"
      ),
      "@aos/lifecycle": path.resolve(
        import.meta.dirname,
        "packages/lifecycle/index.ts"
      ),
    },
  },
  // Every setting here, plugins and aliases included, is inherited by both
  // projects below; each project adds only its files and its environment.
  test: {
    // Agent worktrees nest a full checkout under `.claude`; sweeping them
    // reports every test twice and the stale copy's failures as ours.
    exclude: [...configDefaults.exclude, ".worktrees/**", "**/.claude/**"],
    restoreMocks: true,
    // The workspace composition tests each drive a full jsdom app through
    // several async Session switches and take 2-6s alone; with one worker per
    // core they slow 3-4x under load, so the default 5s budget turned real
    // load into phantom failures. The budget bounds a hung test, not a slow
    // one: a passing test never waits for it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One worker per core is the default, and several agent worktrees sweeping
    // at once oversubscribe the machine several times over — which starves the
    // operator's own deployment on the same host, not just the suite. Half the
    // cores keeps a concurrent sweep survivable; a machine running one sweep
    // alone can raise it.
    maxWorkers: Number(process.env.AOS_UI_TEST_WORKERS) || "50%",
    // Lists the slowest tests past their project's budget after every run.
    reporters: ["default", "./test/support/slow-tests-reporter.ts"],
    // Tests that need no DOM skip jsdom and the Testing Library setup. Each
    // test file lands in exactly one project: `.tsx` files and `domTests` in
    // `dom`, `gateTests` in `gate`, every other `.test.ts` in `node`.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: [...domTests, ...gateTests],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
          include: ["**/*.test.tsx", ...domTests],
        },
      },
      {
        extends: true,
        test: { name: "gate", environment: "node", include: gateTests },
      },
    ],
  },
})
