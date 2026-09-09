# Native Markdown Renderer

## Goal

Render assistant text through Assistant UI's Markdown primitive without an
application-owned loading state. Message text is primary content and must never
look blocked while an optional presentation layer downloads.

## Design

- `Thread` keeps Assistant UI's native `MessagePrimitive.GroupedParts` routing.
- Text parts render the existing `MarkdownText` component directly through a
  static import.
- `MarkdownText` remains a thin customization of
  `MarkdownTextPrimitive` for AOS styling, safe links/code, sanitized Mermaid,
  streaming status, and RTL behavior.
- Delete the `MessageText` lazy-loading selector, plain-text heuristic, Suspense
  fallback, and “Loading formatted text…” copy.
- Preserve explicit rendering errors at the rich-output boundary where a real
  failure can be acted upon.

## Verification

At the public message-rendering seam, verify that plain text and Markdown render
immediately through the same primitive, streaming status remains native, and
English/Hebrew direction and existing Markdown semantics remain intact. Remove
tests that only specify the deleted lazy-loading implementation.

## Exclusions

No runtime changes, Markdown-library migration, visual redesign, eager Mermaid
bundle, or broad thread refactor.
