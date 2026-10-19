/** Demo mode: no API, the web app reads seeded data straight from the database. NEXT_PUBLIC_* needs a literal name. */
export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === '1';
}
