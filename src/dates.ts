import { usageError } from './errors.ts';

// Search Console reports days in US Pacific time.
const GSC_TIME_ZONE = 'America/Los_Angeles';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  startDate: string;
  endDate: string;
}

export function todayInPacific(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GSC_TIME_ZONE }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = parseIso(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatIso(d);
}

export function addMonths(date: string, months: number): string {
  const d = parseIso(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return formatIso(d);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86_400_000);
}

/** Range of `spec` (e.g. 7d, 4w, 3m, 1y) ending on `endDate` inclusive. */
export function rangeFromLast(spec: string, endDate: string): DateRange {
  const match = /^(\d+)\s*([dwmy])$/i.exec(spec.trim());
  if (!match) throw usageError(`Invalid --last value "${spec}"`, 'Use a number and a unit: 7d, 4w, 3m, 16m or 1y.');
  const n = Number(match[1]);
  if (n < 1) throw usageError(`--last must be at least 1, got "${spec}"`);
  const unit = match[2]!.toLowerCase();
  let startDate: string;
  if (unit === 'd') startDate = addDays(endDate, -(n - 1));
  else if (unit === 'w') startDate = addDays(endDate, -(n * 7 - 1));
  else startDate = addDays(addMonths(endDate, -(unit === 'y' ? n * 12 : n)), 1);
  return { startDate, endDate };
}

/** The equally long range that ends the day before `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const length = daysBetween(range.startDate, range.endDate);
  const endDate = addDays(range.startDate, -1);
  return { startDate: addDays(endDate, -length), endDate };
}

/** The same calendar dates one year earlier. */
export function yearAgoRange(range: DateRange): DateRange {
  return { startDate: addMonths(range.startDate, -12), endDate: addMonths(range.endDate, -12) };
}

export interface RangeInput {
  last?: string;
  start?: string;
  end?: string;
}

/**
 * Resolves CLI date flags. Without --end, ranges end on the latest day that has data,
 * which Search Console publishes with a lag of roughly two to three days.
 */
export async function resolveRange(
  input: RangeInput,
  latestDate: () => Promise<string>,
  defaultLast = '28d',
): Promise<DateRange> {
  validateRangeInput(input);
  const endDate = input.end ?? (await latestDate());
  const range = input.start ? { startDate: input.start, endDate } : rangeFromLast(input.last ?? defaultLast, endDate);
  if (range.startDate > range.endDate) {
    throw usageError(`Start date ${range.startDate} is after end date ${range.endDate}.`);
  }
  return range;
}

/** Checks date flags without any network call, so usage errors surface before credentials do. */
export function validateRangeInput(input: RangeInput): void {
  if (input.start) assertIso(input.start, '--start');
  if (input.end) assertIso(input.end, '--end');
  if (input.start && input.last) throw usageError('Use either --start/--end or --last, not both.');
  if (input.last) rangeFromLast(input.last, input.end ?? '2000-01-01');
}

export function assertIso(value: string, flag: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(parseIso(value).getTime()) || formatIso(parseIso(value)) !== value) {
    throw usageError(`${flag} must be a date in YYYY-MM-DD format, got "${value}".`);
  }
}

function parseIso(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
