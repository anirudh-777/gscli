import { readFile } from 'node:fs/promises';
import type { SearchConsoleClient } from '../client.ts';
import { parseLimit, str, type Command } from '../command.ts';
import { CliError, usageError } from '../errors.ts';
import type { Column, Row } from '../output.ts';

/** Sitemaps can list thousands of URLs; inspection quota is 2,000 per property per day. */
const DEFAULT_URL_LIMIT = 50;
const MAX_CONCURRENCY = 10;

interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: { richResultType?: string; items?: { issues?: { issueMessage?: string; severity?: string }[] }[] }[];
  };
}

export const inspect: Command = {
  name: 'inspect',
  summary: 'Indexing status of URLs: indexed or not, why, canonical, last crawl',
  usage: 'gscli inspect <url...> [options]',
  help: `Runs the URL Inspection API (Google's indexed version, not a live test) for each URL.

verdict is PASS (indexed), NEUTRAL (excluded, e.g. noindex or duplicate) or FAIL (error).
coverageState gives the reason, e.g. "Crawled - currently not indexed".
canonicalMismatch is true when Google picked a different canonical than the page declares.
A URL that fails to inspect gets an error field; the command still exits 0.

Options:
      --file <path>          Read URLs from a file, one per line ("-" for stdin).
      --sitemap <url>        Inspect the URLs listed in a sitemap (follows one level of sitemap index).
  -n, --limit <n|all>        Maximum URLs from --file or --sitemap. Default: ${DEFAULT_URL_LIMIT}.
                             Quota: 2,000 inspections per property per day, 600 per minute.
      --concurrency <n>      Parallel requests. Default: 4, maximum ${MAX_CONCURRENCY}.
      --language <code>      Language for issue messages, e.g. en-US. Default: en-US.
      --raw                  Return Google's full inspection result for each URL.

Examples:
  gscli inspect https://example.com/pricing
  gscli inspect --sitemap https://example.com/sitemap.xml -n 200 --format csv > index-status.csv
  gscli query -d page --format jsonl | jq -r .page | head -20 | gscli inspect --file -`,
  options: {
    file: { type: 'string' },
    sitemap: { type: 'string' },
    limit: { type: 'string', short: 'n' },
    concurrency: { type: 'string' },
    language: { type: 'string' },
    raw: { type: 'boolean' },
  },
  allowPositionals: true,
  async run(ctx, values, positionals) {
    const client = ctx.client();
    const limit = parseLimit(values.limit, DEFAULT_URL_LIMIT);
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Number(str(values.concurrency) ?? 4) || 4));
    const languageCode = str(values.language) ?? 'en-US';

    let urls = [...positionals];
    let source = 'arguments';
    const file = str(values.file);
    const sitemap = str(values.sitemap);
    if (file) {
      const text = file === '-' ? await readStdin() : await readFile(file, 'utf8');
      urls.push(...text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, limit));
      source = file === '-' ? 'stdin' : file;
    }
    let sitemapTotal: number | undefined;
    if (sitemap) {
      const fromSitemap = await sitemapUrls(sitemap);
      sitemapTotal = fromSitemap.length;
      urls.push(...fromSitemap.slice(0, limit));
      source = sitemap;
    }
    urls = [...new Set(urls)];
    if (urls.length === 0) throw usageError('No URLs to inspect.', 'Pass URLs as arguments, or use --file or --sitemap.');
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) throw usageError(`"${url}" is not an absolute http(s) URL.`);
    }

    const site = await ctx.site(client);
    const rows = await mapLimit(urls, concurrency, (url) => inspectOne(client, site, url, languageCode, Boolean(values.raw)));
    const failed = rows.filter((r) => r.error).length;

    const columns: Column[] = values.raw
      ? [{ key: 'url' }, { key: 'error' }]
      : [
          { key: 'url' },
          { key: 'verdict' },
          { key: 'coverageState', label: 'coverage' },
          { key: 'lastCrawlTime', label: 'lastCrawl' },
          { key: 'canonicalMismatch', label: 'canonical≠' },
          { key: 'error' },
        ];
    return {
      meta: {
        site,
        source,
        sitemapUrlCount: sitemapTotal,
        inspected: rows.length,
        failed,
        indexed: values.raw ? undefined : rows.filter((r) => r.verdict === 'PASS').length,
      },
      rows,
      columns,
    };
  },
};

async function inspectOne(
  client: SearchConsoleClient,
  siteUrl: string,
  url: string,
  languageCode: string,
  raw: boolean,
): Promise<Row> {
  try {
    const res = await client.searchConsole<{ inspectionResult?: InspectionResult }>('/urlInspection/index:inspect', {
      method: 'POST',
      body: { inspectionUrl: url, siteUrl, languageCode },
    });
    const result = res.inspectionResult ?? {};
    return raw ? { url, ...result } : flattenInspection(url, result);
  } catch (err) {
    // Credential and quota problems affect every URL, so stop instead of reporting each one.
    if (err instanceof CliError && (err.code === 'auth' || err.code === 'quota')) throw err;
    return { url, error: err instanceof Error ? err.message : String(err) };
  }
}

export function flattenInspection(url: string, result: InspectionResult): Row {
  const index = result.indexStatusResult ?? {};
  const rich = result.richResultsResult;
  const issues = rich?.detectedItems?.flatMap((d) => d.items?.flatMap((i) => i.issues ?? []) ?? []) ?? [];
  return {
    url,
    verdict: index.verdict,
    coverageState: index.coverageState,
    indexingState: index.indexingState,
    pageFetchState: index.pageFetchState,
    robotsTxtState: index.robotsTxtState,
    lastCrawlTime: index.lastCrawlTime,
    crawledAs: index.crawledAs,
    googleCanonical: index.googleCanonical,
    userCanonical: index.userCanonical,
    canonicalMismatch:
      index.googleCanonical && index.userCanonical
        ? normalizeUrl(index.googleCanonical) !== normalizeUrl(index.userCanonical)
        : undefined,
    sitemaps: index.sitemap,
    referringUrls: index.referringUrls,
    richResultsVerdict: rich?.verdict,
    richResultTypes: rich?.detectedItems?.map((d) => d.richResultType).filter(Boolean),
    richResultIssues: issues.length ? issues.map((i) => `${i.severity}: ${i.issueMessage}`) : undefined,
    link: result.inspectionResultLink,
  };
}

/** `https://a.com` and `https://a.com/` are the same URL; URL parsing makes them equal. */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const MAX_CHILD_SITEMAPS = 50;

export async function sitemapUrls(url: string, depth = 0): Promise<string[]> {
  const xml = await fetchText(url);
  const locs = extractLocs(xml);
  if (!/<sitemapindex[\s>]/i.test(xml)) return locs;
  if (depth > 0) return [];
  const urls: string[] = [];
  for (const child of locs.slice(0, MAX_CHILD_SITEMAPS)) urls.push(...(await sitemapUrls(child, depth + 1)));
  return urls;
}

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?\s*<\/loc>/gis)].map((m) =>
    m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'gscli' }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new CliError('error', `Could not fetch sitemap ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new CliError('error', `Fetching sitemap ${url} returned HTTP ${res.status}.`);
  if (url.endsWith('.gz')) {
    const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return res.text();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw usageError('--file - reads URLs from stdin, but nothing was piped in.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
