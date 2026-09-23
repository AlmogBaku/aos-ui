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
  workspace: "var(--workspace-shell-radius)"
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
- **The installed title bar is `sidebar`:** an installed window paints the band
  behind the window controls from the theme colour, and that band meets the
  Agents rail and the inspector at both top corners, so it takes `--sidebar`.
  That band is browser chrome outside the page: no CSS rule reaches it, and
  neither a meta tag nor the JSON manifest can resolve a custom property.
  `shared/theme-color.ts` therefore reads the token at build time and converts
  it to sRGB for the `theme-color` tags and the manifest, keeping this file the
  only place the value is written. Renaming or reformatting the token fails the
  build rather than shipping a mismatched window.
- **Semantic state:** `success` represents completed or healthy work and the
  unread signal on navigation rows; `destructive` represents failure,
  cancellation, and confirmed destructive intent; `warning` represents work
  waiting on the operator. A navigation row shows one dot: waiting for input
  and failure outrank unread; unread outranks a run in progress.
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

**Sans Font:** Inter (`--font-geist: Inter, ui-sans-serif, system-ui, sans-serif`)
through `--app-font-sans`. In Hebrew, `--font-hebrew: Arial, ui-sans-serif, system-ui, sans-serif`
is selected first (`html[lang="he"] { --app-font-sans: var(--font-hebrew) ... }`).
Neither Geist nor Noto Sans Hebrew is loaded; both names are legacy references
only.
**Mono Font:** `--font-geist-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace`
is available for code-like material; it is not the default interface voice.
**Wordmark Font:** `--font-aos-wordmark: "Michroma"` — the only imported webfont
(`@fontsource/michroma/400.css`).

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

At desktop capacity (≥ 64rem container width) the workspace is a rounded inset
shell with a spacious three-pane composition and conversation in the center.
The inset shell's border, radius, and ambient shadow only apply inside
`@container workspace (min-width: 64rem)`, and come from the frame tokens
`--workspace-shell-gutter` (1rem), `--workspace-shell-border-width` (1px),
`--workspace-shell-radius` (1.375rem), and `--workspace-shell-shadow` in
`src/app/globals.css`. An installed window drops all four: see
`display-mode` below.
Sessions are real tabs with an active underline; supporting panels hold agent
identity, status, description, and sessions rather than dashboard cards or
extra navigation.

At narrow capacity (below 64rem) the workspace is edge-to-edge, viewport-
filling, with compact system-style chrome. Mobile has its own two-level drawer
(Agent roster → Sessions) that opens from the logical-start edge; the tab strip
is hidden. Pointer and hover media queries govern the _reveal behavior_ of
hover-only controls (for example `.tabClose`), and are the documented exception
to the container-query rule because they are not expressible as container
queries.

Logical properties (`inline`, `block`, `start`, and `end`) are required for
layout direction. English LTR and Hebrew RTL share the same hierarchy, keyboard
flow, focus behavior, and comfortable density; message content retains its own
automatic direction where needed.

The shell is an inline-size container (`container: workspace / inline-size`).
At 64rem, 80rem, and 90rem of available container width it progressively opens
the established three-pane composition. At coarse pointers, buttons, button
roles, and tabs have at least 2.75rem inline and block target dimensions.

An installed window (`display-mode: standalone`, `minimal-ui`, or
`window-controls-overlay`) supplies its own title bar, corners, and shadow, so
the frame tokens collapse to zero there and the workspace fills the window edge
to edge at every capacity. The list is positive rather than a negation of
`browser` so an unknown feature keeps the frame, and `fullscreen` is excluded
because an ordinary tab at F11 reports it too. The three-pane composition,
pane dividers, and every container tier are unchanged; only the frame goes.

**The Capacity-Not-Viewport Rule.** Workspace layout responds to usable inline
space, including enlarged text. Do not add viewport-only pane breakpoints that
can hide controls or create page-level horizontal overflow at 200% text scale.
Pointer and hover media queries that govern reveal-only behavior are the stated
exception, as is the `display-mode` query above: an installed window is an
environment, not a capacity, and has no container equivalent.

## Elevation & Depth

Depth is tonal first: the cool canvas, application background, cards, muted
surfaces, and quiet borders create the reading order. The shell alone receives
a broad low-elevation shadow to separate the inset application from the page;
drawers use a scrim and their own restrained shadow. An installed window has no
page to separate from, so that shadow is absent there. Rich tools are bordered
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

## Density

Controls follow a four-band height scale: 28 px (compact inline), 32 px
(default control), 36 px (comfortable action), 40 px (prominent button or
avatar). The radius scale (`--radius-sm`, `--radius-md`, `--radius-lg` and
wider steps) is defined relative to the single `--radius` base in
`src/app/globals.css`. Theme and locale toggle buttons are 1.75 rem square at
fine-pointer sizes; the global coarse-pointer rule lifts every button target to
2.75 rem. The inspector and session-tab header share the same block height band
so their borders meet as a single line.

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
- **Draft Agent rows:** a `New Agent` draft row uses the neutral `unassigned`
  glyph, carries the accessible name "New Agent, draft", and shows the status
  dot of its single creator-owned Session.
- **Narrow capacity:** below 64rem the tab strip is hidden and a two-level
  logical-start drawer (Agent roster → Sessions for the selected Agent)
  provides Session navigation. Choosing a Session dismisses the drawer
  immediately; merely browsing does not mark anything read. Preserve focus
  restoration on drawer close.

#### Session status dots

A navigation row shows at most one dot. Priority, highest first:

| State   | Color                      | Meaning                                                            |
| ------- | -------------------------- | ------------------------------------------------------------------ |
| Waiting | `--warning` (orange)       | Session is waiting for user input. Also covers attention.          |
| Failed  | `--destructive`            | The last run failed.                                               |
| Unread  | `--success` (green)        | Session has content the user has not seen. Clears on focused view. |
| Running | `--info` (blue), breathing | Active model turn in progress.                                     |

The row's accessible name still lists every state; only the visual dot collapses.

Row count pills (violet) were removed; the bell count replaces them as the sole
derived unread count. Browsing the Activity drawer marks nothing read.

### Rich Output

**Character:** informative when available and inspectable when it is not.

- **Todos and activity:** stay eager because the default workspace uses them;
  Todos progress has a localized accessible name and a proper heading level.
- **Optional visuals:** question and permission renderers load on demand
  behind a localized loading state and error boundary.
- **Fallback:** loading or failure leaves an inspectable textual/JSON
  representation available. Markdown follows the same rule: plain text stays
  lightweight, while deferred Markdown retains a localized raw-text fallback.
- **Safety:** charts, maps, Mermaid, tool results, and generated content retain
  textual alternatives. Never execute generated browser code or arbitrary HTML.
- **Mermaid size follows the diagram:** one that fits stays a compact card at
  its natural size with no controls. One past 36rem wide or 24rem tall widens to
  the message content width and renders in a bounded, scrollable frame (max
  `28rem` tall) that scales the diagram down only to a readable floor, with zoom
  and an expanded view in the card's existing footer row. The diagram renders in
  one place at a time, and the source fallback stays available in every state.
- **Published artifacts:** audio, video, and images are first-class inline
  outcomes with no download control of their own. Audio and video play in the
  message as native players inside a `w-full max-w-[30rem]` container, whose
  own controls carry the download, and nothing about them opens the Artifact
  viewer. An image shows in the message as a bounded preview (max height
  `max-h-64`), never at its original size; the preview opens the viewer, which
  holds the full picture and the download. Video is likewise bounded
  (`max-h-96`). Every other artifact stays a compact card that opens the
  viewer, and the Artifacts roster stays a list of openable rows. A failure
  states what happened in place, and a provider that no longer holds the bytes
  says so and drops the retry and download it cannot honor.
- **MCP Apps:** the one exception to "never run arbitrary HTML". A tool whose
  own MCP server declares a `ui://` view renders that server-authored HTML as
  an inline card in the message, inside an opaque-origin double iframe with a
  CSP built from the view's declared domains; nothing else ever runs there.
  The card follows the App's requested height up to 80% of the viewport, and
  the App may ask for fullscreen, which covers the viewport in place with a
  localized close control that returns focus to the card. Loading, failure, and
  an unavailable view read as card states. The card has no header: the view
  sits in the message, followed by the compact "Used <tool>" row that keeps the
  call's textual details in every state. Charts, maps, and stats are the
  `aos-ui` server's own App views (`render_chart`, `render_map`,
  `render_stats`); `present_artifact` has no view.

### Notification ask and settings

**Character:** calm, inline, and non-intrusive.

- **Ask surface:** the permission ask appears as an inline card in the notice
  slot of the conversation — never as a modal, a load-time interstitial, or an
  automatic browser prompt. It appears once, after the first real operator
  message, and only if permission has not already been granted or denied.
- **Actions:** the card offers a primary **Turn on** button (violet primary
  pair) and a ghost **Not now** button. Declining opts out durably; the card
  does not reappear.
- **Copy:** calm and operational — state what turns on without urgency. No
  promotional framing.
- **Settings:** every closed-app delivery state (push enabled, push not
  configured, HTTPS required, permission denied, not asked yet) is legible in
  the notification settings panel. Controls use native checkboxes; no custom
  toggle replaces them.
- **Motion:** the card fades in over 200 ms on entry; `prefers-reduced-motion`
  suppresses the transition while the card remains visible.
- **Sound:** the in-tab audio cue is a brand asset — the elementary OS sound
  theme, released under the Unlicense, at `public/sounds/urgent.wav`. Sound is
  never the only notification channel; all states are legible without it.

### Conversation and Execution

The conversation is the product surface; execution history supports it. Keep
internal work compact and inspectable without allowing it to compete with the
assistant's answer.

- **Separate trace from outcome:** reasoning, commands, and progress belong to
  a cohesive execution trace. Final prose and meaningful interactive or visual
  output remain first-class message content and are never hidden by execution
  chrome.
- **Fold a settled turn's work:** provider order is absolute, so a part never
  moves relative to another, and consecutive ordinary tool calls read as one
  run. Once the turn settles, everything before its final answer — mid-turn
  prose, tool runs, reasoning — collapses into one "Worked for 29 s" disclosure
  that keeps its contents in that order inside it. Work the turn did after its
  final answer folds too, into its own disclosure after that answer, named by
  what it ran. Rich tool views, question and
  permission flows, subagent activity, and attached data, media or sources stay
  outside the fold. Nothing folds while the turn is still running: a live turn
  offers only the elapsed time.
- **Tool facts live in the trace:** a tool row reads by the provider's ACP
  kind when it declares one and by the tool's name otherwise, and carries its
  paths and duration. Diffs sit folded inside the edit tool's details, with
  "+N −M" on the row and the turn's total in the fold summary ("Changed 3
  files +42 −7"). A live terminal opens while its command runs and folds with
  the turn once it settles. Paths, patches, and terminal output render
  left-to-right in both locales. Each keeps a plain-text fallback.
- **Compaction is a quiet divider:** it sits outside the fold, keeps its summary
  behind a disclosure, and splits the fold into before and after when it lands
  mid-turn. A failed compaction is a warning System Notice.
- **Stops say why:** a turn stopped at the length limit or refused by the
  provider gets a warning System Notice under the message, and the fold
  headline says so ("Stopped at the length limit after 40 s"). A failure notice
  names the provider and model when the runtime reports them.
- **Usage stays in the composer:** the last turn's tokens and the Session cost
  appear only in the composer's context popover; messages carry no numbers.
- **Subagents stay visible:** a subagent's work nests under the call that
  spawned it, outside the fold, with its goal, status, and counts, and offers
  its child Session when the workspace knows it.
- **Preserve fidelity:** retain provider order and lifecycle, render each piece
  of content once, and degrade to an honest inspectable fallback when richer
  presentation is unavailable.
- **Use a quiet operational grammar:** disclosures, icons, labels, and status
  signals remain consistent across tools. Summary rows communicate what
  happened; details remain available without turning the trace into a stack of
  cards.
- **Out-of-band questions:** when the runtime exposes `interactions`
  (`src/components/runtime-interactions/question-composer.tsx`), questions
  surface as a single answer form beside the composer rather than as an
  answerable card in the transcript. The transcript keeps a read-only record
  (`src/components/tool-ui/question-flow.tsx`). An "Other (type your answer)"
  free-text row is always offered when options exist and freeform is allowed;
  the send button is disabled until at least one option or a non-empty free-text
  answer is present.
- **Inline permissions:** a permission request is answered on the card of the
  tool call it guards (`src/components/tool-ui/permission.tsx`), or on a
  standalone permission card in the current turn when the runtime cannot name
  that call. The composer stays in place; new messages queue and Edit and Retry
  wait until the request is answered. "Allow always" asks for confirmation
  first. Once the guarded call settles, its own view replaces the card.
- **System notices:** anything AOS or a provider says about a failure or an
  unavailable output renders in the System Notice panel with the AOS source
  label, never as message prose. The operator cannot then mistake it for the
  Agent's words.
- **Protect reading orientation:** search, expansion, live updates, and
  responsive reflow preserve the user's place. The same information hierarchy
  and interaction model holds across keyboard and pointer use, narrow and wide
  layouts, LTR and RTL, and reduced-motion preferences.
- **The thread is virtualized:** a Session longer than 30 messages mounts only
  the messages near the viewport, with spacing standing in for the rest
  (`src/components/assistant-ui/elements/thread-message-list.tsx`). A shorter
  one mounts whole. The list follows Assistant UI's virtualization guide:
  `unstable_useThreadMessageIds` with `ThreadPrimitive.Unstable_MessageById`,
  windowed by `@tanstack/react-virtual`. Both Assistant UI APIs are marked
  unstable and experimental, so re-check them on every Assistant UI upgrade.
  Where the browser anchors scroll, the virtualizer never moves the scroll
  position; its `shouldAdjustScrollPositionOnItemSizeChange` guard is an
  instance field, set to decline there and left to the virtualizer on WebKit,
  which has no `overflow-anchor`. The reading-position controller keeps follow mode, bookmarks, and
  re-anchoring. Conversation search matches the message data and brings an
  unmounted match into the window before highlighting it. The message that last
  held focus stays mounted. Only the newest message plays the entrance
  animation. The browser's own find and a screen reader's browse mode reach
  only the mounted messages of a long Session. Folds and disclosures the
  reader opened or closed stay that way while the thread is open, across a
  message's remount; a Mermaid diagram's zoom and pan reset.

### Motion

**Character:** short state confirmation, never spectacle.

- **Normal preference:** status changes, drawers, dialogs, accordions, and Todos
  progress may transition to clarify a state change.
- **Reduced preference:** alert dialogs, accordions, Todos progress, workspace
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
  and never run arbitrary HTML or generated code in the browser outside the
  sandboxed MCP App frame.
