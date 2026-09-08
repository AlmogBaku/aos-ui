import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import type { Locale } from "@/lib/i18n/config"

const parser = unified().use(remarkParse).use(remarkGfm)
type SpeechNode = { type: string; value?: string; children?: SpeechNode[] }

/** A read-only projection of prose supplied by AUI, never tool/reasoning parts. */
export function projectSpeechText(markdown: string, locale: Locale): string {
  const visit = (node: SpeechNode): string => {
    switch (node.type) {
      case "code":
        return locale === "he"
          ? "קטע קוד מופיע בהודעה."
          : "Code block shown in the message."
      case "table":
        return locale === "he"
          ? "טבלה מופיעה בהודעה."
          : "Table shown in the message."
      case "html":
      case "image":
      case "imageReference":
      case "definition":
      case "footnoteDefinition":
      case "footnoteReference":
        return ""
      case "text":
      case "inlineCode":
        return node.value ?? ""
      case "break":
        return "\n"
      default: {
        const separator =
          node.type === "root"
            ? "\n\n"
            : ["list", "listItem", "blockquote"].includes(node.type)
              ? "\n"
              : ""
        return node.children?.map(visit).filter(Boolean).join(separator) ?? ""
      }
    }
  }
  return visit(parser.parse(markdown))
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
