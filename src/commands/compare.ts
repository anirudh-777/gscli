import { PAGE_SIZE, searchAnalytics, type FlatRow } from '../api.ts';
import { analyticsInput, parseLimit, RANGE_HELP, RANGE_OPTIONS, str, type Command } from '../command.ts';
import { previousRange, yearAgoRange } from '../dates.ts';
import { usageError } from '../errors.ts';
import { parseDimensions, type Dimension } from '../filters.ts';
import type { Column } from '../output.ts';

const STATUSES = ['new', 'lost', 'up', 'down', 'flat'] as const;
type Status = (typeof STATUSES)[number];
const SORTS = ['change', 'clicks', 'impressions', 'position'] as const;
type Sort = (typeof SORTS)[number];

export interface ComparedRow {
  [dimension: string]: unknown;
  clicks: number;
  clicksPrev: number;
  clicksDelta: number;
  impressions: number;
  impressionsPrev: number;
  impressionsDelta: number;
  ctr: number;
  ctrPrev: number;
  ctrDelta: number;
  position: number | null;
  positionPrev: number | null;
  positionDelta: number | null;
  status: Status;
}

export const compare: Command = {
  name: 'compare',
  summary: 'Period over period: what gained, lost, appeared or disappeared',
  usage: 'gscli compare [options]',
  help: `Compares a period with the one before it (or a year earlier) row by row.

status is new (no impressions before), lost (no impressions now), up/down (clicks changed)
or flat. positionDelta is current minus previous, so a negative value means it ranks higher.

Options:
  -d, --dimensions <list>    Default: query. Same values as \`gscli query\`, except date and hour.
      --vs <period>          previous | year. Default: previous.
      --only <statuses>      Keep only these statuses, comma-separated: ${STATUSES.join(', ')}.
      --sort <key>           change (largest click change either way) | clicks | impressions | position.
                             Default: change.
  -n, --limit <n|all>        Rows to return. Default: 50.

${RANGE_HELP}

Examples:
  gscli compare --last 28d                    # biggest movers vs the previous 28 days
  gscli compare -d page --only down -n 20     # pages losing clicks
  gscli compare --only new --sort impressions # queries you started ranking for
  gscli compare --last 3m --vs year`,
  options: {
    ...RANGE_OPTIONS,
    dimensions: { type: 'string', short: 'd' },
    vs: { type: 'string' },
    only: { type: 'string' },
    sort: { type: 'string' },
    limit: { type: 'string', short: 'n' },
  },
  async run(ctx, values) {
    const client = ctx.client();
    const dimensions = parseDimensions(str(values.dimensions), ['query']);
    if (dimensions.includes('date') || dimensions.includes('hour')) {
      throw usageError('compare matches rows across periods, so it cannot group by date or hour.', 'Use `gscli query -d date` for trends.');
    }
    const vs = str(values.vs) ?? 'previous';
    if (vs !== 'previous' && vs !== 'year') throw usageError(`--vs must be "previous" or "year", got "${vs}".`);
    const only = parseStatuses(str(values.only));
    const sort = (str(values.sort) ?? 'change') as Sort;
    if (!SORTS.includes(sort)) throw usageError(`Unknown sort "${sort}".`, `Valid sorts: ${SORTS.join(', ')}.`);
    const limit = parseLimit(values.limit, 50);

    const input = await analyticsInput(ctx, client, values);
    const comparison = vs === 'year' ? yearAgoRange(input.range) : previousRange(input.range);
    const base = { dimensions, type: input.type, filters: input.filters, dataState: input.dataState, limit: PAGE_SIZE };
    const [current, previous] = await Promise.all([
      searchAnalytics(client, input.site, { ...base, ...input.range }),
      searchAnalytics(client, input.site, { ...base, ...comparison }),
    ]);

    let rows = compareRows(current, previous, dimensions);
    if (only) rows = rows.filter((r) => only.includes(r.status));
    rows = sortCompared(rows, sort).slice(0, limit);

    const columns: Column[] = [
      ...dimensions.map((key) => ({ key })),
      { key: 'clicks', kind: 'int' },
      { key: 'clicksDelta', label: 'Δclicks', kind: 'delta' },
      { key: 'impressions', kind: 'int' },
      { key: 'impressionsDelta', label: 'Δimpr', kind: 'delta' },
      { key: 'position', kind: 'position' },
      { key: 'positionDelta', label: 'Δpos', kind: 'positionDelta' },
      { key: 'status' },
    ];
    return {
      meta: {
        site: input.site,
        startDate: input.range.startDate,
        endDate: input.range.endDate,
        previousStartDate: comparison.startDate,
        previousEndDate: comparison.endDate,
        type: input.type,
        dimensions,
        filters: input.filters.length ? input.filters : undefined,
        dataState: input.dataState,
        rowCount: rows.length,
        // Each period is capped at one page; beyond that, rows can look new or lost when they are not.
        incomplete: current.length === PAGE_SIZE || previous.length === PAGE_SIZE || undefined,
      },
      rows: rows as unknown as Record<string, unknown>[],
      columns,
    };
  },
};

export function compareRows(current: FlatRow[], previous: FlatRow[], dimensions: Dimension[]): ComparedRow[] {
  const keyOf = (r: FlatRow) => dimensions.map((d) => r[d] ?? '').join('\u0000');
  const before = new Map(previous.map((r) => [keyOf(r), r]));
  const seen = new Set<string>();
  const rows: ComparedRow[] = [];

  for (const now of current) {
    const key = keyOf(now);
    seen.add(key);
    rows.push(combine(dimensions, now, before.get(key)));
  }
  for (const [key, then] of before) {
    if (!seen.has(key)) rows.push(combine(dimensions, undefined, then));
  }
  return rows;
}

function combine(dimensions: Dimension[], now: FlatRow | undefined, then: FlatRow | undefined): ComparedRow {
  const source = (now ?? then)!;
  const clicks = now?.clicks ?? 0;
  const clicksPrev = then?.clicks ?? 0;
  const impressions = now?.impressions ?? 0;
  const impressionsPrev = then?.impressions ?? 0;
  const position = now ? round1(now.position) : null;
  const positionPrev = then ? round1(then.position) : null;

  let status: Status;
  if (!then || impressionsPrev === 0) status = 'new';
  else if (!now || impressions === 0) status = 'lost';
  else if (clicks > clicksPrev) status = 'up';
  else if (clicks < clicksPrev) status = 'down';
  else status = 'flat';

  const row: ComparedRow = {
    clicks,
    clicksPrev,
    clicksDelta: clicks - clicksPrev,
    impressions,
    impressionsPrev,
    impressionsDelta: impressions - impressionsPrev,
    ctr: round4(now?.ctr ?? 0),
    ctrPrev: round4(then?.ctr ?? 0),
    ctrDelta: round4((now?.ctr ?? 0) - (then?.ctr ?? 0)),
    position,
    positionPrev,
    positionDelta: position !== null && positionPrev !== null ? round1(position - positionPrev) : null,
    status,
  };
  return Object.assign(Object.fromEntries(dimensions.map((d) => [d, source[d]])), row);
}

export function sortCompared(rows: ComparedRow[], sort: Sort): ComparedRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'change':
      return sorted.sort(
        (a, b) =>
          Math.abs(b.clicksDelta) - Math.abs(a.clicksDelta) ||
          Math.abs(b.impressionsDelta) - Math.abs(a.impressionsDelta),
      );
    case 'clicks':
      return sorted.sort((a, b) => b.clicks - a.clicks || b.clicksPrev - a.clicksPrev);
    case 'impressions':
      return sorted.sort((a, b) => b.impressions - a.impressions || b.impressionsPrev - a.impressionsPrev);
    case 'position':
      return sorted.sort((a, b) => (a.positionDelta ?? Infinity) - (b.positionDelta ?? Infinity));
  }
}

function parseStatuses(raw: string | undefined): Status[] | undefined {
  if (!raw) return undefined;
  const statuses = raw.split(',').map((s) => s.trim());
  for (const s of statuses) {
    if (!(STATUSES as readonly string[]).includes(s)) {
      throw usageError(`Unknown status "${s}".`, `Valid statuses: ${STATUSES.join(', ')}.`);
    }
  }
  return statuses as Status[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
