import { listSites, matchSite } from '../api.ts';
import type { SearchConsoleClient } from '../client.ts';
import { parseLimit, str, type Command } from '../command.ts';
import { CliError } from '../errors.ts';
import type { Column, Row } from '../output.ts';
import { collectUrls, mapLimit, normalizeUrl, openInBrowser, URL_SOURCE_HELP, URL_SOURCE_OPTIONS } from '../urls.ts';

/** Sitemaps can list thousands of URLs; inspection quota is 2,000 per property per day. */
const DEFAULT_URL_LIMIT = 50;
const MAX_CONCURRENCY = 10;
/** --open launches one browser tab per URL; more than this is a mistake, not a workflow. */
const MAX_OPEN = 10;

export interface InspectionResult {
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
  summary: 'Indexing status of URLs, and a one-click route to "Request indexing"',
  usage: 'gscli inspect <url...> [options]',
  help: `Runs the URL Inspection API (Google's indexed version, not a live test) for each URL.

verdict is PASS (indexed), NEUTRAL (excluded, e.g. noindex or duplicate) or FAIL (error).
coverageState gives the reason, e.g. "Crawled - currently not indexed".
canonicalMismatch is true when Google picked a different canonical than the page declares.
link opens the URL in Search Console's URL Inspection tool.
A URL that fails to inspect gets an error field; the command still exits 0.

Without --site, each URL is matched to the property that contains it.

Requesting a recrawl: Google offers no API for the "Request indexing" button (its Indexing API
is limited to job posting and livestream pages). --open takes you straight to that button.
For Bing, Yandex and other IndexNow engines, use \`gscli indexnow submit\`.

Options:
${URL_SOURCE_HELP}
  -n, --limit <n|all>        Maximum URLs from --file or --sitemap. Default: ${DEFAULT_URL_LIMIT}.
                             Quota: 2,000 inspections per property per day, 600 per minute.
      --open                 Open each URL's inspection page in the browser (at most ${MAX_OPEN}),
                             ready for "Request indexing".
      --concurrency <n>      Parallel requests. Default: 4, maximum ${MAX_CONCURRENCY}.
      --language <code>      Language for issue messages, e.g. en-US. Default: en-US.
      --raw                  Return Google's full inspection result for each URL.

Examples:
  gscli inspect https://example.com/pricing
  gscli inspect https://example.com/pricing --open   # then click "Request indexing"
  gscli inspect --sitemap https://example.com/sitemap.xml -n 200 --format csv > index-status.csv
  gscli query -d page --format jsonl | jq -r .page | head -20 | gscli inspect --file -`,
  options: {
    ...URL_SOURCE_OPTIONS,
    limit: { type: 'string', short: 'n' },
    open: { type: 'boolean' },
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
    const { urls, source, sitemapUrlCount } = await collectUrls(positionals, values, limit);

    let siteFor: (url: string) => string | undefined;
    let siteLabel: string;
    if (ctx.siteRequested) {
      const site = await ctx.site(client);
      siteFor = () => site;
      siteLabel = site;
    } else {
      const available = (await listSites(client))
        .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
        .map((s) => s.siteUrl);
      siteFor = (url) => matchSite(url, available);
      siteLabel = 'per URL';
    }

    const rows = await mapLimit(urls, concurrency, async (url) => {
      const site = siteFor(url);
      if (!site) return { url, error: 'No accessible Search Console property contains this URL.' };
      const row = await inspectOne(client, site, url, languageCode, Boolean(values.raw));
      return ctx.siteRequested ? row : { url, site, ...row };
    });

    if (values.open) {
      for (const row of rows.filter((r) => r.link).slice(0, MAX_OPEN)) {
        row.opened = await openInBrowser(String(row.link));
      }
    }
    const failed = rows.filter((r) => r.error).length;

    const columns: Column[] = [
      { key: 'url' },
      ...(values.raw
        ? []
        : [
            { key: 'verdict' },
            { key: 'coverageState', label: 'coverage' },
            { key: 'lastCrawlTime', label: 'lastCrawl' },
            { key: 'canonicalMismatch', label: 'canonical≠' },
          ]),
      ...(values.open ? [{ key: 'opened' }] : []),
      { key: 'error' },
    ];
    return {
      meta: {
        site: siteLabel,
        source,
        sitemapUrlCount,
        inspected: rows.length,
        failed,
        indexed: values.raw ? undefined : rows.filter((r) => r.verdict === 'PASS').length,
        opened: values.open ? rows.filter((r) => r.opened).length : undefined,
        notOpened:
          values.open && rows.filter((r) => r.link).length > MAX_OPEN
            ? `--open opens at most ${MAX_OPEN} pages; the rest have a link field.`
            : undefined,
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
    const result = await inspectUrl(client, siteUrl, url, languageCode);
    return raw ? { url, link: result.inspectionResultLink, ...result } : flattenInspection(url, result);
  } catch (err) {
    // Credential and quota problems affect every URL, so stop instead of reporting each one.
    if (err instanceof CliError && (err.code === 'auth' || err.code === 'quota')) throw err;
    return { url, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Google's indexed view of one URL in a property (the URL Inspection API, not a live test). */
export async function inspectUrl(
  client: SearchConsoleClient,
  siteUrl: string,
  url: string,
  languageCode = 'en-US',
): Promise<InspectionResult> {
  const res = await client.searchConsole<{ inspectionResult?: InspectionResult }>('/urlInspection/index:inspect', {
    method: 'POST',
    body: { inspectionUrl: url, siteUrl, languageCode },
  });
  return res.inspectionResult ?? {};
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
