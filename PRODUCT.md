# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AOS is for people who operate several provider-owned AI agents and need to follow their conversations, delegated work, decisions, and execution state without losing which agent or session owns an event.

## Product Purpose

AOS provides one calm workspace for selecting a primary Agent, resuming its Sessions, observing nested Subagents, reviewing message-scoped Plans, and tracking session-scoped Todos. Success means users can move between active work streams confidently while delayed events, unsupported provider capabilities, and failures remain explicit and correctly scoped.

## Positioning

AOS is a UI for native harnesses, with Agent creation and rich messages around their conversations. OpenCode and Hermes use separate integrations behind a small workspace boundary; generic AG-UI and explicit fixtures remain available. Monty is an independent optional integration.

## Operating Context

Users work in a three-pane desktop workspace or a focus-managed narrow-screen layout. They select a primary Agent, open or create an Agent-bound Session, converse through Assistant UI, respond to questions and permissions, inspect rich tool activity, follow Subagents, and review session history and Todos. English and Hebrew are first-class locales.

## Capabilities and Constraints

- An Agent is a provider-owned primary agent; a Session belongs to exactly one Agent; a Subagent is a nested delegated run; a Plan belongs to the message that produced it; Todos belong to the Session.
- Native runtimes own durable conversations and execution. Assistant UI owns their frontend projection, composer, queue, and thread lifecycle.
- Provider data is authoritative. Client-owned state is limited to view preferences, manually opened recent tabs, per-visit selection restoration, and content-free Activity read/delivery state persisted locally in the browser.
- The Agent catalog includes visible and hidden ordinary primary Agents; only visible, selectable Agents appear in the workspace roster. Creators, native/system definitions, and Subagents are excluded from management. Visibility and creator role come from native metadata. Unsupported native mutations are read-only; AOS has no management server or Agent registry.
- One engine is selected per deployment, with multiple Agents and Sessions. Native harnesses own execution, persistence, credentials, and Agent configuration outside this checkout. Unsupported capabilities remain explicit.
- On configured real runtimes, Agent creation uses an ordinary creator-owned Session opened through the dedicated New Agent entry point. The hidden creator identity never appears in the ordinary roster or management catalog. Creation uses portable guidance with a native safe writer; it never transfers interview ownership or automatically starts the created Agent's first Session. Public fixture/demo mode intentionally omits Agent creation. Native harnesses can initiate inbound Sessions without a browser.
- Provider events retain their originating Agent and Session. Delayed events may update their own cache but never the visible Session.
- Rich tools always have safe, inspectable fallbacks. Browser-side code execution is limited to published Artifact HTML in the isolated preview described below; terminal/filesystem/VCS surfaces and provider hosting are out of scope.
- An Artifact is a provider-owned deliverable that an Agent explicitly publishes with `present_artifact`; ordinary file edits are not Artifacts. AOS derives published outputs from the active conversation branch and provides read-only preview and download without owning file editing, storage, or version history.
- Published HTML opens on Preview by default and remains inspectable through a Source tab. Preview runs in an opaque-origin sandboxed frame with a fixed CSP. Deployment configuration may allowlist public asset origins; this trusted generated-content preview is isolation, not a hard network-egress boundary.

## Activity and Live Notifications

Activity is the source of truth for notification history and unread state, alongside inline conversation state, coalesced in-app notices, and opt-in live browser notifications. Completion in the exact visible, focused Session is already read and suppresses alerts. Other Sessions in a focused workspace produce unread markers and one coalesced notice. Hidden tabs and visible but unfocused windows/apps can deliver eligible generic OS notifications after explicit opt-in and granted permission.

Browser notifications require at least one loaded AOS tab; no delivery occurs after all tabs close. V1 includes no service worker, Web Push, backend notification service, email, remote approval, or scheduled-work notifications. Permission denial and unsupported browsers preserve Activity. Multiple tabs synchronize read state and elect one delivery tab; history hydration does not replay OS alerts. Clicks focus AOS and validate provider ownership before selecting the owning Agent and Session; deleted targets remain unavailable.

Stored Activity and OS payloads contain no conversation, tool, question, permission, or error content. OS text also omits Agent and Session labels. OpenCode covers workspace activity, fixtures exercise deterministic scenarios, and AG-UI covers only the selected Session with an explicit settings limitation. Browser and OS policies can delay or suppress delivery. The Activity bell is in the desktop Agents heading and mobile header, with an accessible unread count, keyboard-managed drawer, English/Hebrew support, and reduced motion.

## Brand Commitments

The product name is AOS. Product language is concise, calm, and operational. The interface may take inspiration from the restrained spatial hierarchy of modern dark chat products, but uses original branding, terminology, and visual details.

## Evidence on Hand

The frontend uses Vite, React, Tailwind, and shadcn with static production hosting. Integration readiness requires automated and live acceptance evidence; implementation alone is not proof. No testimonials, customer logos, benchmarks, pricing, or deployment claims are available and future work must not fabricate them.

## Product Principles

1. Preserve ownership: every Agent, Session, Subagent, Plan, Todo, and event has an unambiguous scope.
2. Make system state legible: running, waiting, failed, stale, expired, malformed, and unsupported states are visible and actionable.
3. Prefer provider truth over duplicated client state.
4. Keep the workspace calm under complexity through progressive disclosure and restrained visual hierarchy.
5. Keep the workspace developable and testable through deterministic fixtures,
   while reserving real-runtime-only capabilities for provider harnesses.

## Accessibility & Inclusion

English LTR and Hebrew RTL are first-class. Chrome, statuses, times, validation, tool labels, and accessibility labels are localized while conversation content remains verbatim with automatic direction. The interface must support keyboard navigation, focus restoration, reduced motion, streamed-status announcements, sufficient contrast, and textual alternatives for charts and maps.
