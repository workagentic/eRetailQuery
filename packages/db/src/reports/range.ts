import type { RangePreset, ReportRange } from './types';

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The current range ending on `today`, and the equally long range directly before it. */
export function resolveRange(
  preset: RangePreset,
  today: string,
): { current: ReportRange; previous: ReportRange } {
  const from =
    preset === 'mtd' ? `${today.slice(0, 8)}01` : addDays(today, -(parseInt(preset, 10) - 1));
  const length = daysBetween(from, today) + 1;
  return {
    current: { from, to: today },
    previous: { from: addDays(from, -length), to: addDays(from, -1) },
  };
}
