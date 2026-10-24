import type { DateRange } from './dates.ts';
import { CliError, usageError, type ExitCodeName } from './errors.ts';

export const BING_API = 'https://ssl.bing.com/webmaster/api.svc/json';
const MAX_ATTEMPTS = 3;

export interface BingClientOptions {
  /** Bing Webmaster Tools API key (Settings > API Access). */
  apiKey: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
}

/** Bing Webmaster Tools JSON API. Every response wraps its value in `d`. */
export class BingClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retryDelayMs: number;

  constructor(options: BingClientOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? BING_API;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  get<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    return this.request<T>(method, params);
  }

  post<T>(method: string, body: unknown): Promise<T> {
    return this.request<T>(method, {}, body);
  }

  private async request<T>(method: string, params: Record<string, string>, body?: unknown): Promise<T> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams({ ...params, apikey: this.apiKey })}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'gscli' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new CliError('error', `Bing Webmaster request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Only reads are retried: a POST such as SubmitUrlBatch may have taken effect before the error.
      if (body === undefined && (res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * this.retryDelayMs * (1 + Math.random() / 2));
        continue;
      }
      const text = await res.text();
      const json = parseJson(text);
      if (!res.ok) throw bingError(res.status, json, text);
      return (json as { d?: T } | undefined)?.d as T;
    }
  }
}

// Bing's ErrorCode enum: https://learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces.apierrorcode
const ERROR_CODES: Record<number, { code: ExitCodeName; hint?: string }> = {
  3: { code: 'auth', hint: 'Check the key under Settings > API Access in Bing Webmaster Tools.' },
  4: { code: 'quota', hint: 'Bing is throttling this account. Wait before retrying.' },
  5: { code: 'quota', hint: 'Bing is throttling this site. Wait before retrying.' },
  6: { code: 'permission' },
  7: { code: 'usage' },
  8: { code: 'usage' },
  11: { code: 'permission' },
  13: { code: 'permission' },
  14: { code: 'permission', hint: 'Run `gscli bing sites` to see the sites this key can access.' },
};

export function bingError(status: number, json: unknown, text = ''): CliError {
  const body = json as { ErrorCode?: number; Message?: string } | undefined;
  const message = (body?.Message ?? text.slice(0, 300)).replace(/^ERROR!!!\s*/, '') || `HTTP ${status}`;
  const known = body?.ErrorCode === undefined ? undefined : ERROR_CODES[body.ErrorCode];
  if (known) return new CliError(known.code, `Bing Webmaster: ${message}`, { hint: known.hint });
  if (status === 429) return new CliError('quota', `Bing Webmaster: ${message}`);
  if (status === 401) return new CliError('auth', `Bing Webmaster: ${message}`);
  if (status === 403) return new CliError('permission', `Bing Webmaster: ${message}`);
  return new CliError('error', `Bing Webmaster: ${message}`);
}

/** Bing dates look like `/Date(1316156400000-0700)/`. Returns the YYYY-MM-DD in the stated offset. */
export function parseBingDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(value);
  if (!match) return undefined;
  let ms = Number(match[1]);
  if (match[2]) {
    const sign = match[2][0] === '-' ? -1 : 1;
    ms += sign * (Number(match[2].slice(1, 3)) * 60 + Number(match[2].slice(3))) * 60_000;
  }
  const date = new Date(ms);
  // Bing uses year 1 for "never".
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1970) return undefined;
  return date.toISOString().slice(0, 10);
}

export interface BingSite {
  Url: string;
  IsVerified?: boolean;
}

export async function listBingSites(client: BingClient): Promise<BingSite[]> {
  const sites = (await client.get<BingSite[] | null>('GetUserSites')) ?? [];
  return sites.sort((a, b) => a.Url.localeCompare(b.Url));
}

/**
 * The verified Bing site for --site; else `fromUrl`, a URL the command acts on; else GSC_BING_SITE or GSC_SITE;
 * else the only site. Accepts what works for Search Console too: `example.com`, `https://example.com/blog`,
 * `sc-domain:example.com`.
 */
export async function resolveBingSite(client: BingClient, input: string | undefined, fromUrl?: string): Promise<string> {
  const wanted = input ?? fromUrl ?? process.env.GSC_BING_SITE ?? process.env.GSC_SITE;
  const available = (await listBingSites(client)).filter((s) => s.IsVerified !== false).map((s) => s.Url);
  if (!wanted) {
    if (available.length === 1) return available[0]!;
    if (available.length === 0) {
      throw new CliError('permission', 'This Bing API key has no verified sites.', {
        hint: 'Add and verify the site in Bing Webmaster Tools; you can import it from Search Console.',
      });
    }
    throw usageError('Several Bing sites are available; choose one with --site or GSC_BING_SITE.', available.join('\n'));
  }
  const match = matchBingSite(wanted, available);
  if (!match) {
    throw new CliError('permission', `No verified Bing site matches "${wanted}".`, {
      hint: available.length ? `Verified sites:\n${available.join('\n')}` : undefined,
    });
  }
  return match;
}

export function matchBingSite(wanted: string, available: string[]): string | undefined {
  const value = wanted.trim().replace(/^sc-domain:/, '');
  const url = toUrl(value);
  if (!url) return undefined;
  if (/^https?:\/\//i.test(value)) {
    // The longest site URL that contains the given URL.
    const prefix = available.filter((s) => siteContains(s, url.href)).sort((a, b) => b.length - a.length)[0];
    if (prefix) return prefix;
  }
  // A bare domain: the site at the root of that host, preferring an exact host over www, and https.
  const bare = (h: string) => h.replace(/^www\./, '');
  const roots = available.filter((s) => {
    const u = toUrl(s);
    return u !== undefined && u.pathname === '/' && bare(u.hostname) === bare(url.hostname);
  });
  const score = (s: string) => {
    const u = toUrl(s)!;
    return (u.hostname === url.hostname ? 2 : 0) + (u.protocol === 'https:' ? 1 : 0);
  };
  return roots.sort((a, b) => score(b) - score(a))[0];
}

/** Whether `url` is on `site`: the site URL is a path prefix of it, compared after URL normalization. */
export function siteContains(site: string, url: string): boolean {
  const s = toUrl(site)?.href;
  const u = toUrl(url)?.href;
  if (!s || !u) return false;
  const base = s.endsWith('/') ? s : `${s}/`;
  return u.startsWith(base) || `${u}/` === base;
}

export function inRange(date: string | undefined, range: DateRange): date is string {
  return date !== undefined && date >= range.startDate && date <= range.endDate;
}

function toUrl(value: string): URL | undefined {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

/** One row of GetQueryStats or GetPageStats. For pages, `Query` holds the page URL. */
export interface BingStatsRow {
  Query: string;
  Date: string;
  Clicks: number;
  Impressions: number;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
}

export interface BingAggregate {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  /** Impression-weighted average position. */
  position: number;
}

/**
 * Sums Bing's per-period stats rows by query or page within `range`, ordered by clicks.
 * Positions are averaged by impressions; Bing reports -1 or 0 when it has none.
 */
export function aggregateStats(rows: BingStatsRow[], range: DateRange): BingAggregate[] {
  const byKey = new Map<string, { clicks: number; impressions: number; weighted: number; weight: number }>();
  for (const row of rows) {
    const date = parseBingDate(row.Date);
    if (!inRange(date, range)) continue;
    const entry = byKey.get(row.Query) ?? { clicks: 0, impressions: 0, weighted: 0, weight: 0 };
    entry.clicks += row.Clicks;
    entry.impressions += row.Impressions;
    if (row.AvgImpressionPosition > 0) {
      entry.weighted += row.AvgImpressionPosition * row.Impressions;
      entry.weight += row.Impressions;
    }
    byKey.set(row.Query, entry);
  }
  return [...byKey]
    .map(([key, e]) => ({
      key,
      clicks: e.clicks,
      impressions: e.impressions,
      ctr: e.impressions ? Math.round((e.clicks / e.impressions) * 10_000) / 10_000 : 0,
      position: e.weight ? Math.round((e.weighted / e.weight) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

/** The latest date among Bing rows, so default ranges end where Bing's data does. */
export function latestBingDate(rows: { Date: string }[]): string | undefined {
  let latest: string | undefined;
  for (const row of rows) {
    const date = parseBingDate(row.Date);
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
