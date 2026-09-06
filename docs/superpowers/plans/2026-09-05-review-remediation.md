# Review Remediation Implementation Plan

> Execute this corrective plan with test-first changes and commit only after the full verification matrix passes.

**Goal:** Restore the real OpenCode integration and close the correctness, ownership, localization, accessibility, and regression-test gaps found in the post-commit audit.

**Architecture:** Keep OpenCode loader entrypoints isolated from reusable helpers, keep provider-owned events keyed by both Agent and Session, keep UI preferences and generated labels explicit at the workspace boundary, and reject malformed rich-tool payloads instead of inventing transport-specific values in the renderer.

**Tech Stack:** Bun, TypeScript, React 19, Next.js 16, Vitest, Testing Library, Playwright, OpenCode 1.18.

**Spec:** `docs/superpowers/specs/2026-09-04-agent-workspace-completion-design.md`

## Global Constraints

- Fixture data appears only in explicit fixture mode; real mode never falls back to synthetic data.
- Every delayed provider event remains scoped to its originating Agent and Session.
- English LTR and Hebrew RTL stay first-class, including app-generated labels and spoken numeric values.
- Animations added by AOS must stop under reduced-motion preferences.
- Rich output remains schema-validated, inspectable, and safe; malformed data falls back textually.
- Do not write real Agent definitions as part of routine automated verification.

### Task 1: Repair OpenCode plugin loading

**Files:** `.opencode/plugins/aos-ui-harness.ts`, `.opencode/lib/aos-ui-harness.ts`, `test/opencode/aos-ui-harness-plugin.test.ts`

- Add a regression test that invokes every function exported from the auto-loaded plugin module the way OpenCode does and proves only valid plugin entrypoints exist.
- Move reusable prompt-append logic outside `.opencode/plugins` and leave a single default plugin export.
- Run `bunx vitest run test/opencode/aos-ui-harness-plugin.test.ts`.

### Task 2: Correct workspace ownership and preference persistence

**Files:** `lib/runtime-adapters/workspace-state.ts`, `lib/runtime-adapters/workspace-state.test.ts`, `components/workspace/workspace-shell.tsx`, `components/workspace/workspace-shell.test.tsx`, `e2e/desktop.workspace.spec.ts`

- Add a collision regression test for identical Session IDs under different Agents.
- Require Agent plus Session when reading cached events.
- Persist the desktop inspector under `aos_ui:workspace:inspector-open`; accept only literal `true` and `false`, defaulting open otherwise.
- Run the focused Vitest files.

### Task 3: Localize generated UI and honor reduced motion

**Files:** `components/tool-ui/stats.tsx`, `components/tool-ui/stats-display/stats-display.tsx`, `components/tool-ui/stats-display/sparkline.tsx`, `components/assistant-ui/elements/thread.aui.tsx`, `components/assistant-ui/elements/tool-fallback.aui.tsx`, `components/assistant-ui/elements/reasoning.tsx`, and focused tests.

- Format spoken percentages with `Intl.NumberFormat` using the active locale.
- Gate AOS animation utilities with `motion-safe:` or provide explicit reduced-motion suppression.
- Add focused behavior/accessibility regressions and run them.

### Task 4: Tighten rich-tool normalization and app-created labels

**Files:** `components/tool-ui/chart.tsx`, `components/tool-ui/rich-tool-renderer.test.tsx`, the workspace adapter contract and implementations, `components/aos-ui-workspace.tsx`, locale dictionaries, and focused tests.

- Remove chart shorthand repair and the fabricated English `Value` series; invalid payloads must render an inspectable fallback.
- Pass localized app-created Agent and Session labels from the locale-aware workspace into provider-neutral creation operations.
- Run focused adapter and workspace tests.

### Task 5: Restore Google credential forwarding

**Files:** `scripts/opencode-config.ts`, `scripts/opencode-serve.ts`, `compose.yaml`, `.env.compose.example`, `README.md`, and focused tests.

- Preserve `GOOGLE_GENERATIVE_AI_API_KEY` and accept the common `GEMINI_API_KEY` name as a launcher alias when the canonical OpenCode variable is absent.
- Pass both variable names only to the OpenCode Compose service and verify the resolved configuration does not expose them to the web service.
- Restart OpenCode and confirm Google appears in its connected provider catalog.

### Task 6: Verification and live integration smoke

- Run `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run test:e2e`, and `bun run monty:test`.
- Restart the real OpenCode server after plugin changes, open the real app at `/en`, and confirm the current log contains no plugin-load error.
- Confirm the browser-facing app uses OpenCode data and no fixture process is running.
- Commit the corrective diff without amending or pushing.
