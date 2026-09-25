import { useCallback, useState, type PointerEvent } from "react"

/**
 * Whether the last press on an element came from a finger or a pen rather
 * than a mouse. A long press that opens a menu must not also start a native
 * text selection, but a device can offer both touch and a fine pointer (an
 * iPad with a trackpad), so the input of the press decides, not the device.
 * Pass `onPointerDown` to the pressed element.
 */
export function useTouchPress() {
  const [touchPress, setTouchPress] = useState(false)
  const onPointerDown = useCallback((event: PointerEvent) => {
    setTouchPress(event.pointerType !== "mouse")
  }, [])
  return { touchPress, onPointerDown }
}
