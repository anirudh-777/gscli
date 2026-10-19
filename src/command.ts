import type { ParseArgsOptionsConfig } from 'node:util';
import { latestDataDate, resolveSite, SEARCH_TYPES, type DataState, type SearchType } from './api.ts';
import type { SearchConsoleClient } from './client.ts';
import { resolveRange, validateRangeInput, type DateRange } from './dates.ts';
import { usageError } from './errors.ts';
import { parseFilter, type DimensionFilter } from './filters.ts';
import type { Format, Result } from './output.ts';

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Context {
  format: Format;
  client(options?: { write?: boolean }): SearchConsoleClient;
  /** The property to act on, from --site, GSC_SITE, or the only accessible property. */
  site(client: SearchConsoleClient): Promise<string>;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Longer help: details and examples. */
  help: string;
  options: ParseArgsOptionsConfig;
  allowPositionals?: boolean;
  run(ctx: Context, values: Values, positionals: string[]): Promise<Result>;
}

export const GLOBAL_OPTIONS = {
  site: { type: 'string', short: 's' },
  format: { type: 'string', short: 'f' },
  credentials: { type: 'string' },
  'quota-project': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsOptionsConfig;

export const GLOBAL_HELP = `Global options:
  -s, --site <property>      Property: example.com, https://example.com/ or sc-domain:example.com.
                             Defaults to GSC_SITE, or the only property you can access.
  -f, --format <format>      json | jsonl | csv | table. Default: table in a terminal, json when piped.
      --credentials <file>   Service account or authorized-user JSON. Default: GSC_CREDENTIALS,
                             GOOGLE_APPLICATION_CREDENTIALS, then gcloud application-default credentials.
      --quota-project <id>   Google Cloud project billed for API quota. Default: GSC_QUOTA_PROJECT.
  -h, --help                 Show help.`;

export const RANGE_OPTIONS = {
  last: { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  type: { type: 'string', short: 't' },
  filter: { type: 'string', multiple: true },
  fresh: { type: 'boolean' },
} satisfies ParseArgsOptionsConfig;

export const RANGE_HELP = `Date and filter options:
      --last <span>          Span ending on the latest day with data: 7d, 4w, 3m, 16m, 1y. Default: 28d.
      --start <YYYY-MM-DD>   Start date (Pacific time, like Search Console).
      --end <YYYY-MM-DD>     End date. Default: the latest day with data.
  -t, --type <type>          ${SEARCH_TYPES.join(' | ')}. Default: web.
      --filter <expr>        Filter rows, e.g. query~shoes, page~/blog/, country=ind. Repeatable (AND).
                             Run \`gscli help filters\` for the full syntax.
      --fresh                Include the last few days of not-yet-final data.`;

export interface AnalyticsInput {
  site: string;
  range: DateRange;
  type: SearchType;
  filters: DimensionFilter[];
  dataState: DataState;
}

/** Shared parsing for commands that read search analytics. */
export async function analyticsInput(
  ctx: Context,
  client: SearchConsoleClient,
  values: Values,
  defaultLast = '28d',
): Promise<AnalyticsInput> {
  const type = (str(values.type) ?? 'web') as SearchType;
  if (!SEARCH_TYPES.includes(type)) {
    throw usageError(`Unknown search type "${type}".`, `Valid types: ${SEARCH_TYPES.join(', ')}.`);
  }
  const filters = list(values.filter).map(parseFilter);
  const dataState: DataState = values.fresh ? 'all' : 'final';
  const rangeInput = { last: str(values.last), start: str(values.start), end: str(values.end) };
  validateRangeInput(rangeInput);
  const site = await ctx.site(client);
  const range = await resolveRange(rangeInput, () => latestDataDate(client, site, dataState), defaultLast);
  return { site, range, type, filters, dataState };
}

export function str(value: Values[string]): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function list(value: Values[string]): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** Parses --limit: a positive integer, or "all". */
export function parseLimit(value: Values[string], fallback: number): number {
  const raw = str(value);
  if (raw === undefined) return fallback;
  if (raw === 'all') return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usageError(`--limit must be a positive integer or "all", got "${raw}".`);
  return n;
}

export function parseNumber(value: Values[string], flag: string, fallback: number): number {
  const raw = str(value);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw usageError(`${flag} must be a number, got "${raw}".`);
  return n;
}
