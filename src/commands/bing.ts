import {
  aggregateStats,
  BingClient,
  latestBingDate,
  listBingSites,
  parseBingDate,
  resolveBingSite,
  inRange,
  siteContains,
  type BingStatsRow,
} from '../bing.ts';
import { parseLimit, str, type Command, type Values } from '../command.ts';
import { resolveRange, todayInPacific, validateRangeInput, type DateRange } from '../dates.ts';
import { CliError, usageError } from '../errors.ts';
import { METRIC_COLUMNS, type Result, type Row } from '../output.ts';
import { collectUrls, URL_SOURCE_HELP, URL_SOURCE_OPTIONS } from '../urls.ts';

const SUBCOMMANDS = ['sites', 'traffic', 'queries', 'pages', 'crawl', 'url', 'sitemaps', 'submit', 'quota'] as const;
const SORTS = ['clicks', 'impressions', 'ctr', 'position'] as const;
type Sort = (typeof SORTS)[number];
/** SubmitUrlBatch takes at most 500 URLs per call. */
const SUBMIT_BATCH = 500;

export const bing: Command = {
  name: 'bing',
  summary: 'Bing Webmaster Tools: traffic, queries, pages, crawl stats, sitemaps and URL submission',
  usage: 'gscli bing <subcommand> [args] [options]',
  help: `Reads Bing Webmaster Tools with an API key: Settings > API Access in Bing Webmaster Tools.
One key covers every site verified on that account.

Subcommands:
  sites                      Sites on the account, and whether each is verified.
  traffic                    Daily clicks and impressions, with totals for the range.
  queries                    Top search queries: clicks, impressions, CTR, average position.
  pages                      Top pages, with the same metrics.
  crawl                      Daily crawl stats: pages crawled, crawl errors, pages in index, HTTP codes.
  url <url>                  What Bing knows about one URL: HTTP status, crawl and discovery dates.
  sitemaps [list]            Sitemaps (feeds) submitted to Bing.
  sitemaps submit <url>      Submit a sitemap.
  sitemaps delete <url>      Remove a sitemap. Needs --yes.
  submit <url...>            Submit URLs for crawling through Bing's URL Submission API.
                             Checks the daily quota first. For IndexNow, see \`gscli indexnow\`.
  quota                      Remaining URL submission quota for today and this month.

Options:
      --api-key <key>        Bing Webmaster API key. Default: GSC_BING_API_KEY.
      --last <span>          Span ending on the latest day Bing has data for: 7d, 4w, 3m. Default: 28d.
      --start <YYYY-MM-DD>   Start date.
      --end <YYYY-MM-DD>     End date. Default: the latest day with data.
  -n, --limit <n|all>        Rows for queries and pages. Default: 100. For submit, URLs from --file or --sitemap.
      --sort <metric>        ${SORTS.join(' | ')}, for queries and pages. Default: clicks.
${URL_SOURCE_HELP}
      --dry-run              For submit: show the batches and quota without sending.
      --yes                  Confirm sitemaps delete.

--site picks the Bing site. Without it, url and submit use the site of their first URL; other subcommands
read GSC_BING_SITE, then GSC_SITE. Search Console forms work:
example.com, https://example.com/ and sc-domain:example.com all match a Bing site for that host.

Bing returns query and page stats in dated periods; the range keeps the periods dated inside it.
Totals in \`traffic\` include queries Bing does not list, so they are higher than the sum of \`queries\`.

Examples:
  export GSC_BING_API_KEY=<key>
  gscli bing sites
  gscli bing traffic --site example.com --last 3m
  gscli bing queries -n 20 --sort impressions
  gscli bing url https://example.com/pricing
  gscli bing submit https://example.com/pricing https://example.com/blog/new-post`,
  options: {
    ...URL_SOURCE_OPTIONS,
    'api-key': { type: 'string' },
    last: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    limit: { type: 'string', short: 'n' },
    sort: { type: 'string' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
  },
  allowPositionals: true,
  async run(_ctx, values, positionals) {
    const [action, ...args] = positionals;
    if (!action || !(SUBCOMMANDS as readonly string[]).includes(action)) {
      throw usageError(
        action ? `Unknown bing subcommand "${action}".` : 'bing needs a subcommand.',
        `Use ${SUBCOMMANDS.join(', ')}. Run \`gscli help bing\`.`,
      );
    }
    // Validate flags before asking for a key, so usage errors come first.
    const rangeInput = { last: str(values.last), start: str(values.start), end: str(values.end) };
    validateRangeInput(rangeInput);
    const sort = (str(values.sort) ?? 'clicks') as Sort;
    if (!SORTS.includes(sort)) throw usageError(`Unknown sort "${sort}".`, `Valid sorts: ${SORTS.join(', ')}.`);
    const limit = parseLimit(values.limit, action === 'submit' ? Infinity : 100);
    const takesNoArgs = ['sites', 'traffic', 'queries', 'pages', 'crawl', 'quota'];
    if (takesNoArgs.includes(action) && args.length) throw usageError(`\`gscli bing ${action}\` takes no arguments.`);

    const client = new BingClient({ apiKey: requireKey(values) });
    if (action === 'sites') {
      const sites = await listBingSites(client);
      return {
        meta: { count: sites.length },
        rows: sites.map((s) => ({ siteUrl: s.Url, verified: s.IsVerified ?? null })),
        columns: [{ key: 'siteUrl' }, { key: 'verified' }],
      };
    }

    // url and submit act on URLs, which name their site when --site does not.
    const fromUrl = action === 'url' || action === 'submit' ? args[0] : undefined;
    const site = await resolveBingSite(client, str(values.site), fromUrl);
    const range = (rows: { Date: string }[]) =>
      resolveRange(rangeInput, async () => latestBingDate(rows) ?? todayInPacific());

    switch (action) {
      case 'traffic':
        return traffic(client, site, range);
      case 'queries':
      case 'pages':
        return stats(client, site, action, range, { limit, sort });
      case 'crawl':
        return crawl(client, site, range);
      case 'url':
        return urlInfo(client, site, args);
      case 'sitemaps':
        return sitemaps(client, site, args, values);
      case 'submit':
        return submit(client, site, args, values, limit);
      default:
        return quota(client, site);
    }
  },
};

function requireKey(values: Values): string {
  const key = str(values['api-key']) ?? process.env.GSC_BING_API_KEY;
  if (!key) {
    throw new CliError('auth', 'No Bing Webmaster API key.', {
      hint: 'Create one in Bing Webmaster Tools under Settings > API Access, then pass --api-key or set GSC_BING_API_KEY.',
    });
  }
  return key;
}

type RangeFor = (rows: { Date: string }[]) => Promise<DateRange>;

async function traffic(client: BingClient, site: string, rangeFor: RangeFor): Promise<Result> {
  const data =
    (await client.get<{ Date: string; Clicks: number; Impressions: number }[] | null>('GetRankAndTrafficStats', {
      siteUrl: site,
    })) ?? [];
  const range = await rangeFor(data);
  const rows = data
    .map((r) => ({ date: parseBingDate(r.Date), clicks: r.Clicks, impressions: r.Impressions }))
    .filter((r) => inRange(r.date, range))
    .map((r) => ({ ...r, ctr: r.impressions ? Math.round((r.clicks / r.impressions) * 10_000) / 10_000 : 0 }))
    .sort((a, b) => a.date!.localeCompare(b.date!));
  const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  return {
    meta: {
      site,
      ...range,
      clicks,
      impressions,
      ctr: impressions ? Math.round((clicks / impressions) * 10_000) / 10_000 : 0,
      days: rows.length,
    },
    rows,
    columns: [{ key: 'date' }, ...METRIC_COLUMNS.slice(0, 3)],
  };
}

async function stats(
  client: BingClient,
  site: string,
  kind: 'queries' | 'pages',
  rangeFor: RangeFor,
  { limit, sort }: { limit: number; sort: Sort },
): Promise<Result> {
  const data = (await client.get<BingStatsRow[] | null>(kind === 'queries' ? 'GetQueryStats' : 'GetPageStats', { siteUrl: site })) ?? [];
  const range = await rangeFor(data);
  const all = aggregateStats(data, range);
  if (sort === 'position') all.sort((a, b) => (a.position || Infinity) - (b.position || Infinity));
  else if (sort !== 'clicks') all.sort((a, b) => b[sort] - a[sort] || b.clicks - a.clicks);
  const key = kind === 'queries' ? 'query' : 'page';
  const rows = all.slice(0, limit).map(({ key: value, ...metrics }) => ({ [key]: value, ...metrics }));
  return {
    meta: { site, ...range, sort, rowCount: rows.length, truncated: all.length > rows.length },
    rows,
    columns: [{ key }, ...METRIC_COLUMNS],
  };
}

interface CrawlStats {
  Date: string;
  CrawledPages: number;
  CrawlErrors: number;
  InIndex: number;
  InLinks: number;
  Code2xx: number;
  Code301: number;
  Code302: number;
  Code4xx: number;
  Code5xx: number;
  AllOtherCodes: number;
  BlockedByRobotsTxt: number;
  ConnectionTimeout: number;
  DnsFailures: number;
  ContainsMalware: number;
}

async function crawl(client: BingClient, site: string, rangeFor: RangeFor): Promise<Result> {
  const data = (await client.get<CrawlStats[] | null>('GetCrawlStats', { siteUrl: site })) ?? [];
  const range = await rangeFor(data);
  const rows = data
    .map((r) => ({
      date: parseBingDate(r.Date),
      crawledPages: r.CrawledPages,
      crawlErrors: r.CrawlErrors,
      inIndex: r.InIndex,
      inLinks: r.InLinks,
      code2xx: r.Code2xx,
      code301: r.Code301,
      code302: r.Code302,
      code4xx: r.Code4xx,
      code5xx: r.Code5xx,
      otherCodes: r.AllOtherCodes,
      blockedByRobotsTxt: r.BlockedByRobotsTxt,
      connectionTimeout: r.ConnectionTimeout,
      dnsFailures: r.DnsFailures,
      containsMalware: r.ContainsMalware,
    }))
    .filter((r) => inRange(r.date, range))
    .sort((a, b) => a.date!.localeCompare(b.date!));
  return {
    meta: { site, ...range, days: rows.length },
    rows,
    columns: [
      { key: 'date' },
      { key: 'crawledPages', label: 'crawled', kind: 'int' },
      { key: 'crawlErrors', label: 'errors', kind: 'int' },
      { key: 'inIndex', label: 'indexed', kind: 'int' },
      { key: 'code4xx', label: '4xx', kind: 'int' },
      { key: 'code5xx', label: '5xx', kind: 'int' },
      { key: 'blockedByRobotsTxt', label: 'robots', kind: 'int' },
    ],
  };
}

interface UrlInfo {
  Url: string;
  HttpStatus: number;
  IsPage: boolean;
  DiscoveryDate: string;
  LastCrawledDate: string;
  DocumentSize: number;
  AnchorCount: number;
  TotalChildUrlCount: number;
}

async function urlInfo(client: BingClient, site: string, args: string[]): Promise<Result> {
  if (args.length !== 1) throw usageError('`gscli bing url` takes one URL.');
  const info = await client.get<UrlInfo | null>('GetUrlInfo', { siteUrl: site, url: args[0]! });
  if (!info) return { data: { site, url: args[0], known: false } };
  const lastCrawled = parseBingDate(info.LastCrawledDate);
  return {
    data: {
      site,
      url: info.Url || args[0],
      known: Boolean(lastCrawled || parseBingDate(info.DiscoveryDate)),
      httpStatus: info.HttpStatus || null,
      isPage: info.IsPage,
      discovered: parseBingDate(info.DiscoveryDate) ?? null,
      lastCrawled: lastCrawled ?? null,
      documentSize: info.DocumentSize,
      anchorCount: info.AnchorCount,
      childUrls: info.TotalChildUrlCount,
    },
  };
}

interface Feed {
  Url: string;
  Type: string;
  Status: string;
  Submitted: string;
  LastCrawled: string;
  UrlCount: number;
  FileSize: number;
  Compressed: boolean;
}

async function sitemaps(client: BingClient, site: string, args: string[], values: Values): Promise<Result> {
  const [action = 'list', feed, ...extra] = args;
  if (extra.length) throw usageError(`Unexpected arguments: ${extra.join(' ')}`);
  if (action === 'list') {
    if (feed) throw usageError('`gscli bing sitemaps list` takes no URL.');
    const feeds = (await client.get<Feed[] | null>('GetFeeds', { siteUrl: site })) ?? [];
    const rows: Row[] = feeds.map((f) => ({
      url: f.Url,
      type: f.Type,
      status: f.Status,
      submitted: parseBingDate(f.Submitted) ?? null,
      lastCrawled: parseBingDate(f.LastCrawled) ?? null,
      urls: f.UrlCount,
      fileSize: f.FileSize,
      compressed: f.Compressed,
    }));
    return {
      meta: { site, count: rows.length },
      rows,
      columns: [
        { key: 'url' },
        { key: 'status' },
        { key: 'submitted' },
        { key: 'lastCrawled' },
        { key: 'urls', kind: 'int' },
      ],
    };
  }
  if (action !== 'submit' && action !== 'delete') {
    throw usageError(`Unknown bing sitemaps subcommand "${action}".`, 'Use list, submit or delete.');
  }
  if (!feed) throw usageError(`\`gscli bing sitemaps ${action}\` needs a sitemap URL.`);
  if (action === 'delete' && !values.yes) {
    throw usageError(`Deleting removes ${feed} from Bing Webmaster Tools.`, 'Re-run with --yes to confirm.');
  }
  await client.post(action === 'submit' ? 'SubmitFeed' : 'RemoveFeed', { siteUrl: site, feedUrl: feed });
  return { data: { site, sitemap: feed, [action === 'submit' ? 'submitted' : 'deleted']: true } };
}

async function getQuota(client: BingClient, site: string): Promise<{ daily: number; monthly: number }> {
  const q = await client.get<{ DailyQuota: number; MonthlyQuota: number } | null>('GetUrlSubmissionQuota', { siteUrl: site });
  if (!q) throw new CliError('error', `Bing returned no URL submission quota for ${site}.`);
  return { daily: q.DailyQuota, monthly: q.MonthlyQuota };
}

async function quota(client: BingClient, site: string): Promise<Result> {
  const { daily, monthly } = await getQuota(client, site);
  return { data: { site, dailyRemaining: daily, monthlyRemaining: monthly } };
}

async function submit(client: BingClient, site: string, args: string[], values: Values, limit: number): Promise<Result> {
  const { urls, source, sitemapUrlCount } = await collectUrls(args, values, limit);
  const foreign = urls.filter((u) => !siteContains(site, u));
  if (foreign.length) {
    throw usageError(
      `${foreign.length} URL(s) are not on ${site}, e.g. ${foreign[0]}.`,
      'Bing only accepts URLs on the site they are submitted for. Pick the site with --site.',
    );
  }

  const { daily, monthly } = await getQuota(client, site);
  const allowed = Math.min(daily, monthly);
  if (urls.length > allowed && !values['dry-run']) {
    throw new CliError('quota', `${urls.length} URLs exceed the remaining quota of ${allowed}.`, {
      hint: `Bing allows ${daily} more today and ${monthly} more this month. Submit only changed URLs, or use \`gscli indexnow submit\`, which has no per-site quota.`,
    });
  }

  const rows: Row[] = [];
  for (let i = 0; i < urls.length; i += SUBMIT_BATCH) {
    const batch = urls.slice(i, i + SUBMIT_BATCH);
    if (!values['dry-run']) {
      try {
        await client.post('SubmitUrlBatch', { siteUrl: site, urlList: batch });
      } catch (err) {
        if (!(err instanceof CliError) || i === 0) throw err;
        // Earlier batches went through; say so, so a rerun can skip them.
        throw new CliError(err.code, `${err.message} The first ${i} URLs were already submitted.`, {
          hint: `Resubmit from URL ${i + 1} on, e.g. with --file and a list that skips the first ${i}.`,
          details: { submitted: urls.slice(0, i) },
        });
      }
    }
    rows.push({ batch: rows.length + 1, urls: batch.length, status: values['dry-run'] ? 'dry run' : 'submitted' });
  }
  return {
    meta: {
      site,
      source,
      sitemapUrlCount,
      submitted: values['dry-run'] ? 0 : urls.length,
      dailyQuotaBefore: daily,
      monthlyQuotaBefore: monthly,
      dryRun: values['dry-run'] || undefined,
      overQuota: urls.length > allowed || undefined,
    },
    rows,
    columns: [{ key: 'batch', kind: 'int' }, { key: 'urls', kind: 'int' }, { key: 'status' }],
  };
}
