export function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.max(0, Math.floor(count)))
}
