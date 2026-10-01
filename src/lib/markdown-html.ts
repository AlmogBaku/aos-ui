import { toHtml } from "hast-util-to-html"
import { toHast } from "mdast-util-to-hast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * Renders message markdown as an HTML fragment for the clipboard, so a rich
 * paste target keeps the formatting. Raw HTML in the markdown is dropped, not
 * passed through.
 */
export function markdownToHtml(markdown: string): string {
  return toHtml(toHast(parser.parse(markdown)))
}
