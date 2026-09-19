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
- Keep the inspector limited to Agent identity, status, description, Sessions, and the active
  Session's explicitly published Artifacts. Opening an Artifact may temporarily
  replace the inspector with its read-only viewer; closing it restores the
  Agent inspector. Narrow layouts use the established focus-managed drawer.
- Do not add department navigation, window traffic lights, dashboard cards, or ornamental effects.
- Prefer native-feeling shadcn controls, comfortable spacing, clear contrast, and progressive disclosure.

Mobile navigation uses one logical-start drawer with two levels. It opens on
the selected Agent's Sessions, returns to the Agent roster through a Back
control, and only changes the active Agent when a Session is chosen. Choosing a
Session dismisses the drawer immediately. Activity remains visible at both
levels, while merely browsing the drawer does not mark a conversation read.

Any intentional visual departure must be called out before it is introduced.

## Intentional departures introduced 2026-09

- **Attention color shifted from teal to blue (`--info`):** waiting-for-input state
  uses `--info` (blue) rather than teal to distinguish it from the unread signal.
- **Unread dot uses `--success` (green):** a separate green dot marks Sessions with
  content the user has not yet seen, independent of execution state.
- **Running indicator uses a breathing teal dot:** an active model turn uses a
  breathing animation on a teal dot, not a violet one.
- **Status and read state appear as two independent dots:** both dots may coexist
  on a row; neither hides the other.
- **Row Activity count pills removed:** navigation rows no longer carry violet
  count pills. The bell in the Agents heading shows the sole derived unread count.
- **Drawer browsing marks nothing read:** the Activity drawer is browse-only;
  reading a Session there does not change its read state.
- **Audio and video Artifacts play in the conversation:** published media renders
  as an inline native player in the message instead of a card that replaces the
  inspector with the Artifact viewer. Every other Artifact keeps the viewer.
