import { PAGE_SIZE, searchAnalytics, type FlatRow } from '../api.ts';
import { analyticsInput, parseLimit, RANGE_HELP, RANGE_OPTIONS, str, type Command } from '../command.ts';
import { usageError } from '../errors.ts';
import { parseDimensions } from '../filters.ts';
import { METRIC_COLUMNS } from '../output.ts';

const SORTS = ['clicks', 'impressions', 'ctr', 'position'] as const;
type Sort = (typeof SORTS)[number];

export const query: Command = {
  name: 'query',
  summary: 'Search performance: clicks, impressions, CTR and position by any dimension',
  usage: 'gscli query [options]',
  help: `Runs a Search Analytics query. Rows come back ordered by clicks.

Options:
  -d, --dimensions <list>    Comma-separated: query, page, country, device, searchAppearance, date, hour.
                             Default: query.
  -n, --limit <n|all>        Rows to return. Default: 100. "all" pages through every row.
      --sort <metric>        ${SORTS.join(' | ')}. Default: clicks. position sorts best (lowest) first.
                             Other sorts re-rank the top ${PAGE_SIZE.toLocaleString('en-US')} rows by clicks.

${RANGE_HELP}

Examples:
  gscli query --last 7d -n 20
  gscli query -d page --filter page~/blog/ --sort impressions
  gscli query -d query,page --filter query~/^how to/ --limit all --format csv > how-to.csv
  gscli query -d date --last 3m                 # daily trend
  gscli query -d country,device --type image`,
  options: {
    ...RANGE_OPTIONS,
    dimensions: { type: 'string', short: 'd' },
    limit: { type: 'string', short: 'n' },
    sort: { type: 'string' },
  },
  async run(ctx, values) {
    const client = ctx.client();
    const dimensions = parseDimensions(str(values.dimensions), ['query']);
    const limit = parseLimit(values.limit, 100);
    const sort = (str(values.sort) ?? 'clicks') as Sort;
    if (!SORTS.includes(sort)) throw usageError(`Unknown sort "${sort}".`, `Valid sorts: ${SORTS.join(', ')}.`);

    const input = await analyticsInput(ctx, client, values);
    const fetchLimit = sort === 'clicks' ? limit : Math.max(limit, PAGE_SIZE);
    let rows = await searchAnalytics(client, input.site, {
      ...input.range,
      dimensions,
      type: input.type,
      filters: input.filters,
      dataState: input.dataState,
      limit: fetchLimit,
    });
    const fetched = rows.length;
    if (sort !== 'clicks') rows = sortRows(rows, sort).slice(0, limit);

    // Dates and hours read best in time order.
    if (sort === 'clicks' && dimensions.length === 1 && (dimensions[0] === 'date' || dimensions[0] === 'hour')) {
      rows.sort((a, b) => String(a[dimensions[0]!]).localeCompare(String(b[dimensions[0]!])));
    }

    return {
      meta: {
        site: input.site,
        startDate: input.range.startDate,
        endDate: input.range.endDate,
        type: input.type,
        dimensions,
        filters: input.filters.length ? input.filters : undefined,
        dataState: input.dataState,
        sort,
        rowCount: rows.length,
        truncated: sort === 'clicks' ? rows.length === limit : fetched === fetchLimit,
      },
      rows,
      columns: [...dimensions.map((key) => ({ key })), ...METRIC_COLUMNS],
    };
  },
};

export function sortRows(rows: FlatRow[], sort: Sort): FlatRow[] {
  const sorted = [...rows];
  if (sort === 'position') sorted.sort((a, b) => a.position - b.position);
  else sorted.sort((a, b) => b[sort] - a[sort] || b.clicks - a.clicks);
  return sorted;
}
