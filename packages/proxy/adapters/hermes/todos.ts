/**
 * Hermes' native Session-Todo vocabulary. The projection itself is shared
 * (`../todos`); only the words Hermes uses for a Todo's state belong here.
 */

/**
 * Hermes writes `pending | in_progress | completed | cancelled`; the two names
 * it does not share with the normalized vocabulary are renamed here, so a Todo
 * the Agent is working on reads as active instead of degrading to pending.
 */
export const HERMES_TODO_STATUS_ALIASES: Readonly<Record<string, string>> = {
  in_progress: "active",
  cancelled: "failed",
}
