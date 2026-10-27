/**
 * What the Word frame and the artifact view agree on. This module imports
 * nothing, since the renderer that runs in the frame imports it too.
 */

/** The message the Word frame sends the view when it cannot draw a document. */
export const DOCX_FAILED = "aos/documentFailed"

/** The element the renderer draws the document's pages into. */
export const DOCX_CONTAINER_ID = "document"

/** The Word frame's page before its policy and scripts are added. */
// Its body's margin goes in an attribute, since the view that carries this
// page in its script holds exactly one stylesheet.
export const DOCX_PAGE = `<!doctype html><html><head></head><body style="margin:0"><main id="${DOCX_CONTAINER_ID}"></main></body></html>`

/**
 * What a Word frame may do: run its own three scripts, which carry `nonce`,
 * and nothing else, so neither an inline handler nor a `javascript:` link nor
 * any script a document carries runs; keep its styles inline; and show
 * pictures and fonts from `data:` addresses, the only images and fonts the
 * view's own policy, which the frame inherits, allows. It connects to nothing
 * and reaches no host, frame, form, or plugin.
 */
export function docxPolicy(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ")
}
