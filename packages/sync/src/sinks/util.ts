/** Keeps one item per key: the one with the latest `updatedAt` (the last one when there is none). */
export function dedupeLatest<T>(
  items: T[],
  key: (item: T) => string,
  updatedAt?: (item: T) => Date,
): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const current = best.get(k);
    if (!current || !updatedAt || updatedAt(item) >= updatedAt(current)) best.set(k, item);
  }
  return [...best.values()];
}
