# Native Hermes Approval

## Goal

Represent Hermes permission requests through Assistant UI's native tool-call
approval lifecycle without changing the composer or AOS rich presentation.

## Design

- The Hermes adapter decorates the guarded tool-call part with Assistant UI
  `approval` metadata and marks its assistant message `requires-action`.
- If Hermes supplies no corresponding tool call, the adapter adds one stable
  provider-owned permission part to the current assistant message.
- Assistant UI owns pending, submission, and retry behavior through
  `respondToApproval`; the Hermes adapter translates the selected option to the
  existing `approval.respond` RPC.
- AOS's existing `PermissionTool` remains the renderer, including EN/HE labels.
- OpenCode remains on its upstream native approval projection.
- Questions remain on the shared question bridge because Assistant UI's
  arbitrary interrupt callback cannot report an asynchronous Hermes RPC
  rejection to the renderer. Moving them would regress retry behavior.

## Verification

At the Hermes adapter seam, verify option projection, guarded-tool attachment,
fallback permission parts, and exact response RPC identity. At the workspace
rendering seam, verify the normal composer remains visible while permission
controls render in the transcript.

## Exclusions

No composer changes, question redesign, rich-output changes, provider protocol
changes, Docker checks, or full E2E suite.
