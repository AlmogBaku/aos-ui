---
name: AOS
description: A calm, provider-neutral workspace for operating AI agents.
colors:
  canvas: "var(--canvas)"
  background: "var(--background)"
  foreground: "var(--foreground)"
  card: "var(--card)"
  card-foreground: "var(--card-foreground)"
  primary: "var(--primary)"
  primary-foreground: "var(--primary-foreground)"
  primary-hover: "var(--primary-hover)"
  success: "var(--success)"
  destructive: "var(--destructive)"
  border: "var(--border)"
  ring: "var(--ring)"
  chart-1: "var(--chart-1)"
  chart-2: "var(--chart-2)"
  chart-3: "var(--chart-3)"
  chart-4: "var(--chart-4)"
  chart-5: "var(--chart-5)"
typography:
  body:
    fontFamily: "var(--app-font-sans)"
    fontSize: "1rem"
    fontWeight: 400
  label:
    fontFamily: "var(--app-font-sans)"
    fontSize: "0.875rem"
    fontWeight: 500
  heading:
    fontFamily: "var(--app-font-sans)"
    fontSize: "1.25rem"
    fontWeight: 600
rounded:
  base: "0.75rem"
  workspace: "1.375rem"
spacing:
  compact: "0.5rem"
  control: "0.625rem"
  panel: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.base}"
    height: "2rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  tool-chrome:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.base}"
    padding: "{spacing.panel}"
---

# Design System: AOS

## Overview

**Creative North Star: "The Calm Operations Desk"**

AOS is a restrained operational workspace: the conversation leads, while
agent ownership, session state, and rich activity remain close at hand without
competing for attention. The visual language is deliberately quiet under
complexity—spacious, rounded, and legible rather than dashboard-like or
ornamental.

This document records reusable visual constraints. The workspace composition
and its prohibited departures remain authoritative in
[`docs/design/agent-workspace-design-lock.md`](docs/design/agent-workspace-design-lock.md);
product ownership and behavior remain in [`PRODUCT.md`](PRODUCT.md).

**Key Characteristics:**

- Conversation is the dominant surface; supporting panes are calm and
  progressively disclosed.
- A restrained violet signal and small teal accents carry emphasis, never
  broad decorative color fields.
- Theme, direction, motion preference, and safe textual inspection are
  first-class states rather than optional polish.

**The Calm-Under-Complexity Rule.** Use hierarchy, spacing, and semantic state
before adding visual treatment. A new treatment must make an operational
decision easier to scan.

## Colors

The palette is a cool, near-neutral canvas with a single violet primary and
semantic state roles that remain meaningful in both light and dark themes.

### Primary

- **Restrained violet:** `primary` carries committed actions, focus, active
  emphasis, and the primary workspace signal; `primary-hover` is its only
  interactive deepening. `primary-foreground` is the paired readable action
  text.

### Secondary

- **Quiet teal chart role:** `chart-2` is the cool counterpart to violet in
  data views. It is an information series, not a second action color.

### Tertiary

- **Chart-only warm and rose roles:** `chart-3` and `chart-4` distinguish data
  series. They do not replace semantic success or destructive feedback.

### Neutral

- **Layered cool surfaces:** `canvas`, `background`, and `card` establish the
  tonal hierarchy; `foreground` and `border` keep content and boundaries
  readable without heavy lines.
- **Semantic state:** `success` represents completed or healthy work, while
  `destructive` represents failure, cancellation, or destructive intent.
- **Five-series data vocabulary:** `chart-1` through `chart-5` are the sole
  chart-series roles. Chart and rich-tool code uses these semantic roles rather
  than introducing local color literals.

**The One-Accent Rule.** Violet is reserved for actions, focus, and active
state. Do not use it as a decorative wash, a status substitute, or on every
container.

**The Pairing Rule.** Foreground and background are selected as semantic pairs,
not independently. Normal-sized action text and composer placeholder text must
retain at least 4.5:1 contrast in both themes.

## Typography

**Display Font:** Geist, through `--app-font-sans`.
**Body Font:** Geist for English, with Noto Sans Hebrew selected by the Hebrew
locale before the English fallback.
**Label/Mono Font:** Geist Mono is available for code-like material; it is not
the default interface voice.

**Character:** The interface uses one compact sans-serif system with moderate
weights, short headings, and durable body text. Labels support scanning; they
do not become a second decorative typographic layer.

### Hierarchy

- **Heading** (600, `heading`): workspace brand and concise panel hierarchy.
- **Body** (400, `body`): messages, descriptions, and tool content; rich-tool
  descriptions cap readable line length rather than stretching across the
  workspace.
- **Label** (500, `label`): controls, tabs, states, and compact metadata.

**The Operational Type Rule.** Use weight and spacing to establish hierarchy.
Do not use uppercase label noise, artificial display type, or undersized text
to make the workspace feel denser.

Use the shared type scale before introducing one-off sizes. A containing title
must never appear subordinate to the items it introduces. Depart from the
shared scale only when a specific visual or accessibility constraint requires
it.

## Layout

The workspace is a rounded inset shell with a spacious three-pane desktop
composition and conversation in the center. Sessions are real tabs with an
active underline; supporting panels hold agent identity, status, description,
and sessions rather than dashboard cards or extra navigation.

Logical properties (`inline`, `block`, `start`, and `end`) are required for
layout direction. English LTR and Hebrew RTL share the same hierarchy, keyboard
flow, focus behavior, and comfortable density; message content retains its own
automatic direction where needed.

The shell is an inline-size container. At 64rem, 80rem, and 90rem of available
container width it progressively opens the established three-pane composition;
below that capacity, existing focus-managed drawers preserve reachability.
This is intentional reflow for narrower capacity and text zoom, not a separate
mobile information architecture. At coarse pointers, buttons, button roles,
and tabs have at least 2.75rem inline and block target dimensions.

**The Capacity-Not-Viewport Rule.** Workspace layout responds to usable inline
space, including enlarged text. Do not add viewport-only pane breakpoints that
can hide controls or create page-level horizontal overflow at 200% text scale.

## Elevation & Depth

Depth is tonal first: the cool canvas, application background, cards, muted
surfaces, and quiet borders create the reading order. The shell alone receives
a broad low-elevation shadow to separate the inset application from the page;
drawers use a scrim and their own restrained shadow. Rich tools are bordered
cards, not floating glows.

**The Tonal-First Rule.** Prefer a surface step or a border for structure. Use
shadow only for the application shell, a transient drawer, or a state where
spatial separation is necessary; never add colored zero-offset glows.

## Shapes

The system is gently rounded rather than bubbly. The shared base radius shapes
controls, fields, tabs, and rich-tool cards; the shell uses its distinct larger
inset radius. Borders are quiet and functional, while a visible violet ring
with offset is the universal keyboard focus treatment.

**The Focus-Is-Geometry Rule.** Focus remains visible in light and dark themes
and must not be replaced by color-only hover feedback, a shadow, or an
animation.

## Components

**The Native-Primitives Rule.** Start with Assistant UI's established concepts,
primitives, and component compositions. Adapt them through their intended
composition and styling seams before introducing a parallel abstraction or
replacement. A custom implementation must answer a product requirement the
standard component cannot express and record that reason.

### Buttons

**Character:** compact, native-feeling controls with a clear action hierarchy.

- **Primary:** uses the semantic violet primary pair; hover uses the dedicated
  hover role, and destructive actions use the destructive role rather than
  violet.
- **Secondary, outline, and ghost:** preserve dense workspace scanning with
  tonal hover states instead of additional accent colors.
- **Focus and motion:** a visible ring marks keyboard focus; reduced motion
  removes state transitions and active translation without removing feedback.

### Inputs / Fields

**Character:** quiet, bordered editors that make text the object of attention.

- **Style:** textarea and related fields use the neutral surface, border, and
  readable muted placeholder role.
- **Validation:** invalid state uses semantic destructive color and the same
  focus geometry as other interactive controls.

### Cards / Containers

**Character:** tonal, bordered, and purposefully sparse.

- **Workspace shell:** the rounded inset container establishes the application
  boundary and owns the only ambient workspace elevation.
- **Tool chrome:** rich tools are compact cards with a local heading, semantic
  lifecycle label, optional actions, and no decorative status glow.

### Navigation

**Character:** stable, pane-oriented, and progressively disclosed.

- **Sessions:** render as tabs with a clear active underline, never pills or
  badges.
- **Agents:** retain a persistent distinctive icon plus a separate status
  indicator; status must not be conveyed by icon color alone.
- **Narrow capacity:** use the established drawers and preserve focus
  restoration rather than creating parallel mobile navigation.

### Rich Output

**Character:** informative when available and inspectable when it is not.

- **Plan and activity:** stay eager because the default workspace uses them;
  Plan progress has a localized accessible name and a proper heading level.
- **Optional visuals:** question, permission, Monty, chart, map, and stats
  renderers load on demand behind a localized loading state and error boundary.
- **Fallback:** loading or failure leaves an inspectable textual/JSON
  representation available. Markdown follows the same rule: plain text stays
  lightweight, while deferred Markdown retains a localized raw-text fallback.
- **Safety:** charts, maps, Mermaid, tool results, and generated content retain
  textual alternatives. Never execute generated browser code or arbitrary HTML.

### Conversation and Execution

The conversation is the product surface; execution history supports it. Keep
internal work compact and inspectable without allowing it to compete with the
assistant's answer.

- **Separate trace from outcome:** reasoning, commands, and progress belong to
  a cohesive execution trace. Final prose and meaningful interactive or visual
  output remain first-class message content and are never hidden by execution
  chrome.
- **Preserve fidelity:** retain provider order and lifecycle, render each piece
  of content once, and degrade to an honest inspectable fallback when richer
  presentation is unavailable.
- **Use a quiet operational grammar:** disclosures, icons, labels, and status
  signals remain consistent across tools. Summary rows communicate what
  happened; details remain available without turning the trace into a stack of
  cards.
- **Protect reading orientation:** search, expansion, live updates, and
  responsive reflow preserve the user's place. The same information hierarchy
  and interaction model holds across keyboard and pointer use, narrow and wide
  layouts, LTR and RTL, and reduced-motion preferences.

### Motion

**Character:** short state confirmation, never spectacle.

- **Normal preference:** status changes, drawers, dialogs, accordions, and Plan
  progress may transition to clarify a state change.
- **Reduced preference:** alert dialogs, accordions, Plan progress, workspace
  controls, and rich presentation fallbacks intentionally remove animation or
  transitions while preserving visible state and focus behavior.

**The Motion-Is-Optional Rule.** Motion may confirm a change, but the changed
state must be legible without it. Do not make progress, errors, or focus depend
on animation.

## Do's and Don'ts

### Do:

- **Do** use the semantic primary, success, destructive, and chart roles from
  the shared token layer in both themes.
- **Do** preserve the conversation as the dominant surface and use progressive
  disclosure for supporting workspace detail.
- **Do** use logical CSS properties and verify English LTR and Hebrew RTL after
  a layout or control change.
- **Do** use container capacity for workspace reflow, preserve drawer focus
  behavior, and keep coarse-pointer targets at the documented minimum.
- **Do** provide localized accessible names, meaningful heading order, visible
  focus, reduced-motion behavior, and inspectable rich-output fallbacks.
- **Do** reference the design lock before changing shell composition, sessions,
  agent identity, inspector scope, or ornamental treatment.

### Don't:

- **Don't** introduce hard-coded chart or rich-tool status colors, colored
  glows, contrast-unsafe placeholder styling, or a second primary accent.
- **Don't** replace sessions with pills or badges, turn the workspace into a
  dashboard, add department navigation or window traffic lights, or use
  ornamental effects.
- **Don't** create a viewport-only layout branch that causes overflow or makes
  controls unreachable at enlarged text sizes.
- **Don't** use motion as the only status signal, suppress keyboard focus, or
  lower contrast for decorative subtlety.
- **Don't** make rich output opaque or executable: preserve textual inspection
  and never run arbitrary HTML or generated code in the browser.
