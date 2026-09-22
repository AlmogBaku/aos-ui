// Terminal escape sequences: OSC (titles, hyperlinks) ended by BEL or ST,
// CSI (colors, cursor movement), and the remaining two-byte escapes.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- matching ESC is the point.
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g

/** Terminal output as plain text, with every ANSI escape sequence removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}
