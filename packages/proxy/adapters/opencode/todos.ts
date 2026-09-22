/**
 * OpenCode's native Session-Todo vocabulary. The projection itself is shared
 * (`../todos`); only the words OpenCode uses for a Todo's state, and the name
 * of the native tool that writes the list, belong to this adapter.
 */

/** The native tool whose own input is the authoritative Todo list. */
export const OPENCODE_TODO_TOOL = "todowrite"

/**
 * OpenCode reports `pending | in_progress | completed | cancelled`; the two
 * names it does not share with the normalized vocabulary are renamed here.
 */
export const OPENCODE_TODO_STATUS_ALIASES: Readonly<Record<string, string>> = {
  in_progress: "active",
  cancelled: "failed",
}
