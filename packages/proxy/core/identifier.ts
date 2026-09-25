/** A public identifier: 1 to 256 characters, none of them a control character. */
export function validIdentifier(value: string) {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}
