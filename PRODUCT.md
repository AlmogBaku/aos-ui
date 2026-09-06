# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AOS is for people who operate several provider-owned AI agents and need to follow their conversations, delegated work, decisions, and execution state without losing which agent or session owns an event.

## Product Purpose

AOS provides one calm workspace for selecting a primary Agent, resuming its Sessions, observing nested Subagents, reviewing message-scoped Plans, and tracking session-scoped Todos. Success means users can move between active work streams confidently while delayed events, unsupported provider capabilities, and failures remain explicit and correctly scoped.

## Positioning

AOS keeps the chat runtime authoritative for conversation state and adds only the workspace concepts providers do not supply consistently. A narrow adapter seam supports OpenCode first, AG-UI where capabilities exist, and deterministic fixtures for complete offline development.

## Operating Context

Users work in a three-pane desktop workspace or a focus-managed narrow-screen layout. They select a primary Agent, open or create an Agent-bound Session, converse through Assistant UI, respond to questions and permissions, inspect rich tool activity, follow Subagents, and review session history and Todos. English and Hebrew are first-class locales.

## Capabilities and Constraints

- An Agent is a provider-owned primary agent; a Session belongs to exactly one Agent; a Subagent is a nested delegated run; a Plan belongs to the message that produced it; Todos belong to the Session.
- Assistant UI remains canonical for threads, messages, runs, branches, composer state, and thread lifecycle.
- Provider data is authoritative. Client-owned state is limited to view preferences, manually opened recent tabs, per-visit selection restoration, and content-free Activity read/delivery state persisted locally in the browser.
- The Agent catalog includes visible and hidden ordinary primary Agents; only visible, selectable Agents appear in the workspace roster. Agent Builder, native/system definitions, and Subagents are excluded from management. Visibility remains provider-owned. AOS may edit only its managed Agent definitions through the optional provider-side management service; other definitions are read-only.
- OpenCode is the primary production integration. AG-UI degrades honestly where workspace capabilities are unavailable. Deterministic fixtures must exercise the entire interface without a live backend.
- Provider events retain their originating Agent and Session. Delayed events may update their own cache but never the visible Session.
- Rich tools always have safe, inspectable fallbacks. Browser-side code execution, terminal/filesystem/VCS surfaces, and provider hosting are out of scope.

## Activity and Live Notifications

Activity is the source of truth for notification history and unread state, alongside inline conversation state, coalesced in-app notices, and opt-in live browser notifications. Completion in the exact visible, focused Session is already read and suppresses alerts. Other Sessions in a focused workspace produce unread markers and one coalesced notice. Hidden tabs and visible but unfocused windows/apps can deliver eligible generic OS notifications after explicit opt-in and granted permission.

Browser notifications require at least one loaded AOS tab; no delivery occurs after all tabs close. V1 includes no service worker, Web Push, backend notification service, email, remote approval, or scheduled-work notifications. Permission denial and unsupported browsers preserve Activity. Multiple tabs synchronize read state and elect one delivery tab; history hydration does not replay OS alerts. Clicks focus AOS and validate provider ownership before selecting the owning Agent and Session; deleted targets remain unavailable.

Stored Activity and OS payloads contain no conversation, tool, question, permission, or error content. OS text also omits Agent and Session labels. OpenCode covers workspace activity, fixtures exercise deterministic scenarios, and AG-UI covers only the selected Session with an explicit settings limitation. Browser and OS policies can delay or suppress delivery. The Activity bell is in the desktop Agents heading and mobile header, with an accessible unread count, keyboard-managed drawer, English/Hebrew support, and reduced motion.

## Brand Commitments

The product name is AOS. Product language is concise, calm, and operational. The interface may take inspiration from the restrained spatial hierarchy of modern dark chat products, but uses original branding, terminology, and visual details.

## Evidence on Hand

The repository contains an early Next.js, Tailwind, and shadcn scaffold. The approved agent-workspace plan defines the required architecture, interaction states, acceptance journeys, and failure audit. No testimonials, customer logos, benchmarks, pricing, or deployment claims are available and future work must not fabricate them.

## Product Principles

1. Preserve ownership: every Agent, Session, Subagent, Plan, Todo, and event has an unambiguous scope.
2. Make system state legible: running, waiting, failed, stale, expired, malformed, and unsupported states are visible and actionable.
3. Prefer provider truth over duplicated client state.
4. Keep the workspace calm under complexity through progressive disclosure and restrained visual hierarchy.
5. Keep the full experience developable and testable through deterministic fixtures.

## Accessibility & Inclusion

English LTR and Hebrew RTL are first-class. Chrome, statuses, times, validation, tool labels, and accessibility labels are localized while conversation content remains verbatim with automatic direction. The interface must support keyboard navigation, focus restoration, reduced motion, streamed-status announcements, sufficient contrast, and textual alternatives for charts and maps.
