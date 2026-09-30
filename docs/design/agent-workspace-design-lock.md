# AOS-ui Agent Workspace Design Lock

This is the durable visual source of truth for the workspace approved on
2026-09-04. Impeccable's generated working files and screenshots remain local
and gitignored; this short record is part of the product documentation.

Implementation invariants:

- Preserve the rounded inset application shell and spacious three-pane composition
  on desktop. Mobile is an edge-to-edge, viewport-filling workspace with compact
  system-style chrome.
- Keep the conversation as the dominant surface.
- Render Sessions as real tabs with an active underline on desktop. On mobile,
  hide the tab strip and expose multi-Session navigation through the Agent and
  Session drawer.
- Use the temporary AOS placeholder mark at small scale and the violet/teal palette sparingly.
- Give every primary Agent a persistent, distinctive icon and a separate status indicator.
- Keep the inspector limited to Agent identity, status, description, and
  Sessions. An MCP App view in the side panel may temporarily take its place;
  returning the view to its message restores the Agent inspector. Narrow
  layouts use the established focus-managed drawer.
- A selected `New Agent` draft shows neither the Session tab strip nor the
  inspector; a `Discard draft` control takes the tab strip's place.
- Do not add department navigation, window traffic lights, dashboard cards, or ornamental effects.
- Prefer native-feeling shadcn controls, comfortable spacing, clear contrast, and progressive disclosure.

Mobile navigation uses one logical-start drawer with two levels. It opens on
the selected Agent's Sessions, returns to the Agent roster through a Back
control, and only changes the active Agent when a Session is chosen. Choosing a
Session dismisses the drawer immediately. Activity remains visible at both
levels, while merely browsing the drawer does not mark a conversation read.

Any intentional visual departure must be called out before it is introduced.

## Intentional departures introduced 2026-09

- **A large Mermaid diagram spans the message content width:** diagrams wider
  than the shared `max-w-2xl` card were scaled down to illegibility. One that
  fits keeps the compact card and no controls; a larger one widens to the
  message content width and gains zoom and an expanded view in its existing
  footer row, rather than an overlay or a second card.
- **Attention color is orange (`--warning`):** waiting-for-input and attention
  states use the semantic `--warning` token. Blue (`--info`) was tried on
  2026-09 and replaced on 2026-09-20 because it read as informational rather
  than as a request for the operator.
- **Unread dot uses `--success` (green):** a green dot marks Sessions with
  content the user has not yet seen.
- **Running indicator uses a breathing blue dot (`--info`):** an active model
  turn breathes in blue, not violet. Teal was replaced on 2026-09-20.
- **One dot per row, by priority (2026-09-20):** waiting for input, attention,
  and failed outrank unread; unread outranks a running turn. The earlier
  two-dot rendering was withdrawn because two dots on one row read as a bug.
  The row's accessible name still states every state.
- **Row Activity count pills removed:** navigation rows no longer carry violet
  count pills. The bell in the Agents heading shows the sole derived unread count.
- **Drawer browsing marks nothing read:** the Activity drawer is browse-only;
  reading a Session there does not change its read state.
- **Published Artifacts render inline:** audio and video play as native players
  in the message; an image renders as a bounded preview (max height `max-h-64`)
  that opens its view in the side panel. Every other Artifact is a compact card
  showing the name, type, and size; its name opens the side panel and a
  Download control sits beside it. The inspector's collapsible Artifacts list
  names every published file, newest first.
- **Density pass (2026-09-20):** control heights follow a 28/32/36/40 px band
  scale; theme and locale buttons are 1.75 rem square at fine-pointer sizes.
  The `--radius-sm|md|lg` token scale is live in `src/app/globals.css`.
- **Question surface in the composer (2026-09-20, b6787b6):** when the runtime
  exposes `interactions`, the question form surfaces beside the composer and
  the transcript keeps a read-only record. An "Other" free-text row is always
  offered when freeform is allowed.
- **Mobile drawer changes (2026-09-20):** the two-level drawer opens when the
  operator taps the search / new-session control in the compact mobile header;
  the new-session control in the drawer is compact rather than a full-width
  button.
- **No inset frame in an installed window (2026-09-22):** the rounded inset
  shell stays the desktop composition in a browser tab, but an installed PWA
  window drops the outer gutter, the border, the radius, and the ambient
  shadow, because the operating system window already draws a title bar,
  corners, and a shadow. Two frames read as one ring of dead space and the
  `--canvas` colour behind it says nothing. Four frame tokens in
  `src/app/globals.css` carry it, gated on `display-mode: standalone`,
  `minimal-ui`, and `window-controls-overlay`. The panes, dividers, tab strip,
  and inspector are untouched.
- **Generated robot Agent icons (2026-09-25):** the Lucide Agent symbols, the
  unused image variant, and the `unassigned` draft glyph are replaced by one
  generated tile: 34 flat robot silhouettes in 8 muted tones, unique per
  visible Agent and stored opaquely in the runtime's own Agent slot. Drafts
  share one dashed tile. The pair sensor follows the pointer and blinks while
  the Agent runs. This is not one of the ornamental effects the lock
  rules out: the sensor is the Agent's identity, and the blink only mirrors a
  running state the status indicator already shows. Both motions stop under
  reduced motion.
- **Waiting Agent tile (2026-09-28):** an Agent waiting on the person looks
  away and back, hops, and looks toward the conversation as it lands, then
  holds that pose. Like the blink, it mirrors the attention state the status
  indicator already shows. The aside pose stays under reduced motion, so
  waiting still reads differently from idle. Each silhouette caps how far its
  pair may look aside, so no bar leaves its backdrop.
- **An MCP App view can show in the side panel (2026-09-30):** an App that asks
  for picture-in-picture (`pip`) shows in the side panel rather than floating
  over the conversation, which stays the dominant surface. The side panel takes
  the inspector's place on wide screens and opens as the focus-managed drawer on
  phones, and it holds one view at a time. A frame cannot move without
  reloading, so the view reloads each time it moves. Its message keeps a "Shown
  in the side panel" note with a control that returns it, as the panel's close
  control and Esc do, and leaving the Session returns it to its message.
