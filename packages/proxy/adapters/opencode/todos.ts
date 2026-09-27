/**
 * OpenCode's native Session-Todo tool. The projection and the state aliases
 * OpenCode shares with Hermes live in `../todos`; only the name of the native
 * tool that writes the list belongs to this adapter.
 */

/** The native tool whose own input is the authoritative Todo list. */
export const OPENCODE_TODO_TOOL = "todowrite"
