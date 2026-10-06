/** Internal helpers. Deliberately not exported from the package barrel. */

/** Copies defaults, then overrides with partial keys whose value is not undefined. */
export function withDefaults<T extends object>(defaults: Readonly<T>, partial?: Partial<T>): T {
  const result = { ...defaults } as T;
  if (!partial) return result;
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const value = partial[key];
    if (value !== undefined) result[key] = value as T[keyof T];
  }
  return result;
}
