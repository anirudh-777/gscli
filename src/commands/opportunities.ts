import { PAGE_SIZE, searchAnalytics, type FlatRow } from '../api.ts';
import { analyticsInput, parseLimit, parseNumber, RANGE_HELP, RANGE_OPTIONS, str, type Command } from '../command.ts';
import { usageError } from '../errors.ts';
import { parseDimensions } from '../filters.ts';
import type { Column } from '../output.ts';

/**
 * Rough organic CTR by position, from published click-curve studies. Real CTR varies a lot
 * with SERP features and query intent, so this ranks opportunities rather than predicting clicks.
 */
const CTR_CURVE = [0.28, 0.16, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015, 0.012, 0.01, 0.009, 0.008];

export function expectedCtr(position: number): number {
  if (position <= 1) return CTR_CURVE[0]!;
  const last = CTR_CURVE.length;
  if (position >= last) return Math.max(0.002, CTR_CURVE[last - 1]! * (last / position));
  const lower = Math.floor(position);
  const t = position - lower;
  return CTR_CURVE[lower - 1]! * (1 - t) + CTR_CURVE[lower]! * t;
}

export type Opportunity = FlatRow & {
  expectedCtr: number;
  potentialClicks: number;
  signal: string;
};

export interface OpportunityOptions {
  minPosition: number;
  maxPosition: number;
  minImpressions: number;
  targetPosition: number;
}

export function findOpportunities(rows: FlatRow[], options: OpportunityOptions): Opportunity[] {
  const targetCtr = expectedCtr(options.targetPosition);
  return rows
    .filter(
      (r) =>
        r.position >= options.minPosition &&
        r.position <= options.maxPosition &&
        r.impressions >= options.minImpressions,
    )
    .map((r) => {
      const expected = expectedCtr(r.position);
      return {
        ...r,
        ctr: Math.round(r.ctr * 10_000) / 10_000,
        position: Math.round(r.position * 10) / 10,
        expectedCtr: Math.round(expected * 10_000) / 10_000,
        potentialClicks: Math.max(0, Math.round(r.impressions * targetCtr - r.clicks)),
        signal: signalFor(r, expected),
      };
    })
    .filter((r) => r.potentialClicks > 0)
    .sort((a, b) => b.potentialClicks - a.potentialClicks);
}

function signalFor(row: FlatRow, expected: number): string {
  const signals: string[] = [];
  if (row.ctr < expected * 0.5) signals.push('low-ctr');
  if (row.position > 10) signals.push('page-2');
  else if (row.position < 7) signals.push('near-top-3');
  return signals.join(',') || 'page-1';
}

export const opportunities: Command = {
  name: 'opportunities',
  summary: 'Queries and pages ranking just off the top with clicks to gain',
  usage: 'gscli opportunities [options]',
  help: `Finds rows ranking between --min-position and --max-position with enough impressions,
and estimates the extra clicks over the same period if each reached --target-position.

potentialClicks = impressions × expected CTR at the target position − current clicks.
expectedCtr is a rough industry click curve; use it to rank work, not to forecast traffic.

signal (comma-separated):
  low-ctr      CTR under half of expected for the position: rework the title and description
  near-top-3   positions 4-7: small ranking gains move it into the top 3
  page-2       position over 10: needs stronger content or internal links to reach page 1
  page-1       positions 7-10 with no CTR problem

Options:
  -d, --dimensions <list>    Default: query,page. Use query or page alone to aggregate.
      --min-position <n>     Default: 4.
      --max-position <n>     Default: 20.
      --min-impressions <n>  Default: 50.
      --target-position <n>  Default: 3.
  -n, --limit <n|all>        Rows to return. Default: 25.

${RANGE_HELP}

Examples:
  gscli opportunities
  gscli opportunities -d page --min-impressions 200
  gscli opportunities --filter page~/blog/ --max-position 12`,
  options: {
    ...RANGE_OPTIONS,
    dimensions: { type: 'string', short: 'd' },
    'min-position': { type: 'string' },
    'max-position': { type: 'string' },
    'min-impressions': { type: 'string' },
    'target-position': { type: 'string' },
    limit: { type: 'string', short: 'n' },
  },
  async run(ctx, values) {
    const client = ctx.client();
    const dimensions = parseDimensions(str(values.dimensions), ['query', 'page']);
    const options: OpportunityOptions = {
      minPosition: parseNumber(values['min-position'], '--min-position', 4),
      maxPosition: parseNumber(values['max-position'], '--max-position', 20),
      minImpressions: parseNumber(values['min-impressions'], '--min-impressions', 50),
      targetPosition: parseNumber(values['target-position'], '--target-position', 3),
    };
    if (options.minPosition > options.maxPosition) throw usageError('--min-position is greater than --max-position.');
    if (options.targetPosition < 1) throw usageError('--target-position must be at least 1.');
    const limit = parseLimit(values.limit, 25);

    const input = await analyticsInput(ctx, client, values);
    const all = await searchAnalytics(client, input.site, {
      ...input.range,
      dimensions,
      type: input.type,
      filters: input.filters,
      dataState: input.dataState,
      limit: PAGE_SIZE,
    });
    const rows = findOpportunities(all, options).slice(0, limit);

    const columns: Column[] = [
      ...dimensions.map((key) => ({ key })),
      { key: 'impressions', kind: 'int' },
      { key: 'clicks', kind: 'int' },
      { key: 'ctr', kind: 'pct' },
      { key: 'expectedCtr', label: 'expected', kind: 'pct' },
      { key: 'position', kind: 'position' },
      { key: 'potentialClicks', label: '+clicks', kind: 'int' },
      { key: 'signal' },
    ];
    return {
      meta: {
        site: input.site,
        startDate: input.range.startDate,
        endDate: input.range.endDate,
        type: input.type,
        dimensions,
        filters: input.filters.length ? input.filters : undefined,
        ...options,
        rowCount: rows.length,
      },
      rows,
      columns,
    };
  },
};
