import { searchAnalytics, type AnalyticsQuery } from '../api.ts';
import type { SearchConsoleClient } from '../client.ts';
import { analyticsInput, RANGE_HELP, RANGE_OPTIONS, str, type Command } from '../command.ts';
import { previousRange, yearAgoRange, type DateRange } from '../dates.ts';
import { usageError } from '../errors.ts';
import { formatCell, type ColumnKind } from '../output.ts';

const METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
type Metric = (typeof METRICS)[number];
const VALUE_KIND: Record<Metric, ColumnKind> = { clicks: 'int', impressions: 'int', ctr: 'pct', position: 'position' };
const CHANGE_KIND: Record<Metric, ColumnKind> = {
  clicks: 'delta',
  impressions: 'delta',
  ctr: 'pctDelta',
  position: 'positionDelta',
};

export const summary: Command = {
  name: 'summary',
  summary: 'Site totals for a period, compared with the period before',
  usage: 'gscli summary [options]',
  help: `Shows total clicks, impressions, CTR and average position, and the change against
the previous period of the same length (or the same dates a year earlier).
Totals include anonymized queries, so they are higher than the sum of \`gscli query\` rows.

Options:
      --vs <period>          previous | year. Default: previous.

${RANGE_HELP}

Examples:
  gscli summary
  gscli summary --last 3m --vs year
  gscli summary --filter page~/blog/`,
  options: { ...RANGE_OPTIONS, vs: { type: 'string' } },
  async run(ctx, values) {
    const client = ctx.client();
    const vs = str(values.vs) ?? 'previous';
    if (vs !== 'previous' && vs !== 'year') throw usageError(`--vs must be "previous" or "year", got "${vs}".`);

    const input = await analyticsInput(ctx, client, values);
    const comparison = vs === 'year' ? yearAgoRange(input.range) : previousRange(input.range);
    const base = { dimensions: [], type: input.type, filters: input.filters, dataState: input.dataState, limit: 1 };
    const [current, previous] = await Promise.all([
      totals(client, input.site, { ...base, ...input.range }),
      totals(client, input.site, { ...base, ...comparison }),
    ]);

    return {
      meta: {
        site: input.site,
        startDate: input.range.startDate,
        endDate: input.range.endDate,
        previousStartDate: comparison.startDate,
        previousEndDate: comparison.endDate,
        type: input.type,
        filters: input.filters.length ? input.filters : undefined,
        dataState: input.dataState,
      },
      rows: METRICS.map((metric) => metricRow(metric, current, previous)),
      columns: [
        { key: 'metric' },
        { key: 'current', format: (v, row) => formatCell(v, VALUE_KIND[row.metric as Metric]) },
        { key: 'previous', format: (v, row) => formatCell(v, VALUE_KIND[row.metric as Metric]) },
        { key: 'change', format: (v, row) => formatCell(v, CHANGE_KIND[row.metric as Metric]) },
        { key: 'changePct', label: 'change %', format: (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v}%` : '') },
      ],
    };
  },
};

type Totals = Record<Metric, number>;

async function totals(client: SearchConsoleClient, site: string, query: AnalyticsQuery & DateRange): Promise<Totals> {
  const [row] = await searchAnalytics(client, site, query);
  return row ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

function metricRow(metric: Metric, current: Totals, previous: Totals) {
  const change = current[metric] - previous[metric];
  const changePct = previous[metric] ? change / previous[metric] : null;
  return {
    metric,
    current: round(current[metric], metric),
    previous: round(previous[metric], metric),
    change: round(change, metric),
    changePct: changePct === null ? null : Math.round(changePct * 1000) / 10,
  };
}

function round(value: number, metric: Metric): number {
  if (metric === 'ctr') return Math.round(value * 10_000) / 10_000;
  if (metric === 'position') return Math.round(value * 10) / 10;
  return value;
}
