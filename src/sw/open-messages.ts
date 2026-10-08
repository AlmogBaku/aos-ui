/**
 * `type` of the message the service worker posts to a focused window when a
 * notification is clicked: `{ type, agentId?, sessionId? }`, ids iff one Session.
 */
export const OPEN_MESSAGE_TYPE = "aos:open"

/**
 * `type` of the answer a window posts back on the port the worker handed it.
 * The click only counts as delivered once a window answers: an open window may
 * be loading, frozen, or already gone, and a message lost to one of those would
 * leave the click with no window at all.
 */
export const OPEN_ACK_MESSAGE_TYPE = "aos:open-ack"
