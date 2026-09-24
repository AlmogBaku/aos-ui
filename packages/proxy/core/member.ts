/**
 * The typed seam between a transport and the Channel. Nothing here names a
 * wire: a transport decodes its frames into these types and encodes them back.
 */

/**
 * One part of a user prompt: text, or a link to an attachment batch the
 * browser staged. Only the fields a browser itself writes are kept, so nothing
 * else a sender put on a prompt reaches another member.
 */
export type PromptPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; uri: string; name: string; mimeType?: string }

/** A prompt's text parts joined the way the normalized wire carries a turn. */
export function promptText(prompt: readonly PromptPart[]) {
  return prompt
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
}
