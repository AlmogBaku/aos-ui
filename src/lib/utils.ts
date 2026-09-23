import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Whether two JSON-shaped values carry the same data, so a state setter can
 * keep the value it has and an unchanged re-read re-renders nothing.
 */
export function sameData(left: unknown, right: unknown) {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}
