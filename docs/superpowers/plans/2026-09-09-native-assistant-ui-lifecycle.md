# Native Assistant UI Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-owned Markdown loading and Hermes approval orchestration where Assistant UI already supplies the lifecycle.

**Architecture:** Keep AOS renderers as `MessagePrimitive.Parts` presentation. Statically render text through `MarkdownText`, and project Hermes permissions into native tool-call approval metadata handled by the Hermes external-store adapter.

**Tech Stack:** React, TypeScript, Assistant UI 0.15, Vitest, Bun.

---

### Task 1: Native Markdown rendering

**Files:**
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`
- Modify: `src/components/assistant-ui/elements/reasoning.aui.tsx`
- Delete: `src/components/assistant-ui/elements/message-text.tsx`
- Replace: `src/components/assistant-ui/elements/thread-markdown-loading.test.tsx`
- Delete: `src/components/assistant-ui/elements/message-text.test.tsx`

- [ ] Add a rendering test proving Markdown has no message-level loading state.
- [ ] Run the focused test and observe the old loading wrapper fail it.
- [ ] Statically use `MarkdownText` for text and reasoning parts.
- [ ] Run the focused Markdown tests.

### Task 2: Native Hermes approvals

**Files:**
- Create: `src/runtime-adapters/hermes/hermes-approval.ts`
- Create: `src/runtime-adapters/hermes/hermes-approval.test.ts`
- Modify: `src/runtime-adapters/hermes/use-hermes-runtime-bundle.ts`
- Modify: `src/runtime-adapters/hermes/composition.tsx`
- Modify: `src/runtime-adapters/hermes/composition.test.tsx`
- Modify: `src/runtime-adapters/contracts.ts`
- Delete: `src/components/runtime-interactions/approval-composer.tsx`
- Delete: `src/components/runtime-interactions/approval-composer.test.tsx`

- [ ] Add adapter tests for native approval projection and response translation.
- [ ] Run them and observe missing behavior.
- [ ] Project pending Hermes permission metadata and wire `onRespondToToolApproval`.
- [ ] Remove the approval composer override and approval-only shared contract.
- [ ] Verify focused Hermes interaction and rendering tests.

### Task 3: Applicable verification

- [ ] Run affected Vitest files.
- [ ] Run `bun run typecheck` and `bun run lint`.
- [ ] Run `bun run build` because static import behavior affects bundling.
- [ ] Run `bun run hermes:test` because Hermes integration remains in scope.
- [ ] Inspect the parity-only diff and commit the implementation.

Explicitly skip Docker and the full Playwright suite; neither is proportionate
to these adapter and rendering changes.
