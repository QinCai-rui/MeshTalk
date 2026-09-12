export function sameResponse<T>(current: T, next: T): boolean {
  return Object.is(current, next) || JSON.stringify(current) === JSON.stringify(next)
}

export function retainRecentEntries<T>(entries: Record<string, T>, maximum: number) {
  const keys = Object.keys(entries)
  return keys.length <= maximum
    ? entries
    : Object.fromEntries(keys.slice(-maximum).map((key) => [key, entries[key]!])) as Record<string, T>
}

export function updateBoundedEntry<T>(
  entries: Record<string, T>,
  key: string,
  value: T,
  maximum: number,
) {
  if (Object.is(entries[key], value)) return entries
  const next = { ...entries }
  delete next[key]
  next[key] = value
  return retainRecentEntries(next, maximum)
}
