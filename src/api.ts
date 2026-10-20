import type { SearchConsoleClient } from './client.ts';
import { addDays, todayInPacific, type DateRange } from './dates.ts';
import { CliError, usageError } from './errors.ts';
import type { Dimension, DimensionFilter } from './filters.ts';

export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export type DataState = 'final' | 'all' | 'hourly_all';

/** Search Console returns at most this many rows per request. */
export const PAGE_SIZE = 25_000;

export interface Site {
  siteUrl: string;
  permissionLevel: string;
}

export interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AnalyticsQuery extends DateRange {
  dimensions: Dimension[];
  type?: SearchType;
  filters?: DimensionFilter[];
  dataState?: DataState;
  aggregationType?: 'auto' | 'byPage' | 'byProperty';
  /** Maximum rows to return; Infinity pages through everything. */
  limit: number;
}

export type FlatRow = Partial<Record<Dimension, string>> & Omit<AnalyticsRow, 'keys'>;

export async function listSites(client: SearchConsoleClient): Promise<Site[]> {
  const res = await client.webmasters<{ siteEntry?: Site[] }>('/sites');
  return (res.siteEntry ?? []).sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/**
 * Maps what a person types (`example.com`, `https://example.com/blog`, `sc-domain:example.com`)
 * to a property these credentials can read. Falls back to the only property when there is one.
 */
export async function resolveSite(client: SearchConsoleClient, input: string | undefined): Promise<string> {
  const wanted = input ?? process.env.GSC_SITE;
  const sites = (await listSites(client)).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  const available = sites.map((s) => s.siteUrl);

  if (!wanted) {
    if (available.length === 1) return available[0]!;
    if (available.length === 0) {
      throw new CliError('permission', 'These credentials cannot access any Search Console property.', {
        hint: 'Add the account or service account as a user in Search Console > Settings > Users and permissions.',
      });
    }
    throw usageError('Several properties are available; choose one with --site or GSC_SITE.', available.join('\n'));
  }

  const match = matchSite(wanted, available);
  if (!match) {
    throw new CliError('permission', `No accessible property matches "${wanted}".`, {
      hint: available.length ? `Accessible properties:\n${available.join('\n')}` : undefined,
    });
  }
  return match;
}

export function matchSite(wanted: string, available: string[]): string | undefined {
  const value = wanted.trim();
  if (available.includes(value)) return value;

  if (value.startsWith('sc-domain:')) return undefined;

  const url = toUrl(value);
  if (!url) return undefined;
  const host = url.hostname.toLowerCase();
  const bareHost = host.replace(/^www\./, '');
  const isBareDomain = !/^https?:\/\//i.test(value);
  // Domain properties cover every subdomain; the most specific one wins.
  const domain = available
    .filter((s) => s.startsWith('sc-domain:'))
    .filter((s) => {
      const d = s.slice('sc-domain:'.length);
      return host === d || host.endsWith(`.${d}`);
    })
    .sort((a, b) => b.length - a.length)[0];

  // A bare domain means the whole site, so the domain property wins when there is one.
  if (isBareDomain && domain) return domain;

  // URL-prefix properties: the longest prefix that contains the given URL wins.
  const href = url.href;
  const prefix = available
    .filter((s) => /^https?:\/\//.test(s) && (href.startsWith(s) || `${href}/` === s))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return prefix;
  if (domain) return domain;

  if (isBareDomain) {
    return available.find((s) => {
      const u = toUrl(s);
      return u !== undefined && u.hostname.replace(/^www\./, '') === bareHost && u.pathname === '/';
    });
  }
  return undefined;
}

function toUrl(value: string): URL | undefined {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

export async function searchAnalytics(
  client: SearchConsoleClient,
  siteUrl: string,
  query: AnalyticsQuery,
): Promise<FlatRow[]> {
  const rows: FlatRow[] = [];
  let startRow = 0;
  while (rows.length < query.limit) {
    const rowLimit = Math.min(PAGE_SIZE, query.limit - rows.length);
    const body = {
      startDate: query.startDate,
      endDate: query.endDate,
      dimensions: query.dimensions,
      type: query.type ?? 'web',
      dataState: query.dataState ?? (query.dimensions.includes('hour') ? 'hourly_all' : 'final'),
      aggregationType: query.aggregationType,
      dimensionFilterGroups: query.filters?.length ? [{ groupType: 'and', filters: query.filters }] : undefined,
      rowLimit,
      startRow,
    };
    const res = await client.webmasters<{ rows?: AnalyticsRow[] }>(
      `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: 'POST', body },
    );
    const page = res.rows ?? [];
    for (const row of page) rows.push(flatten(row, query.dimensions));
    if (page.length < rowLimit) break;
    startRow += page.length;
  }
  return rows;
}

/** Names each key by its dimension and rounds metrics to what the Search Console UI shows. */
export function flatten(row: AnalyticsRow, dimensions: readonly Dimension[]): FlatRow {
  const flat = Object.fromEntries(dimensions.map((d, i) => [d, row.keys?.[i] ?? ''])) as unknown as FlatRow;
  flat.clicks = row.clicks;
  flat.impressions = row.impressions;
  flat.ctr = Math.round(row.ctr * 10_000) / 10_000;
  flat.position = Math.round(row.position * 100) / 100;
  return flat;
}

/** Latest day with data, so default ranges never end on days Google has not published yet. */
export async function latestDataDate(
  client: SearchConsoleClient,
  siteUrl: string,
  dataState: DataState = 'final',
): Promise<string> {
  const today = todayInPacific();
  const rows = await searchAnalytics(client, siteUrl, {
    startDate: addDays(today, -10),
    endDate: today,
    dimensions: ['date'],
    dataState: dataState === 'hourly_all' ? 'all' : dataState,
    limit: 20,
  });
  const dates = rows.map((r) => r.date).filter((d): d is string => Boolean(d));
  return dates.length ? dates.sort().at(-1)! : addDays(today, -3);
}
