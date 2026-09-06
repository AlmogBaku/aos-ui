# Impeccable Audit Remediation Implementation Plan

> Execute with subagent-driven development: one sequential implementer and one independent task review per task, followed by full verification, whole-branch review, and a fresh Impeccable audit.

**Goal:** Raise the AOS workspace from the 2026-09-05 Impeccable audit baseline of 14/20 to 20/20, with no P0-P2 findings and the missing design documentation resolved.

**Architecture:** Preserve the existing provider-neutral workspace and Assistant UI ownership boundaries. Fix the audit at the shared token, presentation, semantics, responsive-layout, and renderer-loading layers. Keep provider contracts and serializable tool schemas unchanged. Use deterministic fixtures and behavior-focused tests.

**Tech stack:** Next.js 16.2.6, React 19, TypeScript, Tailwind CSS 4, Assistant UI, Base UI, Vitest, Playwright, Bun.

**Spec and visual authority:** `PRODUCT.md`, `AGENTS.md`, and `docs/design/agent-workspace-design-lock.md`. The design lock is authoritative; this is a refinement, not a redesign.

## Baseline

- Accessibility/theming: the light primary foreground pairing is approximately 4.46:1; the dark primary pairing is approximately 2.93:1. The composer placeholder is approximately 2.58:1 light and 3.11:1 dark.
- Semantics: Plan and Question progress indicators have no accessible names; rich tool headings skip from the page `h1` to `h3`.
- Responsive design: at 200% root text scaling the workspace exceeds the viewport and important controls become inaccessible; multiple coarse-pointer controls are below 44×44 CSS pixels.
- Motion: alert-dialog, accordion, and Plan transitions are not all intentionally reduced.
- Theming: chart and rich-tool status colors include hard-coded values rather than semantic tokens.
- Performance: the fixture route ships approximately 685,010 compressed bytes of JavaScript and a large eager Assistant UI/tool renderer chunk.
- Documentation: root `DESIGN.md` is missing even though the incumbent visual world is coherent and locked.

## Global Constraints

- Preserve `docs/design/agent-workspace-design-lock.md`; do not redesign the workspace or add decorative effects.
- English LTR and Hebrew RTL are first-class. Add both locales for any new user-facing or accessible string, use logical layout properties, and verify both directions when affected.
- Assistant UI remains authoritative for threads, messages, runs, branches, composer state, and thread lifecycle. Provider data remains authoritative and scoped to its originating Agent and Session.
- Keep provider-specific behavior behind its existing adapter. Do not change `lib/runtime-adapters/contracts.ts` unless a genuinely shared concept makes it unavoidable; this plan expects no provider contract changes.
- Keep rich output safe and inspectable. Preserve textual fallbacks and never execute generated code or arbitrary HTML.
- Keep all serializable tool input/result schemas renderer-free and unchanged in wire shape.
- Use test-driven development for behavior changes: record the expected failing test, confirm RED for the intended reason, implement the minimum change, then confirm GREEN and relevant regression coverage.
- Use Bun for all JavaScript commands. Before handoff run `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:e2e`.
- Preserve unrelated working-tree changes. Do not add production dependencies.

### Task 1: Repair contrast and establish semantic color roles

**Files:**
- Modify: `app/globals.css`
- Modify: `components/ui/button.tsx`
- Modify: `components/assistant-ui/elements/thread.aui.tsx`
- Modify: `components/tool-ui/chart-visual.tsx`
- Modify: `components/tool-ui/stats-display/stats-display.tsx`
- Modify: `components/tool-ui/plan/plan.tsx`
- Modify: `components/tool-ui/question-flow/question-flow.tsx`
- Test: use the nearest existing token, component, and browser/E2E test files; add a focused contrast behavior test if no suitable file exists.

1. Write focused failing assertions that obtain the computed foreground/background colors used by primary actions and composer placeholder text, convert supported CSS color values to sRGB, and require at least 4.5:1 contrast. The assertions must exercise the rendered or computed behavior, not grep source text.
2. Confirm the contrast assertions fail for the current light/dark primary and placeholder combinations.
3. In `app/globals.css`, set the light `--primary` to `oklch(0.57 0.22 285)` and use an intentionally dark foreground for the dark-theme primary surface. Add reusable `--primary-hover` and `--success` semantic roles for both themes. Map them through the existing Tailwind theme layer.
4. Use the primary hover token for primary buttons and the skip link. Remove low-opacity placeholder styling (`/60`) so the composer placeholder uses a token pairing that clears 4.5:1 in both themes.
5. Replace chart hex literals with the existing chart CSS variables. Replace rich-tool success/error color literals in Plan, QuestionFlow, and StatsDisplay with semantic success/destructive tokens. Remove the Plan's colored `rgba(...)` glow; retain restrained, token-based hierarchy.
6. Confirm the focused tests pass in both themes, then run the smallest relevant unit and browser checks.

**Acceptance:** all normal-sized primary/placeholder text pairings are at least 4.5:1 in light and dark; visualization/status colors come from theme tokens; no zero-offset Plan glow remains; no visual identity change beyond the audited repair.

### Task 2: Restore accessible semantics and intentional reduced motion

**Files:**
- Modify: `components/tool-ui/common.tsx`
- Modify: `components/tool-ui/plan/plan.tsx`
- Modify: `components/tool-ui/question-flow/question-flow.tsx`
- Modify: `components/ui/alert-dialog.tsx`
- Modify: `components/ui/accordion.tsx`
- Modify locale resources where the existing feature-local English/Hebrew strings live.
- Test: nearest ToolChrome, Plan, QuestionFlow, dialog, accordion, and E2E accessibility tests.

1. Write failing tests for named progress bars, page/tool heading hierarchy, and reduced-motion behavior. The named progress tests must query by role and localized accessible name. The hierarchy test must observe real rendered heading levels. Motion tests must verify the reduced-motion branch disables or shortens the audited transitions while preserving visible state change.
2. Confirm RED against current behavior.
3. Add localized accessible names to Plan and QuestionFlow progress indicators in English and Hebrew.
4. Add a runtime-only `headingLevel?: 2 | 3` presentation prop to ToolChrome, Plan, and QuestionFlow. Default standalone rich tools to `h2`; use `h3` only when the tool is actually nested below an `h2`. Keep the serializable tool schemas and provider payloads unchanged.
5. Add intentional `prefers-reduced-motion` handling for alert-dialog entrance/exit, accordion expansion/collapse, and Plan progress transitions. Preserve state hierarchy and focus behavior instead of relying only on a global near-zero-duration kill switch.
6. Confirm focused tests pass and run the smallest relevant unit and browser checks in English and Hebrew.

**Acceptance:** progress indicators have localized names, workspace heading order does not skip levels, serializable schemas are unchanged, and audited motion responds intentionally to reduced-motion preferences.

### Task 3: Make text reflow and touch targets robust

**Files:**
- Modify: `components/workspace/workspace-shell.tsx`
- Modify: `components/workspace/workspace-shell.module.css`
- Modify: `app/globals.css`
- Modify affected compact controls only where the shared coarse-pointer rule cannot safely cover them.
- Test: `test/e2e/` workspace responsive/reflow coverage and the nearest unit tests.

1. Add a failing Playwright journey that loads the deterministic fixture workspace, emulates 200% root text scaling, and asserts there is no page-level horizontal overflow and that the primary navigation/composer controls remain reachable. Cover both English LTR and Hebrew RTL where layout direction changes the result.
2. Add a failing coarse-pointer/touch assertion for audited controls below 44×44 CSS pixels, using a coarse-pointer media environment rather than forcing desktop controls to be oversized.
3. Confirm RED for the existing overflow and touch-target behavior.
4. Add a neutral inline-size container wrapper at the workspace composition boundary. Convert the shell's `64rem`, `80rem`, and `90rem` viewport media decisions to container queries so text zoom reduces the effective layout capacity and activates the existing narrow-screen drawers.
5. Ensure the drawer/focus behavior remains the existing implementation; do not build a new mobile navigation model. Eliminate horizontal overflow at 200% without hiding content.
6. Under `@media (pointer: coarse)`, enforce a minimum `2.75rem` block and inline target size for appropriate icon buttons, tabs, and compact controls while preserving fine-pointer density.
7. Confirm the new E2E journeys pass, then run the full affected responsive and locale E2E group.

**Acceptance:** at 200% text scaling the workspace has no page-level horizontal scroll and important controls remain operable; coarse-pointer targets are at least 44×44 CSS pixels; standard desktop density and existing drawer semantics remain intact.

### Task 4: Split optional rich-tool renderers from the initial bundle

**Files:**
- Modify: `components/tool-ui/registry.tsx`
- Modify renderer modules as necessary to separate serializable schemas/types from UI-only imports.
- Add focused registry/lazy-renderer tests near existing tool UI tests.
- Read and follow `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` and `package-bundling.md` before implementation.

1. Capture a fresh production analyzer baseline with `bunx next experimental-analyze --output` (or the repository's equivalent analyzer command) and record total compressed route JavaScript plus the largest relevant chunk in the task report.
2. Write failing tests proving an optional rich tool renders through an explicit lazy boundary with an inspectable loading/error fallback and that the registry can adapt the tool without eagerly importing its renderer implementation. Test observable registry/render behavior, not source-string presence.
3. Confirm RED against the eager registry.
4. Keep serializable schemas and validation renderer-free. Keep Plan, Activity, and generic fallback renderers eager because the default fixture exercises them on first load.
5. Load QuestionFlow, Permission, Monty, Chart, Map, and Stats display renderers through explicit top-level `React.lazy` or supported Next.js dynamic imports. Use named import adapters where needed, stable fallbacks, and no variable-path dynamic imports.
6. Preserve runtime inputs, error boundaries, textual fallbacks, tool lifecycle behavior, and both provider compositions.
7. Confirm focused tests pass, run relevant unit/E2E tests, rebuild the analyzer output, and record the before/after numbers.

**Acceptance:** optional renderer code is absent from the initial fixture-route bundle until needed; lazy failures remain inspectable; no schema or provider contract changes; compressed initial JavaScript is at most 650 KB, down from approximately 685 KB.

### Task 5: Carbonize the incumbent visual system in DESIGN.md

**Files:**
- Create: `DESIGN.md`
- Create: `.impeccable/design.json` only if repository policy allows tracking it; because `.impeccable/` is intentionally ignored, the committed deliverable is `DESIGN.md` unless the plan records a ruling to change that policy.
- Reference: `PRODUCT.md`, `docs/design/agent-workspace-design-lock.md`, `app/globals.css`, and representative shared components.

1. Extract the current, post-remediation visual tokens and component rules. Treat the design lock and incumbent implementation as authority; do not invent a new visual world.
2. Write root `DESIGN.md` in the canonical DESIGN.md section order with compact frontmatter for tokens actually used. Reference the full design lock for composition-specific authority rather than duplicating it.
3. Document the restrained violet primary, semantic success/destructive/chart roles, typography, density, logical/RTL layout, container-query reflow behavior, touch-target policy, tonal depth, radii, focus, motion/reduced-motion, safe rich-output fallbacks, and representative components.
4. Include durable named rules and concrete do/don't guidance. Keep product truth in `PRODUCT.md` and avoid repeating the design lock verbatim.
5. Validate Markdown/YAML structure and run formatting/document checks that exist in the repository.

**Acceptance:** `DESIGN.md` exists at the root, follows the canonical format, accurately captures the implemented/locked system, and gives future agents clear constraints for contrast, reflow, RTL, motion, theming, and rich output.

## Final Verification and Re-review

1. Run the complete applicable verification matrix on the final commit: `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test:e2e`.
2. Run a fresh production analyzer and verify initial compressed JavaScript is at most 650 KB.
3. Run the Impeccable detector once over all changed UI targets, as required by the skill context.
4. In parallel, dispatch a most-capable whole-branch code reviewer and a fresh most-capable Impeccable re-auditor. Give each the full branch diff/review package, the plan, verification evidence, and relevant baselines. Both are read-only.
5. If either returns a blocking/important finding, dispatch one consolidated fix agent, verify the fix, and run one scoped re-review. There is no second final fix wave; adjudicate and report any residual finding explicitly.
6. The target handoff state is: full command matrix green, no P0-P2 audit findings, documentation present, contrast/reflow/touch/motion/bundle acceptance checks met, and final review clean.
