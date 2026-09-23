/**
 * `MEDIA:<path>` delivery lines: the convention a harness uses to hand a file
 * to its messaging surfaces from inside assistant prose. The line itself never
 * reaches the browser — it names a native path — so a streaming filter removes
 * each one and lets its caller decide what the reference becomes.
 */

export const MEDIA_LINE =
  /^\s*MEDIA:\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/u
export const MEDIA_DIRECTIVE_PREFIX = /^\s*MEDIA:/u
/** A partial line that may still grow into a MEDIA directive. */
export const POSSIBLE_MEDIA_PREFIX =
  /^\s*(?:M(?:E(?:D(?:I(?:A(?::(?:\s*)?)?)?)?)?)?)?$/u
export const MAX_MEDIA_LINE_BYTES = 4_112
/** What an unusable MEDIA line reads as instead of its path. */
export const MEDIA_UNAVAILABLE = "[Media unavailable]"

export function mediaReference(line: string) {
  return MEDIA_LINE.exec(line)?.slice(1).find(Boolean)
}

function withinBytes(value: string, max: number) {
  return new TextEncoder().encode(value).length <= max
}

/**
 * Incrementally removes MEDIA lines from streamed text. Every well-formed line
 * reports its reference to `claim`: a claimed line leaves the text, and an
 * unclaimed or overlong one becomes {@link MEDIA_UNAVAILABLE}.
 */
export class MediaLineFilter {
  #pending = ""
  #discardingMediaLine = false
  readonly #claim: (reference: string) => boolean

  constructor(claim: (reference: string) => boolean) {
    this.#claim = claim
  }

  write(value: string) {
    let prefix = ""
    if (this.#discardingMediaLine) {
      const newline = value.indexOf("\n")
      if (newline < 0) return ""
      this.#discardingMediaLine = false
      value = value.slice(newline + 1)
      prefix = "\n"
    }
    this.#pending += value
    return `${prefix}${this.#drain(false)}`
  }

  finish() {
    this.#discardingMediaLine = false
    return this.#drain(true)
  }

  #projectLine(line: string) {
    const reference = mediaReference(line)
    if (!reference) return line
    return this.#claim(reference) ? undefined : MEDIA_UNAVAILABLE
  }

  #drain(final: boolean) {
    let output = ""
    while (this.#pending) {
      const newline = this.#pending.indexOf("\n")
      if (newline >= 0) {
        const line = this.#pending.slice(0, newline).replace(/\r$/u, "")
        this.#pending = this.#pending.slice(newline + 1)
        const projected = this.#projectLine(line)
        if (projected !== undefined) output += `${projected}\n`
        continue
      }
      if (
        !final &&
        (POSSIBLE_MEDIA_PREFIX.test(this.#pending) ||
          MEDIA_DIRECTIVE_PREFIX.test(this.#pending))
      ) {
        if (withinBytes(this.#pending, MAX_MEDIA_LINE_BYTES)) break
        output += MEDIA_UNAVAILABLE
        this.#pending = ""
        this.#discardingMediaLine = true
        break
      }
      output += this.#projectLine(this.#pending) ?? ""
      this.#pending = ""
    }
    return output
  }
}
